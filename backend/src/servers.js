// サーバー登録の検証・整形
const { validateAddress } = require('./netguard');
const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const TYPES = ['vanilla', 'modrinth', 'curseforge', 'ftb', 'mrpack', 'zip', 'manifest'];

let vCache = { at: 0, list: [] };
async function mojangVersions() {
  if (Date.now() - vCache.at < 600_000 && vCache.list.length) return vCache.list;
  const r = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  if (!r.ok) {
    if (vCache.list.length) return vCache.list;
    throw new Error('mojang_unavailable');
  }
  const j = await r.json();
  vCache = { at: Date.now(), list: j.versions.map((v) => ({ id: v.id, type: v.type })) };
  return vCache.list;
}

const httpsUrl = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && u.length <= 500 ? x.href : null; } catch { return null; }
};

// 戻り値: { value } か { error }
async function validate(body, { curseforge = false } = {}) {
  const b = body || {};
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const name = str(b.name, 30);
  if (!name) return { error: 'サーバー名を入力してください' };
  // 接続先: メイン1つ + 予備(最大3つ)。他の人から届かないアドレス(ローカル/プライベートIP)は拒否
  const rawList = [str(b.address, 100), ...(Array.isArray(b.altAddresses) ? b.altAddresses : String(b.altAddresses || '').split(/[\r\n,]+/)).map((x) => str(x, 100))].filter(Boolean);
  const addrs = [];
  for (const raw of rawList) {
    const r = validateAddress(raw);
    if (r.error) return { error: r.error };
    if (!addrs.includes(r.value)) addrs.push(r.value);
  }
  if (!str(b.address, 100) && addrs.length) return { error: '予備アドレスだけでなく、メインの接続先アドレスも入力してください' };
  if (addrs.length > 4) return { error: '予備アドレスは3つまでです' };
  const address = addrs[0] || '';
  const altAddresses = addrs.slice(1);
  const type = b.type;
  if (!TYPES.includes(type)) return { error: '種類が不正です' };

  const v = {
    name, description: str(b.description, 300), address, altAddresses, autoConnect: b.autoConnect !== false,
    type, source: '', minecraft: '', loader: 'vanilla', loaderVersion: '',
  };

  if (type === 'vanilla' || type === 'zip') {
    const mc = str(b.minecraft, 40);
    // zip だけは、バージョン/ローダーを空欄(自動)にでき、ランチャーが zip の中身から判定する
    const auto = type === 'zip';
    if (!(auto && !mc)) {
      const list = await mojangVersions();
      if (!list.some((x) => x.id === mc)) return { error: 'Minecraft のバージョンが存在しません' };
    }
    const loader = b.loader || (auto ? 'auto' : 'vanilla');
    if (!LOADERS.includes(loader) && !(auto && loader === 'auto')) return { error: 'ローダーが不正です' };
    const lv = str(b.loaderVersion, 50);
    if (lv && !/^[\w.+-]+$/.test(lv)) return { error: 'ローダーのバージョンが不正です' };
    Object.assign(v, { minecraft: mc, loader, loaderVersion: lv });
    if (type === 'zip') {
      const url = httpsUrl(str(b.source, 500));
      if (!url) return { error: 'https:// で始まるzipファイルのURLを入力してください' };
      v.source = url;
    }
  } else if (type === 'curseforge') {
    if (!curseforge) return { error: 'このサーバーでは CurseForge が有効になっていません(API キー未設定)' };
    const raw = str(b.source, 500);
    const slug = /curseforge\.com\/minecraft\/modpacks\/([a-z0-9-]+)/i.exec(raw)?.[1];
    const url = slug ? null : httpsUrl(raw);
    if (!slug && !url) return { error: 'CurseForge のモッドパックURL(https://www.curseforge.com/minecraft/modpacks/...)か、パックzipのURLを入力してください' };
    v.source = slug ? slug.toLowerCase() : url;
  } else if (type === 'ftb') {
    // FTB のパックページURL(https://www.feed-the-beast.com/modpacks/35-ftb-revelation)か、数字のパックID
    const raw = str(b.source, 300);
    const id = /feed-the-beast\.com\/modpacks\/(\d{1,8})/i.exec(raw)?.[1] || (/^\d{1,8}$/.test(raw) ? raw : null);
    if (!id) return { error: 'FTB のパックページのURL(https://www.feed-the-beast.com/modpacks/...)か、パックIDを入力してください' };
    // 実在するパックか確認(固定のホストへの問い合わせ。FTBに繋がらないときは確認せず通す)
    try {
      const r = await fetch(`https://api.feed-the-beast.com/v1/modpacks/public/modpack/${id}`, { signal: AbortSignal.timeout(6000) });
      const j = await r.json().catch(() => null);
      // 見つからないときは HTTP 404 + {"status":"error"} が返る
      if (r.status === 404 || j?.status === 'error') return { error: `FTB にパックID ${id} が見つかりません(非公開のパックは使えません)` };
    } catch { /* 確認できなくても登録は許可する */ }
    v.source = id;
  } else if (type === 'modrinth') {
    const raw = str(b.source, 300);
    const slug = /modrinth\.com\/modpack\/([\w-]+)/.exec(raw)?.[1] || (/^[\w-]{2,64}$/.test(raw) ? raw : null);
    if (!slug) return { error: 'Modrinth のモッドパックURL(https://modrinth.com/modpack/...)を入力してください' };
    v.source = slug;
  } else {
    const url = httpsUrl(str(b.source, 500));
    if (!url) return { error: 'https:// で始まるURLを入力してください' };
    v.source = url;
  }
  return { value: v };
}

const serialize = (r) => ({
  id: r.id, guildId: r.guild_id, name: r.name, description: r.description,
  address: r.address, altAddresses: r.alt_addresses ? r.alt_addresses.split('\n') : [], autoConnect: !!r.auto_connect,
  type: r.source_type, source: r.source, minecraft: r.minecraft,
  loader: r.loader, loaderVersion: r.loader_version, updatedAt: r.updated_at,
});

module.exports = { validate, serialize, mojangVersions, LOADERS };
