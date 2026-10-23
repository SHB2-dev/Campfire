// GitHub Releases のダウンロード数(開発者向けの集計用)
// GitHub の公開API(認証なしは1時間60回まで)を使うので、結果は10分間キャッシュする
const REPO = process.env.GITHUB_REPO || 'SHB2-dev/Packhearth';
const TTL = 10 * 60_000;
let cache = { at: 0, data: null };

// 配布ファイルだけを数える(自動更新用の yml / blockmap と、macOS の zip は除く)
function platformOf(name) {
  if (/\.exe$/i.test(name)) return /Portable/i.test(name) ? 'windowsPortable' : 'windows';
  if (/\.dmg$/i.test(name)) return 'mac';
  if (/\.AppImage$/i.test(name)) return 'linuxAppImage';
  if (/\.deb$/i.test(name)) return 'linuxDeb';
  return null;
}

async function loadDownloads() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  const headers = { 'User-Agent': 'packhearth-backend', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) {
    if (cache.data) return { ...cache.data, stale: true };
    throw Object.assign(new Error(`GitHub からダウンロード数を取得できませんでした (${r.status})`), { status: 502 });
  }
  const releases = await r.json();
  const byRelease = releases.filter((x) => !x.draft).map((rel) => {
    const platforms = {};
    let total = 0;
    for (const a of rel.assets || []) {
      const p = platformOf(a.name);
      if (!p) continue;
      platforms[p] = (platforms[p] || 0) + a.download_count;
      total += a.download_count;
    }
    return { tag: rel.tag_name, publishedAt: rel.published_at, prerelease: !!rel.prerelease, total, platforms };
  });
  const platforms = {};
  let total = 0;
  for (const rel of byRelease) {
    total += rel.total;
    for (const [p, n] of Object.entries(rel.platforms)) platforms[p] = (platforms[p] || 0) + n;
  }
  const data = { repo: REPO, total, platforms, releases: byRelease, fetchedAt: Date.now(), stale: false };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { loadDownloads };
