// Minecraft Java Edition の Server List Ping(サーバーの稼働状況の表示・接続先の自動切り替え用)
// ランチャーを使う本人のPCから接続する。プロトコルの実装は backend/src/mcping.js と同じ
const net = require('net');
const dns = require('dns').promises;

const varint = (n) => {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>>= 7;
    if (n) out.push(b | 0x80); else { out.push(b); break; }
  }
  return Buffer.from(out);
};
const mcString = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varint(b.length), b]); };
const packet = (payload) => Buffer.concat([varint(payload.length), payload]);

function readVarint(buf, offset) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i];
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return { value, size: i + 1 };
  }
  throw new Error('不正な応答');
}

const flattenText = (d) => (!d ? '' : typeof d === 'string' ? d : (d.text || '') + (Array.isArray(d.extra) ? d.extra.map(flattenText).join('') : ''));

// "host" か "host:port"。不正なら null
function parseAddress(raw) {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(String(raw || '').trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 25565;
  return port >= 1 && port <= 65535 ? { host: m[1], port, explicitPort: !!m[2] } : null;
}

async function ping(address, timeoutMs = 3000) {
  const parsed = parseAddress(address);
  if (!parsed) throw new Error('アドレスの形式が不正です');
  let { host, port } = parsed;
  if (!net.isIP(host) && !parsed.explicitPort) {
    try { const srv = await dns.resolveSrv(`_minecraft._tcp.${host}`); if (srv[0]) { host = srv[0].name; port = srv[0].port; } } catch { /* SRVなし */ }
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const done = (fn, v) => { sock.destroy(); fn(v); };
    sock.setTimeout(timeoutMs, () => done(reject, new Error('timeout')));
    sock.on('error', (e) => done(reject, e));
    sock.on('connect', () => {
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(parsed.port);
      sock.write(Buffer.concat([
        packet(Buffer.concat([varint(0), varint(765), mcString(parsed.host), portBuf, varint(1)])),
        packet(varint(0)),
      ]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 262144) return done(reject, new Error('too large'));
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const id = readVarint(buf, len.size);
        const strLen = readVarint(buf, len.size + id.size);
        if (!strLen) return;
        const start = len.size + id.size + strLen.size;
        if (buf.length < start + strLen.value) return;
        const json = JSON.parse(buf.subarray(start, start + strLen.value).toString('utf8'));
        done(resolve, {
          online: true,
          latencyMs: Date.now() - started,
          version: String(json.version?.name || '').slice(0, 40),
          players: { online: json.players?.online ?? 0, max: json.players?.max ?? 0 },
          motd: flattenText(json.description).replace(/§./g, '').slice(0, 100),
        });
      } catch { done(reject, new Error('bad response')); }
    });
  });
}

module.exports = { ping, parseAddress };
