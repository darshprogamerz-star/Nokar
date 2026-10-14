/**
 * NOKAR 2.0 — Survival: always-on reflexes.
 * Auto-eat, creeper/lava avoidance, low-HP management, guard mode polling.
 * These run every tick-ish interval and never block the task queue.
 */
const {
  nearestHostile, bestFood, classifyEntity, releaseControls, sleep
} = require('./helpers');

const CREEPER_FLEE_RANGE = 6;
const LAVA_CHECK_MS = 900;
const EAT_CHECK_MS = 2500;
const GUARD_CHECK_MS = 1200;

function lavaNear (bot) {
  try {
    const p = bot.entity.position.floored();
    const positions = [
      p.offset(0, -1, 0), p.offset(0, 0, 0),
      p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1), p.offset(0, 0, -1)
    ];
    for (const pos of positions) {
      const b = bot.blockAt(pos);
      if (b && (b.name === 'lava' || b.name === 'fire' || b.name === 'flowing_lava')) return b;
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function avoidLava (engine) {
  const bot = engine.bot;
  if (!bot || !bot.entity || !bot.entity.position) return;
  if (engine._lavaCooldown && Date.now() < engine._lavaCooldown) return;
  const lava = lavaNear(bot);
  if (!lava) return;
  engine._lavaCooldown = Date.now() + 5000;
  engine.brain.log('🌋 Lava under me — moving away!', 'warn');
  const p = bot.entity.position;
  const dx = p.x - lava.position.x || (Math.random() > 0.5 ? 1 : -1);
  const dz = p.z - lava.position.z || (Math.random() > 0.5 ? 1 : -1);
  const len = Math.hypot(dx, dz) || 1;
  try {
    const { goals } = require('mineflayer-pathfinder');
    bot.pathfinder.setGoal(new goals.GoalXZ(Math.round(p.x + (dx / len) * 12), Math.round(p.z + (dz / len) * 12)), false);
  } catch (e) { /* ignore */ }
}

async function avoidCreepers (engine) {
  const bot = engine.bot;
  if (!bot || !bot.entity) return;
  if (engine.brain.current && (engine.brain.current.type === 'attack' || engine.brain.current.type === 'flee')) return;
  if (engine._creeperCooldown && Date.now() < engine._creeperCooldown) return;

  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity || !entity.position) continue;
    if (entity.name !== 'creeper') continue;
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist <= CREEPER_FLEE_RANGE) {
      engine._creeperCooldown = Date.now() + 8000;
      engine.brain.log('💥 Creeper nearby — backing off!', 'warn');
      engine.brain.enqueue('flee', { entityId: entity.id }, 'flee from creeper');
      return;
    }
  }
}

async function autoEat (engine) {
  const bot = engine.bot;
  if (!bot || !bot.entity || engine._eating || engine._eatCooldown > Date.now()) return;
  if (bot.food === undefined) return;
  if (bot.targetDigBlock) return; // never swap food into hand mid-dig — the block would drop nothing
  if (bot.currentWindow && bot.currentWindow !== bot.inventory) return; // mid-craft/smelt: don't touch the inventory

  const cfg = engine.config.behavior;
  const hurt = bot.health <= 10;
  const threshold = hurt ? cfg.critEatAt : cfg.autoEatAt;
  if (bot.food > threshold && !(hurt && bot.food < 20)) return;
  if (bot.food >= 20 && bot.health >= 20) return;

  const food = bestFood(bot, hurt);
  if (!food) return;

  engine._eating = true;
  try {
    await bot.equip(food, 'hand').catch(() => {});
    await bot.consume().catch(() => {});
    engine.brain.log(`🍗 Auto-eat: ${food.name} (food ${bot.food}, hp ${Math.round(bot.health)})`);
  } catch (e) { /* ignore */ }
  finally {
    engine._eating = false;
    engine._eatCooldown = Date.now() + 3000;
  }
}

async function lowHpWatch (engine) {
  const bot = engine.bot;
  if (!bot || !bot.entity || !bot.health) return;
  const cfg = engine.config.behavior;
  if (bot.health > cfg.fleeHealth) return;
  const threat = nearestHostile(bot, 10);
  const busyFighting = engine.brain.current && engine.brain.current.type === 'attack';
  if ((threat || busyFighting) && !engine._lowHpHandled) {
    engine._lowHpHandled = Date.now() + 15000;
    engine.brain.log('🚨 Low HP!', 'warn');
    if (busyFighting) {
      engine.brain.stopAll('low HP');
      await sleep(150);
    }
    if (threat) engine.brain.enqueue('flee', { entityId: threat.id }, 'flee (low hp)');
    engine.brain.enqueue('eat', {}, 'emergency eat');
  }
  if (Date.now() > (engine._lowHpHandled || 0)) engine._lowHpHandled = 0;
}

async function guardWatch (engine) {
  const bot = engine.bot;
  if (!bot || !bot.entity) return;
  if (!engine.brain.guard) return;
  if (engine.brain.current) return;
  if (engine._guardCooldown > Date.now()) return;

  const threat = nearestHostile(bot, engine.config.behavior.guardRange);
  if (threat) {
    engine._guardCooldown = Date.now() + 4000;
    engine.brain.log(`🛡️ Guard engaging ${threat.name}`, 'warn');
    engine.brain.enqueue('attack', { entityId: threat.id }, `guard: ${threat.name}`);
  }
}

// ---------------------------------------------------------------------------
// Attach all reflex loops to a live bot
// ---------------------------------------------------------------------------
function attachSurvival (engine) {
  detachSurvival(engine);
  const bot = engine.bot;
  if (!bot) return;

  engine._timers = {
    eat: setInterval(() => autoEat(engine).catch(() => {}), EAT_CHECK_MS),
    guard: setInterval(() => guardWatch(engine).catch(() => {}), GUARD_CHECK_MS),
    lava: setInterval(() => avoidLava(engine).catch(() => {}), LAVA_CHECK_MS),
    creeper: setInterval(() => avoidCreepers(engine).catch(() => {}), 700),
    hp: setInterval(() => lowHpWatch(engine).catch(() => {}), 1500)
  };

  // When a player damages someone near the bot while guard is on → retaliate
  bot.on('entityHurt', (entity) => {
    if (!engine.brain.guard || engine.brain.current) return;
    try {
      if (entity && entity.type === 'player' && entity.username !== bot.username) {
        const attacker = nearestHostile(bot, 6);
        if (attacker) engine.brain.enqueue('attack', { entityId: attacker.id }, `defend ${entity.username}`);
      } else if (entity === bot.entity) {
        const attacker = nearestHostile(bot, 6);
        if (attacker) engine.brain.enqueue('attack', { entityId: attacker.id }, `fight back: ${attacker.name}`);
      }
    } catch (e) { /* ignore */ }
  });
}

function detachSurvival (engine) {
  if (engine._timers) {
    for (const id of Object.values(engine._timers)) clearInterval(id);
    engine._timers = null;
  }
}

module.exports = { attachSurvival, detachSurvival };
