const REPO = 'SHB2-dev/Packhearth';
const RELEASES = `https://github.com/${REPO}/releases/latest`;

// 閲覧中のOSを判定
const ua = navigator.userAgent;
const os = /Windows/i.test(ua) ? 'win' : /Mac/i.test(ua) && !/iPhone|iPad/i.test(ua) ? 'mac' : /Linux/i.test(ua) && !/Android/i.test(ua) ? 'linux' : null;
const names = { win: 'Windows', mac: 'macOS', linux: 'Linux' };
const exts = { win: /\.exe$/i, mac: /\.dmg$/i, linux: /\.(AppImage|deb)$/i };

if (os) {
  document.querySelector(`.dl[data-os="${os}"]`)?.classList.add('rec');
  document.getElementById('dl-main').textContent = `${names[os]} 版をダウンロード`;
}

// 最新リリースを取得してリンクを差し替える(取得できなければリリースページへ)
fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((rel) => {
    document.getElementById('ver').textContent = `最新バージョン: ${rel.tag_name}`;
    for (const a of document.querySelectorAll('.dl')) {
      // Windows はインストーラー(Setup)を優先。ポータブル版より自動更新が使える
      const matches = rel.assets.filter((x) => exts[a.dataset.os].test(x.name));
      const asset = matches.find((x) => /Setup/i.test(x.name)) || matches[0];
      if (asset) a.href = asset.browser_download_url;
    }
    const mainMatches = rel.assets.filter((x) => os && exts[os].test(x.name));
    const main = mainMatches.find((x) => /Setup/i.test(x.name)) || mainMatches[0];
    if (main) document.getElementById('dl-main').href = main.browser_download_url;
  })
  .catch(() => {
    document.getElementById('ver').textContent = 'リリースページから最新版を入手できます';
    document.getElementById('dl-main').href = RELEASES;
  });
