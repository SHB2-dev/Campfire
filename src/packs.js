const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const MRPACK_DEPS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };
const UA = { 'User-Agent': 'community-launcher' };

function assertHttps(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error(`不正なURL: ${u}`); }
  if (url.protocol !== 'https:') throw new Error(`https 以外のURLは使えません: ${u}`);
  return url.href;
}

// 保存先が baseDir の外に出ないことを保証
function safeJoin(baseDir, rel) {
  const base = path.resolve(baseDir);
  const dest = path.resolve(base, rel);
  if (dest !== base && !dest.startsWith(base + path.sep)) throw new Error(`不正なパス: ${rel}`);
  return dest;
}

const sha1Of = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

async function fetchBuffer(url) {
  const r = await fetch(assertHttps(url), { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// .mrpack をキャッシュ付きで取得。ETag で未更新なら再ダウンロードしない
async function cachedDownload(url, cacheDir, immutable) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${sha1Of(Buffer.from(url))}.mrpack`);
  const tagFile = `${file}.etag`;
  const have = fs.existsSync(file);
  if (have && immutable) return fs.readFileSync(file);
  const headers = { ...UA };
  if (have && fs.existsSync(tagFile)) headers['If-None-Match'] = fs.readFileSync(tagFile, 'utf8');
  const r = await fetch(assertHttps(url), { headers });
  if (r.status === 304 && have) return fs.readFileSync(file);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  const tag = r.headers.get('etag');
  if (tag) fs.writeFileSync(tagFile, tag);
  else if (fs.existsSync(tagFile)) fs.unlinkSync(tagFile);
  return buf;
}

async function modrinthLatest(slug) {
  const r = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version`, { headers: UA });
  if (!r.ok) throw new Error(`Modrinth のパック「${slug}」が見つかりません (${r.status})`);
  const versions = await r.json();
  const v = versions.find((x) => x.version_type === 'release') || versions[0];
  const f = v && (v.files.find((x) => x.primary) || v.files[0]);
  if (!f) throw new Error(`Modrinth のパック「${slug}」に配布ファイルがありません`);
  return { url: f.url, label: v.version_number };
}

// サーバー定義(entry)を共通形式に正規化し、パックの最新状態を取得する
async function resolveEntry(entry, cacheDir, log) {
  switch (entry.type) {
    case 'vanilla':
      return {
        minecraft: entry.minecraft, loader: entry.loader || 'vanilla', loaderVersion: entry.loaderVersion || '',
        files: [], strictMods: false, packHash: null, label: `Minecraft ${entry.minecraft}`,
      };
    case 'manifest': {
      const text = (await fetchBuffer(entry.source)).toString('utf8');
      const m = JSON.parse(text);
      if (typeof m.minecraft !== 'string') throw new Error('manifest に minecraft バージョンがありません');
      const loader = m.loader || 'vanilla';
      if (!LOADERS.includes(loader)) throw new Error(`未対応のローダー: ${loader}`);
      return {
        minecraft: m.minecraft, loader, loaderVersion: m.loaderVersion || m.fabricLoader || '',
        files: m.files || [], strictMods: !!m.strictMods, packHash: sha1Of(Buffer.from(text)), label: 'manifest',
      };
    }
    case 'mrpack':
      return resolveMrpack(entry.source, cacheDir, false, 'mrpack');
    case 'modrinth': {
      const { url, label } = await modrinthLatest(entry.source);
      return resolveMrpack(url, cacheDir, true, `Modrinth ${entry.source} ${label}`);
    }
    default:
      throw new Error(`未対応の種類: ${entry.type}`);
  }
}

async function resolveMrpack(url, cacheDir, immutable, label) {
  const buf = await cachedDownload(url, cacheDir, immutable);
  const zip = new AdmZip(buf);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('modrinth.index.json が見つかりません(.mrpack ではない?)');
  const index = JSON.parse(indexEntry.getData().toString('utf8'));
  const deps = index.dependencies || {};
  if (!deps.minecraft) throw new Error('パックに Minecraft バージョンの指定がありません');
  const loaderKey = Object.keys(MRPACK_DEPS).find((k) => deps[k]);
  const files = (index.files || [])
    .filter((f) => f.env?.client !== 'unsupported')
    .map((f) => ({ path: f.path, url: f.downloads?.[0], sha1: f.hashes?.sha1 }));
  for (const f of files) if (!f.url || !f.sha1) throw new Error(`ダウンロード情報が不足: ${f.path}`);

  return {
    minecraft: deps.minecraft,
    loader: loaderKey ? MRPACK_DEPS[loaderKey] : 'vanilla',
    loaderVersion: loaderKey ? deps[loaderKey] : '',
    files, strictMods: false, packHash: sha1Of(buf), label,
    // overrides(設定ファイル等)はパック更新時のみ展開し、ユーザーの設定を毎回上書きしない
    applyOverrides: (gameDir) => {
      for (const e of zip.getEntries()) {
        const m = /^(?:client-)?overrides\/(.+)$/.exec(e.entryName);
        if (!m || e.isDirectory) continue;
        const dest = safeJoin(gameDir, m[1]);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, e.getData());
      }
    },
  };
}

const stateFile = (gameDir) => path.join(gameDir, '.pack-state.json');
function readState(gameDir) {
  try { return JSON.parse(fs.readFileSync(stateFile(gameDir), 'utf8')); } catch { return {}; }
}

// 前回との差分だけ更新する。戻り値: { downloaded, removed, packChanged }
async function syncFiles(resolved, gameDir, log) {
  const state = readState(gameDir);
  const newPaths = new Set();
  const todo = [];
  for (const f of resolved.files) {
    const dest = safeJoin(gameDir, f.path);
    newPaths.add(f.path);
    if (fs.existsSync(dest) && f.sha1 && sha1Of(fs.readFileSync(dest)) === f.sha1) continue;
    todo.push({ f, dest });
  }

  let done = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const buf = await fetchBuffer(t.f.url);
      if (t.f.sha1 && sha1Of(buf) !== t.f.sha1) throw new Error(`ハッシュ不一致: ${t.f.path}`);
      fs.mkdirSync(path.dirname(t.dest), { recursive: true });
      fs.writeFileSync(t.dest, buf);
      log(`ダウンロード ${++done}/${todo.length}: ${t.f.path}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));

  // 前回管理していたが、新しいパックに無いファイルを削除(MODの入れ替え対応)
  let removed = 0;
  for (const p of state.managed || []) {
    if (newPaths.has(p)) continue;
    const dest = safeJoin(gameDir, p);
    if (fs.existsSync(dest)) { fs.unlinkSync(dest); removed++; log(`削除: ${p}`); }
  }
  const modsDir = path.join(gameDir, 'mods');
  if (resolved.strictMods && fs.existsSync(modsDir)) {
    const keep = new Set([...newPaths].filter((p) => p.startsWith('mods/')).map((p) => path.basename(p)));
    for (const n of fs.readdirSync(modsDir)) {
      if (n.endsWith('.jar') && !keep.has(n)) { fs.unlinkSync(path.join(modsDir, n)); removed++; log(`不要なmodを削除: ${n}`); }
    }
  }

  const packChanged = resolved.packHash !== (state.packHash ?? null);
  if (packChanged) resolved.applyOverrides?.(gameDir);
  fs.writeFileSync(stateFile(gameDir), JSON.stringify({ packHash: resolved.packHash, managed: [...newPaths] }));
  return { downloaded: todo.length, removed, packChanged, firstRun: !('packHash' in state) };
}

module.exports = { resolveEntry, syncFiles };
