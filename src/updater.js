// ランチャー自身の自動更新(GitHub Releases)
//  - Windows インストーラー版 / Linux AppImage: 自動ダウンロード → 再起動で更新
//  - Windows ポータブル / macOS(未署名) / deb: 自動更新できないため「新しい版があります」を通知してダウンロードページへ誘導
// 通知は、ランチャーの画面内のバーと、OS の通知(Windows の通知センターなど)の両方に出す
const { app, Notification, shell } = require('electron');

const RELEASES_URL = 'https://github.com/SHB2-dev/Packhearth/releases/latest';
const CHECK_INTERVAL = 6 * 3600 * 1000;

let updater = null; // electron-updater の autoUpdater(パッケージ版のみ)

function canSelfUpdate() {
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  if (process.platform === 'darwin') return require('./config.json').signed === true; // macOS は署名済みビルドのみ
  return false;
}

function setupUpdater({ getWindow, send, log, isNotifyEnabled }) {
  if (!app.isPackaged) return; // 開発中は何もしない

  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  const self = canSelfUpdate();
  autoUpdater.autoDownload = self;
  autoUpdater.autoInstallOnAppQuit = self;
  autoUpdater.logger = null;

  // OS の通知。同じ内容は、起動中に何度も出さない。クリックするとランチャーの画面を前面に出す
  const notified = new Set();
  const notify = (key, title, body, onClick) => {
    if (!isNotifyEnabled() || notified.has(key) || !Notification.isSupported()) return;
    notified.add(key);
    const n = new Notification({ title, body });
    n.on('click', () => {
      const w = getWindow();
      if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
      onClick?.();
    });
    n.show();
  };

  autoUpdater.on('update-available', (info) => {
    if (self) {
      log(`ランチャーの新しいバージョン ${info.version} をダウンロードしています...`);
      send('update', { version: info.version, downloading: true });
      notify(`dl-${info.version}`, 'Packhearth のアップデート', `新しいバージョン ${info.version} をダウンロードしています`);
    } else {
      send('update', { version: info.version, manual: true });
      notify(`new-${info.version}`, 'Packhearth の新しいバージョン', `${info.version} があります。クリックでダウンロードページを開きます`, openReleases);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    send('update', { version: info.version, ready: true });
    notify(`ready-${info.version}`, 'アップデートの準備ができました', `バージョン ${info.version}。Packhearth を開いて「今すぐ再起動して更新」を押してください`);
  });

  autoUpdater.on('error', (e) => log(`ランチャーの更新確認に失敗しました: ${e.message}`));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_INTERVAL).unref();
}

const openReleases = () => shell.openExternal(RELEASES_URL);
const installUpdate = () => { if (updater) updater.quitAndInstall(); };

module.exports = { setupUpdater, openReleases, installUpdate };
