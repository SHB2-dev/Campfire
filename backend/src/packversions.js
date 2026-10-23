// 管理サイトの「パックのバージョンを選ぶ」用に、各配布元からバージョン一覧を取得する
// 問い合わせ先は固定のホスト(Modrinth / FTB / CurseForge)だけ。管理者が入力したURLには接続しない
const curseforge = require('./curseforge');
const { parseFtbId, parseModrinthSlug, parseCurseforgeSlug } = require('./servers');

const UA = { 'User-Agent': 'packhearth-backend' };
const MAX = 50;
const cache = new Map(); // "type:source" -> { at, list }
const TTL = 60_000;

async function getJson(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw Object.assign(new Error(r.status === 404 ? 'パックが見つかりません' : `配布元に接続できません (${r.status})`), { status: r.status === 404 ? 404 : 502 });
  return r.json();
}

async function modrinthVersions(slug) {
  const list = await getJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version`);
  return list.slice(0, MAX).map((v) => ({
    id: v.id, name: v.version_number || v.name, date: v.date_published,
    mc: (v.game_versions || []).slice(-1)[0] || '', loaders: v.loaders || [], type: v.version_type || 'release',
  }));
}

async function ftbVersions(id) {
  const pack = await getJson(`https://api.feed-the-beast.com/v1/modpacks/public/modpack/${id}`);
  if (pack.status === 'error') throw Object.assign(new Error('パックが見つかりません'), { status: 404 });
  return (pack.versions || [])
    .slice().sort((a, b) => b.id - a.id).slice(0, MAX)
    .map((v) => ({ id: String(v.id), name: v.name, date: v.updated ? new Date(v.updated * 1000).toISOString() : '', mc: '', loaders: [], type: v.type || 'release' }));
}

// type: modrinth | curseforge | ftb、source: 管理サイトの「パックのURLまたはID」の入力そのまま
async function listVersions(type, source) {
  let key;
  let load;
  if (type === 'modrinth') {
    const slug = parseModrinthSlug(source);
    if (!slug) throw Object.assign(new Error('Modrinth のパックのURLを入力してください'), { status: 400 });
    key = `modrinth:${slug}`; load = () => modrinthVersions(slug);
  } else if (type === 'ftb') {
    const id = parseFtbId(source);
    if (!id) throw Object.assign(new Error('FTB のパックのURLかIDを入力してください'), { status: 400 });
    key = `ftb:${id}`; load = () => ftbVersions(id);
  } else if (type === 'curseforge') {
    if (!curseforge.enabled()) throw Object.assign(new Error('CurseForge が有効になっていません(API キー未設定)'), { status: 400 });
    const slug = parseCurseforgeSlug(source);
    if (!slug) throw Object.assign(new Error('CurseForge のパックのページURLを入力してください(zipのURLでは選べません)'), { status: 400 });
    key = `curseforge:${slug}`; load = () => curseforge.listPackFiles(slug);
  } else {
    throw Object.assign(new Error('この形式ではバージョンを選べません'), { status: 400 });
  }
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.list;
  const list = await load();
  cache.set(key, { at: Date.now(), list });
  return list;
}

module.exports = { listVersions };
