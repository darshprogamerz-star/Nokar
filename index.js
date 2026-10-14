/**
 * ════════════════════════════════════════════════════════════════════
 *  NOKAR 2.0 — Autonomous Minecraft Player Bot
 *  ---------------------------------------------------------------
 *  Run:      npm start              (or: node index.js)
 *  Dashboard: http://localhost:3000
 *  Config:    config.json  (or env: MC_HOST, MC_PORT, MC_NAME, MC_VERSION,
 *             MC_PASSWORD, MC_OWNER, PORT, DASH_PASSWORD)
 * ════════════════════════════════════════════════════════════════════
 */
const { loadConfig } = require('./lib/config');
const { Engine } = require('./lib/engine');
const { startDashboard } = require('./lib/dashboard');

// Crash guard: a single malformed packet from a custom server plugin must
// never take down the whole process (bot + dashboard + auto-reconnect).
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT GUARD]', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED GUARD]', err && err.message ? err.message : err);
});

const config = loadConfig();
const engine = new Engine(config);

startDashboard(config, engine);
engine.start();
