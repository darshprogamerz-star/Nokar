/**
 * NOKAR 2.0 — Command parser.
 * Works for in-game chat (owner only) and the web dashboard.
 * Prefix is optional: "follow darsh" and ".follow darsh" both work.
 */

const ALIASES = {
  f: 'follow',
  follow: 'follow',
  come: 'come',
  c: 'come',
  stop: 'stop',
  s: 'stop',
  halt: 'stop',
  guard: 'guard',
  defend: 'guard',
  attack: 'attack',
  kill: 'attack',
  hunt: 'attack',
  mine: 'mine',
  dig: 'mine',
  grind: 'mine',
  chop: 'chop',
  wood: 'chop',
  goto: 'goto',
  go: 'goto',
  walk: 'goto',
  flee: 'flee',
  run: 'flee',
  eat: 'eat',
  food: 'eat',
  toss: 'toss',
  drop: 'toss',
  dropall: 'dropall',
  goal: 'goal',
  get: 'goal',
  lao: 'goal',
  laao: 'goal',
  lelo: 'goal',
  farm: 'goal',
  craft: 'craft',
  make: 'craft',
  banao: 'craft',
  bana: 'craft',
  smelt: 'smelt',
  cook: 'smelt',
  ghalo: 'smelt',
  afk: 'afk',
  status: 'status',
  stat: 'status',
  where: 'where',
  pos: 'where',
  help: 'help',
  '?': 'help'
};

const BOOLEAN_ON = new Set(['on', 'true', 'yes', '1', 'enable']);
const BOOLEAN_OFF = new Set(['off', 'false', 'no', '0', 'disable']);

function parseBool (token) {
  if (!token) return undefined;
  const t = token.toLowerCase();
  if (BOOLEAN_ON.has(t)) return true;
  if (BOOLEAN_OFF.has(t)) return false;
  return undefined;
}

/**
 * @returns {null | {type:string, raw:string, args:object}}
 */
function parseCommand (text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim().replace(/^[.!]/, '');
  if (!clean) return null;

  const tokens = clean.split(/\s+/);
  const head = tokens[0].toLowerCase();
  let type = ALIASES[head];
  // Hinglish suffix: "diamond lao" / "iron 64 lao" / "pickaxe banao"
  if (!type && tokens.length >= 2) {
    const tail = tokens[tokens.length - 1].toLowerCase();
    if (['lao', 'laao', 'lelo', 'lana', 'banao', 'bana'].includes(tail)) {
      type = tail.startsWith('bana') ? 'craft' : 'goal';
      tokens.pop();
      if (tokens.length >= 2 && /^\d+$/.test(tokens[0])) tokens.reverse(); // "64 iron lao"
      tokens.unshift(type);
    }
  }
  if (!type) return { type: 'unknown', raw: clean, args: {} };

  const rest = tokens.slice(1);
  const args = {};

  switch (type) {
    case 'follow':
      if (!rest[0]) return { type: 'help', raw: clean, args: {} };
      args.player = rest.join(' ');
      break;

    case 'guard':
    case 'afk':
      args.on = parseBool(rest[0]);
      break;

    case 'attack':
      args.target = rest[0] || 'nearest';
      break;

    case 'mine': {
      if (!rest[0]) return { type: 'help', raw: clean, args: {} };
      args.block = rest[0];
      const count = parseInt(rest[1], 10);
      args.count = Number.isFinite(count) && count > 0 ? Math.min(count, 999) : 1;
      break;
    }

    case 'chop': {
      const count = parseInt(rest[0], 10);
      args.count = Number.isFinite(count) && count > 0 ? Math.min(count, 999) : 16;
      break;
    }

    case 'goal':
    case 'craft':
    case 'smelt': {
      if (!rest[0]) return { type: 'help', raw: clean, args: {} };
      let item = rest[0];
      let countRaw = rest[1];
      if (/^\d+$/.test(item) && rest[1]) { countRaw = item; item = rest[1]; } // "goal 64 iron"
      args.item = item;
      const count = parseInt(countRaw, 10);
      args.count = Number.isFinite(count) && count > 0 ? Math.min(count, 999) : 1;
      break;
    }

    case 'goto': {
      const nums = rest.map((n) => parseFloat(n)).filter((n) => Number.isFinite(n));
      if (nums.length >= 3) {
        args.x = Math.floor(nums[0]);
        args.y = Math.floor(nums[1]);
        args.z = Math.floor(nums[2]);
      } else if (nums.length === 2) {
        args.x = Math.floor(nums[0]);
        args.y = null;
        args.z = Math.floor(nums[1]);
      } else {
        return { type: 'help', raw: clean, args: {} };
      }
      break;
    }

    case 'toss': {
      if (!rest[0]) return { type: 'help', raw: clean, args: {} };
      args.item = rest[0];
      const count = parseInt(rest[1], 10);
      args.count = Number.isFinite(count) && count > 0 ? count : null;
      break;
    }

    case 'flee':
      args.entityId = null;
      break;
  }

  return { type, raw: clean, args };
}

const HELP_LINES = [
  'follow <player>     — follow a player (dynamic, doors+stairs handled)',
  'come                — come to the owner',
  'stop                — cancel everything (all tasks + queue)',
  'guard on|off        — auto-defend mode (mobs in range)',
  'attack <name|nearest> — attack a player/mob by name or nearest hostile',
  'mine <block> <count> — e.g. "mine iron 64" (aliases: iron/gold/diamond/coal/stone/...)',
  'goal <item> [count] — get ANY item all by myself (mines, crafts, smelts, digs down!)',
  '   e.g. "goal diamond 3" / "diamond lao" / "banao iron_pickaxe" / "torch lao 64"',
  'craft <item> [count] — make it (fetches missing ingredients on its own)',
  'smelt <item> [count] — smelt it (furnace + fuel handled)',
  'chop <count>        — chop trees for wood logs',
  'goto <x> <y> <z>    — walk to coordinates (y optional)',
  'eat                 — eat food now',
  'toss <item> [count] — drop items from inventory',
  'dropall             — ⚠️ drop the ENTIRE inventory (3s delay)',
  'afk on|off          — anti-afk mode',
  'status              — show bot status',
  'where               — show position',
  'help                — this list'
];

module.exports = { parseCommand, HELP_LINES };
