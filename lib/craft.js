/**
 * NOKAR 2.0 — Crafting & Smelting.
 *
 * Both are implemented with verification-first logic, live-tested on Paper 1.21.4:
 *  - Crafting uses explicit window clicks (pick stack → right-click 1 into grid →
 *    put the rest back → take result → deposit). mineflayer's bot.craft() proved
 *    flaky on this stack (crafted items occasionally vanished), so we do it manually
 *    with per-click pacing (also nicely human-like for anticheat).
 *  - Smelting uses mineflayer's furnace API + output polling + verification.
 */
const { sleep, humanDelay, countItems } = require('./helpers');
const { Vec3 } = require('vec3');
const mcDataOf = require('minecraft-data');

const CLICK_LO = 220;
const CLICK_HI = 400;

// target item → what you smelt to get it (1:1). Meat names are resolved at runtime (1.21.x renames).
const SMELT_SOURCES = {
  iron_ingot: 'raw_iron',
  gold_ingot: 'raw_gold',
  copper_ingot: 'raw_copper',
  cooked_beef: 'beef',
  cooked_chicken: 'chicken',
  cooked_porkchop: 'porkchop',
  cooked_mutton: 'mutton',
  cooked_rabbit: 'rabbit',
  cooked_cod: 'cod',
  cooked_salmon: 'salmon',
  glass: 'sand',
  brick: 'clay_ball',
  stone: 'cobblestone',
  smooth_stone: 'stone',
  nether_brick: 'netherrack',
  dried_kelp: 'kelp',
  green_dye: 'cactus',
  charcoal: 'LOG'
};

const FUELS = [['coal', 8], ['charcoal', 8], ['coal_block', 80], ['blaze_rod', 12], ['dried_kelp_block', 20], ['stick', 0.5]];

function dataOf (bot) { return mcDataOf(bot.version); }
function ensure (task) { if (task && task.cancelled) throw new Error('cancelled'); }

// ---------------------------------------------------------------------------
// windows / low-level clicks
// ---------------------------------------------------------------------------
async function click (bot, slot, button = 0, mode = 0) {
  ensure(null);
  await bot.clickWindow(slot, button, mode);
  await humanDelay(CLICK_LO, CLICK_HI);
}

/** Pick `n` of itemId from the inventory and place exactly `n` into crafting-grid `destSlot`; put the rest back. */
async function placeOneAt (bot, win, itemId, destSlot, n = 1) {
  const src = win.findInventoryItem(itemId, null);
  if (!src) {
    const nm = dataOf(bot).items[itemId] ? dataOf(bot).items[itemId].name : itemId;
    throw new Error(`missing ingredient: ${nm}`);
  }
  await click(bot, src.slot, 0, 0);              // pick up whole stack
  for (let i = 0; i < n; i++) await click(bot, destSlot, 1, 0); // right-click = place one
  await click(bot, src.slot, 0, 0);              // return the rest
}

/** Wait until the crafting result slot is populated by the server. */
async function waitResult (bot, win, timeout = 3500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (win.slots[0]) return win.slots[0];
    await sleep(150);
  }
  return null;
}

/** Move whatever is on the cursor into the player inventory (merge into stacks first, then free slots). */
async function depositCursor (bot, win) {
  let guard = 0;
  while (win.selectedItem && guard++ < 8) {
    const cur = win.selectedItem;
    let target = null;
    for (let s = win.inventoryStart; s < win.inventoryEnd; s++) {
      const it = win.slots[s];
      if (it && it.type === cur.type && it.count < 64) { target = s; break; }
    }
    if (target === null) {
      for (let s = win.inventoryStart; s < win.inventoryEnd; s++) {
        if (!win.slots[s]) { target = s; break; }
      }
    }
    if (target === null) throw new Error('inventory is full');
    await click(bot, target, 0, 0);
  }
}

async function openTableWindow (bot, tableBlock) {
  const win = await new Promise((resolve) => {
    let done = false;
    const onOpen = (w) => { if (!done) { done = true; resolve(w); } };
    bot.once('windowOpen', onOpen);
    try { bot.activateBlock(tableBlock); } catch (e) { /* fallthrough to timeout */ }
    setTimeout(() => { if (!done) { done = true; resolve(null); } }, 5000);
  });
  if (!win || !String(win.type).startsWith('minecraft:crafting')) {
    if (win) { try { bot.closeWindow(win); } catch (e) {} }
    throw new Error('crafting table window did not open');
  }
  return win;
}

// ---------------------------------------------------------------------------
// recipes
// ---------------------------------------------------------------------------
/** All recipe variants for an item (including table recipes). */
function recipeVariants (bot, itemName) {
  const mcData = dataOf(bot);
  const item = mcData.itemsByName[itemName];
  if (!item) return [];
  try { return bot.recipesAll(item.id, null, true); } catch (e) { return []; }
}

/** Consumed ingredients per single craft: [{ id, count }] */
function ingredientList (recipe) {
  return (recipe.delta || []).filter((d) => d.count < 0).map((d) => ({ id: d.id, count: -d.count }));
}

function woodOf (bot, prefer) {
  const items = bot.inventory.items();
  const plank = items.find((i) => i.name.endsWith('_planks'));
  if (plank) return plank.name.slice(0, -'_planks'.length);
  const log = items.find((i) => /(_log|_stem|_wood)$/.test(i.name));
  if (log) return log.name.replace(/(_log|_stem|_wood)$/, '');
  for (const p of (prefer || [])) {
    if (p.endsWith('_planks')) return p.slice(0, -'_planks'.length);
    if (p.endsWith('_log')) return p.slice(0, -'_log'.length);
  }
  return 'oak';
}

/** Choose the recipe variant that best matches what we have / are planning to get. */
function pickRecipe (bot, itemName, prefer = new Set()) {
  const variants = recipeVariants(bot, itemName);
  if (!variants.length) return null;
  const mcData = dataOf(bot);
  const invIds = new Set(bot.inventory.items().map((i) => i.type));
  const wood = woodOf(bot, prefer);
  const score = (r) => {
    let s = 0;
    for (const ing of ingredientList(r)) {
      if (invIds.has(ing.id)) s += 4;
      const nm = mcData.items[ing.id] ? mcData.items[ing.id].name : '';
      if (prefer.has(nm)) s += 2;
      if (nm.startsWith(wood + '_')) s += 1;
    }
    return s;
  };
  return variants.slice().sort((a, b) => score(b) - score(a))[0];
}

// ---------------------------------------------------------------------------
// block placement helpers (crafting table / furnace)
// ---------------------------------------------------------------------------
async function placeBlockNear (bot, itemName) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) throw new Error(`no ${itemName} in inventory to place`);
  const base = bot.entity.position.floored();
  const offsets = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, 2], [-2, 0], [0, -2]];
  for (const [dx, dz] of offsets) {
    const target = base.offset(dx, 0, dz);
    const below = bot.blockAt(target.offset(0, -1, 0));
    const t = bot.blockAt(target);
    if (!below || !t) continue;
    if (t.name !== 'air' && t.name !== 'cave_air') continue;
    if (below.name === 'air' || below.name === 'cave_air' || below.name === 'water') continue;
    try {
      await bot.equip(item, 'hand');
      await bot.lookAt(target.offset(0.5, 1, 0.5), true);
      await bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch (e) { continue; }
    await sleep(400);
    const placed = bot.blockAt(target);
    if (placed && placed.name === itemName) return placed;
  }
  throw new Error(`could not place ${itemName} nearby`);
}

function findPlaced (bot, blockName, radius = 48) {
  const mcData = dataOf(bot);
  const id = mcData.blocksByName[blockName] ? mcData.blocksByName[blockName].id : null;
  if (id == null) return null;
  return bot.findBlock({ matching: [id], maxDistance: radius });
}

async function goNear (bot, pos, dist = 3, timeout = 20000) {
  if (bot.entity.position.distanceTo(pos) <= 3.8) return true;
  const { goals } = require('mineflayer-pathfinder');
  try { bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, dist)); } catch (e) { return false; }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (bot.entity.position.distanceTo(pos) <= 3.8) { try { bot.pathfinder.setGoal(null); } catch (e) {} return true; }
    await sleep(250);
  }
  try { bot.pathfinder.setGoal(null); } catch (e) {}
  return false;
}

/**
 * Get a usable crafting_table / furnace block: find a placed one (and walk to it),
 * else place one from the inventory. Returns null if we have neither.
 */
async function ensurePlaceable (engine, bot, task, itemName, blockName) {
  const found = findPlaced(bot, blockName);
  if (found) {
    const ok = await goNear(bot, found.position);
    if (ok) return found;
  }
  if (countItems(bot, [itemName]) > 0) {
    return await placeBlockNear(bot, itemName);
  }
  return null;
}

// ---------------------------------------------------------------------------
// crafting (public)
// ---------------------------------------------------------------------------
async function fillGrid (bot, win, recipe, w) {
  const cells = [];
  if (recipe.inShape) {
    for (let y = 0; y < recipe.inShape.length; y++) {
      const row = recipe.inShape[y];
      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        if (cell && cell.id !== -1 && (cell.count || 1) > 0) cells.push({ id: cell.id, n: Math.max(1, cell.count || 1), slot: 1 + x + w * y });
      }
    }
  } else {
    const positions = [];
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) positions.push(1 + x + w * y);
    (recipe.ingredients || []).forEach((ing, i) => {
      if (positions[i] !== undefined && ing && ing.id !== -1) cells.push({ id: ing.id, n: Math.max(1, Math.abs(ing.count || 1)), slot: positions[i] });
    });
  }
  for (const c of cells) await placeOneAt(bot, win, c.id, c.slot, c.n);
}

async function emptyGrid (bot, win, w) {
  for (let i = 1; i <= w * w; i++) {
    if (win.slots[i]) { await click(bot, i, 0, 0); await depositCursor(bot, win); }
  }
}

/**
 * Craft `count` of itemName. Ingredients must already be in the inventory
 * (the goal planner takes care of that). Throws on any failure.
 */
async function craftItem (engine, bot, task, itemName, count, opts = {}) {
  const recipe = opts.recipe || pickRecipe(bot, itemName, opts.prefer);
  if (!recipe) throw new Error(`no recipe for ${itemName}`);
  const per = recipe.result.count || 1;
  const crafts = Math.ceil(count / per);
  const mcData = dataOf(bot);

  const need = ingredientList(recipe).map((ing) => {
    const name = mcData.items[ing.id] ? mcData.items[ing.id].name : null;
    return { name, count: ing.count * crafts };
  });
  for (const n of need) {
    if (!n.name) throw new Error('unknown ingredient id in recipe');
    const have = countItems(bot, [n.name]);
    if (have < n.count) throw new Error(`missing ${n.count - have} ${n.name} to craft ${itemName}`);
  }

  const before = countItems(bot, [itemName]);
  engine.brain.log(`🔨 Crafting ${crafts}× ${itemName}...`);

  let win = bot.inventory;
  let tableWin = null;
  let w = 2;
  if (recipe.requiresTable) {
    const table = await ensurePlaceable(engine, bot, task, 'crafting_table', 'crafting_table');
    if (!table) throw new Error('no crafting table — craft one first (4 planks)');
    win = tableWin = await openTableWindow(bot, table);
    w = 3;
  }

  try {
    for (let c = 0; c < crafts; c++) {
      ensure(task);
      await fillGrid(bot, win, recipe, w);
      const result = await waitResult(bot, win);
      if (!result) {
        await emptyGrid(bot, win, w).catch(() => {});
        throw new Error('server rejected the craft (no result)');
      }
      await click(bot, 0, 0, 0);          // take result onto cursor
      await depositCursor(bot, win);      // deposit into inventory
      if (task) engine.brain.updateProgress(task, `${countItems(bot, [itemName])}/${count}`);
    }
  } finally {
    await emptyGrid(bot, win, w).catch(() => {});
    if (tableWin) { try { bot.closeWindow(tableWin); } catch (e) {} await sleep(250); }
  }

  const gained = countItems(bot, [itemName]) - before;
  if (gained <= 0) throw new Error(`craft produced nothing for ${itemName}`);
  engine.brain.log(`🔨 Crafted ${gained}× ${itemName}`);
  return gained;
}

// ---------------------------------------------------------------------------
// smelting (public)
// ---------------------------------------------------------------------------
/** What do we smelt to get `target`? Returns input item name or null. */
function smeltInputName (bot, target) {
  const mcData = dataOf(bot);
  const src = SMELT_SOURCES[target];
  if (!src) return null;
  if (src === 'LOG') { // charcoal from any log
    const log = bot.inventory.items().find((i) => /(_log|_stem)$/.test(i.name));
    return log ? log.name : 'oak_log';
  }
  if (mcData.itemsByName[src]) return src;
  const rawAlt = 'raw_' + src;
  if (mcData.itemsByName[rawAlt]) return rawAlt;
  return null;
}

function fuelUnitsAvailable (bot) {
  const items = bot.inventory.items();
  let units = 0;
  for (const [name, u] of FUELS) {
    const it = items.find((i) => i.name === name);
    if (it) units += it.count * u;
  }
  for (const it of items) {
    if (it.name.endsWith('_planks') || /(_log|_stem)$/.test(it.name)) units += it.count * 1.5;
  }
  return units;
}

function pickFuel (bot, units) {
  const items = bot.inventory.items();
  for (const [name, u] of FUELS) {
    const it = items.find((i) => i.name === name);
    if (it) return { item: it, units: u, need: Math.max(1, Math.ceil((units + 1) / u)) };
  }
  const plank = items.find((i) => i.name.endsWith('_planks'));
  if (plank) return { item: plank, units: 1.5, need: Math.max(1, Math.ceil((units + 1) / 1.5)) };
  const log = items.find((i) => /(_log|_stem)$/.test(i.name));
  if (log) return { item: log, units: 1.5, need: Math.max(1, Math.ceil((units + 1) / 1.5)) };
  return null;
}

/**
 * Smelt `count` of itemName. Input + fuel must be in the inventory
 * (the goal planner takes care of that). Throws on failure.
 */
async function smeltItem (engine, bot, task, itemName, count) {
  const inputName = smeltInputName(bot, itemName);
  if (!inputName) throw new Error(`${itemName} is not smeltable`);
  const haveInput = countItems(bot, [inputName]);
  if (haveInput < count) throw new Error(`need ${count}× ${inputName} to smelt ${itemName} (have ${haveInput})`);
  const fuel = pickFuel(bot, count);
  if (!fuel) throw new Error('no fuel (need coal / charcoal / planks / logs)');

  const furnaceBlock = await ensurePlaceable(engine, bot, task, 'furnace', 'furnace');
  if (!furnaceBlock) throw new Error('no furnace — craft one first (8 cobblestone)');

  const before = countItems(bot, [itemName]);
  engine.brain.log(`♨️ Smelting ${count}× ${inputName} → ${itemName}...`);
  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    const mcData = dataOf(bot);
    const inputType = mcData.itemsByName[inputName].id;
    const fuelType = fuel.item.type;
    await furnace.putFuel(fuelType, null, Math.min(64, fuel.need));
    await sleep(350);

    let remaining = count;
    let guard = 0;
    while (remaining > 0 && guard++ < 8) {
      const batch = Math.min(64, remaining);
      await furnace.putInput(inputType, null, batch);
      await sleep(450);
      const inFurnace = furnace.inputItem() ? furnace.inputItem().count : 0;
      if (!inFurnace) break;
      const deadline = Date.now() + inFurnace * 12000 + 20000;
      let taken = 0;
      while (taken < inFurnace && Date.now() < deadline) {
        if (task && task.cancelled) break;
        const out = furnace.outputItem();
        if (out && out.count > 0) {
          const got = await furnace.takeOutput();
          taken += got.count;
          if (task) engine.brain.updateProgress(task, `${Math.min(count, count - remaining + taken)}/${count}`);
        } else {
          await sleep(900);
        }
      }
      if (taken === 0) break;
      remaining -= Math.min(taken, batch);
      if (task && task.cancelled) break;
    }
  } finally {
    try { await furnace.close(); } catch (e) {}
    await sleep(250);
  }

  const gained = countItems(bot, [itemName]) - before;
  if (gained <= 0) throw new Error(`smelting produced no ${itemName}`);
  engine.brain.log(`♨️ Smelted ${gained}× ${itemName}`);
  return gained;
}

module.exports = {
  SMELT_SOURCES,
  pickRecipe,
  recipeVariants,
  ingredientList,
  craftItem,
  smeltItem,
  smeltInputName,
  fuelUnitsAvailable,
  pickFuel,
  ensurePlaceable,
  placeBlockNear,
  findPlaced,
  goNear
};
