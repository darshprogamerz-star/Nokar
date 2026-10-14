// Minimal RCON client for the local test server
const net = require('net');

function packet(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeInt16LE(0, 12 + payload.length);
  return buf;
}

function rconExec(commands, { host = '127.0.0.1', port = 25575, password = 'nokartest', timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    let stage = 'auth';
    let buffer = Buffer.alloc(0);
    const out = [];
    let id = 1;
    const timer = setTimeout(() => { sock.destroy(); resolve(out); }, timeout);

    sock.on('connect', () => sock.write(packet(id, 3, password)));
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 12) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < size + 4) break;
        const respId = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.slice(12, 4 + size - 2).toString('utf8');
        buffer = buffer.slice(4 + size);
        if (type === 2 && stage === 'auth') {
          stage = 'cmd';
          sendNext();
        } else if (type === 0 && body) {
          out.push(body);
          sendNext();
        }
      }
    });

    let idx = 0;
    function sendNext() {
      if (idx >= commands.length) {
        setTimeout(() => { clearTimeout(timer); sock.end(); resolve(out); }, 250);
        return;
      }
      id = 100 + idx;
      sock.write(packet(id, 2, commands[idx++]));
    }
  });
}

module.exports = { rconExec };

if (require.main === module) {
  rconExec(process.argv.slice(2)).then((r) => { console.log(r.join('\n')); process.exit(0); }).catch((e) => { console.error('RCON ERROR:', e.message); process.exit(1); });
}
