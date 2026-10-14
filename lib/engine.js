/**
 * NOKAR 2.0 — Engine: bot lifecycle, plugins, event wiring, state snapshot.
 */
const EventEmitter = require('events');
const mineflayer = require('mineflayer');
const { Brain } = require('./brain');
const { attachSurvival, detachSurvival } = require('./survival');
const { parseCommand, HELP_LINES } = require('./commands');
const { classifyEntity, findPlayerEntity, releaseControls } = require('./helpers');

class Engine extends EventEmitter {
  constructor (config) {
    super();
    this.setMaxListeners(50);
    this.config = config;
    this.bot = null;
    this.brain = new Brain(this);
    this.startedAt = Date.now();
    this.botStartedAt = null;
    this.stats = { kills: 0, deaths: 0, reconnects: 0 };
    this.authState = 'none';
    this.isReady = false;
    this._relaunchTimer = null;
    this._relaunchDelay = config.mc.reconnectDelayMs;
    this._afkInitOnce = false;

    // Recent log ring-buffer (sent to freshly connected dashboards)
    this._logHistory = [];
    this.on('log', (d) => {
      this._logHistory.push(d);
      if (this._logHistory.length > 150) this._logHistory.shift();
    });
  }

  log (msg, level = 'info') {
    this.brain.log(msg, level);
  }

  getLogHistory () {
    return this._logHistory.slice(-150);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================
  start () {
    this.launchBot();
  }

  launchBot () {
    const mc = this.config.mc;
    this.log(`🔌 Connecting to ${mc.host}:${mc.port} as ${mc.username} (MC ${mc.version})...`);

    const bot = mineflayer.createBot({
      host: mc.host,
      port: mc.port,
      username: mc.username,
      auth: 'offline',
      version: mc.version,
      respawn: true,
      skipValidation: true,
      checkTimeoutInterval: 120000,
      closeTimeout: 120000,
      noPongTimeout: 120000
    });

    this.bot = bot;
    this.isReady = false;
    this.authState = mc.password ? 'pending' : 'none';
    this._loadPlugins(bot);
    this._wireEvents(bot);
  }

  _loadPlugins (bot) {
    try {
      const { pathfinder } = require('mineflayer-pathfinder');
      bot.loadPlugin(pathfinder);
      this.log('🧠 pathfinder loaded');
    } catch (err) {
      this.log(`⚠️ pathfinder failed to load: ${err.message}`, 'error');
    }
    try {
      const { plugin: collectBlock } = require('mineflayer-collectblock');
      bot.loadPlugin(collectBlock);
      this.log('⛏️ collectblock loaded');
    } catch (err) {
      this.log(`⚠️ collectblock failed to load: ${err.message}`, 'error');
    }
  }

  _wireEvents (bot) {
    const mc = this.config.mc;

    bot.on('connect', () => this.log('🌐 TCP connected'));

    bot.on('spawn', () => {
      const firstSpawn = !this.isReady;
      this.isReady = true;
      this.botStartedAt = Date.now();
      this._relaunchDelay = mc.reconnectDelayMs;

      // Pathfinder movements (once per bot instance)
      try {
        const { Movements } = require('mineflayer-pathfinder');
        const moves = new Movements(bot);
        moves.canDig = false;          // don't tunnel through people's builds
        moves.allowParkour = true;
        moves.allow1by1towers = false;
        bot.pathfinder.setMovements(moves);
      } catch (e) { /* ignore */ }

      if (firstSpawn) {
        this.log(`🤖 ${bot.username} is LIVE on ${mc.host}!`);
        if (this.config.behavior.antiAfk && !this._afkInitOnce) {
          this._afkInitOnce = true;
          this.brain.toggleAntiAfk(true);
        }
      } else {
        this.log('👼 Respawned');
      }

      this.brain.setState('idle');
      attachSurvival(this);
      this._maybeLogin(bot);
      this.emit('state', this.brain.state);
    });

    // ---- Auth (AuthMe-style login plugins) ----
    let lastLoginAttempt = 0;
    let registerAttempted = false;
    bot.on('messagestr', (message) => {
      const lower = String(message).toLowerCase();
      if (/successfully logged in|logged in successfully|you are now logged/.test(lower)) {
        if (this.authState !== 'logged_in') {
          this.authState = 'logged_in';
          this.log('🔐 Logged in to the server auth plugin');
        }
      } else if (/(please|you need to) (log ?in|register)|use \/login/.test(lower)) {
        if (mc.password && Date.now() - lastLoginAttempt > 4000) {
          lastLoginAttempt = Date.now();
          bot.chat(`/login ${mc.password}`);
          this.log('🔐 Sent /login');
        } else if (!mc.password) {
          this.log('⚠️ Server wants /login but no password set in config.json!', 'warn');
        }
      } else if (/\/register|not registered|please register/.test(lower) && mc.password && !registerAttempted) {
        registerAttempted = true;
        bot.chat(`/register ${mc.password} ${mc.password}`);
        this.log('🔐 Sent /register');
      } else if (/wrong password|incorrect password/.test(lower)) {
        this.log('❌ Auth plugin rejected the password — check config.json', 'error');
      }
    });

    bot.on('chat', (username, message) => {
      if (!username || username === bot.username) return;
      this.emit('chat', { t: Date.now(), user: username, msg: message });
      this._handleInGameCommand(username, message, 'chat');
    });

    bot.on('whisper', (username, message) => {
      if (!username || username === bot.username) return;
      this.emit('chat', { t: Date.now(), user: username, msg: message, whisper: true });
      this._handleInGameCommand(username, message, 'whisper');
    });

    bot.on('playerJoined', (player) => {
      if (player.username !== bot.username) this.log(`🟢 ${player.username} joined`);
    });
    bot.on('playerLeft', (player) => {
      if (player.username !== bot.username) this.log(`🔴 ${player.username} left`);
    });

    bot.on('death', () => {
      this.stats.deaths++;
      this.log('☠️ I died! Respawning...', 'error');
      this.brain.stopAll('death');
      this.brain.setState('dead');
    });

    bot.on('kicked', (reason) => {
      let text = reason;
      try { text = typeof reason === 'string' ? reason : JSON.stringify(reason); } catch (e) {}
      this.stats.lastKickReason = text;
      this.log(`🥾 Kicked: ${text}`, 'error');
    });

    bot.on('error', (err) => {
      this.log(`⚠️ Connection error: ${err.message}`, 'error');
    });

    bot.on('end', (reason) => {
      const sessionLen = this.botStartedAt ? Date.now() - this.botStartedAt : 0;
      this.isReady = false;
      detachSurvival(this);
      this.brain.stopAll('disconnected');
      this.brain.setState('offline');
      this.log(`🔌 Disconnected (${reason || 'unknown'}) — retrying...`, 'warn');

      // Backoff: if we keep dropping fast (server throttling re-logins), slow down
      if (sessionLen < 30000) {
        this._relaunchDelay = Math.min(Math.round(this._relaunchDelay * 1.5), 120000);
      } else {
        this._relaunchDelay = this.config.mc.reconnectDelayMs;
      }
      this.stats.reconnects++;
      this._relaunchTimer = setTimeout(() => this.launchBot(), this._relaunchDelay);
    });
  }

  _maybeLogin (bot) {
    const mc = this.config.mc;
    if (!mc.password) return;
    setTimeout(() => {
      try { bot.chat(`/login ${mc.password}`); } catch (e) {}
    }, 1500);
  }

  /** In-game commands: only accepted from the owner (config.json → mc.owner). */
  _handleInGameCommand (username, message, source) {
    const owner = this.config.mc.owner;
    if (!owner) {
      if (!this._noOwnerWarned) {
        this._noOwnerWarned = true;
        this.log('⚠️ "owner" is not set in config.json — in-game commands are DISABLED for everyone. Set your IGN there!', 'warn');
      }
      return;
    }
    // Bedrock/Geyser players may appear as ".Name" or "*Name" — match on the clean name
    const { normalizeOwner } = require('./helpers');
    if (normalizeOwner(username) !== normalizeOwner(owner)) return; // strangers: ignored
    const clean = String(message).trim();
    if (!clean) return;
    this.handleCommandText(clean, `mc:${source}:${username}`);
  }

  /** Unified command entry used by in-game chat AND the dashboard. */
  handleCommandText (text, source = 'dashboard') {
    const parsed = parseCommand(text);
    if (!parsed) return;

    switch (parsed.type) {
      case 'stop':
        this.brain.stopAll('command');
        this.log('⏹️ Everything stopped');
        return;
      case 'guard': {
        const on = parsed.args.on === undefined ? !this.brain.guard : parsed.args.on;
        this.brain.setGuard(on);
        return;
      }
      case 'afk': {
        const on = parsed.args.on === undefined ? !this.brain.antiAfk : parsed.args.on;
        this.brain.toggleAntiAfk(on);
        return;
      }
      case 'status':
        this.log(`📊 ${this.brain.statusLine}`);
        return;
      case 'where': {
        const bot = this.bot;
        if (bot && bot.entity) {
          const p = bot.entity.position;
          this.log(`📍 Position: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} (dim: ${bot.game?.dimension || '?'})`);
        } else {
          this.log('📍 Bot is offline', 'warn');
        }
        return;
      }
      case 'help':
        for (const line of HELP_LINES) this.log(`💡 ${line}`);
        return;
      case 'unknown':
        this.log(`❓ Unknown command "${parsed.raw}" — type "help"`, 'warn');
        return;
    }

    // Everything below is a queued task → requires a live bot
    if (!this.isReady || !this.bot || !this.bot.entity) {
      this.log('⚠️ Bot is offline — cannot start task right now', 'warn');
      return;
    }
    if (source.startsWith('mc:')) this.log(`📥 Command from ${source.split(':').pop()}: ${text}`);

    const label = text.replace(/^[.!]/, '');
    switch (parsed.type) {
      case 'follow': this.brain.enqueue('follow', { player: parsed.args.player }, label); break;
      case 'come': this.brain.enqueue('come', {}, label); break;
      case 'goto': this.brain.enqueue('goto', parsed.args, label); break;
      case 'mine': this.brain.enqueue('mine', parsed.args, label); break;
      case 'chop': this.brain.enqueue('chop', parsed.args, label); break;
      case 'goal': this.brain.enqueue('goal', { item: parsed.args.item, count: parsed.args.count }, label); break;
      case 'craft': this.brain.enqueue('craft', { item: parsed.args.item, count: parsed.args.count }, label); break;
      case 'smelt': this.brain.enqueue('smelt', { item: parsed.args.item, count: parsed.args.count }, label); break;
      case 'attack': this.brain.enqueue('attack', { target: parsed.args.target }, label); break;
      case 'flee': this.brain.enqueue('flee', parsed.args, label); break;
      case 'eat': this.brain.enqueue('eat', {}, label); break;
      case 'toss': this.brain.enqueue('toss', parsed.args, label); break;
      case 'dropall': this.brain.enqueue('dropall', {}, label); break;
      default:
        this.log(`❓ Command type "${parsed.type}" has no handler`, 'warn');
    }
  }

  // ==========================================================================
  // Manual controls (dashboard buttons)
  // ==========================================================================
  move (dir) {
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    if (this.brain.isBusy) return this.log('⚠️ Busy with a task — press Stop first', 'warn');
    if (dir === 'jump') {
      bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) {} }, 300);
      return;
    }
    if (['forward', 'back', 'left', 'right'].includes(dir)) {
      bot.setControlState(dir, true);
      setTimeout(() => { try { bot.setControlState(dir, false); } catch (e) {} }, 350);
    }
  }

  async action (type) {
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    if (this.brain.isBusy) return this.log('⚠️ Busy with a task — press Stop first', 'warn');
    try {
      if (type === 'break') {
        const block = bot.blockAtCursor(4);
        if (block && block.name !== 'air') await bot.dig(block).catch(() => {});
        else bot.swingArm('right');
      } else if (type === 'interact') {
        const block = bot.blockAtCursor(4);
        if (block && block.name !== 'air') await bot.activateBlock(block).catch(() => {});
        else bot.activateItem();
      }
    } catch (e) { /* ignore */ }
  }

  async swapSlots (source, target) {
    const bot = this.bot;
    if (!bot || !bot.inventory) return;
    try {
      if (target === 'hand') {
        const item = bot.inventory.slots[source];
        if (item) await bot.equip(item, 'hand').catch((e) => this.log(`⚠️ equip failed: ${e.message}`, 'warn'));
        return;
      }
      if (typeof bot.moveSlotItem === 'function') {
        await bot.moveSlotItem(source, target);
      } else {
        await bot.clickWindow(source, 0, 0);
        await bot.clickWindow(target, 0, 0);
        if (bot.inventory.selectedItem) await bot.clickWindow(source, 0, 0);
      }
    } catch (err) {
      this.log(`⚠️ Swap failed: ${err.message}`, 'warn');
    }
  }

  // ==========================================================================
  // Snapshot for the dashboard (called ~1x/sec)
  // ==========================================================================
  snapshot () {
    const bot = this.bot;
    const online = !!(bot && bot.entity);
    const brain = this.brain;

    const snap = {
      ts: Date.now(),
      online,
      isReady: this.isReady,
      auth: this.authState,
      server: `${this.config.mc.host}:${this.config.mc.port}`,
      version: this.config.mc.version,
      owner: this.config.mc.owner || null,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      sessionSec: this.botStartedAt ? Math.round((Date.now() - this.botStartedAt) / 1000) : 0,
      stats: { ...this.stats },
      state: brain.state,
      guard: brain.guard,
      antiAfk: brain.antiAfk,
      task: brain.queueSnapshot()
    };

    if (!online) return snap;

    try {
      const p = bot.entity.position;
      snap.username = bot.username;
      snap.pos = { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) };
      snap.yaw = bot.entity.yaw;
      snap.health = bot.health ?? 20;
      snap.food = bot.food ?? 20;

      // Held + offhand
      snap.held = bot.heldItem ? itemInfo(bot.heldItem) : null;
      const off = bot.inventory.slots[45];
      snap.offhand = off ? itemInfo(off) : null;

      // Armor (slots 5-8 of player inventory)
      snap.armor = [5, 6, 7, 8].map((slot) => {
        const it = bot.inventory.slots[slot];
        return it ? { slot, ...itemInfo(it) } : { slot, name: null };
      });

      // Inventory (36 main slots)
      snap.inventory = bot.inventory.items().map((i) => ({
        slot: i.slot,
        name: i.name,
        displayName: i.displayName || i.name.replace(/_/g, ' '),
        count: i.count
      }));

      // Players
      snap.players = Object.values(bot.players || {})
        .filter((pl) => pl.username !== bot.username)
        .map((pl) => {
          const ent = pl.entity;
          return {
            name: pl.username,
            ping: pl.ping,
            distance: ent ? +bot.entity.position.distanceTo(ent.position).toFixed(1) : null
          };
        })
        .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));

      // Radar entities (players + mobs within 40 blocks)
      const me = bot.entity;
      snap.entities = Object.values(bot.entities)
        .filter((e) => e !== me && e.position && me.position.distanceTo(e.position) <= 40)
        .slice(0, 80)
        .map((e) => ({
          name: e.username || e.name || '?',
          kind: classifyEntity(e),
          x: e.position.x,
          z: e.position.z,
          dist: +me.position.distanceTo(e.position).toFixed(1)
        }));
    } catch (err) {
      snap.error = err.message;
    }
    return snap;
  }
}

function itemInfo (item) {
  return {
    name: item.name,
    displayName: item.displayName || item.name.replace(/_/g, ' '),
    count: item.count,
    maxDurability: item.maxDurability || 0,
    durabilityUsed: item.durabilityUsed || 0
  };
}

module.exports = { Engine };
