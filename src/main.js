const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { resolveEntry, syncFiles, readInstalled, patchInstalled } = require('./packs');
const { ensureLoader } = require('./loaders');
const { componentFor, ensureJava } = require('./java');
const { setupUpdater, openReleases } = require('./updater');
const { ping: mcping, parseAddress } = require('./mcping');

// バックエンドURL: 環境変数 > src/config.json(ビルド時に配布用URLへ書き換える)
const BACKEND_URL = (process.env.BACKEND_URL || require('./config.json').backendUrl).replace(/\/$/, '');
// 配布版は https のバックエンドにしか接続しない(トークンを平文で流さないため)
if (app.isPackaged && !BACKEND_URL.startsWith('https://')) {
  app.whenReady().then(() => {
    dialog.showErrorBox('設定エラー', 'バックエンドURLが https ではありません。ビルド時に BACKEND_URL を設定してください。');
    app.quit();
  });
}
const REDIRECT_PORT = 53682; // Discord の OAuth2 Redirects に http://127.0.0.1:53682/callback を登録

const dataDir = () => path.join(app.getPath('appData'), '.packhearth');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

let win;
let mcAccount = null; // MCLC 形式の認証情報
let lastGroups = []; // 最後に取得した Discord サーバー別の一覧

const gib = 1024 ** 3;
const defaultSettings = () => ({
  javaPath: '',
  memoryMax: `${Math.max(2, Math.min(4, Math.floor(os.totalmem() / gib / 2)))}G`,
  memoryMin: '1G',
  discord: null,
  trusted: [],
  myList: [], // [{ id, guild:{id,name,icon}, entry }]
});
function loadSettings() {
  try { return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; }
  catch { return defaultSettings(); }
}
function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
  return s;
}

// Discord セッショントークンは可能なら OS の資格情報ストアで暗号化して保存
function storeToken(token) {
  return safeStorage.isEncryptionAvailable()
    ? { enc: true, v: safeStorage.encryptString(token).toString('base64') }
    : { enc: false, v: token };
}
function readToken(d) {
  if (!d?.token) return null;
  try { return d.token.enc ? safeStorage.decryptString(Buffer.from(d.token.v, 'base64')) : d.token.v; }
  catch { return null; }
}

const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
const log = (m) => send('log', m);

// ダウンロードの進捗(何を・何%)を画面へ送る。頻繁に送りすぎないよう0.1秒に1回に間引く
// total が無いときは「処理中」の表示になる
const MCLC_LABELS = { assets: 'アセット', classes: 'ライブラリ', natives: 'ネイティブ', 'assets-copy': 'アセットのコピー', 'classes-custom': 'ライブラリ', forge: 'Forge' };
function makeProgress() {
  let last = 0;
  return (label, done, total) => {
    const now = Date.now();
    const finished = total && done >= total;
    if (!finished && now - last < 100) return;
    last = now;
    send('progress', { label, done, total: total || 0 });
  };
}

async function backend(pathname, opts = {}) {
  const token = readToken(loadSettings().discord);
  const res = await fetch(BACKEND_URL + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers },
  });
  if (!res.ok) throw Object.assign(new Error(`バックエンドエラー (${res.status})`), { status: res.status });
  return res.json();
}

// ---- Discord ログイン(ループバック OAuth) ----
async function discordLogin() {
  const { clientId } = await (await fetch(`${BACKEND_URL}/api/config`)).json();
  const redirect = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
  const state = crypto.randomBytes(16).toString('hex');

  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? '<p>ログインしました。ランチャーに戻ってください。</p>' : '<p>ログインに失敗しました。</p>');
      clearTimeout(timer);
      srv.close();
      ok ? resolve(u.searchParams.get('code')) : reject(new Error('Discord ログインがキャンセルされました'));
    });
    const timer = setTimeout(() => { srv.close(); reject(new Error('Discord ログインがタイムアウトしました')); }, 180_000);
    srv.on('error', (e) => { clearTimeout(timer); reject(e); });
    srv.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const q = new URLSearchParams({
        client_id: clientId, response_type: 'code', scope: 'identify guilds', redirect_uri: redirect, state,
      });
      shell.openExternal(`https://discord.com/oauth2/authorize?${q}`);
    });
  });

  const r = await fetch(`${BACKEND_URL}/auth/discord`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: redirect }),
  });
  if (!r.ok) throw new Error('Discord 認証に失敗しました');
  const { token, user } = await r.json();
  saveSettings({ discord: { user, token: storeToken(token) } });
  return user;
}

// ---- IPC ----
ipcMain.handle('init', () => {
  const s = loadSettings();
  return {
    settings: { javaPath: s.javaPath, memoryMax: s.memoryMax },
    discord: s.discord?.user || null,
    account: mcAccount && { name: mcAccount.name },
    myList: s.myList,
  };
});

ipcMain.handle('save-settings', (_e, s) => {
  saveSettings({ javaPath: String(s.javaPath || ''), memoryMax: String(s.memoryMax || '4G') });
  return true;
});

ipcMain.handle('login-discord', () => discordLogin());
ipcMain.handle('logout-discord', async () => {
  try { await backend('/auth/logout', { method: 'POST' }); } catch { /* 既に無効 */ }
  saveSettings({ discord: null });
  lastGroups = [];
  return true;
});

ipcMain.handle('open-admin', async () => {
  const { adminUrl } = await (await fetch(`${BACKEND_URL}/api/config`)).json();
  // サーバーから受け取ったURLなので、接続先と同じオリジンの http(s) 以外は開かない
  const u = new URL(adminUrl);
  if (!['http:', 'https:'].includes(u.protocol) || u.origin !== new URL(BACKEND_URL).origin) throw new Error('管理サイトのURLが不正です');
  return shell.openExternal(u.href);
});

// Discord サーバー(アイコン・名前)と、そこに登録されたサーバー一覧。ついでにマイリストを最新化
ipcMain.handle('list-guilds', async () => {
  let groups;
  try { ({ groups } = await backend('/api/guilds')); }
  catch (e) {
    if (e.status === 401) { saveSettings({ discord: null }); throw new Error('Discord のログインが切れました。再ログインしてください'); }
    throw e;
  }
  lastGroups = groups;
  const fresh = new Map(groups.flatMap((g) => g.servers.map((s) => [s.id, { guild: g.guild, entry: s }])));
  const myList = loadSettings().myList.map((i) => (fresh.has(i.id) ? { ...i, ...fresh.get(i.id), gone: false } : { ...i, gone: true }));
  saveSettings({ myList });
  return { groups, myList };
});

ipcMain.handle('add-server', (_e, id) => {
  const s = loadSettings();
  if (s.myList.some((i) => i.id === id)) return s.myList;
  const g = lastGroups.find((x) => x.servers.some((v) => v.id === id));
  if (!g) throw new Error('サーバーが見つかりません。一覧を更新してください');
  const myList = [...s.myList, { id, guild: g.guild, entry: g.servers.find((v) => v.id === id), gone: false }];
  saveSettings({ myList });
  return myList;
});

ipcMain.handle('remove-server', (_e, id) => {
  const myList = loadSettings().myList.filter((i) => i.id !== id);
  saveSettings({ myList });
  return myList;
});

ipcMain.handle('login-microsoft', async () => {
  const xbox = await new Auth('select_account').launch('electron');
  mcAccount = (await xbox.getMinecraft()).mclc();
  return { name: mcAccount.name };
});

ipcMain.handle('login-offline', (_e, name) => {
  if (!/^\w{3,16}$/.test(name)) throw new Error('名前は3〜16文字の英数字/アンダースコア');
  mcAccount = Authenticator.getAuth(name);
  return { name };
});

ipcMain.handle('open-folder', () => shell.openPath(dataDir()));
// サーバーの稼働状況(一覧に表示)。同じアドレスは20秒キャッシュして、無駄に接続しない
const pingCache = new Map();
async function pingCached(address) {
  const hit = pingCache.get(address);
  if (hit && Date.now() - hit.at < 20_000) return hit.result;
  let result;
  try { result = await mcping(address, 3000); } catch { result = { online: false }; }
  pingCache.set(address, { at: Date.now(), result });
  return result;
}
ipcMain.handle('ping', (_e, address) => (parseAddress(address) ? pingCached(String(address)) : { online: false }));

ipcMain.handle('open-releases', () => openReleases());
ipcMain.handle('app-version', () => app.getVersion());

async function confirmTrust(entry, settings) {
  if (entry.type === 'vanilla' && entry.loader === 'vanilla') return true;
  const key = `${entry.id}|${entry.type}|${entry.source}`;
  if (settings.trusted.includes(key)) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['起動する', 'キャンセル'], defaultId: 1, cancelId: 1,
    title: '確認',
    message: `「${entry.name}」をダウンロードして起動しますか?`,
    detail: 'これは Discord サーバーの管理者が設定したMODパックです。MODは任意のプログラムを実行できるため、信頼できる管理者のものだけ起動してください。' +
      (entry.source ? `\n\n配布元: ${entry.source}` : ''),
  });
  if (response !== 0) return false;
  saveSettings({ trusted: [...settings.trusted, key] });
  return true;
}

ipcMain.handle('play', async (_e, id) => {
  if (!mcAccount) throw new Error('先に Minecraft アカウントでログインしてください');
  const settings = loadSettings();
  const item = settings.myList.find((i) => i.id === id);
  if (!item) throw new Error('サーバーが一覧にありません');

  // 起動のたびに管理者の最新設定を確認(通信できなければ保存済みの情報で起動)
  let entry = item.entry;
  log('サーバー情報を確認中...');
  try {
    entry = (await backend(`/api/servers/${id}`)).server;
    saveSettings({ myList: settings.myList.map((i) => (i.id === id ? { ...i, entry } : i)) });
  } catch (e) {
    if (e.status === 404) throw new Error('このサーバーは管理者により削除されました');
    if (e.status === 403) throw new Error('このDiscordサーバーに参加していないため起動できません');
    log('最新情報を取得できないため、保存済みの設定で起動します');
  }
  if (!(await confirmTrust(entry, settings))) return false;

  if (!Number.isInteger(entry.id)) throw new Error('サーバー情報が不正です');
  const root = dataDir();
  const gameDir = path.join(root, 'instances', `s${entry.id}`);
  fs.mkdirSync(gameDir, { recursive: true });

  const onProgress = makeProgress();

  // 管理者が自動更新をオフ(固定)にしているパック: 導入済みなら更新を確認せず、今の版のまま起動する。
  // まだ入っていない(または別のパックに変わった)場合だけ、そのときの版を導入する
  const pinned = entry.autoUpdate === false && entry.type !== 'vanilla';
  const installed = pinned ? readInstalled(gameDir, entry) : null;
  let resolved;
  if (installed) {
    log('管理者がこのパックの自動更新をオフにしているため、更新を確認せずに今の版で起動します');
    resolved = installed;
  } else {
    log(pinned ? '初回の導入です(このパックは管理者が自動更新をオフにしています)' : 'パックの更新を確認中...');
    // CurseForge は API キーを持つバックエンド経由で問い合わせる
    const curseforge = {
      pack: (slug) => backend(`/api/curseforge/pack?slug=${encodeURIComponent(slug)}`),
      files: (ids) => backend('/api/curseforge/files', { method: 'POST', body: JSON.stringify({ fileIds: ids }) }),
    };
    resolved = await resolveEntry(entry, path.join(root, 'cache'), log, { curseforge });
    const sync = await syncFiles(resolved, gameDir, log, onProgress);
    log(sync.downloaded || sync.removed || sync.packChanged
      ? `更新しました (取得 ${sync.downloaded} / 削除 ${sync.removed})`
      : '最新の状態です');
  }

  const javaBins = settings.javaPath
    ? { java: settings.javaPath, gameJava: settings.javaPath }
    : await ensureJava(await componentFor(resolved.minecraft), root, log, onProgress);
  // 固定中は、前回導入したローダーをそのまま使う(最新のローダーに勝手に変わらないように)
  const lockedLoader = installed?.customId && fs.existsSync(path.join(root, 'versions', installed.customId, `${installed.customId}.json`))
    ? installed.customId : null;
  const custom = lockedLoader || await ensureLoader(resolved, root, javaBins.java, log, onProgress);
  if (custom) patchInstalled(gameDir, { customId: custom });

  const launcher = new Client();
  // Minecraft 本体のダウンロードは進捗バーに任せ、ログには出さない
  launcher.on('debug', (m) => { if (!/^(\[MCLC\]:\s*)?(Downloading|Downloaded|Attempting to download)/i.test(String(m))) log(m); });
  let gameStarted = false;
  launcher.on('data', (m) => {
    if (!gameStarted) { gameStarted = true; send('progress', { label: '' }); } // ゲームが動き出したら進捗表示を消す
    log(String(m).trimEnd());
  });
  launcher.on('progress', (p) => onProgress(`Minecraft をダウンロード中(${MCLC_LABELS[p.type] || p.type})`, p.task, p.total));
  launcher.on('close', (code) => send('closed', code));

  const opts = {
    authorization: mcAccount,
    root,
    javaPath: javaBins.gameJava,
    version: { number: resolved.minecraft, type: 'release', custom },
    memory: { max: settings.memoryMax, min: settings.memoryMin },
    overrides: { gameDirectory: gameDir },
  };
  if (entry.address && entry.autoConnect) {
    // メインのアドレスが落ちていれば、繋がる予備アドレスに切り替える
    let address = entry.address;
    const alts = (entry.altAddresses || []).filter((a) => parseAddress(a));
    if (alts.length && !(await pingCached(address)).online) {
      for (const alt of alts) {
        if ((await pingCached(alt)).online) { address = alt; log(`メインのサーバーに接続できないため、予備アドレス ${alt} に接続します`); break; }
      }
    }
    if (parseAddress(address)) {
      const [host, port] = address.split(':');
      opts.quickPlay = { type: 'multiplayer', identifier: address };
      opts.server = { host, port: port || '25565' };
    }
  }
  log('起動中...');
  const proc = await launcher.launch(opts);
  if (!proc) throw new Error('起動に失敗しました');
  return true;
});

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1000, height: 680, minWidth: 840, minHeight: 560,
    backgroundColor: '#14161c', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  // 画面は同梱のHTMLのみ。外部ページへの遷移や新規ウィンドウは許可しない
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => setupUpdater({ getWindow: () => win, send, log }));
});
app.on('window-all-closed', () => app.quit());
