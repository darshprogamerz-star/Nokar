/**
 * NOKAR 2.0 — Config loader
 * Priority: environment variables > config.local.json > config.json > defaults
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  webPort: 3000,
  dashboardPassword: '',
  mc: {
    host: 'localhost',
    port: 25565,
    username: 'Nokar',
    version: '1.21.4',
    password: '',
    owner: '',
    reconnectDelayMs: 20000
  },
  behavior: {
    autoEatAt: 14,
    critEatAt: 20,
    fleeHealth: 7,
    guardRange: 12,
    antiAfk: true,
    tossJunkWhenFull: true
  }
};

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge (target, source) {
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val === undefined) continue;
    if (isPlainObject(val) && isPlainObject(target[key])) {
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

function readJson (file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[CONFIG] Failed to parse ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

function loadConfig () {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  deepMerge(cfg, readJson(path.join(ROOT, 'config.json')) || {});
  deepMerge(cfg, readJson(path.join(ROOT, 'config.local.json')) || {});

  // Environment overrides
  if (process.env.PORT) cfg.webPort = parseInt(process.env.PORT, 10) || cfg.webPort;
  if (process.env.DASH_PASSWORD !== undefined) cfg.dashboardPassword = process.env.DASH_PASSWORD;
  if (process.env.MC_HOST) cfg.mc.host = process.env.MC_HOST;
  if (process.env.MC_PORT) cfg.mc.port = parseInt(process.env.MC_PORT, 10) || cfg.mc.port;
  if (process.env.MC_NAME) cfg.mc.username = process.env.MC_NAME;
  if (process.env.MC_VERSION) cfg.mc.version = process.env.MC_VERSION;
  if (process.env.MC_PASSWORD) cfg.mc.password = process.env.MC_PASSWORD;
  if (process.env.MC_OWNER) cfg.mc.owner = process.env.MC_OWNER;

  cfg.mc.owner = String(cfg.mc.owner || '').trim();
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
