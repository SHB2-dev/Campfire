// ランチャー自身の自動更新(GitHub Releases)
//  - Windows インストーラー版 / Linux AppImage: 自動ダウンロード → 再起動で更新
//  - Windows ポータブル / macOS(未署名) / deb: 自動更新できないため「新しい版があります」を通知してダウンロードページへ誘導
const { app, dialog, shell } = require('electron');

const RELEASES_URL = 'https://github.com/SHB2-dev/Packhearth/releases/latest';
const CHECK_INTERVAL = 6 * 3600 * 1000;

function canSelfUpdate() {
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  if (process.platform === 'darwin') return require('./config.json').signed === true; // macOS は署名済みビルドのみ
  return false;
}

function setupUpdater({ getWindow, send, log }) {
  if (!app.isPackaged) return; // 開発中は何もしない

  const { autoUpdater } = require('electron-updater');
  const self = canSelfUpdate();
  autoUpdater.autoDownload = self;
  autoUpdater.autoInstallOnAppQuit = self;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (info) => {
    if (self) log(`ランチャーの新しいバージョン ${info.version} をダウンロードしています...`);
    else send('update', { version: info.version, manual: true });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    send('update', { version: info.version, ready: true });
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'info', buttons: ['今すぐ再起動して更新', 'あとで'], defaultId: 0, cancelId: 1,
      title: 'アップデート',
      message: `新しいバージョン ${info.version} の準備ができました`,
      detail: '「あとで」を選んでも、ランチャーを終了したときに自動で更新されます。',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (e) => log(`ランチャーの更新確認に失敗しました: ${e.message}`));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_INTERVAL).unref();
}

const openReleases = () => shell.openExternal(RELEASES_URL);

module.exports = { setupUpdater, openReleases };
