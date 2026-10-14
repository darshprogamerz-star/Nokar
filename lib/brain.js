/**
 * NOKAR 2.0 — Brain: task queue + state machine
 * Every ability is a "task". Tasks run one-at-a-time, FIFO, and can be
 * cancelled at any time. The brain owns high-level state (idle/following/
 * fighting/mining/...) and emits it for the dashboard.
 */
const { sleep } = require('./helpers');

const STATE_BY_TASK = {
  follow: 'following',
  come: 'moving',
  goto: 'moving',
  mine: 'grinding',
  chop: 'grinding',
  goal: 'planning',
  craft: 'crafting',
  smelt: 'smelting',
  attack: 'fighting',
  eat: 'eating',
  flee: 'fleeing',
  toss: 'working',
  dropall: 'working'
};

class Brain {
  constructor (engine) {
    this.engine = engine;
    this.state = 'boot';          // boot | idle | offline | dead | <task states>
    this.queue = [];
    this.current = null;
    this.guard = false;           // auto-defend mode
    this.antiAfk = false;         // manual anti-afk toggle
    this.antiAfkTimer = null;
    this.taskSeq = 0;
    this.paused = false;
  }

  log (msg, level = 'info') {
    this.engine.emit('log', { t: Date.now(), msg, level });
  }

  setState (state) {
    if (this.state === state) return;
    this.state = state;
    this.engine.emit('state', state);
  }

  get isBusy () {
    return !!this.current;
  }

  // -------------------------------------------------------------------------
  // Task queue
  // -------------------------------------------------------------------------
  enqueue (type, args = {}, label = null) {
    const task = {
      id: ++this.taskSeq,
      type,
      args,
      label: label || `${type}${args.player ? ' ' + args.player : ''}${args.block ? ' ' + args.block : ''}`,
      status: 'queued',
      progress: null,
      createdAt: Date.now(),
      cancelled: false
    };
    this.queue.push(task);
    this.emitQueue();
    if (!this.current) this._runNext();
    return task;
  }

  /** Cancel one queued (or the running) task by id. */
  cancel (id) {
    if (this.current && this.current.id === id) {
      this.current.cancelled = true;
      this.log(`⏹️ Cancelling: ${this.current.label}`, 'warn');
      return true;
    }
    const idx = this.queue.findIndex((t) => t.id === id);
    if (idx !== -1) {
      this.queue[idx].status = 'cancelled';
      this.queue.splice(idx, 1);
      this.emitQueue();
      return true;
    }
    return false;
  }

  /** Nuke everything: running task, queue, pathfinder, combat, controls. */
  stopAll (reason = 'manual stop') {
    if (this.current) {
      this.current.cancelled = true;
      this.log(`⏹️ Stopped: ${this.current.label} (${reason})`, 'warn');
    }
    this.queue = [];
    const bot = this.engine.bot;
    if (bot) {
      try { if (bot.pathfinder) bot.pathfinder.setGoal(null); } catch (e) {}
      const { releaseControls } = require('./helpers');
      releaseControls(bot);
      try { bot.deactivateItem(); } catch (e) {}
    }
    this.emitQueue();
  }

  emitQueue () {
    this.engine.emit('queue', this.queueSnapshot());
  }

  queueSnapshot () {
    return {
      current: this.current
        ? { id: this.current.id, label: this.current.label, type: this.current.type, progress: this.current.progress, status: 'running' }
        : null,
      queue: this.queue.map((t) => ({ id: t.id, label: t.label, type: t.type, status: t.status }))
    };
  }

  updateProgress (task, progress) {
    task.progress = progress;
    this.emitQueue();
  }

  async _runNext () {
    if (this.current || this.paused) return;
    const task = this.queue.shift();
    if (!task) {
      this.setState(this.engine.isReady ? 'idle' : this.state);
      this.emitQueue();
      return;
    }

    this.current = task;
    task.status = 'running';
    this.setState(STATE_BY_TASK[task.type] || 'working');
    this.emitQueue();

    const skills = require('./skills');
    const runner = skills[task.type];
    try {
      if (!runner) throw new Error(`unknown task type "${task.type}"`);
      await runner(this.engine, task);
      if (task.cancelled) {
        task.status = 'cancelled';
      } else {
        task.status = 'done';
        this.log(`✅ ${task.label} — done`);
      }
    } catch (err) {
      if (task.cancelled) {
        task.status = 'cancelled';
      } else {
        task.status = 'failed';
        this.log(`❌ ${task.label} — ${err.message}`, 'error');
      }
    } finally {
      this.current = null;
      const bot = this.engine.bot;
      if (bot) {
        try { if (bot.pathfinder) bot.pathfinder.setGoal(null); } catch (e) {}
        const { releaseControls } = require('./helpers');
        releaseControls(bot);
      }
      this.emitQueue();
      if (!this.paused && this.queue.length) {
        await sleep(250);
        this._runNext();
      } else {
        this.setState(this.engine.isReady ? 'idle' : this.state);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Guard mode (auto-defend) — survival.js polls and enqueues attack tasks
  // -------------------------------------------------------------------------
  setGuard (on) {
    this.guard = !!on;
    this.log(on ? '🛡️ Guard mode ON — I will defend this area' : '🛡️ Guard mode OFF');
    this.engine.emit('state', this.state);
  }

  toggleGuard () {
    this.setGuard(!this.guard);
    return this.guard;
  }

  // -------------------------------------------------------------------------
  // Anti-AFK (only moves when idle, so it never fights the pathfinder)
  // -------------------------------------------------------------------------
  toggleAntiAfk (on = !this.antiAfk) {
    this.antiAfk = !!on;
    if (this.antiAfkTimer) {
      clearInterval(this.antiAfkTimer);
      this.antiAfkTimer = null;
    }
    if (this.antiAfk) {
      this.antiAfkTimer = setInterval(async () => {
        const bot = this.engine.bot;
        if (!bot || !bot.entity || this.current || this.paused) return;
        if (bot.pathfinder) {
          try { if (bot.pathfinder.isMoving()) return; } catch (e) {}
        }
        try {
          const yaw = bot.entity.yaw + (Math.random() - 0.5) * 1.2;
          const pitch = (Math.random() - 0.5) * 0.4;
          await bot.look(yaw, pitch, true).catch(() => {});
          if (Math.random() < 0.35) {
            const dir = ['forward', 'back', 'left', 'right'][Math.floor(Math.random() * 4)];
            bot.setControlState(dir, true);
            setTimeout(() => { try { bot.setControlState(dir, false); } catch (e) {} }, 220 + Math.random() * 200);
          }
        } catch (e) { /* ignore */ }
      }, 5200);
      this.log('🔄 Anti-AFK ON');
    } else {
      this.log('🔄 Anti-AFK OFF');
    }
    return this.antiAfk;
  }

  pause () {
    this.paused = true;
    if (this.current) this.current.cancelled = true;
    this.queue = [];
  }

  resume () {
    this.paused = false;
    if (!this.current && this.queue.length) this._runNext();
  }

  get statusLine () {
    const engine = this.engine;
    const bot = engine.bot;
    const parts = [`state=${this.state}`];
    if (bot && bot.entity) {
      const p = bot.entity.position;
      parts.push(`pos=(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`);
      parts.push(`hp=${bot.health?.toFixed(0) ?? '?'}`);
      parts.push(`food=${bot.food ?? '?'}`);
    } else {
      parts.push('bot=offline');
    }
    if (this.current) parts.push(`task="${this.current.label}"`);
    if (this.queue.length) parts.push(`queued=${this.queue.length}`);
    if (this.guard) parts.push('guard=ON');
    if (this.antiAfk) parts.push('afk=ON');
    return parts.join(' | ');
  }
}

module.exports = { Brain };
