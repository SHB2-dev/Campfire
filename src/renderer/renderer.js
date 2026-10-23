const $ = (id) => document.getElementById(id);
const logEl = $('log');

let account = null;
let discord = null;
let groups = [];
let myList = [];
let view = 'home'; // 'home' | guild id
let selectedId = null;
let busy = false;

const MAX_LOG_CHARS = 20000; // ログが長くなりすぎないよう、古い行から捨てる
const addLog = (m) => {
  logEl.textContent += m + '\n';
  if (logEl.textContent.length > MAX_LOG_CHARS) logEl.textContent = logEl.textContent.slice(-MAX_LOG_CHARS * 0.75);
  logEl.scrollTop = logEl.scrollHeight;
};
// ログは最初は非表示。「ログを表示」で出し入れする(エラーが出たときは、原因が見えるよう自動で表示する)
function showLog(visible) {
  logEl.hidden = !visible;
  $('logToggle').textContent = visible ? 'ログを隠す' : 'ログを表示';
  $('logToggle').setAttribute('aria-expanded', String(visible));
  if (visible) logEl.scrollTop = logEl.scrollHeight;
}
const refreshPlay = () => {
  const item = myList.find((i) => i.id === selectedId);
  $('play').disabled = busy || !account || !item || item.gone;
  $('sel').textContent = item ? `${item.guild.name} / ${item.entry.name}` : 'サーバーを選んでください';
};
const guard = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) { addLog('エラー: ' + (e.message || e)); showLog(true); busy = false; refreshPlay(); showProgress(null); }
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
// アイコンが無いサーバーは、名前の頭文字(単語の先頭を並べる。1語なら先頭2文字)を表示する
function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.map((w) => [...w][0]).join('') : [...(words[0] || '?')].slice(0, 2).join('')).slice(0, 3);
}
function avatar(guild, cls) {
  if (guild.icon) { const i = el('img', cls); i.src = guild.icon; i.alt = ''; return i; }
  return el('span', `${cls} ph`, initials(guild.name));
}
function describe(s) {
  const kinds = {
    vanilla: `Minecraft ${s.minecraft}`, modrinth: 'MODパック (自動更新)', curseforge: 'MODパック (CurseForge)', ftb: 'MODパック (FTB)',
    mrpack: 'MODパック', zip: `MODパック (zip)${s.minecraft ? ' · ' + s.minecraft : ''}`, manifest: 'MODパック',
  };
  const loader = s.type === 'vanilla' && s.loader !== 'vanilla' ? ` / ${s.loader}` : '';
  const pinned = (s.packVersion ? ' · バージョン指定' : '') + (s.type !== 'vanilla' && s.autoUpdate === false ? ' · 更新固定' : '');
  return kinds[s.type] + loader + pinned + (s.address ? ` · ${s.address}` : '');
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
    const b = el('button', `tile${view === g.guild.id ? ' on' : ''}`);
    b.title = g.guild.name;
    b.append(avatar(g.guild, 'av'), el('span', 'name', g.guild.name));
    b.onclick = () => { view = g.guild.id; render(); };
    rail.append(b);
  }
  $('home').classList.toggle('on', view === 'home');
}

// 起動構成(サーバー)ごとのメモリ割り当て。「既定」は詳細設定の最大メモリを使う
let defaultMemory = '4G';
let totalMemGb = 8;
function memoryRow(item) {
  const row = el('div', 'memrow');
  row.append(el('span', null, 'メモリ'));
  const sel = el('select', 'mem');
  sel.title = 'このサーバーを起動するときに使うメモリ(最大)';
  const options = [2, 3, 4, 6, 8, 10, 12, 16, 24, 32].filter((g) => g <= Math.max(2, totalMemGb - 1)).map((g) => `${g}G`);
  if (item.memory && !options.includes(item.memory)) options.push(item.memory); // 他の形式で保存済みの値も残す
  const def = el('option', null, `既定 (${defaultMemory})`);
  def.value = '';
  sel.append(def, ...options.map((v) => { const o = el('option', null, v.replace('G', ' GB')); o.value = v; return o; }));
  sel.value = item.memory || '';
  sel.onclick = (e) => e.stopPropagation(); // カードの選択を邪魔しない
  sel.onchange = guard(async () => { myList = await api.setMemory(item.id, sel.value); });
  row.append(sel);
  return row;
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
    if (i.entry.address && !i.gone) info.append(statusLine(i.entry.address));
    if (!i.gone) info.append(memoryRow(i));
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
    if (s.address) info.append(statusLine(s.address));
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

// サーバーの稼働状況(オンライン/人数/応答時間)。描画後にまとめて問い合わせる
let statusTargets = [];
function statusLine(address) {
  const st = el('small', 'st', '● 確認中…');
  statusTargets.push({ st, address });
  return st;
}
async function updateStatuses(targets) {
  const queue = [...targets];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const r = await api.ping(t.address).catch(() => ({ online: false }));
      t.st.className = r.online ? 'st on' : 'st off';
      t.st.textContent = r.online ? `● オンライン ${r.players.online}/${r.players.max}人 · ${r.latencyMs}ms` : '● オフライン';
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
}

function render() {
  statusTargets = [];
  renderRail();
  const root = $('view');
  root.replaceChildren();
  const g = groups.find((x) => x.guild.id === view);
  if (view !== 'home' && !g) view = 'home';
  $('title').textContent = view === 'home' ? 'マイリスト' : g.guild.name;
  if (view === 'home') renderHome(root); else renderGuild(root, g);
  updateStatuses(statusTargets);
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
  defaultMemory = init.settings.memoryMax;
  totalMemGb = init.totalMemGb || totalMemGb;
  $('notify').checked = init.settings.notifyUpdates;
  setDiscord(init.discord);
  if (init.account) setAccount(init.account);
  myList = init.myList;
  render();
  reload();
})();

api.on('log', addLog);
// ランチャーのバージョンアップの案内バー。状態ごとにボタンの役割が変わる
//   manual: ダウンロードページを開く / ready: 今すぐ再起動して更新 / downloading: ボタンなし
let updateMode = null;
api.on('update', (u) => {
  $('update').hidden = false;
  const btn = $('updateBtn');
  if (u.ready) {
    updateMode = 'install';
    $('updateText').textContent = `新しいバージョン ${u.version} の準備ができました(終了時にも自動で更新されます)`;
    btn.textContent = '今すぐ再起動して更新';
    btn.hidden = false;
  } else if (u.manual) {
    updateMode = 'releases';
    $('updateText').textContent = `新しいバージョン ${u.version} があります`;
    btn.textContent = 'ダウンロードページを開く';
    btn.hidden = false;
  } else {
    updateMode = null;
    $('updateText').textContent = `新しいバージョン ${u.version} をダウンロードしています...`;
    btn.hidden = true;
  }
});
$('updateBtn').onclick = guard(async () => {
  if (updateMode === 'install') await api.installUpdate();
  else if (updateMode === 'releases') await api.openReleases();
});
api.appVersion().then((v) => { $('ver').textContent = v; });
// ダウンロードの進捗: 「何を・何%・(件数)」。件数が分からない処理は動いている表示だけ
function showProgress(p) {
  const bar = $('fill');
  const text = $('progressText');
  if (!p || !p.label) { bar.classList.remove('indet'); bar.style.width = '0'; text.textContent = ''; return; }
  if (p.total) {
    const pct = Math.min(100, Math.floor((p.done / p.total) * 100));
    bar.classList.remove('indet');
    bar.style.width = pct + '%';
    text.textContent = `${p.label}  ${pct}%  (${p.done}/${p.total})`;
  } else {
    bar.classList.add('indet');
    text.textContent = p.label;
  }
}
api.on('progress', showProgress);
api.on('closed', (c) => { addLog(`ゲーム終了 (code ${c})`); busy = false; refreshPlay(); showProgress(null); });

$('home').onclick = () => { view = 'home'; render(); };
$('reload').onclick = reload;
$('dcin').onclick = guard(async () => { setDiscord(await api.loginDiscord()); await reload(); });
$('dcout').onclick = guard(async () => { await api.logoutDiscord(); setDiscord(null); groups = []; render(); });
$('ms').onclick = guard(async () => setAccount(await api.loginMicrosoft()));
$('off').onclick = guard(async () => setAccount(await api.loginOffline($('offname').value)));
$('save').onclick = guard(async () => {
  await api.saveSettings({ javaPath: $('java').value.trim(), memoryMax: $('max').value.trim(), notifyUpdates: $('notify').checked });
  defaultMemory = $('max').value.trim() || '4G';
  render(); // 各サーバーの「既定 (○G)」の表示を更新
  addLog('設定を保存しました');
});
$('folder').onclick = () => api.openFolder();
$('logToggle').onclick = () => showLog(logEl.hidden);
// ログを mclo.gs にアップロード(どのログを送るかは、確認ダイアログで選ぶ)
$('logUpload').onclick = guard(async () => {
  const url = await api.uploadLog(selectedId);
  if (url) addLog(`ログをアップロードしました: ${url}`);
});
$('admin').onclick = guard(() => api.openAdmin());
$('play').onclick = guard(async () => {
  busy = true; refreshPlay();
  if (!(await api.play(selectedId))) { busy = false; refreshPlay(); }
});
