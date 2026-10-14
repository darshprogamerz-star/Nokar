#!/usr/bin/env node
/**
 * NOKAR 2.0 — Local integration test.
 * Boots a local Paper server (test-server/paper.jar), connects the full bots
 * engine, and exercises every skill: mine, chop, combat, follow, auto-eat, goto.
 *
 * Usage:  node scripts/livetest.js          (needs test-server/paper.jar running dir)
 * Env:    TEST_SERVER_DIR=/path/to/server   JAVA=java   TEST_MC_VERSION=1.21.4
 */
/* eslint-disable no-console */
const { spawn } = require('child_process');
const path = require('path');
const mineflayer = require('mineflayer');
const { Engine } = require('../lib/engine');
const { DEFAULTS } = require('../lib/config');

const SERVER_DIR = process.env.TEST_SERVER_DIR || path.join(__dirname, '..', '..', 'test-server');
const PORT = parseInt(process.env.TEST_MC_PORT || '25565', 10);
const VERSION = process.env.TEST_MC_VERSION || '1.21.4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let serverProc = null;
let serverOut = '';
const results = [];

function check (name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sendConsole (cmd) {
  console.log(`[CONSOLE>] ${cmd}`);
  serverProc.stdin.write(cmd + '\n');
}

async function waitFor (fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return true; } catch (e) { /* keep waiting */ }
    await sleep(300);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const invCount = (bot, name) => bot.inventory.items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);

async function main () {
  // ── 1. Boot Paper server ────────────────────────────────────────────────
  console.log('Starting Paper server...');
  serverProc = spawn(process.env.JAVA || 'java', ['-Xmx900M', '-Xms400M', '-jar', 'paper.jar', 'nogui'], { cwd: SERVER_DIR });
  serverProc.stdout.on('data', (d) => { serverOut += d.toString(); });
  serverProc.stderr.on('data', (d) => { serverOut += d.toString(); });
  await waitFor(() => serverOut.includes('Done ('), 300000, 'server boot');
  check('Paper 1.21.4 server booted', true);
  sendConsole('gamerule doDaylightCycle false');
  sendConsole('time set midnight');
  sendConsole('gamerule doMobSpawning false');
  await sleep(500);

  // ── 2. Boot the bot engine ──────────────────────────────────────────────
  const config = JSON.parse(JSON.stringify(DEFAULTS));
  config.mc = {
    host: '127.0.0.1', port: PORT, username: 'Nokar', version: VERSION,
    password: '', owner: 'Tester', reconnectDelayMs: 3000
  };
  const engine = new Engine(config);
  engine.on('log', (d) => console.log(`[${(d.level || 'info').padEnd(5)}] ${d.msg}`));
  engine.start();
  await waitFor(() => engine.isReady && engine.bot && engine.bot.entity, 90000, 'bot spawn');
  const bot = engine.bot;
  check('Bot spawned (pathfinder + collectblock plugins)', true, `at ${bot.entity.position}`);

  // ── 3. Tester player ("the owner") ──────────────────────────────────────
  const tester = mineflayer.createBot({ host: '127.0.0.1', port: PORT, username: 'Tester', auth: 'offline', version: VERSION });
  await waitFor(() => tester.entity, 60000, 'tester spawn');
  check('Tester player joined', true);

  // ── 4. Equipment + gear ─────────────────────────────────────────────────
  sendConsole('give Nokar minecraft:iron_pickaxe 1');
  sendConsole('give Nokar minecraft:diamond_sword 1');
  sendConsole('give Nokar minecraft:cooked_beef 6');
  await sleep(1800);
  check('Gear delivered (pickaxe, sword, food)', bot.inventory.items().length >= 3, `inv=${bot.inventory.items().length}`);

  const pos = () => bot.entity.position.floored();

  // ── 5. MINE ─────────────────────────────────────────────────────────────
  let p = pos();
  for (let i = 1; i <= 3; i++) sendConsole(`setblock ${p.x + i} ${p.y} ${p.z} minecraft:stone`);
  await sleep(1200);
  engine.handleCommandText('mine stone 3');
  await waitFor(() => !engine.brain.current && engine.brain.queue.length === 0, 120000, 'mine task');
  const cobble = invCount(bot, 'cobblestone');
  check('SKILL: mining (3 stone → cobblestone)', cobble >= 3, `got ${cobble}`);

  // ── 6. CHOP ─────────────────────────────────────────────────────────────
  p = pos();
  sendConsole(`setblock ${p.x + 2} ${p.y} ${p.z + 2} minecraft:oak_log`);
  sendConsole(`setblock ${p.x + 2} ${p.y + 1} ${p.z + 2} minecraft:oak_log`);
  await sleep(1000);
  engine.handleCommandText('chop 2');
  await waitFor(() => !engine.brain.current && engine.brain.queue.length === 0, 90000, 'chop task');
  const logs = invCount(bot, 'oak_log');
  check('SKILL: chopping wood', logs >= 2, `got ${logs} logs`);

  // ── 7. COMBAT ───────────────────────────────────────────────────────────
  p = pos();
  const zpos = `${p.x + 4} ${p.y} ${p.z}`;
  sendConsole(`summon minecraft:zombie ${zpos} {NoAI:1b,Silent:1b,PersistenceRequired:1b}`);
  await sleep(1500);
  const killsBefore = engine.stats.kills;
  engine.handleCommandText('attack nearest');
  await waitFor(() => !engine.brain.current && engine.brain.queue.length === 0, 120000, 'attack task');
  const zombieGone = !Object.values(bot.entities).some((e) => e.name === 'zombie');
  check('SKILL: combat (zombie killed with sword)', zombieGone && engine.stats.kills > killsBefore, `kills=${engine.stats.kills}`);

  // ── 8. FOLLOW ───────────────────────────────────────────────────────────
  engine.handleCommandText('follow Tester');
  await sleep(2000);
  tester.setControlState('forward', true);
  await sleep(3200);
  tester.setControlState('forward', false);
  await sleep(3000);
  const dist = bot.entity.position.distanceTo(tester.entity.position);
  check('SKILL: follow player', dist < 10, `distance=${dist.toFixed(1)}m`);
  engine.handleCommandText('stop');
  await sleep(500);

  // ── 9. AUTO-EAT ─────────────────────────────────────────────────────────
  sendConsole('effect give Nokar minecraft:hunger 10 4 true');
  await waitFor(() => bot.food <= 15, 30000, 'hunger to drop');
  console.log(`[TEST] food dropped to ${bot.food} — waiting for auto-eat...`);
  await waitFor(() => bot.food >= 18 || invCount(bot, 'cooked_beef') < 6, 40000, 'auto-eat to trigger');
  check('SKILL: auto-eat (eats when hungry)', bot.food >= 18 || invCount(bot, 'cooked_beef') < 6, `food=${bot.food}`);

  // ── 10. GOTO ────────────────────────────────────────────────────────────
  p = pos();
  const gx = p.x + 14; const gz = p.z + 12;
  engine.handleCommandText(`goto ${gx} ${gz}`);
  await waitFor(() => !engine.brain.current && engine.brain.queue.length === 0, 120000, 'goto task');
  const remaining = Math.hypot(bot.entity.position.x - gx, bot.entity.position.z - gz);
  check('SKILL: goto coordinates', remaining < 5, `remaining=${remaining.toFixed(1)}m`);

  // ── 11. Snapshot sanity ─────────────────────────────────────────────────
  const snap = engine.snapshot();
  check('Dashboard snapshot complete', !!(snap.pos && snap.inventory && snap.task && snap.players && snap.armor), `players=${snap.players.length}, inv=${snap.inventory.length}`);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  try { tester.quit(); } catch (e) {}
  try { bot.quit(); } catch (e) {}
  await sleep(1500);
  sendConsole('stop');
  await sleep(3000);
  try { serverProc.kill('SIGKILL'); } catch (e) {}

  console.log('\n════════════════ RESULTS ════════════════');
  const failed = results.filter((r) => !r.ok).length;
  results.forEach((r) => console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  console.log(failed ? `\n${failed} TEST(S) FAILED` : '\nALL TESTS PASSED 🎉');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error('--- server tail ---');
  console.error(serverOut.slice(-3000));
  try { serverProc && serverProc.kill('SIGKILL'); } catch (e) {}
  process.exit(1);
});
