const $ = (id) => document.getElementById(id);
const logEl = $('log');

let account = null;
let discord = null;
let groups = [];
let myList = [];
let view = 'home'; // 'home' | guild id
let selectedId = null;
let busy = false;

const addLog = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; };
const refreshPlay = () => {
  const item = myList.find((i) => i.id === selectedId);
  $('play').disabled = busy || !account || !item || item.gone;
  $('sel').textContent = item ? `${item.guild.name} / ${item.entry.name}` : 'サーバーを選んでください';
};
const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { addLog('エラー: ' + (e.message || e)); busy = false; refreshPlay(); }
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function avatar(guild, cls) {
  if (guild.icon) { const i = el('img', cls); i.src = guild.icon; i.alt = ''; return i; }
  return el('span', `${cls} ph`, guild.name.slice(0, 1));
}
function describe(s) {
  const kinds = {
    vanilla: `Minecraft ${s.minecraft}`, modrinth: 'MODパック (自動更新)', curseforge: 'MODパック (CurseForge)',
    mrpack: 'MODパック', zip: `MODパック (zip) · ${s.minecraft}`, manifest: 'MODパック',
  };
  const loader = s.type === 'vanilla' && s.loader !== 'vanilla' ? ` / ${s.loader}` : '';
  return kinds[s.type] + loader + (s.address ? ` · ${s.address}` : '');
}

function setAccount(a) { account = a; $('acct').textContent = a.name; refreshPlay(); }
function setDiscord(u) {
  discord = u;
  $('dc').textContent = u ? u.name : '未ログイン';
  $('dcin').hidden = !!u;
  $('dcout').hidden = !u;
}

function renderRail() {
  const rail = $('guilds');
  rail.replaceChildren();
  for (const g of groups) {
    const b = el('button', `rail-btn${view === g.guild.id ? ' on' : ''}`);
    b.title = g.guild.name;
    b.append(avatar(g.guild, 'av'));
    b.onclick = () => { view = g.guild.id; render(); };
    rail.append(b);
  }
  $('home').classList.toggle('on', view === 'home');
}

function renderHome(root) {
  if (!myList.length) {
    root.append(el('p', 'muted', discord
      ? '左のDiscordサーバーのアイコンを押して、遊びたいサーバー名をクリックすると、ここに追加されます。'
      : 'まず左の「1. Discord」でログインしてください。'));
  }
  for (const i of myList) {
    const card = el('div', `card${i.id === selectedId ? ' on' : ''}${i.gone ? ' gone' : ''}`);
    card.append(avatar(i.guild, 'av'));
    const info = el('div', 'info');
    info.append(el('b', null, i.entry.name), el('small', null, `${i.guild.name} · ${i.gone ? '削除されたか、参加していません' : describe(i.entry)}`));
    if (i.entry.description && !i.gone) info.append(el('small', 'muted', i.entry.description));
    const rm = el('button', 'ghost sm', '外す');
    rm.onclick = guard(async (e) => { e.stopPropagation(); myList = await api.removeServer(i.id); if (selectedId === i.id) selectedId = null; render(); });
    card.append(info, rm);
    card.onclick = () => { selectedId = i.id; render(); };
    root.append(card);
  }
}

function renderGuild(root, g) {
  root.append(el('p', 'muted', 'サーバー名を押すと、マイリストに追加されます。'));
  for (const s of g.servers) {
    const added = myList.some((i) => i.id === s.id);
    const card = el('button', `card pick${added ? ' added' : ''}`);
    const info = el('div', 'info');
    info.append(el('b', null, s.name), el('small', null, describe(s)));
    if (s.description) info.append(el('small', 'muted', s.description));
    card.append(info, el('span', 'badge', added ? '追加済み ✓' : '＋ 追加'));
    card.onclick = guard(async () => {
      myList = await api.addServer(s.id);
      selectedId = s.id;
      view = 'home';
      render();
    });
    root.append(card);
  }
}

function render() {
  renderRail();
  const root = $('view');
  root.replaceChildren();
  const g = groups.find((x) => x.guild.id === view);
  if (view !== 'home' && !g) view = 'home';
  $('title').textContent = view === 'home' ? 'マイリスト' : g.guild.name;
  if (view === 'home') renderHome(root); else renderGuild(root, g);
  refreshPlay();
}

const reload = guard(async () => {
  if (!discord) return;
  ({ groups, myList } = await api.listGuilds());
  render();
});

(async () => {
  const init = await api.init();
  $('java').value = init.settings.javaPath;
  $('max').value = init.settings.memoryMax;
  setDiscord(init.discord);
  if (init.account) setAccount(init.account);
  myList = init.myList;
  render();
  reload();
})();

api.on('log', addLog);
api.on('update', (u) => {
  $('update').hidden = false;
  $('updateText').textContent = u.ready
    ? `新しいバージョン ${u.version} の準備ができました。終了時に自動で更新されます`
    : `新しいバージョン ${u.version} があります`;
  $('updateBtn').hidden = !u.manual;
});
$('updateBtn').onclick = () => api.openReleases();
api.appVersion().then((v) => { $('ver').textContent = v; });
api.on('progress', (p) => { if (p.total) $('fill').style.width = (p.task / p.total * 100) + '%'; });
api.on('closed', (c) => { addLog(`ゲーム終了 (code ${c})`); busy = false; refreshPlay(); $('fill').style.width = '0'; });

$('home').onclick = () => { view = 'home'; render(); };
$('reload').onclick = reload;
$('dcin').onclick = guard(async () => { setDiscord(await api.loginDiscord()); await reload(); });
$('dcout').onclick = guard(async () => { await api.logoutDiscord(); setDiscord(null); groups = []; render(); });
$('ms').onclick = guard(async () => setAccount(await api.loginMicrosoft()));
$('off').onclick = guard(async () => setAccount(await api.loginOffline($('offname').value)));
$('save').onclick = guard(async () => {
  await api.saveSettings({ javaPath: $('java').value.trim(), memoryMax: $('max').value.trim() });
  addLog('設定を保存しました');
});
$('folder').onclick = () => api.openFolder();
$('admin').onclick = guard(() => api.openAdmin());
$('play').onclick = guard(async () => {
  busy = true; refreshPlay();
  if (!(await api.play(selectedId))) { busy = false; refreshPlay(); }
});
