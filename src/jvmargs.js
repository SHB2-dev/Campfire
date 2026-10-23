// Forge / NeoForge / Fabric など、MOD ローダーの version JSON が持つ Java の起動引数(arguments.jvm)を展開する。
//
// 起動ライブラリ(minecraft-launcher-core)は、この arguments.jvm を使わない。
// しかし Forge 1.17+ / NeoForge は、モジュールパス(-p)や --add-opens などが無いと起動直後に
//   "module java.base does not opens java.lang.invoke to unnamed module"
// で落ちる。公式ランチャーと同じ引数を、customArgs として渡すために使う。
const fs = require('fs');
const path = require('path');

const PAIRED_FLAGS = new Set(['-cp', '-classpath', '--class-path', '-p', '--module-path']);

const osName = () => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux');

// Mojang 形式の rules(OS 条件のみ対応。features 条件の付いたものは使わない)
function ruleAllows(rules) {
  if (!rules) return true;
  let allowed = false;
  for (const r of rules) {
    if (r.features) continue;
    const matches = !r.os || (!r.os.name || r.os.name === osName());
    if (matches) allowed = r.action === 'allow';
  }
  return allowed;
}

// 戻り値: 展開済みの引数の配列。取得できなければ []
function loaderJvmArgs(root, versionId) {
  let json;
  try { json = JSON.parse(fs.readFileSync(path.join(root, 'versions', versionId, `${versionId}.json`), 'utf8')); }
  catch { return []; }
  const list = json.arguments?.jvm;
  if (!Array.isArray(list)) return [];

  const vars = {
    '${library_directory}': path.join(root, 'libraries'),
    '${classpath_separator}': path.delimiter,
    '${version_name}': versionId,
  };
  const expand = (s) => s.replace(/\$\{[a-z_]+\}/gi, (m) => vars[m] ?? m);

  const out = [];
  for (const entry of list) {
    const values = typeof entry === 'string' ? [entry] : ruleAllows(entry.rules) ? [].concat(entry.value) : [];
    for (const v of values) {
      const s = expand(String(v));
      if (/\$\{[a-z_]+\}/i.test(s)) {
        // 起動ライブラリが自前で付ける引数(-cp ${classpath}、natives、ランチャー名など)は重複するので除く。
        // 「-cp ${classpath}」のようにフラグと値が対の引数は、値を捨てるとき、直前のフラグも一緒に捨てる
        if (PAIRED_FLAGS.has(out[out.length - 1])) out.pop();
        continue;
      }
      out.push(s);
    }
  }
  return out;
}

module.exports = { loaderJvmArgs };
