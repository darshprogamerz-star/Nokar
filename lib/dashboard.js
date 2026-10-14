/**
 * NOKAR 2.0 — Web dashboard server (Express + Socket.IO).
 * Serves /public and pushes live snapshots + logs to the browser.
 * Optional password gate via config.dashboardPassword.
 */
const http = require('http');
const path = require('path');
const express = require('express');
const socketIo = require('socket.io');

function startDashboard (config, engine) {
  const app = express();
  const server = http.createServer(app);
  const io = socketIo(server, { cors: { origin: '*' } });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  const password = String(config.dashboardPassword || '');
  const authRequired = password.length > 0;
  const sessions = new Set(); // authenticated socket ids

  // -------------------------------------------------------------------------
  // Socket.IO
  // -------------------------------------------------------------------------
  io.on('connection', (sock) => {
    const authed = !authRequired || sessions.has(sock.id);
    if (authRequired) {
      sock.emit('need_auth');
    } else {
      sessions.add(sock.id);
      sendHello(sock);
    }

    const gate = (handler) => (data) => {
      if (!sessions.has(sock.id)) return sock.emit('auth_fail', 'Not authenticated');
      try { handler(data); } catch (err) { console.error('[DASHBOARD] handler error:', err.message); }
    };

    sock.on('auth', (pw) => {
      if (String(pw || '') === password) {
        sessions.add(sock.id);
        sock.emit('auth_ok');
        sendHello(sock);
        engine.log('🔓 Dashboard session authenticated');
      } else {
        sock.emit('auth_fail', 'Wrong password');
      }
    });

    sock.on('cmd', gate((data) => {
      const text = String(data?.text || '').trim();
      if (text) engine.handleCommandText(text, 'dashboard');
    }));

    sock.on('move', gate((data) => engine.move(String(data?.dir || ''))));

    sock.on('action', gate((data) => engine.action(String(data?.type || ''))));

    sock.on('swap', gate((data) => {
      const source = Number(data?.source);
      const target = data?.target === 'hand' ? 'hand' : Number(data?.target);
      if (Number.isInteger(source) && (target === 'hand' || Number.isInteger(target))) {
        engine.swapSlots(source, target);
      }
    }));

    sock.on('task_cancel', gate((data) => engine.brain.cancel(Number(data?.id))));
    sock.on('task_clear', gate(() => engine.brain.stopAll('dashboard clear')));

    sock.on('disconnect', () => sessions.delete(sock.id));

    function sendHello (target) {
      target.emit('hello', {
        passwordRequired: authRequired,
        owner: config.mc.owner || null,
        server: `${config.mc.host}:${config.mc.port}`,
        version: config.mc.version
      });
      target.emit('snapshot', engine.snapshot());
      target.emit('history', engine.getLogHistory ? engine.getLogHistory() : []);
    }
  });

  // -------------------------------------------------------------------------
  // Live event fan-out
  // -------------------------------------------------------------------------
  const broadcast = (event, payload) => io.emit(event, payload);
  engine.on('log', (d) => broadcast('log', d));
  engine.on('chat', (d) => broadcast('chat', d));
  engine.on('state', () => broadcast('snapshot', engine.snapshot()));
  engine.on('queue', () => broadcast('snapshot', engine.snapshot()));

  const snapshotTimer = setInterval(() => {
    if (io.engine.clientsCount > 0) broadcast('snapshot', engine.snapshot());
  }, 1000);

  // -------------------------------------------------------------------------
  server.listen(config.webPort, '0.0.0.0', () => {
    console.log(`[DASHBOARD] 🎛️  http://localhost:${config.webPort}  ${authRequired ? '(password protected)' : '(no password — set dashboardPassword in config.json)'}`);
  });

  return { app, server, io, close: () => { clearInterval(snapshotTimer); server.close(); } };
}

module.exports = { startDashboard };
