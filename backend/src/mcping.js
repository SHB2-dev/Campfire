// Minecraft Java Edition の Server List Ping(接続テスト用)
// バックエンドから外部へ接続するため、名前解決した結果が公開IPのときだけ、そのIPに直接つなぐ
// (名前解決のやり直しによるすり抜け=DNS rebinding を防ぐ)
const net = require('net');
const dns = require('dns').promises;
const { isPrivateIp, parseAddress } = require('./netguard');

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

// 戻り値: { value, size } か、データ不足なら null
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

function flattenText(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  return (d.text || '') + (Array.isArray(d.extra) ? d.extra.map(flattenText).join('') : '');
}

async function resolveTarget(host, port, explicitPort) {
  let h = host;
  let p = port;
  if (!net.isIP(h) && !explicitPort) {
    try { const srv = await dns.resolveSrv(`_minecraft._tcp.${h}`); if (srv[0]) { h = srv[0].name; p = srv[0].port; } } catch { /* SRVなし */ }
  }
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  const ip = addrs.map((a) => a.address).find((a) => !isPrivateIp(a));
  if (!ip) throw new Error('公開されているIPアドレスではありません');
  return { ip, port: p };
}

// address: "host" か "host:port"。戻り値: { online, latencyMs, version, players, motd } (失敗時は例外)
async function ping(address, timeoutMs = 4000) {
  const parsed = parseAddress(address);
  if (!parsed) throw new Error('アドレスの形式が不正です');
  const { ip, port } = await resolveTarget(parsed.host, parsed.port, parsed.explicitPort);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.connect({ host: ip, port });
    let buf = Buffer.alloc(0);
    const done = (fn, v) => { sock.destroy(); fn(v); };
    sock.setTimeout(timeoutMs, () => done(reject, new Error('応答がありません(タイムアウト)')));
    sock.on('error', (e) => done(reject, new Error(`接続できません: ${e.code || e.message}`)));
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
      if (buf.length > 262144) return done(reject, new Error('応答が大きすぎます'));
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
      } catch (e) { done(reject, new Error('Minecraftサーバーの応答ではありません')); }
    });
  });
}

module.exports = { ping };
