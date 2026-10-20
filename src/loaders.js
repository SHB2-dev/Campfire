const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const UA = { 'User-Agent': 'community-launcher' };

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

const versionJsonPath = (root, id) => path.join(root, 'versions', id, `${id}.json`);
const hasVersion = (root, id) => fs.existsSync(versionJsonPath(root, id));
const listVersions = (root) => {
  try { return fs.readdirSync(path.join(root, 'versions')); } catch { return []; }
};

// Fabric / Quilt: メタAPIがそのまま使えるプロファイルJSONを返す
async function installProfileLoader(name, base, { minecraft, loaderVersion }, root, log) {
  let v = loaderVersion;
  if (!v) {
    const list = await getJson(`${base}/versions/loader/${minecraft}`);
    v = list[0]?.loader.version;
  }
  if (!v) throw new Error(`${name} は Minecraft ${minecraft} に対応していません(対応は 1.14 以降)`);
  const profile = await getJson(`${base}/versions/loader/${minecraft}/${v}/profile/json`);
  if (!hasVersion(root, profile.id)) {
    log(`${name} ${v} を導入中`);
    fs.mkdirSync(path.dirname(versionJsonPath(root, profile.id)), { recursive: true });
    fs.writeFileSync(versionJsonPath(root, profile.id), JSON.stringify(profile));
  }
  return profile.id;
}

function runInstaller(java, jar, root, log) {
  return new Promise((resolve, reject) => {
    const lp = path.join(root, 'launcher_profiles.json');
    if (!fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ profiles: {}, selectedProfile: '' }));
    const p = spawn(java, ['-jar', jar, '--installClient', root], { cwd: root, windowsHide: true });
    const pipe = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => log(`[installer] ${l}`));
    p.stdout.on('data', pipe);
    p.stderr.on('data', pipe);
    p.on('error', (e) => reject(new Error(`Java を起動できません: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`インストーラーが失敗しました (code ${code})`))));
  });
}

// インストール結果(installerUrl -> version id)を覚えておき、2回目以降はスキップする
const idMapPath = (root) => path.join(root, 'cache', 'loader-ids.json');
function readIdMap(root) { try { return JSON.parse(fs.readFileSync(idMapPath(root), 'utf8')); } catch { return {}; } }

async function installWithInstaller({ ids, urls, match }, root, java, log) {
  const known = readIdMap(root);
  const cached = urls.map((u) => known[u]).find((id) => id && hasVersion(root, id));
  if (cached) return cached;
  const direct = ids.find((id) => hasVersion(root, id));
  if (direct) return direct;

  let url = null;
  for (const u of urls) {
    const r = await fetch(u, { method: 'HEAD', headers: UA });
    if (r.ok) { url = u; break; }
  }
  if (!url) throw new Error('このバージョンのインストーラーが見つかりません');

  const jar = path.join(root, 'cache', 'installers', path.basename(url));
  log(`インストーラーを取得: ${path.basename(url)}`);
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  fs.mkdirSync(path.dirname(jar), { recursive: true });
  fs.writeFileSync(jar, Buffer.from(await r.arrayBuffer()));

  const before = new Set(listVersions(root));
  log('MODローダーをインストール中(数分かかることがあります)');
  await runInstaller(java, jar, root, log);

  const id = ids.find((x) => hasVersion(root, x)) || listVersions(root).find((d) => !before.has(d) && match(d) && hasVersion(root, d));
  if (!id) throw new Error('インストール後のバージョンが見つかりません');
  fs.mkdirSync(path.dirname(idMapPath(root)), { recursive: true });
  fs.writeFileSync(idMapPath(root), JSON.stringify({ ...readIdMap(root), [url]: id }));
  return id;
}

async function installForge({ minecraft, loaderVersion }, root, java, log) {
  let ver = loaderVersion;
  if (!ver) {
    const promos = (await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
    ver = promos[`${minecraft}-recommended`] || promos[`${minecraft}-latest`];
    if (!ver) throw new Error(`Forge は Minecraft ${minecraft} に対応していません`);
  }
  // 古いバージョンはファイル名に Minecraft バージョンが付く場合がある
  const base = minecraft.replace(/^(\d+\.\d+)(\..*)?$/, '$1');
  const fulls = [...new Set([`${minecraft}-${ver}`, `${minecraft}-${ver}-${minecraft}`, `${minecraft}-${ver}-${base}.0`, `${minecraft}-${ver}-${base}`])];
  return installWithInstaller({
    ids: [`${minecraft}-forge-${ver}`],
    urls: fulls.map((f) => `https://maven.minecraftforge.net/net/minecraftforge/forge/${f}/forge-${f}-installer.jar`),
    match: (d) => /forge/i.test(d),
  }, root, java, log);
}

async function installNeoForge({ minecraft, loaderVersion }, root, java, log) {
  let ver = loaderVersion;
  if (!ver) {
    const m = /^1\.(\d+)(?:\.(\d+))?/.exec(minecraft);
    if (!m || (Number(m[1]) === 20 && Number(m[2] || 0) < 2) || Number(m[1]) < 20) throw new Error('NeoForge は Minecraft 1.20.2 以降のみ対応です');
    const prefix = `${m[1]}.${m[2] || 0}.`;
    const xml = await getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((x) => x[1]).filter((v) => v.startsWith(prefix));
    const stable = all.filter((v) => !v.includes('-'));
    ver = (stable.length ? stable : all).at(-1);
    if (!ver) throw new Error(`NeoForge は Minecraft ${minecraft} に対応していません`);
  }
  return installWithInstaller({
    ids: [`neoforge-${ver}`],
    urls: [`https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`],
    match: (d) => /neoforge/i.test(d),
  }, root, java, log);
}

// 戻り値: MCLC の version.custom に渡す ID(vanilla は undefined)
async function ensureLoader(pack, root, java, log) {
  switch (pack.loader) {
    case 'vanilla': return undefined;
    case 'fabric': return installProfileLoader('Fabric', 'https://meta.fabricmc.net/v2', pack, root, log);
    case 'quilt': return installProfileLoader('Quilt', 'https://meta.quiltmc.org/v3', pack, root, log);
    case 'forge': return installForge(pack, root, java, log);
    case 'neoforge': return installNeoForge(pack, root, java, log);
    default: throw new Error(`未対応のローダー: ${pack.loader}`);
  }
}

module.exports = { ensureLoader };
