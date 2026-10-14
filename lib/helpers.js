/**
 * NOKAR 2.0 — Shared helpers (human-like timing, entity utils, tools, food)
 */

// ---------------------------------------------------------------------------
// Timing — human-like random delays so movement does not look robotic
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const humanDelay = (min = 120, max = 420) => sleep(min + Math.floor(Math.random() * (max - min)));
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// ---------------------------------------------------------------------------
// Entity classification
// ---------------------------------------------------------------------------
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'creeper',
  'drowned', 'husk', 'witch', 'phantom', 'blaze', 'ghast', 'magma_cube',
  'slime', 'pillager', 'vindicator', 'evoker', 'ravager', 'guardian',
  'elder_guardian', 'shulker', 'silverfish', 'endermite', 'vex', 'illusioner',
  'warden', 'breeze', 'zoglin', 'hoglin', 'piglin_brute', 'wither_skeleton',
  'ender_dragon', 'wither', 'enderman', 'piglin', 'zombified_piglin'
]);

const ANIMALS = new Set([
  'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'mule',
  'llama', 'wolf', 'cat', 'ocelot', 'parrot', 'fox', 'bee', 'goat', 'frog',
  'camel', 'axolotl', 'turtle', 'panda', 'polar_bear', 'mooshroom', 'villager',
  'wandering_trader', 'iron_golem', 'snow_golem', 'squid', 'dolphin', 'cod',
  'salmon', 'tropical_fish', 'pufferfish', 'bat', 'allay', 'sniffer', 'armadillo'
]);

function classifyEntity (entity) {
  if (!entity || !entity.name) return 'other';
  if (entity.type === 'player') return 'player';
  if (HOSTILE_MOBS.has(entity.name)) return 'hostile';
  if (ANIMALS.has(entity.name)) return 'animal';
  return 'other';
}

/** Nearest hostile mob within `range` blocks. */
function nearestHostile (bot, range = 16, filter) {
  let best = null;
  let bestDist = Infinity;
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity || !entity.position) continue;
    if (classifyEntity(entity) !== 'hostile') continue;
    if (filter && !filter(entity)) continue;
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist <= range && dist < bestDist) {
      best = entity;
      bestDist = dist;
    }
  }
  return best;
}

/** Find another player's entity by (partial, case-insensitive) name. */
function findPlayerEntity (bot, name) {
  if (!name) return null;
  const needle = String(name).toLowerCase();
  let exact = null;
  let partial = null;
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity.type !== 'player' || !entity.username) continue;
    if (entity.username.toLowerCase() === needle) { exact = entity; break; }
    if (!partial && entity.username.toLowerCase().includes(needle)) partial = entity;
  }
  return exact || partial;
}

/** Find any entity (player or mob) by name / mob type. */
function findEntityByName (bot, name) {
  const player = findPlayerEntity(bot, name);
  if (player) return player;
  const needle = String(name).toLowerCase();
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity || !entity.position) continue;
    if (entity.name && entity.name.toLowerCase().includes(needle)) return entity;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inventory utils
// ---------------------------------------------------------------------------
/**
 * Bedrock players (Geyser/Floodgate) often show up as ".DARSHPROGAMERZL" or
 * "*Name" on Java servers. Strip any leading junk so the owner check still matches.
 */
function normalizeOwner (name) {
  return String(name || '').toLowerCase().trim().replace(/^[^a-z0-9_]+/i, '').replace(/\s+/g, '');
}

function countItems (bot, names) {
  const set = names instanceof Set ? names : new Set(names);
  let total = 0;
  for (const item of bot.inventory.items()) {
    if (set.has(item.name)) total += item.count;
  }
  return total;
}

function findItem (bot, predicate) {
  return bot.inventory.items().find(predicate) || null;
}

const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'wooden', 'golden'];

/** Equip the best available tool for a block (pickaxe / axe / shovel). */
async function equipBestTool (bot, blockName) {
  const kind =
    /(ore|stone|deepslate|cobble|obsidian|granite|diorite|andesite|netherrack|blackstone|basalt|tuff|calcite|amethyst|furnace|anvil|brick|concrete|sandstone|terracotta|prismarine|quartz|purpur|magma)/.test(blockName) ? 'pickaxe'
      : /(log|wood|plank|chest|barrel|crafting_table|bookshelf|door|fence|sign|pumpkin|melon|beehive|lectern)/.test(blockName) ? 'axe'
        : /(dirt|grass|sand|gravel|clay|soul_sand|soul_soil|podzol|mycelium|snow)/.test(blockName) ? 'shovel'
          : null;
  if (!kind) return null;

  for (const tier of TOOL_TIERS) {
    const item = findItem(bot, (i) => i.name === `${tier}_${kind}`);
    if (item) {
      try { await bot.equip(item, 'hand'); } catch (e) { /* ignore */ }
      return item;
    }
  }
  return null;
}

/** Pick the best food to eat right now. Prefers golden apples when hurt. */
function bestFood (bot, hurt = false) {
  const foods = bot.inventory.items().filter((i) => i.foodPoints || /(apple|bread|carrot|cooked|beef|pork|mutton|chicken|potato|berries|melon|stew|soup)/.test(i.name));
  if (!foods.length) return null;
  if (hurt) {
    const gapple = foods.find((i) => i.name === 'enchanted_golden_apple') || foods.find((i) => i.name === 'golden_apple');
    if (gapple) return gapple;
  }
  // Prefer cooked / highest food points
  let best = null;
  let bestScore = -1;
  for (const f of foods) {
    const points = f.foodPoints || 2;
    const cookedBonus = /cooked|golden|stew|soup/.test(f.name) ? 2 : 0;
    const score = points * 2 + cookedBonus;
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Block / mining aliases
// ---------------------------------------------------------------------------
const LOG_BLOCKS = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
  'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
  'stripped_oak_log', 'stripped_birch_log', 'stripped_spruce_log',
  'crimson_stem', 'warped_stem'
];

const MINE_ALIASES = {
  iron: ['iron_ore', 'deepslate_iron_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  copper: ['copper_ore', 'deepslate_copper_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  lapis: ['lapis_ore', 'deepslate_lapis_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  quartz: ['nether_quartz_ore'],
  ancient_debris: ['ancient_debris'],
  stone: ['stone'],
  cobble: ['cobblestone'],
  cobblestone: ['cobblestone'],
  dirt: ['dirt', 'grass_block'],
  gravel: ['gravel'],
  sand: ['sand'],
  obsidian: ['obsidian'],
  glowstone: ['glowstone'],
  wood: LOG_BLOCKS,
  log: LOG_BLOCKS,
  tree: LOG_BLOCKS
};

/** Resolve a user-typed block alias to a list of block names. */
function resolveBlocks (input) {
  const key = String(input || '').toLowerCase().trim().replace(/ /g, '_');
  if (MINE_ALIASES[key]) return MINE_ALIASES[key];
  return [key];
}

/** Block name → the item it actually drops when mined (for progress counting). */
const DROPS = {
  stone: 'cobblestone',
  deepslate: 'cobbled_deepslate',
  grass_block: 'dirt',
  iron_ore: 'raw_iron',
  deepslate_iron_ore: 'raw_iron',
  gold_ore: 'raw_gold',
  deepslate_gold_ore: 'raw_gold',
  nether_gold_ore: 'gold_nugget',
  copper_ore: 'raw_copper',
  deepslate_copper_ore: 'raw_copper',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  nether_quartz_ore: 'quartz'
};

/** Expand a list of block names with their drop items. */
function withDrops (blockNames) {
  const set = new Set(blockNames);
  for (const name of blockNames) {
    if (DROPS[name]) set.add(DROPS[name]);
  }
  return [...set];
}

const WEAPON_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

/** Equip the best sword (or axe) available. */
async function equipBestWeapon (bot) {
  for (const tier of WEAPON_TIERS) {
    const sword = bot.inventory.items().find((i) => i.name === `${tier}_sword`);
    if (sword) { await bot.equip(sword, 'hand').catch(() => {}); return sword; }
  }
  for (const tier of WEAPON_TIERS) {
    const axe = bot.inventory.items().find((i) => i.name === `${tier}_axe`);
    if (axe) { await bot.equip(axe, 'hand').catch(() => {}); return axe; }
  }
  return null;
}

const JUNK_ITEMS = new Set([
  'dirt', 'gravel', 'flint', 'leaves', 'oak_leaves', 'birch_leaves',
  'spruce_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves',
  'oak_sapling', 'birch_sapling', 'spruce_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'short_grass', 'grass',
  'wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds',
  'rotten_flesh', 'feather', 'poppy', 'dandelion', 'stick'
]);

/** Clear control states + stop pathfinder safely. */
function releaseControls (bot) {
  if (!bot) return;
  try {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      bot.setControlState(c, false);
    }
  } catch (e) { /* ignore */ }
}

module.exports = {
  sleep,
  humanDelay,
  randInt,
  HOSTILE_MOBS,
  ANIMALS,
  LOG_BLOCKS,
  JUNK_ITEMS,
  DROPS,
  withDrops,
  classifyEntity,
  nearestHostile,
  findPlayerEntity,
  findEntityByName,
  countItems,
  normalizeOwner,
  findItem,
  equipBestTool,
  equipBestWeapon,
  bestFood,
  resolveBlocks,
  releaseControls
};
