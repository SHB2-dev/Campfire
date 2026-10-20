// Mojang 公式の Java ランタイムを自動で取得する(Minecraft のバージョンごとに必要な Java が違うため)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'community-launcher' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function platformKey() {
  const a = process.arch;
  if (process.platform === 'win32') return a === 'arm64' ? 'windows-arm64' : a === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return a === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return a === 'ia32' ? 'linux-i386' : 'linux';
}

// その Minecraft バージョンが要求する Java ランタイム名(古いバージョンは jre-legacy = Java 8)
async function componentFor(minecraft) {
  const manifest = await getJson(VERSION_MANIFEST);
  const v = manifest.versions.find((x) => x.id === minecraft);
  if (!v) throw new Error(`Minecraft ${minecraft} が見つかりません`);
  const detail = await getJson(v.url);
  return detail.javaVersion?.component || 'jre-legacy';
}

function findBins(dir) {
  const exe = process.platform === 'win32';
  const candidates = ['bin', 'jre.bundle/Contents/Home/bin'].map((b) => path.join(dir, b));
  for (const b of candidates) {
    const java = path.join(b, exe ? 'java.exe' : 'java');
    if (fs.existsSync(java)) {
      const javaw = path.join(b, 'javaw.exe');
      return { java, gameJava: exe && fs.existsSync(javaw) ? javaw : java };
    }
  }
  return null;
}

async function ensureJava(component, root, log) {
  const dir = path.join(root, 'runtime', component);
  const marker = path.join(dir, '.complete');
  const found = findBins(dir);
  if (found && fs.existsSync(marker)) return found;

  const entry = (await getJson(RUNTIME_INDEX))[platformKey()]?.[component]?.[0];
  if (!entry) throw new Error(`この環境用の Java (${component}) が見つかりません。設定で Java のパスを指定してください`);
  log(`Java (${component}) を準備中。初回のみ時間がかかります`);
  const files = (await getJson(entry.manifest.url)).files;

  const todo = [];
  for (const [rel, f] of Object.entries(files)) {
    const dest = path.resolve(dir, rel);
    if (!dest.startsWith(path.resolve(dir) + path.sep)) throw new Error(`不正なパス: ${rel}`);
    if (f.type === 'directory') fs.mkdirSync(dest, { recursive: true });
    else if (f.type === 'file') todo.push({ dest, f });
  }

  let done = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const ok = fs.existsSync(t.dest) && crypto.createHash('sha1').update(fs.readFileSync(t.dest)).digest('hex') === t.f.downloads.raw.sha1;
      if (!ok) {
        const r = await fetch(t.f.downloads.raw.url);
        if (!r.ok) throw new Error(`Java のダウンロードに失敗 (${r.status})`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (crypto.createHash('sha1').update(buf).digest('hex') !== t.f.downloads.raw.sha1) throw new Error('Java のハッシュが一致しません');
        fs.mkdirSync(path.dirname(t.dest), { recursive: true });
        fs.writeFileSync(t.dest, buf, { mode: t.f.executable ? 0o755 : 0o644 });
      }
      if (++done % 40 === 0) log(`Java 準備中 ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  fs.writeFileSync(marker, entry.version?.name || '');
  const bins = findBins(dir);
  if (!bins) throw new Error('Java の展開後に実行ファイルが見つかりません');
  return bins;
}

module.exports = { componentFor, ensureJava };
