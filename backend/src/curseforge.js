// CurseForge API の中継。API キー(CURSEFORGE_API_KEY)はサーバーだけが持ち、ランチャーには渡さない
const API = 'https://api.curseforge.com/v1';
const KEY = process.env.CURSEFORGE_API_KEY || '';
const GAME_MINECRAFT = 432;
const CLASS_MODPACKS = 4471;

const enabled = () => !!KEY;

async function cf(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { 'x-api-key': KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw Object.assign(new Error(`CurseForge API エラー (${r.status})`), { status: 502 });
  return (await r.json()).data;
}

// downloadUrl が null(サードパーティ配布を許可していない作者)の場合は公開CDNのURLを試す。
// 配布が禁止されているファイルはここで 403 になり、ランチャー側でエラーとして表示される
const edgeUrl = (id, name) => `https://edge.forgecdn.net/files/${Math.floor(id / 1000)}/${id % 1000}/${encodeURIComponent(name)}`;

function shape(f) {
  return {
    id: f.id,
    modId: f.modId,
    fileName: String(f.fileName),
    displayName: f.displayName,
    sha1: f.hashes?.find((h) => h.algo === 1)?.value || null,
    url: f.downloadUrl || edgeUrl(f.id, f.fileName),
    direct: !!f.downloadUrl,
  };
}

const cache = new Map(); // fileId -> { at, info }
const TTL = 3600_000;

// fileId の一覧 → ファイル情報。大きなパックでも200件ずつに分けて問い合わせ、1時間キャッシュする
async function filesInfo(ids) {
  const unique = [...new Set(ids)];
  if (unique.length > 1500 || unique.some((n) => !Number.isInteger(n) || n < 1 || n > 2 ** 31)) {
    throw Object.assign(new Error('bad_request'), { status: 400 });
  }
  const now = Date.now();
  const missing = unique.filter((id) => !(cache.get(id)?.at > now - TTL));
  for (let i = 0; i < missing.length; i += 200) {
    const data = await cf('/mods/files', { method: 'POST', body: JSON.stringify({ fileIds: missing.slice(i, i + 200) }) });
    for (const f of data) cache.set(f.id, { at: now, info: shape(f) });
  }
  return unique.map((id) => cache.get(id)?.info).filter(Boolean);
}

// モッドパックのスラッグ → 最新のリリースファイル
async function latestPack(slug) {
  if (!/^[a-z0-9][a-z0-9-]{1,99}$/.test(slug)) throw Object.assign(new Error('bad_request'), { status: 400 });
  const q = new URLSearchParams({ gameId: GAME_MINECRAFT, classId: CLASS_MODPACKS, slug, pageSize: 1 });
  const mod = (await cf(`/mods/search?${q}`))[0];
  if (!mod) throw Object.assign(new Error('CurseForge のパックが見つかりません'), { status: 404 });
  const files = (mod.latestFiles || []).slice().sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
  const f = files.find((x) => x.releaseType === 1) || files[0];
  if (!f) throw Object.assign(new Error('配布ファイルがありません'), { status: 404 });
  return { name: mod.name, ...shape(f) };
}

module.exports = { enabled, filesInfo, latestPack };
