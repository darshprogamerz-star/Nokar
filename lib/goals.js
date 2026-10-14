/**
 * NOKAR 2.0 — Goal engine ("sab kuch lao").
 *
 * One planner for ANY item: `goal diamond 3`, `iron lao`, `banao iron_pickaxe`,
 * `goal 64 stick` … It recursively works out the whole chain by itself:
 *   craft → smelt → mine → dig a staircase down, and it always ensures the required
 *   tool tier first (wood → stone → iron → diamond pickaxe …).
 *
 * Live-tested chain (Paper 1.21.4, EMPTY inventory):
 *   goal diamond 1 → chop logs → planks → table → wooden pickaxe → mine stone →
 *   stone pickaxe → furnace → mine coal + iron → smelt iron → iron pickaxe → diamond.
 */
const mcDataOf = require('minecraft-data');
const { countItems, sleep, DROPS, LOG_BLOCKS } = require('./helpers');
const craft = require('./craft');

// lazy — avoids a require cycle (skills.js exposes lazy wrappers for us too)
function S () { return require('./skills'); }

const TIER_ORDER = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
const MAX_DEPTH = 16;

/** Item → where to find it: mineable blocks + the Y level worth digging to. */
const ORE = {
  coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], label: 'coal', y: 48 },
  cobbled_deepslate: { blocks: ['deepslate', 'cobbled_deepslate'], label: 'cobbled deepslate', y: 0 },
  raw_iron: { blocks: ['iron_ore', 'deepslate_iron_ore'], label: 'iron ore', y: 16 },
  raw_copper: { blocks: ['copper_ore', 'deepslate_copper_ore'], label: 'copper ore', y: 48 },
  raw_gold: { blocks: ['gold_ore', 'deepslate_gold_ore'], label: 'gold ore', y: -16 },
  redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], label: 'redstone', y: -59 },
  diamond: { blocks: ['diamond_ore', 'deepslate_diamond_ore'], label: 'diamond', y: -59 },
  lapis_lazuli: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], label: 'lapis', y: -20 },
  emerald: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], label: 'emerald', y: null },
  cobblestone: { blocks: ['stone'], label: 'cobblestone', y: null },
  obsidian: { blocks: ['obsidian'], label: 'obsidian', y: null },
  dirt: { blocks: ['dirt', 'grass_block'], label: 'dirt', y: null },
  sand: { blocks: ['sand'], label: 'sand', y: null },
  gravel: { blocks: ['gravel'], label: 'gravel', y: null },
  quartz: { blocks: ['nether_quartz_ore'], label: 'quartz', y: null, nether: true },
  ancient_debris: { blocks: ['ancient_debris'], label: 'ancient debris', y: null, nether: true },
  glowstone: { blocks: ['glowstone'], label: 'glowstone', y: null, nether: true }
};
for (const log of LOG_BLOCKS) ORE[log] = { blocks: [log], label: log, y: null };

const ITEM_ALIASES = {
  iron: 'iron_ingot', steel: 'iron_ingot',
  gold: 'gold_ingot',
  copper: 'copper_ingot',
  netherite: 'netherite_ingot',
  lapis: 'lapis_lazuli',
  stone: 'cobblestone',
  wood: 'WOOD', logs: 'WOOD', log: 'WOOD', lakdi: 'WOOD',
  beef: 'cooked_beef', steak: 'cooked_beef',
  redstone_dust: 'redstone', emeralds: 'emerald', diamonds: 'diamond',
  cobble: 'cobblestone', planks: 'oak_planks'
};

const MOB_DROPS = new Set([
  'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon',
  'leather', 'feather', 'string', 'gunpowder', 'bone', 'bone_meal',
  'rotten_flesh', 'spider_eye', 'ender_pearl', 'slime_ball', 'blaze_rod',
  'magma_cream', 'ghast_tear', 'ink_sac', 'prismarine_shard', 'phantom_membrane'
]);

function ensureBot (engine) {
  const bot = engine.bot;
  if (!bot || !bot.entity) throw new Error('bot is offline');
  return bot;
}
function ensure (task) { if (task && task.cancelled) throw new Error('cancelled'); }

// deepslate is a *substitute* for cobblestone in stone-tool recipes — keeping it out
// of the default preference set makes the planner pick the plain cobblestone variants.
const PREFER_EXCLUDE = new Set(['cobbled_deepslate']);
function defaultPrefer () {
  return new Set([...Object.keys(ORE), ...LOG_BLOCKS].filter((k) => !PREFER_EXCLUDE.has(k)));
}

/** User text → { name } single item | { multi } any-of group. */
function resolveGoalInput (bot, raw) {
  const mcData = mcDataOf(bot.version);
  if (!raw) return null;
  let t = String(raw).toLowerCase().trim().replace(/\s+/g, '_');
  if (!t) return null;
  let alias = ITEM_ALIASES[t];
  if (!alias && t.endsWith('s')) alias = ITEM_ALIASES[t.slice(0, -1)];
  if (alias === 'WOOD') return { multi: LOG_BLOCKS.filter((n) => mcData.blocksByName[n]), label: 'wood' };
  if (alias) t = alias;
  if (mcData.itemsByName[t]) return { name: t, label: mcData.itemsByName[t].displayName || t };
  // block name → the item it drops / the target it belongs to
  if (mcData.blocksByName[t]) {
    const entry = Object.entries(ORE).find(([, v]) => v.blocks.includes(t));
    if (entry) return { name: entry[0], label: entry[1].label };
    if (DROPS[t]) return { name: DROPS[t], label: DROPS[t] };
    return { name: t, label: t };
  }
  return { name: t, label: t };
}

/** Lowest pickaxe tier that can actually harvest any of these blocks (data-driven, via harvestTools). */
function tierForBlocks (mcData, blockNames) {
  let idx = -1;
  for (const b of blockNames) {
    const info = mcData.blocksByName[b];
    if (!info || !info.harvestTools) continue;
    const names = Object.keys(info.harvestTools).map((id) => mcData.items[Number(id)] && mcData.items[Number(id)].name).filter(Boolean);
    const tiers = names.filter((n) => n.endsWith('_pickaxe'))
      .map((n) => n.replace('_pickaxe', ''))
      .map((t) => (t === 'golden' ? 1 : TIER_ORDER.indexOf(t)))
      .filter((i) => i >= 0);
    if (!tiers.length) continue;
    idx = Math.max(idx, Math.min(...tiers));
  }
  return idx >= 0 ? TIER_ORDER[idx] : null;
}

// ---------------------------------------------------------------------------
// staircase descent (used when an ore is far below us)
// ---------------------------------------------------------------------------
async function digAt (bot, pos) {
  const b = bot.blockAt(pos);
  if (!b) return false;
  if (b.name === 'air' || b.name === 'cave_air') return true;
  if (['bedrock', 'lava', 'flowing_lava', 'water', 'flowing_water'].includes(b.name)) return false;
  try {
    await Promise.race([bot.dig(b, false), sleep(7000).then(() => { throw new Error('dig timeout'); })]);
    return true;
  } catch (e) { return false; }
}

async function descendToY (engine, bot, task, targetY) {
  const { goals } = require('mineflayer-pathfinder');
  engine.brain.log(`⛏️ Ore's deep — digging a staircase down to Y=${targetY}...`);
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let di = 0;
  let steps = 0;
  let stuck = 0;
  const hazard = (b) => !b || ['lava', 'flowing_lava', 'water', 'flowing_water'].includes(b.name);

  while (bot.entity.position.y > targetY) {
    ensure(task);
    if (++steps > 400) throw new Error('staircase descent took too long');
    if (stuck > 12) throw new Error('cannot find a safe way down (lava / bedrock)');
    const yBefore = bot.entity.position.y;
    const feet = bot.entity.position.floored();
    const [dx, dz] = dirs[di % 4];
    const ahead = feet.offset(dx, 0, dz);
    const aheadHead = ahead.offset(0, 1, 0);
    const aheadFloor = ahead.offset(0, -1, 0);
    if (hazard(bot.blockAt(ahead)) || hazard(bot.blockAt(aheadHead)) || hazard(bot.blockAt(aheadFloor))) { di++; stuck++; continue; }
    await digAt(bot, ahead);
    await digAt(bot, aheadHead);
    const a = bot.blockAt(ahead);
    const aH = bot.blockAt(aheadHead);
    if ((a && !['air', 'cave_air'].includes(a.name)) || (aH && !['air', 'cave_air'].includes(aH.name))) { di++; stuck++; continue; }
    // step into the cleared cell (pathfinder first, direct walk as fallback)
    try { bot.pathfinder.setGoal(new goals.GoalBlock(ahead.x, ahead.y, ahead.z)); } catch (e) {}
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && bot.entity.position.distanceTo(ahead.offset(0.5, 0, 0.5)) > 1.3) {
      await sleep(200);
      if (task && task.cancelled) break;
    }
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    if (bot.entity.position.distanceTo(ahead.offset(0.5, 0, 0.5)) > 1.3) {
      try { await bot.lookAt(bot.entity.position.offset(dx, 0.5, dz), true); } catch (e) {}
      try { bot.setControlState('forward', true); } catch (e) {}
      await sleep(700);
      try { bot.setControlState('forward', false); } catch (e) {}
    }
    // dig one down and fall to the next step
    const down = bot.entity.position.floored().offset(0, -1, 0);
    await digAt(bot, down);
    await sleep(700);
    if (bot.entity.position.y < yBefore - 0.5) { stuck = 0; } else { stuck++; di++; }
    if (steps % 5 === 0) di++; // drift the staircase so it doesn't tunnel in one endless line
    if (task) engine.brain.updateProgress(task, `digging down (Y=${bot.entity.position.y.toFixed(0)})`);
  }
  engine.brain.log(`⛏️ Reached Y=${bot.entity.position.y.toFixed(0)}`);
}

// ---------------------------------------------------------------------------
// planner core
// ---------------------------------------------------------------------------
async function ensurePickaxe (engine, bot, task, tier, depth, ctx) {
  const needIdx = TIER_ORDER.indexOf(tier);
  const ok = bot.inventory.items()
    .filter((i) => i.name.endsWith('_pickaxe'))
    .map((i) => { const t = i.name.replace('_pickaxe', ''); return t === 'golden' ? 1 : TIER_ORDER.indexOf(t); })
    .some((i) => i >= needIdx);
  if (ok) return;
  engine.brain.log(`🛠️ Need a ${tier} pickaxe — making one`);
  await ensureItem(engine, bot, task, `${tier}_pickaxe`, 1, depth + 1, ctx);
}

async function ensureFuel (engine, bot, task, units, depth, ctx) {
  if (craft.fuelUnitsAvailable(bot) >= units + 1) return;
  engine.brain.log('🪵 Need fuel — getting coal');
  await ensureItem(engine, bot, task, 'coal', Math.max(1, Math.ceil((units + 1) / 8)), depth + 1, ctx);
}

async function acquireByMining (engine, bot, task, name, missing, depth, ctx, overrideBlocks) {
  const mcData = mcDataOf(bot.version);
  const spec = ORE[name] || { blocks: overrideBlocks || [name], label: name };
  const blocks = spec.blocks.filter((b) => mcData.blocksByName[b]);
  if (!blocks.length) throw new Error(`no blocks known for ${name}`);
  if (spec.nether && !String(bot.game.dimension).includes('nether')) throw new Error(`${spec.label} only exists in the Nether (no nether access here)`);
  const tier = tierForBlocks(mcData, blocks);
  if (tier) await ensurePickaxe(engine, bot, task, tier, depth, ctx);
  if (spec.y != null && bot.entity.position.y > spec.y + 4) {
    const visible = S().findNearestBlock(bot, blocks, 48);
    if (!visible) await descendToY(engine, bot, task, spec.y);
  }
  engine.brain.log(`⛏️ Mining ${missing}× ${spec.label}...`);
  await S().grindBlocks(engine, task, blocks, missing, spec.label);
}

async function acquireByCrafting (engine, bot, task, name, missing, recipe, depth, ctx) {
  const mcData = mcDataOf(bot.version);
  const per = recipe.result.count || 1;
  const crafts = Math.ceil(missing / per);
  const ings = craft.ingredientList(recipe);
  const needs = ings.map((ing) => {
    const nm = mcData.items[ing.id] ? mcData.items[ing.id].name : null;
    if (!nm) throw new Error('unknown ingredient in recipe for ' + name);
    return { name: nm, count: ing.count * crafts };
  });
  engine.brain.log(`🔨 ${name}: needs ${needs.map((n) => `${n.count}× ${n.name}`).join(', ')}`);
  for (const n of needs) ctx.prefer.add(n.name);
  if (recipe.requiresTable) {
    const hasTable = craft.findPlaced(bot, 'crafting_table') || countItems(bot, ['crafting_table']) > 0;
    if (!hasTable) await ensureItem(engine, bot, task, 'crafting_table', 1, depth + 1, ctx);
  }
  // Ingredients can share resources (e.g. sticks eat planks needed by the pickaxe head),
  // so re-check after each pass and top up whatever fell short.
  for (let pass = 0; pass < 3; pass++) {
    const deficits = needs.filter((n) => countItems(bot, [n.name]) < n.count);
    if (!deficits.length) break;
    for (const d of deficits) await ensureItem(engine, bot, task, d.name, d.count, depth + 1, ctx);
  }
  await craft.craftItem(engine, bot, task, name, missing, { recipe, prefer: ctx.prefer });
}

async function acquire (engine, bot, task, name, missing, depth, ctx) {
  const mcData = mcDataOf(bot.version);
  // 1) smelting
  const src = craft.smeltInputName(bot, name);
  if (src) {
    engine.brain.log(`♨️ ${name} = smelted ${src}`);
    await ensureItem(engine, bot, task, src, missing, depth + 1, ctx);
    await ensureFuel(engine, bot, task, missing, depth, ctx);
    const hasFurnace = craft.findPlaced(bot, 'furnace') || countItems(bot, ['furnace']) > 0;
    if (!hasFurnace) await ensureItem(engine, bot, task, 'furnace', 1, depth + 1, ctx);
    await craft.smeltItem(engine, bot, task, name, missing);
    return;
  }
  // 2) mining (known ores / blocks)
  if (ORE[name]) { await acquireByMining(engine, bot, task, name, missing, depth, ctx); return; }
  // 3) crafting
  const recipe = craft.pickRecipe(bot, name, ctx.prefer);
  if (recipe) { await acquireByCrafting(engine, bot, task, name, missing, recipe, depth, ctx); return; }
  // 4) a block with this exact name → mine it
  if (mcData.blocksByName[name]) { await acquireByMining(engine, bot, task, name, missing, depth, ctx, [name]); return; }
  // 5) explain politely
  if (MOB_DROPS.has(name)) throw new Error(`${name} is a mob drop — hunting isn't supported yet (hunt it and give me one, I'll do the rest)`);
  throw new Error(`I don't know how to get "${name}" yet (farming/other sources not supported)`);
}

async function ensureItem (engine, bot, task, name, need, depth, ctx) {
  if (depth > MAX_DEPTH) throw new Error('plan too deep — missing something very basic');
  ensure(task);
  const have = countItems(bot, [name]);
  if (have >= need) return have;
  const missing = need - have;
  engine.brain.log(`📋 Need ${missing} more ${name} (have ${have}/${need})`);
  await acquire(engine, bot, task, name, missing, depth, ctx);
  const after = countItems(bot, [name]);
  if (after < need) throw new Error(`could not get enough ${name} (${after}/${need})`);
  return after;
}

async function ensureMulti (engine, bot, task, names, need, ctx) {
  const have = () => names.reduce((a, n) => a + countItems(bot, [n]), 0);
  if (have() >= need) return;
  const missing = need - have();
  const pick = names.find((n) => countItems(bot, [n]) > 0) || names[0];
  engine.brain.log(`📋 Need ${missing} more wood (any log type)`);
  await acquireByMining(engine, bot, task, pick, missing, 0, ctx);
  if (have() < need) throw new Error(`could not get enough wood (${have()}/${need})`);
}

// ---------------------------------------------------------------------------
// public skills
// ---------------------------------------------------------------------------
async function goal (engine, task) {
  const bot = ensureBot(engine);
  const spec = resolveGoalInput(bot, task.args.item);
  if (!spec) throw new Error('what should I get? e.g. "goal diamond 3"');
  const count = Math.max(1, parseInt(task.args.count || 1, 10) || 1);
  // prefer = everything we already know how to reach → recipe variants that use
  // cobblestone beat cobbled_deepslate, coal beats charcoal, oak beats pale oak, …
  const ctx = { prefer: defaultPrefer() };
  if (spec.multi) {
    engine.brain.log(`🎯 Goal: ${count}× wood (any log) — planning...`);
    await ensureMulti(engine, bot, task, spec.multi, count, ctx);
  } else {
    engine.brain.log(`🎯 Goal: ${count}× ${spec.label || spec.name} — planning...`);
    await ensureItem(engine, bot, task, spec.name, count, 0, ctx);
  }
  const got = spec.multi ? spec.multi.reduce((a, n) => a + countItems(bot, [n]), 0) : countItems(bot, [spec.name]);
  engine.brain.log(`🏁 Goal complete: ${got}× ${spec.label || spec.name} in inventory`);
}

async function runDirect (engine, task, kind) {
  const bot = ensureBot(engine);
  const spec = resolveGoalInput(bot, task.args.item);
  if (!spec || !spec.name) throw new Error(`what should I ${kind}? e.g. "${kind} stick 8"`);
  const count = Math.max(1, parseInt(task.args.count || 1, 10) || 1);
  if (kind === 'smelt' && !craft.smeltInputName(bot, spec.name)) throw new Error(`${spec.name} is not smeltable`);
  const ctx = { prefer: defaultPrefer() };
  engine.brain.log(kind === 'craft' ? `🔨 Make ${count}× ${spec.name}` : `♨️ Smelt ${count}× ${spec.name}`);
  await ensureItem(engine, bot, task, spec.name, count, 0, ctx);
}

const craftSkill = (engine, task) => runDirect(engine, task, 'craft');
const smeltSkill = (engine, task) => runDirect(engine, task, 'smelt');

module.exports = {
  goal,
  craft: craftSkill,
  smelt: smeltSkill,
  resolveGoalInput,
  tierForBlocks,
  descendToY,
  ORE
};
