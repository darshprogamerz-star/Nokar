/**
 * NOKAR 2.0 — Goal-engine live test (Paper 1.21.4, local server, RCON).
 *
 * From an EMPTY inventory:
 *   1) `goal diamond 1` → chop → planks → table → wooden pickaxe → mine stone →
 *      stone pickaxe → furnace → mine coal+iron → smelt → iron pickaxe → diamond
 *   2) `goal torch 4`    → craft from leftovers
 *   3) staircase descent → dig down live
 *   4) owner prefix ".Tester" accepted / stranger rejected
 *   5) STOP safety
 */
const mineflayer = require('mineflayer');
const { rconExec } = require('./rcon');
const { Engine } = require('../lib/engine');
const { DEFAULTS } = require('../lib/config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const logLines = [];
function check (name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}
async function waitFor (fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return true; } catch (e) {}
    await sleep(400);
  }
  throw new Error('timeout: ' + label);
}
const invCount = (bot, name) => bot.inventory.items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);

(async () => {
  await rconExec(['gamerule doMobSpawning false', 'kill @e[type=!minecraft:player]', 'gamerule doDaylightCycle false', 'time set day', 'weather clear', 'effect clear Nokar']);

  const config = JSON.parse(JSON.stringify(DEFAULTS));
  config.mc = { host: '127.0.0.1', port: 25565, username: 'Nokar', version: '1.21.4', password: '', owner: 'Tester', reconnectDelayMs: 3000 };
  const engine = new Engine(config);
  engine.on('log', (d) => { logLines.push(d.msg); if (process.env.NOKAR_VERBOSE) console.log(`[${d.level || 'info'}] ${d.msg}`); });
  engine.start();
  await waitFor(() => engine.isReady && engine.bot?.entity, 60000, 'bot spawn');
  const bot = engine.bot;
  check('Bot spawned', true, `v${bot.version}`);

  // ── fresh world: flat arena + EMPTY inventory ──
  await rconExec(['clear Nokar', 'clear Tester', 'tp Nokar 0 -59 0']);
  await sleep(600);
  await rconExec([
    'fill -12 -63 -12 16 -55 16 minecraft:air',
    'fill -12 -62 -12 16 -62 16 minecraft:bedrock',
    'fill -12 -61 -12 16 -61 16 minecraft:grass_block',
    'fill -12 -60 -12 16 -56 16 minecraft:air',
    'tp Nokar 0 -60 0'
  ]);
  await sleep(1200);
  await rconExec(['effect give Nokar minecraft:instant_health 1 10 true', 'effect give Nokar minecraft:saturation 1 5 true']);

  // ── test blocks ──
  const blocks = [
    'setblock 4 -60 4 minecraft:oak_log', 'setblock 4 -59 4 minecraft:oak_log', 'setblock 4 -58 4 minecraft:oak_log', 'setblock 4 -57 4 minecraft:oak_log',
    'setblock 6 -60 0 minecraft:stone', 'setblock 6 -60 1 minecraft:stone', 'setblock 6 -60 2 minecraft:stone',
    'setblock 6 -60 3 minecraft:stone', 'setblock 6 -60 4 minecraft:stone', 'setblock 6 -60 5 minecraft:stone',
    'setblock 7 -60 0 minecraft:stone', 'setblock 7 -60 1 minecraft:stone', 'setblock 7 -60 2 minecraft:stone',
    'setblock 7 -60 3 minecraft:stone', 'setblock 7 -60 4 minecraft:stone', 'setblock 7 -60 5 minecraft:stone',
    'setblock 3 -60 -4 minecraft:coal_ore', 'setblock 4 -60 -4 minecraft:coal_ore',
    'setblock 3 -60 -6 minecraft:iron_ore', 'setblock 4 -60 -6 minecraft:iron_ore', 'setblock 5 -60 -6 minecraft:iron_ore',
    'setblock 7 -60 -4 minecraft:diamond_ore', 'setblock 8 -60 -3 minecraft:diamond_ore'
  ];
  await rconExec(blocks);
  await sleep(1200);
  const verif = await rconExec(['execute if block 4 -60 4 minecraft:oak_log', 'execute if block 8 -60 -3 minecraft:diamond_ore', 'execute if block 6 -60 0 minecraft:stone']);
  console.log('[SETUP] blocks verif:', JSON.stringify(verif), '| inv:', bot.inventory.items().length, 'items');
  check('Arena setup (empty inventory, blocks placed)', bot.inventory.items().length === 0 && verif.every((v) => /Test passed/.test(v)));

  // ═══ TEST 1: goal diamond 1 — the full zero→diamond chain ═══
  console.log('\n💎 goal diamond 1 — full chain starting...');
  const t0 = Date.now();
  engine.handleCommandText('goal diamond 1');
  await waitFor(() => !engine.brain.current && engine.brain.queue.length === 0, 600000, 'goal diamond');
  const chainTime = ((Date.now() - t0) / 1000).toFixed(0);
  const diamond = invCount(bot, 'diamond');
  check('CHAIN: goal diamond 1', diamond >= 1, `${diamond} diamond in ${chainTime}s`);

  const milestones = [
    ['chopped wood', /Mining 4× oak_log|Crafted .*oak_planks/],
    ['crafted wooden_pickaxe', /Crafted 1× wooden_pickaxe/],
    ['mined cobblestone (tool chain)', /Mining 3× cobblestone/],
    ['crafted stone_pickaxe', /Crafted 1× stone_pickaxe/],
    ['mined iron ore', /Mining .*iron ore/],
    ['crafted furnace', /Crafted 1× furnace/],
    ['smelted iron_ingot', /Smelted 3× iron_ingot/],
    ['crafted iron_pickaxe', /Crafted 1× iron_pickaxe/],
    ['mined diamond', /Goal complete: 1× Diamond/]
  ];
  for (const [label, re] of milestones) {
    check(`   ↳ ${label}`, logLines.some((l) => re.test(l)));
  }
  const errors = logLines.filter((l) => l.startsWith('❌'));
  check('   ↳ no task errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  // ═══ TEST 2: goal torch 4 — reuse leftovers ═══
  console.log('\n🔥 goal torch 4...');
  engine.handleCommandText('goal torch 4');
  await waitFor(() => !engine.brain.current && engine.brain.queue.length === 0, 180000, 'goal torch');
  check('CHAIN: goal torch 4 (leftovers only)', invCount(bot, 'torch') >= 4, `torch=${invCount(bot, 'torch')}`);

  // ═══ TEST 3: staircase descent (live) ═══
  console.log('\n⛏️ staircase descent live test...');
  await rconExec(['tp Nokar 30 -60 0', 'fill 28 -56 -2 44 -56 2 minecraft:air']);
  await sleep(1200);
  const { descendToY } = require('../lib/goals');
  let descendErr = null;
  try { await descendToY(engine, bot, { cancelled: false }, -63); } catch (e) { descendErr = e.message; }
  const yNow = bot.entity.position.y;
  check('SKILL: staircase descent', yNow <= -62, `y=${yNow.toFixed(1)}${descendErr ? ' err=' + descendErr : ''}`);

  // ═══ TEST 4: owner prefix (.Tester both accepted; stranger rejected) ═══
  const countPos = () => logLines.filter((l) => l.includes('📍 Position')).length;
  const p0 = countPos();
  engine._handleInGameCommand('.Tester', 'where', 'chat');
  await sleep(700);
  const prefixedOk = countPos() > p0;
  const p1 = countPos();
  engine._handleInGameCommand('Tester', 'where', 'chat');
  await sleep(700);
  const plainOk = countPos() > p1;
  const b2 = logLines.length;
  engine._handleInGameCommand('SomeStranger', 'stop', 'chat');
  await sleep(400);
  const strangerRejected = !logLines.slice(b2).some((l) => l.includes('⏹️'));
  check('owner match: ".Tester" + "Tester" accepted, stranger rejected', prefixedOk && plainOk && strangerRejected,
    `prefixed=${prefixedOk} plain=${plainOk} strangerRejected=${strangerRejected}`);

  // ═══ TEST 5: STOP safety ═══
  engine.handleCommandText('goto 500 500');
  await sleep(1500);
  engine.handleCommandText('stop');
  await sleep(1200);
  check('STOP cancels everything', !engine.brain.current && engine.brain.queue.length === 0 && bot.pathfinder.goal == null);

  // ── summary ──
  console.log('\n── milestone log lines ──');
  for (const l of logLines.filter((x) => /🎯|📋|⛏️ Mining|🔨 Crafted|♨️ Smelted|🏁|🛠️/.test(x))) console.log('   ' + l);
  console.log('\n── full inventory at end ──');
  console.log('   ' + bot.inventory.items().map((i) => `${i.name} x${i.count}`).join(', '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '✅ ALL PASSED' : '❌ FAILED: ' + failed.map((f) => f.name).join(' | ')}`);
  bot.quit();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e.message);
  console.log('── last log lines ──');
  for (const l of logLines.slice(-25)) console.log('   ' + l);
  process.exit(1);
});
