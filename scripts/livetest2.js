/* NOKar 2.0 — Corrected live test against the RUNNING local Paper server (RCON based) */
const mineflayer = require('mineflayer');
const { rconExec } = require('./rcon');
const { Engine } = require('../lib/engine');
const { DEFAULTS } = require('../lib/config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check (name, ok, detail = '') {
  results.push({ name, ok, detail });
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
  // Clean slate (doMobSpawning=false stops natural spawns but keeps our summons!)
  await rconExec(['gamerule doMobSpawning false', 'kill @e[type=!minecraft:player]', 'time set midnight', 'gamerule doDaylightCycle false', 'weather clear', 'effect clear Nokar']);

  // ── 1. Engine boot ──
  const config = JSON.parse(JSON.stringify(DEFAULTS));
  config.mc = { host: '127.0.0.1', port: 25565, username: 'Nokar', version: '1.21.4', password: '', owner: 'Tester', reconnectDelayMs: 3000 };
  const engine = new Engine(config);
  engine.on('log', (d) => console.log(`[${(d.level || 'info').padEnd(5)}] ${d.msg}`));
  engine.start();
  await waitFor(() => engine.isReady && engine.bot?.entity, 60000, 'bot spawn');
  const bot = engine.bot;
  check('Bot spawned (plugins loaded)', true, `at ${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}`);

  // ── 2. Tester (owner) joins ──
  const tester = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'Tester', auth: 'offline', version: '1.21.4' });
  await waitFor(() => tester.entity, 30000, 'tester spawn');
  check('Tester joined', true);

  // ── 3. Gear ──
  // NOTE: Tester stands FAR from the arena — if he stands on/near the test blocks,
  // the server's item-pickup races split Nokar's drops between the two players!
  await rconExec(['give Nokar minecraft:iron_pickaxe 1', 'give Nokar minecraft:diamond_sword 1', 'give Nokar minecraft:cooked_beef 6', 'tp Nokar 0 -59 0', 'tp Tester 12 -60 12']);
  await sleep(1500);

  const pos = () => bot.entity.position.floored();

  // ── 4. MINE (normalize arena first: fresh grass floor + clear air) ──
  await rconExec([
    'fill -3 -62 -3 8 -62 8 minecraft:bedrock',
    'fill -3 -61 -3 8 -61 8 minecraft:grass_block',
    'fill -3 -60 -3 8 -58 8 minecraft:air',
    'tp Nokar 0 -60 0'
  ]);
  await sleep(1500);
  let p = pos();
  await rconExec([1, 2, 3].map((i) => `setblock ${p.x + i} ${p.y} ${p.z} minecraft:stone`));
  await sleep(600);
  const stonesPlaced = await rconExec([`execute if block ${p.x + 1} ${p.y} ${p.z} minecraft:stone`, `execute if block ${p.x + 3} ${p.y} ${p.z} minecraft:stone`]);
  console.log(`[TEST] bot at (${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}), stones at ${p.x + 1}..${p.x + 3} y=${p.y}: ${JSON.stringify(stonesPlaced)}`);
  // DEBUG: see what the engine's findBlock sees
  const { Vec3 } = require('node_modules/vec3');
  const _b1 = bot.blockAt(new Vec3(p.x + 1, p.y, p.z));
  const _fb = bot.findBlock({ matching: [1], maxDistance: 48 });
  console.log(`[DEBUG] blockAt(${p.x + 1},${p.y},${p.z})=${_b1 ? _b1.name : 'NULL'} findBlock(matching:[1])=${_fb ? `${_fb.name}@${_fb.position}` : 'NULL'} botVersion=${bot.version}`);
  const cobbleBefore = invCount(bot, 'cobblestone');
  engine.handleCommandText('mine stone 3');
  try {
    await waitFor(() => !engine.brain.current && engine.brain.queue.length === 0, 120000, 'mine');
  } catch (e) {
    const ev = await rconExec([`execute if block ${p.x + 1} ${p.y} ${p.z} minecraft:stone`, `execute if block ${p.x + 3} ${p.y} ${p.z} minecraft:stone`]);
    const nowBlock = bot.blockAt(new Vec3(p.x + 1, p.y, p.z));
    const nowFind = bot.findBlock({ matching: [1], maxDistance: 48 });
    console.log(`[POST-MINE] server stones: ${JSON.stringify(ev)} | client blockAt: ${nowBlock ? nowBlock.name : 'NULL'} | client findBlock: ${nowFind ? nowFind.position : 'NULL'} | bot pos: (${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}) | task: ${engine.brain.current ? String(engine.brain.current.label || engine.brain.current.name || 'busy') : 'none'}`);
    throw e;
  }
  check('SKILL: mining', invCount(bot, 'cobblestone') - cobbleBefore >= 3, `gained=${invCount(bot, 'cobblestone') - cobbleBefore}`);

  // ── 5. CHOP ──
  p = pos();
  await rconExec([`setblock ${p.x + 2} ${p.y} ${p.z + 2} minecraft:oak_log`, `setblock ${p.x + 2} ${p.y + 1} ${p.z + 2} minecraft:oak_log`]);
  await sleep(600);
  const logsBefore = invCount(bot, 'oak_log');
  engine.handleCommandText('chop 2');
  await waitFor(() => !engine.brain.current && engine.brain.queue.length === 0, 90000, 'chop');
  check('SKILL: chopping', invCount(bot, 'oak_log') - logsBefore >= 2, `gained=${invCount(bot, 'oak_log') - logsBefore}`);

  // ── 6. COMBAT (fair 1v1: heal up, clear arena, one fresh zombie) ──
  await rconExec(['effect give Nokar minecraft:instant_health 1 10 true', 'effect give Nokar minecraft:saturation 1 5 true', 'kill @e[type=!minecraft:player]']);
  await sleep(800);
  p = pos();
  await rconExec([`summon minecraft:zombie ${p.x + 4} ${p.y} ${p.z} {PersistenceRequired:1b}`]);
  await sleep(1800);
  await waitFor(() => Object.values(bot.entities).some((e) => e.name === 'zombie'), 10000, 'zombie visible to bot');
  const killsBefore = engine.stats.kills;
  const hpBefore = bot.health;
  engine.handleCommandText('attack nearest');
  await waitFor(() => !engine.brain.current && engine.brain.queue.length === 0, 120000, 'attack');
  const zombiesLeft = Object.values(bot.entities).filter((e) => e.name === 'zombie').length;
  check('SKILL: combat (killed zombie)', zombiesLeft === 0 && engine.stats.kills > killsBefore, `kills=${engine.stats.kills}, hp ${hpBefore?.toFixed(0)}→${bot.health?.toFixed(0)}`);

  // ── 7. FOLLOW ──
  await rconExec(['kill @e[type=!minecraft:player]']); // clean arena so nothing jumps the bot mid-follow
  engine.handleCommandText('follow Tester');
  await sleep(2000);
  tester.setControlState('forward', true);
  await sleep(3500);
  tester.setControlState('forward', false);
  await sleep(3000);
  const dist = bot.entity.position.distanceTo(tester.entity.position);
  check('SKILL: follow', dist < 10, `distance=${dist.toFixed(1)}m`);
  engine.handleCommandText('stop');
  await sleep(600);

  // ── 8. AUTO-EAT (sprint-drain + hunger effect) ──
  engine.config.behavior.autoEatAt = 17; // speed the test up
  await rconExec(['give Nokar minecraft:cooked_beef 3', 'effect give Nokar minecraft:hunger 90 9 true']);
  const foodStart = bot.food;
  let sprinting = true;
  const stopSpr = setTimeout(() => { sprinting = false; }, 90000);
  bot.setControlState('sprint', true);
  bot.setControlState('forward', true);
  console.log(`[TEST] sprinting to drain food (start food=${foodStart}, will eat at <=17)...`);
  await waitFor(() => bot.food <= 17, 90000, 'food to drain');
  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
  clearTimeout(stopSpr);
  console.log(`[TEST] food drained to ${bot.food} — waiting for auto-eat...`);
  const beefBefore = invCount(bot, 'cooked_beef');
  await waitFor(() => bot.food >= 19 || invCount(bot, 'cooked_beef') < beefBefore, 20000, 'auto-eat');
  check('SKILL: auto-eat', bot.food >= 19 || invCount(bot, 'cooked_beef') < beefBefore, `food=${bot.food}, beef ${beefBefore}→${invCount(bot, 'cooked_beef')}`);

  // ── 9. GOTO ──
  p = pos();
  const gx = p.x + 14, gz = p.z + 12;
  engine.handleCommandText(`goto ${gx} ${gz}`);
  await waitFor(() => !engine.brain.current && engine.brain.queue.length === 0, 120000, 'goto');
  const rem = Math.hypot(bot.entity.position.x - gx, bot.entity.position.z - gz);
  check('SKILL: goto', rem < 5, `remaining=${rem.toFixed(1)}m`);

  // ── 10. Task cancel / stop safety ──
  engine.handleCommandText('goto 500 500');
  await sleep(1500);
  engine.handleCommandText('stop');
  await sleep(1200);
  check('STOP cancels tasks', !engine.brain.current && engine.brain.queue.length === 0 && bot.pathfinder.goal == null, 'queue cleared, path cleared');

  // ── 11. Snapshot ──
  const snap = engine.snapshot();
  check('Snapshot complete', !!(snap.pos && snap.inventory && snap.task && snap.players && snap.armor && snap.entities), `players=${snap.players.length} entities=${snap.entities?.length}`);

  try { tester.quit(); } catch (e) {}
  try { bot.quit(); } catch (e) {}

  console.log('\n═══════════ RESULTS ═══════════');
  const failed = results.filter((r) => !r.ok).length;
  results.forEach((r) => console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  console.log(failed ? `\n${failed} FAILED` : '\nALL TESTS PASSED 🎉');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
