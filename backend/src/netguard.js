// 接続先アドレスの検証と、内部ネットワークへの接続(SSRF)を防ぐためのガード
const net = require('net');

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

// ループバック・プライベート・リンクローカル等(公開インターネットから到達できないIP)
function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); // IPv4射影アドレス
    if (mapped) return isPrivateIp(mapped[1]);
  }
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/i;

// "host" か "host:port" を解析。不正なら null
function parseAddress(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(raw.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 25565;
  if (port < 1 || port > 65535) return null;
  return { host: m[1].toLowerCase(), port, explicitPort: !!m[2] };
}

// 登録用の検証。戻り値: { value: 正規化した文字列 } か { error }
function validateAddress(raw) {
  const p = parseAddress(raw);
  if (!p) return { error: `接続先「${String(raw).slice(0, 60)}」は host または host:port の形式で入力してください` };
  if (LOCAL_NAMES.test(p.host) || isPrivateIp(p.host)) {
    return { error: `「${p.host}」は他の人から接続できないアドレスです(ローカル/プライベートIP)。公開されたIPかドメインを入力してください` };
  }
  return { value: p.explicitPort ? `${p.host}:${p.port}` : p.host };
}

module.exports = { isPrivateIp, parseAddress, validateAddress };
