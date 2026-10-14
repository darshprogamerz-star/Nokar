/**
 * NOKAR 2.0 — Skills: every task the bot can execute.
 * Each skill: async (engine, task) => void
 *   - must bail out quickly when task.cancelled is set (checked via ensure())
 */
const { goals } = require('mineflayer-pathfinder');
const {
  sleep, humanDelay, nearestHostile, findPlayerEntity, findEntityByName,
  countItems, equipBestTool, equipBestWeapon, bestFood, resolveBlocks,
  releaseControls, JUNK_ITEMS, randInt, withDrops
} = require('./helpers');

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
function ensure (engine, task, msg = 'task cancelled') {
  if (task.cancelled) throw new Error(msg);
  const bot = engine.bot;
  if (!bot || !bot.entity) throw new Error('bot is offline');
  return bot;
}

function mcDataFor (engine) {
  if (!engine._mcData) engine._mcData = require('minecraft-data')(engine.bot.version);
  return engine._mcData;
}

// ---------------------------------------------------------------------------
// FOLLOW
// ---------------------------------------------------------------------------
async function follow (engine, task) {
  const bot = ensure(engine, task);
  const name = task.args.player;
  engine.brain.log(`👣 Following ${name}...`);

  let target = findPlayerEntity(bot, name);
  if (!target) {
    engine.brain.log(`⏳ Waiting for ${name} to appear...`, 'warn');
    for (let i = 0; i < 60; i++) {
      ensure(engine, task);
      await sleep(500);
      target = findPlayerEntity(bot, name);
      if (target) break;
    }
    if (!target) throw new Error(`player "${name}" is not online`);
  }

  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  let currentEntity = target;
  let lastLog = 0;

  while (!task.cancelled) {
    ensure(engine, task);
    const t = findPlayerEntity(bot, name);

    if (!t) {
      // target left / went out of loaded chunks — wait for them to come back
      bot.pathfinder.setGoal(null);
      engine.brain.log(`⏳ Lost sight of ${name}, waiting...`, 'warn');
      let found = null;
      for (let i = 0; i < 120 && !task.cancelled; i++) {
        await sleep(500);
        found = findPlayerEntity(bot, name);
        if (found) break;
      }
      if (!found) throw new Error(`${name} disappeared`);
      currentEntity = found;
      bot.pathfinder.setGoal(new goals.GoalFollow(found, 2), true);
      continue;
    }

    if (t !== currentEntity) {
      currentEntity = t;
      bot.pathfinder.setGoal(new goals.GoalFollow(t, 2), true);
    }

    const dist = bot.entity.position.distanceTo(t.position);
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      engine.brain.log(`👣 ${name} is ${dist.toFixed(0)}m away`);
    }
    // Far away? sprint.
    try {
      if (dist > 6 && !bot.getControlState('sprint')) bot.setControlState('sprint', true);
      if (dist <= 6) bot.setControlState('sprint', false);
    } catch (e) { /* ignore */ }
    await sleep(600);
  }
  releaseControls(bot);
}

// ---------------------------------------------------------------------------
// COME (follow owner, finish when close)
// ---------------------------------------------------------------------------
async function come (engine, task) {
  const bot = ensure(engine, task);
  const owner = engine.config.mc.owner;
  if (!owner) throw new Error('owner is not set in config.json');
  engine.brain.log(`🏃 Coming to ${owner}...`);

  const deadline = Date.now() + 120 * 1000;
  while (Date.now() < deadline) {
    ensure(engine, task);
    const t = findPlayerEntity(bot, owner);
    if (!t) {
      await sleep(500);
      continue;
    }
    const dist = bot.entity.position.distanceTo(t.position);
    if (dist <= 3) {
      bot.pathfinder.setGoal(null);
      engine.brain.log(`✅ Reached ${owner}`);
      return;
    }
    bot.pathfinder.setGoal(new goals.GoalFollow(t, 2), true);
    await sleep(700);
  }
  throw new Error('could not reach owner in time');
}

// ---------------------------------------------------------------------------
// GOTO
// ---------------------------------------------------------------------------
async function goto (engine, task) {
  const bot = ensure(engine, task);
  const { x, y, z } = task.args;
  const goal = (y === null || y === undefined)
    ? new goals.GoalXZ(x, z)
    : new goals.GoalBlock(x, y, z);
  engine.brain.log(`🧭 Going to (${x}, ${y ?? '~'}, ${z})...`);
  bot.pathfinder.setGoal(goal, false);

  const deadline = Date.now() + 120 * 1000;
  let announced = 0;
  while (Date.now() < deadline) {
    ensure(engine, task);
    const p = bot.entity.position;
    const dist = Math.hypot(p.x - x, p.z - z);
    if (dist < 2.5) { engine.brain.log('✅ Arrived'); return; }
    if (dist > 30 && Date.now() - announced > 20000) {
      announced = Date.now();
      engine.brain.log(`🚶 ${dist.toFixed(0)}m remaining...`);
    }
    await sleep(500);
  }
  throw new Error('took too long to reach destination');
}

// ---------------------------------------------------------------------------
// MINING / GRINDING
// ---------------------------------------------------------------------------
async function freeSpace (engine, bot) {
  if (bot.inventory.emptySlotCount() > 0) return;
  if (!engine.config.behavior.tossJunkWhenFull) throw new Error('inventory full');

  for (const junk of JUNK_ITEMS) {
    const item = bot.inventory.items().find((i) => i.name === junk);
    if (item) {
      try {
        await bot.tossStack(item);
        engine.brain.log(`🗑️ Tossed ${item.name} x${item.count} (inventory full)`);
        await humanDelay(120, 250);
        if (bot.inventory.emptySlotCount() > 0) return;
      } catch (e) { /* ignore */ }
    }
  }
  throw new Error('inventory full and nothing to toss — deposit items first');
}

function findNearestBlock (bot, blockNames, maxDistance) {
  const mcData = require('minecraft-data')(bot.version);
  const ids = new Set();
  for (const name of blockNames) {
    const block = mcData.blocksByName[name];
    if (block) ids.add(block.id);
  }
  let found = null;
  if (ids.size) found = bot.findBlock({ matching: [...ids], maxDistance });
  if (!found) {
    // bulletproof fallback: scan by block NAME (covers version/id quirks)
    const names = new Set(blockNames);
    found = bot.findBlock({ matching: (blk) => blk && names.has(blk.name), maxDistance });
  }
  if (process.env.NOKAR_TRACE && findNearestBlock._n === undefined) findNearestBlock._n = 0;
  if (process.env.NOKAR_TRACE && findNearestBlock._n < 40) {
    findNearestBlock._n++;
    const p = bot.entity.position;
    console.log(`[TRACE findBlock] names=${JSON.stringify(blockNames)} ids=[${[...ids]}] pos=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) -> ${found ? `${found.name}@${found.position}` : 'NULL'}`);
  }
  return found;
}

/**
 * Walk near a position with a hard timeout. pathfinder.stop() emits 'path_stop',
 * which rejects any pending goto() — so this can NEVER wedge like collectBlock did.
 */
async function gotoNear (bot, pos, range, timeout) {
  const { goals } = require('mineflayer-pathfinder');
  const goal = new goals.GoalNear(pos.x, pos.y, pos.z, range);
  let settled = false;
  let err = null;
  const p = bot.pathfinder.goto(goal)
    .then(() => { settled = true; })
    .catch((e) => { settled = true; err = e; });
  const t0 = Date.now();
  while (!settled && Date.now() - t0 < timeout) await sleep(200);
  if (!settled) {
    try { bot.pathfinder.stop(); } catch (e) { /* ignore */ }
    await Promise.race([p, sleep(1500)]);
    err = err || new Error('walk timeout');
  }
  if (err) throw err;
}

/** Small wiggle to free the bot if it's physically wedged (jump + side steps). */
async function unstuck (bot) {
  const { releaseControls } = require('./helpers');
  try { bot.pathfinder.stop(); } catch (e) {}
  releaseControls(bot);
  try {
    bot.setControlState('jump', true);
    await sleep(250);
    bot.setControlState('jump', false);
    for (const d of ['forward', 'left', 'back', 'right']) {
      bot.setControlState(d, true);
      await sleep(350);
      bot.setControlState(d, false);
    }
  } catch (e) { /* ignore */ }
}

/**
 * Collect a single block: walk near → face → dig. Never hangs (all waits bounded).
 * Returns true when the block is gone/taken care of, false when unreachable.
 */
async function collectOne (engine, bot, task, block) {
  const deadline = Date.now();
  try {
    const fresh = bot.blockAt(block.position);
    if (!fresh || fresh.type === 0 || fresh.name !== block.name) return true; // already gone
    const center = block.position.offset(0.5, 0.5, 0.5);
    if (bot.entity.position.distanceTo(center) > 4.4) {
      try { await gotoNear(bot, block.position, 2, 15000); } catch (e) { /* try harder below */ }
    }
    if (bot.entity.position.distanceTo(center) > 4.4) {
      // direct walk fallback (no pathfinder) with a movement check
      for (let i = 0; i < 2; i++) {
        const start = bot.entity.position.clone();
        try { await bot.lookAt(center, true); } catch (e) {}
        try { bot.setControlState('forward', true); } catch (e) {}
        await sleep(900);
        try { bot.setControlState('forward', false); } catch (e) {}
        if (bot.entity.position.distanceTo(start) > 0.3) break; // moved — good
        await unstuck(bot); // didn't move — wiggle and retry
      }
    }
    const b2 = bot.blockAt(block.position);
    if (!b2 || b2.type === 0 || b2.name !== block.name) return true; // gone meanwhile
    if (bot.entity.position.distanceTo(center) > 4.6) throw new Error('cannot reach block (path blocked)');
    try { await bot.lookAt(center, true); } catch (e) {}
    await Promise.race([
      bot.dig(b2, false),
      sleep(12000).then(() => { throw new Error('dig timeout'); })
    ]);
    // walk onto the drop spot — items only get picked up when very close
    try { await gotoNear(bot, block.position, 0, 6000); } catch (e) {
      try { await bot.lookAt(center, true); } catch (e2) {}
      try { bot.setControlState('forward', true); } catch (e2) {}
      await sleep(700);
      try { bot.setControlState('forward', false); } catch (e2) {}
    }
    // chase the item entities that spawned (they can bounce/land a block or two away)
    const chaseUntil = Date.now() + 9000;
    while (Date.now() < chaseUntil) {
      const drops = Object.values(bot.entities)
        .filter((e) => e.name === 'item' && e.position.distanceTo(center) < 8)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
      const drop = drops[0];
      if (!drop) break;
      if (bot.entity.position.distanceTo(drop.position) <= 1.2) { await sleep(250); continue; }
      try { await gotoNear(bot, drop.position, 1, 4000); } catch (e) {
        try { await bot.lookAt(drop.position, true); } catch (e2) {}
        try { bot.setControlState('forward', true); } catch (e2) {}
        await sleep(800);
        try { bot.setControlState('forward', false); } catch (e2) {}
      }
    }
    return true;
  } catch (err) {
    try { bot.stopDigging(); } catch (e) {}
    try { bot.pathfinder.stop(); } catch (e) {}
    return false;
  } finally {
    if (process.env.NOKAR_TRACE) console.log(`[TRACE collectOne] ${block.name}@${block.position} took ${((Date.now() - deadline) / 1000).toFixed(1)}s`);
  }
}

async function wander (bot, radius, task) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const dist = randInt(Math.floor(radius * 0.5), radius);
    const goal = new goals.GoalXZ(Math.round(p.x + Math.cos(angle) * dist), Math.round(p.z + Math.sin(angle) * dist));
    const start = bot.entity.position.clone();
    bot.pathfinder.setGoal(goal, false);
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !task.cancelled) {
      try { if (!bot.pathfinder.isMoving()) break; } catch (e) { break; }
      await sleep(400);
    }
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    // did we actually get anywhere? if not, we're probably wedged
    if (bot.entity.position.distanceTo(start) >= 2 || task.cancelled) return;
    await unstuck(bot);
  }
}

async function grindBlocks (engine, task, blockNames, targetCount, displayName) {
  const bot = ensure(engine, task);
  let got = 0;
  let attempts = 0;
  const countedNames = withDrops(blockNames); // count what the block DROPS (stone → cobblestone)
  const baseline = countItems(bot, countedNames); // fixed baseline — late pickup packets are never missed
  let wasted = 0;
  let warned = 0;
  let lastHeartbeat = 0;
  let failKey = null;
  let failCount = 0;
  if (process.env.NOKAR_TRACE) console.log(`[TRACE grindBlocks] displayName="${displayName}" blockNames=${JSON.stringify(blockNames)} count=${targetCount} args=${JSON.stringify(task.args)}`);

  // Tool requirement check (stone needs a pickaxe, else it drops nothing!)
  try {
    const mcData = require('minecraft-data')(bot.version);
    const info = mcData.blocksByName[blockNames[0]];
    if (info && info.harvestTools) {
      const toolIds = new Set(Object.keys(info.harvestTools).map(Number));
      const hasTool = bot.inventory.items().some((i) => toolIds.has(i.type));
      if (!hasTool) throw new Error(`need the right tool (e.g. pickaxe) to mine ${displayName}`);
    }
  } catch (err) {
    if (/need the right tool/.test(err.message)) throw err;
  }

  while (got < targetCount) {
    ensure(engine, task);
    if (++attempts > 500) throw new Error(`area exhausted after ${attempts} attempts`);
    await freeSpace(engine, bot);
    await equipBestTool(bot, blockNames[0]);

    let block = findNearestBlock(bot, blockNames, 48);

    if (!block) {
      engine.brain.log(`🔍 No ${displayName} nearby — exploring...`, 'warn');
      await sleep(900); // grace: client world data can lag briefly after teleports/joins
      block = findNearestBlock(bot, blockNames, 48);
      if (!block) {
        await wander(bot, 28, task);
        continue;
      }
    }

    if (!engine.brain.isBusy) break; // safety
    if (process.env.NOKAR_TRACE) console.log(`[TRACE grind] attempt#${attempts} ${displayName} target=${block.name}@${block.position} bot@${bot.entity.position.toString()} inv=[${bot.inventory.items().map((i) => i.name).join(',')}]`);
    const posBefore = bot.entity.position.clone();
    const collected = await collectOne(engine, bot, task, block);
    if (task.cancelled) throw new Error('cancelled');
    if (!collected) {
      attempts += 2; // skip unreachable block
      const key = block.position.toString();
      failCount = key === failKey ? failCount + 1 : 1;
      failKey = key;
      if (warned < 3) {
        warned++;
        engine.brain.log(`⚠️ Can't reach ${displayName} at ${block.position} — trying elsewhere`, 'warn');
      }
      // same block unreachable 3× in a row → stop hammering it, go look elsewhere
      if (failCount >= 3) {
        failCount = 0;
        failKey = null;
        await unstuck(bot);
        await wander(bot, 28, task);
        continue;
      }
      // if we haven't moved at all we're probably wedged — wiggle free
      if (attempts > 0 && attempts % 12 === 0 && bot.entity.position.distanceTo(posBefore) < 1.5) {
        engine.brain.log('🪤 Might be stuck — wiggling free...', 'warn');
        await unstuck(bot);
      }
    }
    // periodic heartbeat so long grinds are never silent
    if (attempts - lastHeartbeat >= 20) {
      lastHeartbeat = attempts;
      engine.brain.log(`⏳ Still working on ${displayName} (${got}/${targetCount}, at ${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)})`);
    }

    // Count from the fixed baseline; wait a moment so late pickup packets land
    const dug = (() => {
      try {
        const b = bot.blockAt(block.position);
        return !b || b.name !== block.name;
      } catch (e) { return false; }
    })();
    const deadline = Date.now() + (dug ? 1800 : 400);
    let gotNow = countItems(bot, countedNames) - baseline;
    while (Date.now() < deadline && gotNow <= got && gotNow < targetCount) {
      await sleep(200);
      gotNow = countItems(bot, countedNames) - baseline;
    }
    if (gotNow > got) {
      got = gotNow;
      engine.brain.updateProgress(task, `${got}/${targetCount}`);
      if (got % 8 === 0 || got === targetCount) {
        engine.brain.log(`⛏️ ${displayName}: ${got}/${targetCount}`);
      }
    } else if (dug && wasted++ < 2) {
      engine.brain.log(`⚠️ ${displayName} broke without drop — tool issue? (in hand: ${bot.heldItem ? bot.heldItem.name : 'nothing'})`, 'warn');
    }
    await humanDelay(80, 220);
  }
  engine.brain.log(`⛏️ Grinding done — ${got} ${displayName} in inventory`);
}

async function mine (engine, task) {
  const blocks = resolveBlocks(task.args.block);
  const count = task.args.count || 1;
  return grindBlocks(engine, task, blocks, count, task.args.block);
}

async function chop (engine, task) {
  const { LOG_BLOCKS } = require('./helpers');
  const count = task.args.count || 16;
  return grindBlocks(engine, task, LOG_BLOCKS, count, 'wood');
}

// ---------------------------------------------------------------------------
// COMBAT
// ---------------------------------------------------------------------------
function combatTarget (engine, bot, task) {
  if (task.args.entityId != null) {
    const e = bot.entities[task.args.entityId];
    return e && e.isValid !== false ? e : null;
  }
  if (!task.args.target || task.args.target === 'nearest') {
    return nearestHostile(bot, 24);
  }
  return findEntityByName(bot, task.args.target);
}

/**
 * Human-like melee combat:
 *  - approaches the target, faces it
 *  - strafes left/right with random timing (harder to hit)
 *  - sprints + jump-crits when possible
 *  - disengages at low HP (survival will eat / flee)
 */
async function combatLoop (engine, task, target) {
  const bot = engine.bot;
  const cfg = engine.config.behavior;
  let strafeDir = 'left';
  let lastStrafe = 0;
  let lastAttack = 0;
  const startedAt = Date.now();

  while (!task.cancelled) {
    ensure(engine, task);
    if (!target || !target.isValid || target.isValid === false) {
      engine.brain.log('🏆 Target defeated');
      engine.stats.kills++;
      break;
    }
    if (target.deathTime !== undefined && target.deathTime) { engine.stats.kills++; break; }

    const dist = bot.entity.position.distanceTo(target.position);
    if (dist > 32) throw new Error('target got away');

    // Disengage when badly hurt
    if (bot.health <= cfg.fleeHealth) {
      engine.brain.log('🩸 HP critical — disengaging!', 'warn');
      releaseControls(bot);
      engine.brain.enqueue('flee', { entityId: target.id }, 'flee from ' + (target.name || 'enemy'));
      break;
    }

    // Face the target (aim at chest height)
    try {
      const aim = target.position.offset(0, (target.height || 1.8) * 0.8, 0);
      await bot.lookAt(aim, true);
    } catch (e) { /* ignore */ }

    // Approach if out of reach
    const reach = 3.2;
    try {
      if (dist > reach) {
        bot.setControlState('forward', true);
        bot.setControlState('sprint', dist > 5);
      } else {
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
      }
    } catch (e) { /* ignore */ }

    // Strafe with random timing
    if (Date.now() - lastStrafe > randInt(450, 900)) {
      try {
        bot.setControlState(strafeDir, false);
        strafeDir = strafeDir === 'left' ? 'right' : 'left';
        if (dist < 5) bot.setControlState(strafeDir, true);
      } catch (e) { /* ignore */ }
      lastStrafe = Date.now();
    }

    // Keep the best weapon in hand (auto-eat may swap food in mid-fight)
    if (Date.now() - (combatLoop._weaponCheck || 0) > 2000) {
      combatLoop._weaponCheck = Date.now();
      await equipBestWeapon(bot).catch(() => {});
    }

    // Attack with human-like cadence (Minecraft 1.9+ ~625ms cooldown)
    if (dist <= reach + 0.4 && Date.now() - lastAttack > 620) {
      try {
        if (bot.entity.onGround && Math.random() < 0.4) {
          bot.setControlState('jump', true); // jump-crit
          setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 180);
        }
        bot.attack(target);
        lastAttack = Date.now();
      } catch (e) { /* ignore */ }
    }

    // Give up if the fight drags on forever (e.g. target unreachable)
    if (Date.now() - startedAt > 90 * 1000) throw new Error('combat timeout');

    await sleep(90);
  }

  releaseControls(bot);
}

async function attack (engine, task) {
  const bot = ensure(engine, task);
  const target = combatTarget(engine, bot, task);
  if (!target) throw new Error(`target "${task.args.target || 'nearest'}" not found`);

  await equipBestWeapon(bot); // sword in hand → much faster kills
  const label = target.username || target.name || 'target';
  engine.brain.log(`⚔️ Attacking ${label}...`);
  await combatLoop(engine, task, target);
}

/**
 * FLEE — sprint away from a threat, eat while running if possible.
 */
async function flee (engine, task) {
  const bot = ensure(engine, task);
  const threat = task.args.entityId != null ? bot.entities[task.args.entityId] : nearestHostile(bot, 16);
  if (!threat || !threat.position) {
    engine.brain.log('✅ No threat nearby');
    return;
  }
  const p = bot.entity.position;
  let dx = p.x - threat.position.x;
  let dz = p.z - threat.position.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;
  const goal = new goals.GoalXZ(Math.round(p.x + dx * 24), Math.round(p.z + dz * 24));
  engine.brain.log('🏃 Retreating!');
  bot.pathfinder.setGoal(goal, false);

  const deadline = Date.now() + 25 * 1000;
  while (Date.now() < deadline && !task.cancelled) {
    ensure(engine, task);
    if (bot.food < 18) await eat(engine, { args: {}, cancelled: task.cancelled }).catch(() => {});
    const now = nearestHostile(bot, 8);
    if (!now) break;
    try { if (!bot.pathfinder.isMoving()) break; } catch (e) { break; }
    await sleep(600);
  }
  releaseControls(bot);
}

// ---------------------------------------------------------------------------
// EAT / TOSS / DROPALL
// ---------------------------------------------------------------------------
async function eat (engine, task) {
  const bot = ensure(engine, task);
  if (bot.food >= 20 && bot.health >= 20) return;
  const hurt = bot.health <= 10;
  let food = bestFood(bot, hurt);
  if (!food) {
    // try equipping something edible directly
    engine.brain.log('🍽️ no food in inventory!', 'warn');
    return;
  }
  try {
    await bot.equip(food, 'hand');
    await bot.consume();
    engine.brain.log(`🍗 Ate ${food.name} (food ${bot.food}, hp ${bot.health?.toFixed(0)})`);
  } catch (err) {
    if (!task.cancelled) engine.brain.log(`⚠️ couldn't eat: ${err.message}`, 'warn');
  }
}

async function toss (engine, task) {
  const bot = ensure(engine, task);
  const name = task.args.item;
  const amount = task.args.count || null;
  const items = bot.inventory.items().filter((i) => i.name === name || i.name.includes(name));
  if (!items.length) throw new Error(`no "${name}" in inventory`);
  let left = amount;
  for (const item of items) {
    ensure(engine, task);
    const toToss = left === null ? item.count : Math.min(left, item.count);
    const stack = toToss === item.count ? item : { ...item, count: toToss };
    try {
      if (toToss === item.count && item.count > 0) {
        await bot.tossStack(item);
      } else {
        await bot.toss(item.type, null, toToss);
      }
    } catch (e) { /* ignore */ }
    if (left !== null) {
      left -= toToss;
      if (left <= 0) break;
    }
    await humanDelay(100, 200);
  }
  engine.brain.log(`🗑️ Tossed ${amount === null ? 'all' : amount} x ${name}`);
}

async function dropall (engine, task) {
  const bot = ensure(engine, task);
  engine.brain.log('⚠️ Dropping ENTIRE inventory in 3s — stop me to cancel!', 'warn');
  await sleep(3000);
  for (const item of [...bot.inventory.items()]) {
    ensure(engine, task);
    try { await bot.tossStack(item); } catch (e) { /* ignore */ }
    await humanDelay(90, 160);
  }
  engine.brain.log('🗑️ Inventory emptied');
}

module.exports = {
  follow,
  come,
  goto,
  mine,
  chop,
  attack,
  flee,
  eat,
  toss,
  dropall,
  // internals reused by the goal planner
  grindBlocks,
  findNearestBlock,
  // goal engine (lazy require — avoids a require cycle)
  goal: (engine, task) => require('./goals').goal(engine, task),
  craft: (engine, task) => require('./goals').craft(engine, task),
  smelt: (engine, task) => require('./goals').smelt(engine, task)
};
