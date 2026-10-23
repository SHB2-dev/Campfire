const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const MRPACK_DEPS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };
const UA = { 'User-Agent': 'packhearth-launcher' };
const STATE_NAME = '.pack-state.json';
const MAX_DOWNLOAD = 1.2e9; // これを超えるパックは拒否
const MAX_UNPACKED = 4 * 1024 ** 3;
const MAX_ENTRIES = 50000;
// 単一トップフォルダの zip でも、これらのフォルダ名ならゲームフォルダ直下の構成とみなす
const KNOWN_DIRS = new Set(['mods', 'config', 'resourcepacks', 'shaderpacks', 'kubejs', 'scripts', 'defaultconfigs', 'datapacks', 'libraries', 'packmenu', 'fancymenu_data']);

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

// zip 系パックをキャッシュ付きで取得。ETag で未更新なら再ダウンロードしない
async function cachedDownload(url, cacheDir, immutable) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${sha1Of(Buffer.from(url))}.zip`);
  const tagFile = `${file}.etag`;
  const have = fs.existsSync(file);
  if (have && immutable) return fs.readFileSync(file);
  const headers = { ...UA };
  if (have && fs.existsSync(tagFile)) headers['If-None-Match'] = fs.readFileSync(tagFile, 'utf8');
  const r = await fetch(assertHttps(url), { headers });
  if (r.status === 304 && have) return fs.readFileSync(file);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  if (Number(r.headers.get('content-length') || 0) > MAX_DOWNLOAD) throw new Error('パックのサイズが大きすぎます');
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  const tag = r.headers.get('etag');
  if (tag) fs.writeFileSync(tagFile, tag);
  else if (fs.existsSync(tagFile)) fs.unlinkSync(tagFile);
  return buf;
}

function openZip(buf) {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw new Error('zip のファイル数が多すぎます');
  if (entries.reduce((n, e) => n + e.header.size, 0) > MAX_UNPACKED) throw new Error('zip の展開後サイズが大きすぎます');
  return zip;
}

// zip 内のファイルを rel パスへ展開する計画を作る。mapper(zip内パス) → 展開先の相対パス or null(展開しない)
function makeExtraction(zip, mapper) {
  const items = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, '/');
    if (name.startsWith('__MACOSX/') || path.posix.basename(name).startsWith('._')) continue;
    const rel = mapper(name);
    if (!rel || rel === STATE_NAME) continue;
    if (rel.split('/').includes('..') || path.isAbsolute(rel)) throw new Error(`不正なパス: ${name}`);
    items.push({ e, rel });
  }
  return {
    extracted: items.map((i) => i.rel),
    applyOverrides: (gameDir) => {
      for (const { e, rel } of items) {
        const dest = safeJoin(gameDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, e.getData());
      }
    },
  };
}

// 単一のトップフォルダ(例: MyPack/mods/...)に全部入っている zip は、そのフォルダを剥がす
function stripTopMapper(zip) {
  const names = zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName.replace(/\\/g, '/')).filter((n) => !n.startsWith('__MACOSX/'));
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes('/')) && !KNOWN_DIRS.has([...tops][0].toLowerCase());
  return (n) => (strip ? n.split('/').slice(1).join('/') : n);
}

// MultiMC / Prism 形式の zip は、ゲームの中身が .minecraft/ か minecraft/ の下にある
function zipMapper(zip) {
  if (zip.getEntry('mmc-pack.json')) return (n) => /^\.?minecraft\/(.+)$/.exec(n)?.[1] || null;
  return stripTopMapper(zip);
}

const readJson = (zip, name) => {
  const e = zip.getEntry(name);
  if (!e) return null;
  try { return JSON.parse(e.getData().toString('utf8')); } catch { return null; }
};
const versionTokens = (s) => String(s || '').match(/\d+\.\d+(?:\.\d+)?/g) || [];

// zip の中身から Minecraft のバージョンとローダーを判定する。判定できなければ null
//  1) パック形式のメタデータ(Modrinth / CurseForge / Prism・MultiMC / CurseForge アプリ)
//  2) なければ MOD の jar の中身(fabric.mod.json, mods.toml など)から推測
function detectPackMeta(zip) {
  const mr = readJson(zip, 'modrinth.index.json');
  if (mr?.dependencies?.minecraft) {
    const k = Object.keys(MRPACK_DEPS).find((x) => mr.dependencies[x]);
    return { minecraft: mr.dependencies.minecraft, loader: k ? MRPACK_DEPS[k] : 'vanilla', loaderVersion: k ? mr.dependencies[k] : '', from: 'modrinth.index.json' };
  }
  const cf = readJson(zip, 'manifest.json');
  if (cf?.minecraft?.version) {
    const ml = (cf.minecraft.modLoaders || []).find((x) => x.primary) || cf.minecraft.modLoaders?.[0];
    const i = ml?.id ? ml.id.indexOf('-') : -1;
    return { minecraft: cf.minecraft.version, loader: i > 0 ? ml.id.slice(0, i) : 'vanilla', loaderVersion: i > 0 ? ml.id.slice(i + 1) : '', from: 'manifest.json' };
  }
  const mmc = readJson(zip, 'mmc-pack.json');
  if (mmc?.components) {
    const ver = (uid) => mmc.components.find((c) => c.uid === uid)?.version || '';
    const mc = ver('net.minecraft');
    if (mc) {
      const loaders = [['net.fabricmc.fabric-loader', 'fabric'], ['org.quiltmc.quilt-loader', 'quilt'], ['net.neoforged', 'neoforge'], ['net.minecraftforge', 'forge']];
      const hit = loaders.find(([uid]) => ver(uid));
      return { minecraft: mc, loader: hit ? hit[1] : 'vanilla', loaderVersion: hit ? ver(hit[0]) : '', from: 'mmc-pack.json' };
    }
  }
  const mci = readJson(zip, 'minecraftinstance.json');
  if (mci?.baseModLoader?.minecraftVersion || mci?.gameVersion) {
    const name = mci.baseModLoader?.name || '';
    const i = name.indexOf('-');
    return { minecraft: mci.baseModLoader?.minecraftVersion || mci.gameVersion, loader: i > 0 ? name.slice(0, i) : 'vanilla', loaderVersion: i > 0 ? name.slice(i + 1) : '', from: 'minecraftinstance.json' };
  }
  return detectFromJars(zip);
}

const MAX_JARS_INSPECTED = 40;
function detectFromJars(zip) {
  const jars = zip.getEntries().filter((e) => !e.isDirectory && /(^|\/)mods\/[^/]+\.jar$/i.test(e.entryName.replace(/\\/g, '/'))).slice(0, MAX_JARS_INSPECTED);
  if (!jars.length) return null;
  const perJar = [];
  for (const e of jars) {
    let inner;
    try { inner = new AdmZip(e.getData()); } catch { continue; }
    const markers = new Set();
    const tokens = [];
    const fabric = readJson(inner, 'fabric.mod.json');
    if (fabric) { markers.add('fabric'); const d = fabric.depends?.minecraft; tokens.push(...versionTokens(Array.isArray(d) ? d.join(' ') : d)); }
    const quilt = readJson(inner, 'quilt.mod.json');
    if (quilt) {
      markers.add('quilt');
      const dep = (quilt.quilt_loader?.depends || []).find((x) => x?.id === 'minecraft');
      tokens.push(...versionTokens(typeof dep?.versions === 'string' ? dep.versions : JSON.stringify(dep?.versions || '')));
    }
    for (const [file, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', 'forge']]) {
      const t = inner.getEntry(file);
      if (!t) continue;
      markers.add(loader);
      const m = /modId\s*=\s*"minecraft"[\s\S]{0,300}?versionRange\s*=\s*"([^"]+)"/.exec(t.getData().toString('utf8'));
      if (m) tokens.push(...versionTokens(m[1]));
    }
    if (markers.size) perJar.push({ markers, tokens });
  }
  if (!perJar.length) return null;

  // 複数ローダー対応の jar は判断材料にならないので、1種類のローダーだけの jar を数える
  const count = {};
  for (const j of perJar.filter((x) => x.markers.size === 1)) { const l = [...j.markers][0]; count[l] = (count[l] || 0) + 1; }
  if (!Object.keys(count).length) for (const j of perJar) for (const l of j.markers) count[l] = (count[l] || 0) + 1;
  const loader = Object.entries(count).sort((a, b) => b[1] - a[1] || (a[0] === 'fabric' ? -1 : 1))[0][0];

  // Minecraft バージョン: そのローダーの MOD が要求するバージョンのうち最多のもの(x.y.z を優先)
  const freq = {};
  for (const j of perJar.filter((x) => x.markers.has(loader))) for (const t of new Set(j.tokens)) freq[t] = (freq[t] || 0) + 1;
  const pick = (re) => Object.entries(freq).filter(([t]) => re.test(t)).sort((a, b) => b[1] - a[1])[0]?.[0];
  const minecraft = pick(/^\d+\.\d+\.\d+$/) || pick(/^\d+\.\d+$/);
  if (!minecraft) return null;
  return { minecraft, loader, loaderVersion: '', from: 'MODの中身' };
}

// URL やパスに埋め込まれる値は、英数字と . _ + - のみ許可する(../ などの混入を防ぐ)
const SAFE_TOKEN = /^[\w.+-]{1,60}$/;
function assertSafeVersions(r) {
  if (!/^[\w. +-]{1,60}$/.test(r.minecraft || '')) throw new Error('Minecraft バージョンの形式が不正です');
  if (r.loaderVersion && !SAFE_TOKEN.test(r.loaderVersion)) throw new Error('ローダーのバージョンの形式が不正です');
  if (!LOADERS.includes(r.loader)) throw new Error(`未対応のローダー: ${r.loader}`);
  return r;
}

// サーバー定義(entry)を共通形式に正規化し、パックの最新状態を取得する
// ctx.curseforge = { pack(slug), files(ids) } はバックエンド経由の CurseForge 中継
async function resolveEntry(entry, cacheDir, log, ctx = {}) {
  return assertSafeVersions(await resolveRaw(entry, cacheDir, log, ctx));
}

async function resolveRaw(entry, cacheDir, log, ctx) {
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
      // 改ざん検知のため、ダウンロードするファイルには sha1 を必須にする
      for (const f of m.files || []) {
        if (typeof f.sha1 !== 'string' || !/^[0-9a-f]{40}$/i.test(f.sha1) || typeof f.url !== 'string' || typeof f.path !== 'string') {
          throw new Error(`manifest のファイル定義が不正です(path/url/sha1 が必要): ${f.path}`);
        }
      }
      return {
        minecraft: m.minecraft, loader, loaderVersion: m.loaderVersion || m.fabricLoader || '',
        files: m.files || [], strictMods: !!m.strictMods, packHash: sha1Of(Buffer.from(text)), label: 'manifest',
      };
    }
    case 'zip': {
      const buf = await cachedDownload(entry.source, cacheDir, false);
      const zip = openZip(buf);
      // 管理者がバージョン/ローダーを指定していればそれを優先。空欄・自動なら zip の中身から判定する
      const auto = !entry.minecraft || !entry.loader || entry.loader === 'auto';
      const meta = auto ? detectPackMeta(zip) : null;
      const minecraft = entry.minecraft || meta?.minecraft;
      if (!minecraft) {
        throw new Error('zip の中身から Minecraft のバージョンを判定できませんでした。管理者に、管理サイトでバージョンの指定を依頼してください');
      }
      const loader = entry.loader && entry.loader !== 'auto' ? entry.loader : (meta?.loader || 'vanilla');
      const hasMods = zip.getEntries().some((e) => /(^|\/)mods\/[^/]+\.jar$/i.test(e.entryName));
      if (loader === 'vanilla' && !meta?.loader && hasMods && entry.loader === 'auto') {
        throw new Error('zip の MOD から MOD ローダー(Fabric / Forge など)を判定できませんでした。管理者に、ローダーの指定を依頼してください');
      }
      if (meta) log(`zip の${meta.from}から判定: Minecraft ${minecraft} / ${loader}`);
      return {
        // ローダーのバージョンは、管理者の指定を優先。ローダーを自動判定したときだけ、判定結果のバージョンを使う
        minecraft, loader, loaderVersion: entry.loaderVersion || (!entry.loader || entry.loader === 'auto' ? meta?.loaderVersion || '' : ''),
        files: [], strictMods: false, packHash: sha1Of(buf), label: 'zip', ...makeExtraction(zip, zipMapper(zip)),
      };
    }
    case 'mrpack':
      return resolveMrpack(entry.source, cacheDir, false, 'mrpack');
    case 'modrinth': {
      const { url, label } = await modrinthLatest(entry.source);
      return resolveMrpack(url, cacheDir, true, `Modrinth ${entry.source} ${label}`);
    }
    case 'curseforge':
      return resolveCurseforge(entry.source, cacheDir, ctx, log);
    case 'ftb':
      return resolveFtb(entry.source, log);
    default:
      throw new Error(`未対応の種類: ${entry.type}`);
  }
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

async function resolveMrpack(url, cacheDir, immutable, label) {
  const buf = await cachedDownload(url, cacheDir, immutable);
  const zip = openZip(buf);
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
    ...makeExtraction(zip, (n) => /^(?:client-)?overrides\/(.+)$/.exec(n)?.[1] || null),
  };
}

// CurseForge のパックzip: manifest.json に MOD の fileID 一覧があり、実体はバックエンド経由で取得する
async function resolveCurseforge(source, cacheDir, ctx, log) {
  if (!ctx.curseforge) throw new Error('CurseForge パックの取得には Discord ログインが必要です');
  let url = source;
  let immutable = false;
  let label = 'CurseForge';
  if (!/^https:\/\//.test(source)) {
    const p = await ctx.curseforge.pack(source);
    url = p.url;
    immutable = true; // URL にファイルIDが含まれるので内容は不変
    label = `CurseForge ${p.name} (${p.displayName || p.fileName})`;
  }
  log('CurseForge パックを取得中');
  const buf = await cachedDownload(url, cacheDir, immutable);
  const zip = openZip(buf);
  const me = zip.getEntry('manifest.json');
  if (!me) throw new Error('manifest.json が見つかりません(CurseForge のパックzipではない?)');
  const m = JSON.parse(me.getData().toString('utf8'));
  const mc = m.minecraft?.version;
  if (!mc) throw new Error('パックに Minecraft バージョンの指定がありません');
  const ml = (m.minecraft.modLoaders || []).find((x) => x.primary) || m.minecraft.modLoaders?.[0];
  let loader = 'vanilla';
  let loaderVersion = '';
  if (ml?.id) {
    const i = ml.id.indexOf('-');
    loader = i < 0 ? ml.id : ml.id.slice(0, i);
    loaderVersion = i < 0 ? '' : ml.id.slice(i + 1);
  }

  const wanted = (m.files || []).filter((f) => f.required !== false);
  log(`MOD の情報を取得中 (${wanted.length}件)`);
  const { files: infos } = await ctx.curseforge.files(wanted.map((f) => f.fileID));
  const byId = new Map(infos.map((f) => [f.id, f]));
  const files = wanted.map((f) => {
    const i = byId.get(f.fileID);
    if (!i) throw new Error(`CurseForge からファイル情報を取得できません (fileID ${f.fileID})`);
    const name = path.basename(i.fileName);
    // .jar は mods/、それ以外(.zip)はリソースパックとして扱う
    return { path: `${/\.jar$/i.test(name) ? 'mods' : 'resourcepacks'}/${name}`, url: i.url, sha1: i.sha1 || undefined };
  });

  const prefix = `${(m.overrides || 'overrides').replace(/^\/+|\/+$/g, '')}/`;
  return {
    minecraft: mc, loader, loaderVersion, files, strictMods: false, packHash: sha1Of(buf), label,
    ...makeExtraction(zip, (n) => (n.startsWith(prefix) ? n.slice(prefix.length) : null)),
  };
}

// FTB(Feed The Beast)公式配布のパック。公開APIにファイル一覧(URL・ハッシュ付き)と
// Minecraft / ローダーのバージョンが載っているので、最新のリリース版をそのまま使う
const FTB_API = 'https://api.feed-the-beast.com/v1/modpacks/public/modpack';
const FTB_LOADERS = new Set(['forge', 'neoforge', 'fabric', 'quilt']);

async function ftbJson(url) {
  const r = await fetch(assertHttps(url), { headers: UA });
  if (!r.ok) throw new Error(`FTB のサーバーから取得できません (${r.status})`);
  const j = await r.json();
  if (j.status === 'error') throw new Error(`FTB: ${j.message || 'パックが見つかりません'}`);
  return j;
}

async function resolveFtb(source, log) {
  const id = String(source).trim();
  if (!/^\d{1,8}$/.test(id)) throw new Error('FTB のパックIDが不正です');
  const pack = await ftbJson(`${FTB_API}/${id}`);
  const versions = (pack.versions || []).filter((v) => v.type === 'release');
  const latest = (versions.length ? versions : pack.versions || []).reduce((a, b) => (!a || b.id > a.id ? b : a), null);
  if (!latest) throw new Error(`FTB のパック「${pack.name || id}」に配布バージョンがありません`);
  log(`FTB ${pack.name} ${latest.name} を確認中`);
  const ver = await ftbJson(`${FTB_API}/${id}/${latest.id}`);

  const target = (type) => (ver.targets || []).find((t) => t.type === type);
  const game = target('game');
  const loader = target('modloader');
  if (!game?.version) throw new Error('FTB のパックに Minecraft バージョンの指定がありません');
  if (loader && !FTB_LOADERS.has(loader.name)) throw new Error(`未対応のローダー: ${loader.name}`);

  const files = [];
  const lazyFiles = [];
  for (const f of ver.files || []) {
    if (f.serveronly || f.optional) continue; // サーバー専用・任意ファイルは入れない
    if (typeof f.url !== 'string' || typeof f.name !== 'string') throw new Error('FTB のファイル情報が不正です');
    const rel = path.posix.normalize(`${f.path || ''}/${f.name}`).replace(/^(\.\/|\/)+/, '');
    const item = { path: rel, url: f.url, sha1: typeof f.sha1 === 'string' ? f.sha1 : undefined };
    // MOD は毎回ハッシュを確認。設定などは、パック更新時だけ上書きする
    (rel.startsWith('mods/') ? files : lazyFiles).push(item);
  }
  return {
    minecraft: game.version,
    loader: loader ? loader.name : 'vanilla',
    loaderVersion: loader?.version || '',
    files, lazyFiles, strictMods: false,
    packHash: sha1Of(Buffer.from(`ftb:${id}:${latest.id}`)),
    label: `FTB ${pack.name} ${latest.name}`,
  };
}

function readState(gameDir) {
  try { return JSON.parse(fs.readFileSync(path.join(gameDir, STATE_NAME), 'utf8')); } catch { return {}; }
}

// 前回との差分だけ更新する。戻り値: { downloaded, removed, packChanged }
async function syncFiles(resolved, gameDir, log, onProgress) {
  const state = readState(gameDir);
  const newPaths = new Set(resolved.extracted || []);
  const todo = [];
  const packChanged = resolved.packHash !== (state.packHash ?? null);
  for (const f of resolved.files) {
    const dest = safeJoin(gameDir, f.path);
    newPaths.add(f.path);
    if (fs.existsSync(dest) && f.sha1 && sha1Of(fs.readFileSync(dest)) === f.sha1) continue;
    todo.push({ f, dest });
  }
  // 設定ファイルなど(lazyFiles)は、無いときとパックが更新されたときだけ取得する。
  // 毎回ハッシュを照合して上書きすると、プレイヤーが変えた設定が起動のたびに戻ってしまうため
  for (const f of resolved.lazyFiles || []) {
    const dest = safeJoin(gameDir, f.path);
    newPaths.add(f.path);
    if (packChanged || !fs.existsSync(dest)) todo.push({ f, dest });
  }

  let done = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      let buf;
      try { buf = await fetchBuffer(t.f.url); }
      catch (e) { throw new Error(`${t.f.path} をダウンロードできません(配布が制限されているMODの可能性があります): ${e.message}`); }
      if (t.f.sha1 && sha1Of(buf) !== t.f.sha1) throw new Error(`ハッシュ不一致: ${t.f.path}`);
      fs.mkdirSync(path.dirname(t.dest), { recursive: true });
      fs.writeFileSync(t.dest, buf);
      onProgress?.('MODをダウンロード中', done + 1, todo.length);
      // 大きなパックでログが埋まらないよう、多いときは10件ごとに表示する
      if (++done === todo.length || todo.length <= 10 || done % 10 === 0) log(`MODをダウンロード中 ${done}/${todo.length}`);
    }
  };
  // 小さなファイルが数百件あるパック(FTB など)は並列数を増やす
  await Promise.all(Array.from({ length: Math.min(todo.length > 50 ? 12 : 4, todo.length) }, worker));

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

  // 設定ファイル等(overrides / zip の中身)は、パックが更新されたときだけ展開する
  if (packChanged) resolved.applyOverrides?.(gameDir);
  fs.writeFileSync(path.join(gameDir, STATE_NAME), JSON.stringify({ packHash: resolved.packHash, managed: [...newPaths] }));
  return { downloaded: todo.length, removed, packChanged, firstRun: !('packHash' in state) };
}

module.exports = { resolveEntry, syncFiles };
