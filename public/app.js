/* ═══════════════════════════════════════════════════════════════
   NOKAR 2.0 — Dashboard client
   ═══════════════════════════════════════════════════════════════ */
/* global io */
(function () {
  'use strict';

  const socket = io();
  let snap = null;
  let selectedSlot = null;
  let logCount = 0;

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------
  // Auth flow
  // ------------------------------------------------------------------
  socket.on('need_auth', () => $('authOverlay').classList.remove('hidden'));
  socket.on('auth_ok', () => { $('authOverlay').classList.add('hidden'); $('authError').innerText = ''; });
  socket.on('auth_fail', (msg) => { $('authError').innerText = msg || 'Wrong password'; });

  $('authForm').addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('auth', $('authPass').value);
    $('authPass').value = '';
  });

  socket.on('hello', (info) => {
    $('serverInfo').innerText = `${info.server} · MC ${info.version}` + (info.owner ? ` · owner: ${info.owner}` : ' · ⚠ owner not set');
    if (!info.owner) {
      appendLog({ t: Date.now(), level: 'warn', msg: '⚠️ "owner" is not set in config.json — in-game commands are disabled. Set your IGN there!' });
    }
  });

  // ------------------------------------------------------------------
  // Logs / chat
  // ------------------------------------------------------------------
  function appendLog (d, isChat) {
    const box = $('logs');
    const atBottom = box.scrollTop + box.clientHeight > box.scrollHeight - 40;
    const row = document.createElement('div');
    if (isChat) {
      row.className = 'log-line chat';
      const time = new Date(d.t).toLocaleTimeString();
      row.innerHTML = `<span class="t">${time}</span><b></b>: `;
      row.querySelector('b').innerText = (d.user || '?') + (d.whisper ? ' (whisper)' : '');
      row.appendChild(document.createTextNode(d.msg || ''));
    } else {
      row.className = 'log-line ' + (d.level || 'info');
      const time = new Date(d.t || Date.now()).toLocaleTimeString();
      const t = document.createElement('span');
      t.className = 't';
      t.innerText = time;
      row.appendChild(t);
      row.appendChild(document.createTextNode(d.msg || ''));
    }
    box.appendChild(row);
    if (++logCount > 400) { box.removeChild(box.firstChild); logCount--; }
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  socket.on('log', (d) => appendLog(d, false));
  socket.on('chat', (d) => appendLog(d, true));
  socket.on('history', (list) => { (list || []).forEach((d) => appendLog(d, false)); });

  $('clearLogBtn').addEventListener('click', () => { $('logs').innerHTML = ''; logCount = 0; });

  // ------------------------------------------------------------------
  // Snapshot → UI
  // ------------------------------------------------------------------
  socket.on('snapshot', (s) => { snap = s; render(s); });

  function render (s) {
    // Header
    const pill = $('statePill');
    pill.innerText = s.state;
    pill.dataset.s = s.state;

    const badge = $('connBadge');
    const txt = $('connText');
    if (s.online && s.isReady) {
      badge.className = 'status-badge';
      txt.innerText = s.auth === 'pending' ? 'AUTH…' : 'OPERATIONAL';
    } else if (s.state === 'offline' || !s.online) {
      badge.className = 'status-badge off';
      txt.innerText = 'OFFLINE — RETRYING';
    }

    // Diagnostics
    $('diagName').innerText = s.username || '—';
    $('diagServer').innerText = s.server;
    $('diagOwner').innerText = s.owner || '⚠ not set';
    $('diagPos').innerText = s.pos ? `${s.pos.x}, ${s.pos.y}, ${s.pos.z}` : '—';
    $('diagSession').innerText = s.sessionSec ? fmtSec(s.sessionSec) + ' / up ' + fmtSec(s.uptimeSec) : '—';
    $('diagStats').innerText = `${s.stats.kills} / ${s.stats.deaths} / ${s.stats.reconnects}`;
    $('diagAuth').innerText = s.auth === 'logged_in' ? '✅ logged in' : s.auth === 'pending' ? '⏳ pending' : '—';

    // HP / food
    const hp = Math.max(0, s.health ?? 0), food = Math.max(0, s.food ?? 0);
    $('hpText').innerText = s.online ? `${Math.round(hp)} / 20` : '—';
    $('foodText').innerText = s.online ? `${Math.round(food)} / 20` : '—';
    const hpBar = $('hpBar');
    hpBar.style.width = (hp / 20 * 100) + '%';
    hpBar.style.background = hp > 12 ? 'var(--accent-green)' : hp > 6 ? 'var(--accent-gold)' : 'var(--accent-red)';
    $('foodBar').style.width = (food / 20 * 100) + '%';

    // Toggles
    const gb = $('guardBtn');
    gb.innerText = `🛡️ Guard: ${s.guard ? 'ON' : 'OFF'}`;
    gb.classList.toggle('on', !!s.guard);
    const ab = $('afkBtn');
    ab.innerText = `🔄 Anti-AFK: ${s.antiAfk ? 'ON' : 'OFF'}`;
    ab.classList.toggle('on', !!s.antiAfk);

    // Equipment
    if (s.held) {
      $('heldIcon').innerText = itemIcon(s.held.name);
      $('heldName').innerText = s.held.displayName;
      $('heldSub').innerText = 'Count: ' + s.held.count + ' · ' + s.held.name;
      if (s.held.maxDurability > 0) {
        const left = s.held.maxDurability - s.held.durabilityUsed;
        const pct = Math.max(0, Math.min(100, Math.round(left / s.held.maxDurability * 100)));
        $('duraWrap').style.display = 'block';
        const db = $('duraBar');
        db.style.width = pct + '%';
        db.style.background = pct > 50 ? 'var(--accent-green)' : pct > 20 ? 'var(--accent-gold)' : 'var(--accent-red)';
      } else {
        $('duraWrap').style.display = 'none';
      }
    } else {
      $('heldIcon').innerText = '✋';
      $('heldName').innerText = 'Empty Hand';
      $('heldSub').innerText = 'Count: 0';
      $('duraWrap').style.display = 'none';
    }
    const armorIcons = ['🪖', '🛡️', '👖', '🥾'];
    $('armorGrid').innerHTML = '';
    (s.armor || []).forEach((a, i) => {
      const div = document.createElement('div');
      div.className = 'armor-slot';
      if (a && a.name) {
        div.innerText = armorIcons[i] || '🦺';
        const small = document.createElement('small');
        small.innerText = a.displayName || a.name;
        div.appendChild(small);
        div.title = a.displayName || a.name;
      } else {
        div.innerText = armorIcons[i] || '🦺';
        div.style.opacity = 0.25;
      }
      $('armorGrid').appendChild(div);
    });
    $('offhandName').innerText = s.offhand ? s.offhand.displayName : 'None';

    // Players strip
    const strip = $('playersStrip');
    strip.innerHTML = '';
    if (s.players && s.players.length) {
      s.players.forEach((p) => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        const b = document.createElement('b'); b.innerText = p.name;
        const d = document.createElement('span'); d.className = 'dist';
        d.innerText = ' ' + (p.distance != null ? p.distance + 'm' : '?') + (p.ping != null ? ' · ' + p.ping + 'ms' : '');
        chip.appendChild(b); chip.appendChild(d);
        strip.appendChild(chip);
      });
    } else {
      const c = document.createElement('div');
      c.className = 'chip';
      c.innerText = s.online ? 'no other players online' : 'bot offline';
      strip.appendChild(c);
    }

    // Radar
    renderRadar(s);

    // Queue
    renderQueue(s.task);

    // Inventory
    renderInventory(s.inventory || []);
    $('invCount').innerText = (s.inventory || []).length + ' items';
  }

  function fmtSec (sec) {
    if (sec >= 3600) return Math.floor(sec / 3600) + 'h ' + Math.floor(sec % 3600 / 60) + 'm';
    if (sec >= 60) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    return sec + 's';
  }

  // ------------------------------------------------------------------
  // Radar
  // ------------------------------------------------------------------
  const cvs = $('radarCanvas');
  const ctx = cvs.getContext('2d');
  const RADAR_RANGE = 40;

  function renderRadar (s) {
    const W = cvs.width, H = cvs.height, cx = W / 2, cy = H / 2;
    const maxR = Math.min(W, H) / 2 - 14;
    ctx.fillStyle = '#04060a';
    ctx.fillRect(0, 0, W, H);

    // Rings
    ctx.strokeStyle = '#141c2b';
    ctx.fillStyle = '#31425c';
    ctx.font = '10px monospace';
    [10, 20, 30, 40].forEach((m) => {
      const r = m / RADAR_RANGE * maxR;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(m + 'm', cx + r - 16, cy - 3);
    });
    // Cross
    ctx.beginPath();
    ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR);
    ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy);
    ctx.stroke();

    // Self
    ctx.fillStyle = '#00f260';
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();

    if (!s.online || !s.pos) {
      $('radarInfo').innerText = 'offline';
      return;
    }

    // Facing arrow (yaw 0 = +Z in Minecraft; screen y grows downward)
    if (s.yaw !== undefined) {
      ctx.strokeStyle = '#00f260';
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx - Math.sin(s.yaw) * 18, cy + Math.cos(s.yaw) * 18);
      ctx.stroke();
    }

    let count = 0;
    (s.entities || []).forEach((e) => {
      const dx = e.x - s.pos.x, dz = e.z - s.pos.z;
      const scale = maxR / RADAR_RANGE;
      const px = cx + dx * scale, py = cy + dz * scale;
      ctx.fillStyle = e.kind === 'player' ? '#00d2ff' : e.kind === 'hostile' ? '#ff416c' : e.kind === 'animal' ? '#8493a8' : '#5b6b82';
      ctx.beginPath();
      ctx.arc(px, py, e.kind === 'player' ? 4 : 3.2, 0, Math.PI * 2);
      ctx.fill();
      if (e.kind === 'player' && e.dist < 30) {
        ctx.fillStyle = '#9fe8ff';
        ctx.font = '10px monospace';
        ctx.fillText(e.name, px + 6, py + 3);
      }
      count++;
    });
    const hostiles = (s.entities || []).filter((e) => e.kind === 'hostile').length;
    $('radarInfo').innerText = `${count} entities · ${hostiles} hostile`;
  }

  // ------------------------------------------------------------------
  // Task queue
  // ------------------------------------------------------------------
  function renderQueue (task) {
    const box = $('queueBox');
    box.innerHTML = '';
    if (!task || (!task.current && (!task.queue || !task.queue.length))) {
      const d = document.createElement('div');
      d.className = 'muted pad';
      d.innerText = 'No tasks queued';
      box.appendChild(d);
      return;
    }
    if (task.current) box.appendChild(queueRow(task.current, true));
    (task.queue || []).forEach((t) => box.appendChild(queueRow(t, false)));
  }

  function queueRow (t, running) {
    const row = document.createElement('div');
    row.className = 'queue-item' + (running ? ' running' : '');
    const label = document.createElement('span');
    label.className = 'q-label';
    label.innerText = (running ? '▶ ' : '• ') + t.label;
    row.appendChild(label);
    if (t.progress) {
      const pr = document.createElement('span');
      pr.className = 'q-progress';
      pr.innerText = t.progress;
      row.appendChild(pr);
    } else if (running) {
      const pr = document.createElement('span');
      pr.className = 'q-progress';
      pr.innerText = 'running…';
      row.appendChild(pr);
    }
    const cancel = document.createElement('button');
    cancel.className = 'q-cancel';
    cancel.innerText = '✕';
    cancel.title = 'Cancel task';
    cancel.onclick = () => socket.emit('task_cancel', { id: t.id });
    row.appendChild(cancel);
    return row;
  }

  // ------------------------------------------------------------------
  // Inventory
  // ------------------------------------------------------------------
  function renderInventory (items) {
    const main = $('mainGrid'), hotbar = $('hotbarGrid');
    main.innerHTML = ''; hotbar.innerHTML = '';
    for (let slot = 9; slot <= 35; slot++) main.appendChild(slotEl(slot, items, false));
    for (let slot = 36; slot <= 44; slot++) hotbar.appendChild(slotEl(slot, items, true));
    $('selIndicator').innerText = selectedSlot === null
      ? '— tap a slot to select, tap another to swap'
      : `slot ${selectedSlot} selected → tap target (or "Hold selected")`;
  }

  function slotEl (slot, items, isHotbar) {
    const div = document.createElement('div');
    div.className = 'slot' + (isHotbar ? ' hotbar' : '') + (selectedSlot === slot ? ' selected' : '');
    div.onclick = () => onSlotClick(slot);
    const it = items.find((x) => x.slot === slot);
    if (it) {
      const icon = document.createElement('span');
      icon.className = 'slot-icon';
      icon.innerText = itemIcon(it.name);
      const name = document.createElement('span');
      name.className = 'slot-name';
      name.innerText = it.displayName;
      div.appendChild(icon); div.appendChild(name);
      if (it.count > 1) {
        const qty = document.createElement('span');
        qty.className = 'slot-qty';
        qty.innerText = it.count;
        div.appendChild(qty);
      }
      div.title = `${it.displayName} x${it.count} (slot ${slot})`;
    }
    return div;
  }

  function onSlotClick (slot) {
    if (selectedSlot === null) selectedSlot = slot;
    else if (selectedSlot === slot) selectedSlot = null;
    else {
      socket.emit('swap', { source: selectedSlot, target: slot });
      selectedSlot = null;
    }
    renderInventory((snap && snap.inventory) || []);
  }

  $('holdBtn').addEventListener('click', () => {
    if (selectedSlot !== null) {
      socket.emit('swap', { source: selectedSlot, target: 'hand' });
      selectedSlot = null;
      renderInventory((snap && snap.inventory) || []);
    }
  });

  // ------------------------------------------------------------------
  // Item icons
  // ------------------------------------------------------------------
  function itemIcon (n) {
    if (!n) return '✋';
    n = n.toLowerCase();
    if (n.includes('sword')) return '⚔️';
    if (n.includes('pickaxe')) return '⛏️';
    if (n.includes('axe')) return '🪓';
    if (n.includes('shovel')) return '🥄';
    if (n.includes('hoe')) return '🌾';
    if (n.includes('bow') || n.includes('crossbow')) return '🏹';
    if (n.includes('arrow')) return '➶';
    if (n.includes('shield')) return '🛡️';
    if (n.includes('helmet')) return '🪖';
    if (n.includes('chestplate')) return '🦺';
    if (n.includes('leggings')) return '👖';
    if (n.includes('boots')) return '🥾';
    if (n.includes('totem')) return '🗿';
    if (n.includes('potion') || n.includes('egg')) return '🧪';
    if (n.includes('golden_apple')) return '🍏';
    if (n.includes('apple') || n.includes('bread') || n.includes('beef') || n.includes('pork') || n.includes('chicken') || n.includes('mutton') || n.includes('cooked') || n.includes('carrot') || n.includes('potato') || n.includes('stew') || n.includes('soup')) return '🍖';
    if (n.includes('bucket')) return '🪣';
    if (n.includes('book')) return '📖';
    if (n.includes('_log') || n.includes('planks')) return '🪵';
    if (n.includes('_ore') || n.includes('raw_')) return '🪨';
    if (n.includes('ingot') || n.includes('diamond') || n.includes('emerald')) return '💎';
    if (n.includes('tnt')) return '💥';
    if (n.includes('torch') || n.includes('lantern')) return '🔥';
    return '📦';
  }

  // ------------------------------------------------------------------
  // Mission control wiring
  // ------------------------------------------------------------------
  const sendCmd = (text) => { if (text) socket.emit('cmd', { text }); };

  $('followBtn').onclick = () => {
    const v = $('followName').value.trim();
    if (v) sendCmd('follow ' + v);
  };
  $('followName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('followBtn').onclick(); });

  $('mineBtn').onclick = () => {
    const b = $('mineBlock').value.trim() || 'stone';
    const c = parseInt($('mineCount').value, 10) || 1;
    sendCmd(`mine ${b} ${c}`);
  };

  $('gotoBtn').onclick = () => {
    const x = $('goX').value, y = $('goY').value, z = $('goZ').value;
    if (x !== '' && z !== '') sendCmd(`goto ${x} ${y !== '' ? y + ' ' : ''}${z}`);
  };

  $('comeBtn').onclick = () => sendCmd('come');
  $('chopBtn').onclick = () => sendCmd('chop 16');
  $('goalBtn').onclick = () => {
    const item = $('goalItem').value.trim();
    const count = Math.max(1, parseInt($('goalCount').value, 10) || 1);
    if (item) sendCmd(`goal ${item} ${count}`);
  };
  $('attackBtn').onclick = () => sendCmd('attack nearest');
  $('eatBtn').onclick = () => sendCmd('eat');
  $('stopBtn').onclick = () => sendCmd('stop');
  $('guardBtn').onclick = () => sendCmd('guard ' + (snap && snap.guard ? 'off' : 'on'));
  $('afkBtn').onclick = () => sendCmd('afk ' + (snap && snap.antiAfk ? 'off' : 'on'));
  $('clearQueueBtn').onclick = () => socket.emit('task_clear');

  document.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => socket.emit('move', { dir: b.dataset.move });
  });
  document.querySelectorAll('[data-action]').forEach((b) => {
    b.onclick = () => socket.emit('action', { type: b.dataset.action });
  });

  $('cmdForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('cmdInput').value.trim();
    if (v) { sendCmd(v); $('cmdInput').value = ''; }
  });

  $('fsBtn').onclick = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  };
})();
