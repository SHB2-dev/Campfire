const $ = (s) => document.querySelector(s);
const form = $('#form');
let versions = [];
let guilds = [];
let gid = null;
let editing = null;

async function api(method, url, body) {
  const r = await fetch('/admin/api' + url, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.reload(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error(j.error || `エラー (${r.status})`);
  return j;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// 操作の結果を、画面の下に数秒だけ表示する
let toastTimer;
function toast(message, kind = 'good') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

const fmtDate = (ms) => new Date(ms).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
const fmtNum = (n) => Number(n || 0).toLocaleString('ja-JP');
const copyText = async (text, button) => {
  try { await navigator.clipboard.writeText(text); toast('コピーしました'); if (button) button.textContent = 'コピーしました'; }
  catch { prompt('コピーしてください', text); }
};

function showTab(name) {
  for (const t of ['servers', 'members']) {
    $(`#tab-${t}`).classList.toggle('on', t === name);
    $(`#tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`#pane-${t}`).hidden = t !== name;
  }
  if (name === 'members') loadMembers();
}

// ---- サーバーのアイコン(無いときは名前の頭文字) ----
function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.map((w) => [...w][0]).join('') : [...(words[0] || '?')].slice(0, 2).join('')).slice(0, 3);
}
function guildIcon(g) {
  if (g.icon) { const i = el('img', 'gicon'); i.src = g.icon; i.alt = ''; return i; }
  return el('span', 'gicon ph', initials(g.name || '?'));
}

// 権限の表示。admin かつ granted でない人 = Discordの管理権限を持つ人
function roleInfo(g) {
  if (g.role === 'admin') return g.granted ? ['管理者', 'admin'] : ['Discord管理者', 'admin'];
  return ['編集者', 'editor'];
}

// ---- パックの種類ごとの入力欄と説明 ----
const SRC = {
  modrinth: ['Modrinth のモッドパックURL', 'https://modrinth.com/modpack/... を貼り付けてください。パックが更新されると、プレイヤーは次回起動時に自動で更新されます。'],
  curseforge: ['CurseForge のモッドパックURL(またはパックzipのURL)', 'https://www.curseforge.com/minecraft/modpacks/... を貼り付けてください。最新のリリースが次回起動時に自動で反映されます。作者が外部配布を禁止しているMODは、ダウンロードできずエラーになることがあります。'],
  ftb: ['FTB のパックページのURL(またはパックID)', 'https://www.feed-the-beast.com/modpacks/... を貼り付けてください。最新のリリース版が次回起動時に自動で反映されます。大きなパックは、初回のダウンロードに時間がかかります。'],
  zip: ['zipファイルのURL(https)', 'mods/ や config/ などをそのまま詰めたzipです。Minecraft バージョンとローダーは「自動判定」のままで、zipの中身(MODの情報やパックの設定ファイル)から自動で判定されます。判定できなかったときだけ、手で指定してください。zipを差し替えると、次回起動時に config も含めて更新されます。'],
  mrpack: ['.mrpack ファイルのURL(https)', 'Modrinth 形式のパックファイルを置いた場所のURLです。ファイルを差し替えると次回起動時に更新されます。'],
  manifest: ['manifest.json のURL(https)', '上級者向け。README の manifest 形式に従ったJSONのURLです。'],
};
const TYPE_LABEL = { vanilla: 'バニラ', modrinth: 'Modrinth', curseforge: 'CurseForge', ftb: 'FTB', mrpack: '.mrpack', zip: 'zip', manifest: 'manifest' };
const VERSIONABLE = ['modrinth', 'curseforge', 'ftb'];

function syncForm() {
  const t = form.type.value;
  document.querySelectorAll('[data-for]').forEach((d) => { d.hidden = !d.dataset.for.split(' ').includes(t); });
  if (SRC[t]) { $('#srcLabel').textContent = SRC[t][0]; $('#srcHelp').textContent = SRC[t][1]; }
  form.source.required = t !== 'vanilla';
  // 「自動判定」は zip のときだけ選べる(ランチャーが zip の中身から Minecraft バージョンとローダーを判定する)
  const autoLoader = form.loader.querySelector('option[data-auto]');
  autoLoader.disabled = autoLoader.hidden = t !== 'zip';
  if (t !== 'zip' && form.loader.value === 'auto') form.loader.value = 'vanilla';
  fillVersions(form.minecraft.value);
}

function fillVersions(selected) {
  const all = $('#showAll').checked;
  const opts = versions.filter((v) => all || v.type === 'release').map((v) => {
    const o = el('option', null, v.id); o.value = v.id; return o;
  });
  if (form.type.value === 'zip') { const a = el('option', null, '自動判定(おすすめ)'); a.value = ''; opts.unshift(a); }
  form.minecraft.replaceChildren(...opts);
  if (selected) form.minecraft.value = selected;
}

// ---- サーバーの追加・編集フォーム ----
function showForm(s) {
  editing = s || null;
  $('#ftitle').textContent = s ? `「${s.name}」を編集` : 'サーバーを追加';
  $('#err').textContent = '';
  form.name.value = s?.name || '';
  form.description.value = s?.description || '';
  form.address.value = s?.address || '';
  form.altAddresses.value = (s?.altAddresses || []).join('\n');
  $('#testResult').textContent = '';
  loadHistory(s);
  form.autoConnect.checked = s ? s.autoConnect : true;
  form.autoUpdate.checked = s ? s.autoUpdate : true;
  form.type.value = s?.type || 'vanilla';
  form.loader.value = s?.loader || 'vanilla';
  form.loaderVersion.value = s?.loaderVersion || '';
  form.source.value = s?.source || '';
  resetVersions(s?.packVersion || '');
  if (s && VERSIONABLE.includes(s.type) && s.source) loadVersions(); // 編集時は、選べる一覧も読み込んでおく
  const isOld = s?.minecraft && !versions.some((v) => v.id === s.minecraft && v.type === 'release');
  $('#showAll').checked = !!isOld;
  fillVersions(s?.minecraft);
  syncForm();
  $('#serverList').hidden = true;
  form.hidden = false;
  window.scrollTo({ top: $('#panel').offsetTop - 70, behavior: 'smooth' });
  form.name.focus();
}
function hideForm() {
  form.hidden = true;
  $('#serverList').hidden = false;
}

// パックのバージョン指定(Modrinth / CurseForge / FTB)
const verOption = (value, text) => { const o = el('option', null, text); o.value = value; return o; };

// 選択肢を「最新」+(指定中の版があればそれ)に戻す。パックのURLや形式を変えたときに使う
function resetVersions(selected) {
  const sel = form.packVersion;
  sel.replaceChildren(verOption('', '最新(自動で追従)'));
  if (selected) sel.append(verOption(selected, `指定中: ${selected}`));
  sel.value = selected || '';
  $('#verResult').textContent = '';
}

function versionLabel(v) {
  const date = v.date ? new Date(v.date).toLocaleDateString('ja-JP') : '';
  const kind = v.type && v.type !== 'release' ? ` [${v.type}]` : '';
  const extra = [v.mc && `MC ${v.mc}`, v.loaders?.length && v.loaders.join('/')].filter(Boolean).join(' · ');
  return `${v.name}${kind}  ·  ${date}${extra ? '  ·  ' + extra : ''}`;
}

async function loadVersions() {
  const out = $('#verResult');
  if (!form.source.value.trim()) { out.className = 'bad'; out.textContent = '先にパックのURLを入力してください'; return; }
  out.className = 'muted';
  out.textContent = '読み込み中...';
  try {
    const { versions: list } = await api('POST', '/pack-versions', { type: form.type.value, source: form.source.value });
    const sel = form.packVersion;
    const current = sel.value;
    sel.replaceChildren(verOption('', '最新(自動で追従)'), ...list.map((v) => verOption(v.id, versionLabel(v))));
    if (current && !list.some((v) => v.id === current)) sel.append(verOption(current, `指定中: ${current}(一覧に無い版)`));
    sel.value = current;
    out.textContent = `${list.length}件を読み込みました`;
  } catch (err) { out.className = 'bad'; out.textContent = err.message; }
}

// 接続先アドレスの変更履歴(編集時のみ表示)
async function loadHistory(s) {
  const box = $('#historyBox');
  box.hidden = true;
  if (!s) return;
  const forGuild = gid;
  const { history } = await api('GET', `/guilds/${forGuild}/servers/${s.id}/history`).catch(() => ({ history: [] }));
  if (editing !== s || forGuild !== gid || !history.length) return;
  const list = $('#history');
  list.replaceChildren();
  for (const h of history) {
    const row = el('div', 'h');
    row.append(el('b', null, fmtDate(h.at)), el('span', null, `  ${h.by}  →  ${[h.address, ...h.altAddresses].join(' , ') || '(なし)'}`));
    list.append(row);
  }
  box.hidden = false;
}

// 接続テスト: メインと予備アドレスを順に確認して結果を表示
$('#testAddr').onclick = async () => {
  const out = $('#testResult');
  const list = [form.address.value, ...form.altAddresses.value.split(/[\r\n,]+/)].map((x) => x.trim()).filter(Boolean);
  if (!list.length) { out.textContent = 'アドレスを入力してください'; out.className = 'bad'; return; }
  out.className = 'muted';
  out.replaceChildren();
  for (const addr of list.slice(0, 4)) {
    const line = el('div', 'muted', `${addr} …確認中`);
    out.append(line);
    try {
      const r = await api('POST', '/ping', { address: addr });
      if (r.online) {
        line.className = 'good';
        line.textContent = `● ${addr}  オンライン ${r.players.online}/${r.players.max}人 · ${r.latencyMs}ms · ${r.version}${r.motd ? ' · ' + r.motd : ''}`;
      } else { line.className = 'bad'; line.textContent = `● ${addr}  オフライン (${r.error})`; }
    } catch (err) { line.className = 'bad'; line.textContent = `● ${addr}  ${err.message}`; }
  }
};

// ---- サーバーの一覧(カード) ----
function serverChips(s) {
  const chips = [];
  const add = (text, cls) => chips.push(el('span', `chip${cls ? ' ' + cls : ''}`, text));
  if (s.type === 'vanilla') {
    add('バニラ');
    add(`Minecraft ${s.minecraft}`);
    if (s.loader !== 'vanilla') add(s.loader);
  } else {
    add(TYPE_LABEL[s.type] || s.type, 'pack');
    if (s.type === 'zip') add(`${s.minecraft || 'バージョン自動判定'}${s.loader && s.loader !== 'auto' ? ' / ' + s.loader : ''}`);
    if (VERSIONABLE.includes(s.type)) add(s.packVersion ? 'バージョン指定' : '最新に自動追従', s.packVersion ? 'pin' : '');
    if (!s.autoUpdate) add('更新固定', 'pin');
  }
  return chips;
}

async function loadServers() {
  const forGuild = gid;
  const { servers } = await api('GET', `/guilds/${forGuild}/servers`);
  if (forGuild !== gid) return;
  $('#serverCount').textContent = `サーバー(${servers.length})`;
  const list = $('#list');
  list.replaceChildren();
  if (!servers.length) {
    list.append(el('div', 'empty', 'まだサーバーが登録されていません。右上の「＋ サーバーを追加」から登録してください。'));
    return;
  }
  for (const s of servers) {
    const card = el('div', 'srv');
    const main = el('div', 'srv-main');
    const meta = el('div', 'srv-meta');
    meta.append(...serverChips(s));
    const addr = el('div', 'srv-addr',
      s.address ? `接続先: ${s.address}${s.altAddresses.length ? `(予備 ${s.altAddresses.length})` : ''}` : '接続先は未設定');
    main.append(el('div', 'srv-name', s.name), meta, addr);
    if (s.description) main.append(el('div', 'srv-addr', s.description));

    const actions = el('div', 'srv-actions');
    const edit = el('button', 'btn ghost sm', '編集');
    edit.onclick = () => showForm(s);
    const del = el('button', 'btn danger sm', '削除');
    del.onclick = async () => {
      if (!confirm(`「${s.name}」を削除しますか?\nこのサーバーは、メンバーのランチャーの一覧から消えます。`)) return;
      try { await api('DELETE', `/guilds/${forGuild}/servers/${s.id}`); toast('削除しました'); loadServers(); }
      catch (err) { toast(err.message, 'bad'); }
    };
    actions.append(edit, del);
    card.append(main, actions);
    list.append(card);
  }
}

// ---- Discord サーバーの選択 ----
function selectGuild(g) {
  gid = g.id;
  document.querySelectorAll('#guilds .g').forEach((b) => b.classList.toggle('on', b.dataset.id === g.id));
  $('#gicon').replaceChildren(guildIcon(g));
  $('#gname').textContent = g.name;
  const [label, cls] = roleInfo(g);
  const badge = $('#grole');
  badge.textContent = label;
  badge.className = `badge ${cls}`;
  $('#panel').hidden = false;
  $('#invNote').textContent = '';
  hideForm();
  $('#tab-members').hidden = g.role !== 'admin';
  showTab('servers');
  loadServers();
}

// ---- メンバーと招待(管理者のみ) ----
const ROLE_NAME = { admin: '管理者', editor: '編集者' };

async function loadMembers() {
  const forGuild = gid;
  let data;
  try { data = await api('GET', `/guilds/${forGuild}/members`); } catch (err) { toast(err.message, 'bad'); return; }
  if (forGuild !== gid) return; // 読み込み中に別のサーバーへ切り替えた

  const inv = $('#invites');
  inv.replaceChildren();
  if (!data.invites.length) inv.append(el('p', 'help', '有効な招待URLはありません。'));
  for (const i of data.invites) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    const head = el('div', 'inline');
    head.append(el('span', `badge ${i.role}`, `${ROLE_NAME[i.role]}のURL`), el('span', 'muted small', `残り${i.usesLeft}人 · ${fmtDate(i.expiresAt)} まで`));
    main.append(head, el('code', null, i.url));
    const copy = el('button', 'btn ghost sm', 'コピー');
    copy.onclick = () => copyText(i.url, copy);
    const del = el('button', 'btn danger sm', '無効化');
    del.onclick = async () => {
      try { await api('DELETE', `/guilds/${forGuild}/invites/${i.code}`); toast('招待URLを無効にしました'); loadMembers(); }
      catch (err) { toast(err.message, 'bad'); }
    };
    row.append(main, copy, del);
    inv.append(row);
  }

  const box = $('#members');
  box.replaceChildren();
  if (!data.members.length) box.append(el('p', 'help', 'まだ誰にも権限を付与していません。上の「招待URLを発行」で、URLを作って渡してください。'));
  for (const m of data.members) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('b', null, m.name), el('span', 'muted small', m.isSelf ? 'あなた' : '招待URLで付与'));
    const sel = el('select');
    for (const role of ['admin', 'editor']) { const o = el('option', null, ROLE_NAME[role]); o.value = role; sel.append(o); }
    sel.value = m.role;
    sel.disabled = m.isSelf;
    sel.setAttribute('aria-label', `${m.name} の権限`);
    sel.onchange = async () => {
      try { await api('PUT', `/guilds/${forGuild}/members/${m.userId}`, { role: sel.value }); toast(`${m.name} を「${ROLE_NAME[sel.value]}」にしました`); }
      catch (err) { toast(err.message, 'bad'); }
      loadMembers();
    };
    const revoke = el('button', 'btn danger sm', '取り消し');
    revoke.disabled = m.isSelf;
    revoke.onclick = async () => {
      if (!confirm(`${m.name} の権限を取り消しますか?\nこの人は、このDiscordサーバーの管理サイトを操作できなくなります。`)) return;
      try { await api('DELETE', `/guilds/${forGuild}/members/${m.userId}`); toast('権限を取り消しました'); }
      catch (err) { toast(err.message, 'bad'); }
      loadMembers();
    };
    row.append(main, sel, revoke);
    box.append(row);
  }
}

$('#invNew').onclick = async () => {
  try {
    const { url, role } = await api('POST', `/guilds/${gid}/invites`, {
      role: $('#invRole').value, hours: Number($('#invHours').value), maxUses: Number($('#invUses').value),
    });
    $('#invNote').textContent = `「${ROLE_NAME[role]}」の招待URLを発行しました。信頼できる人にだけ渡してください。URLを開いてログインした人に、権限が付与されます。`;
    try { await navigator.clipboard.writeText(url); toast('招待URLを発行して、コピーしました'); } catch { toast('招待URLを発行しました'); }
    loadMembers();
  } catch (err) { $('#invNote').textContent = err.message; toast(err.message, 'bad'); }
};

// ---- フォームの操作 ----
$('#loadVersions').onclick = loadVersions;
// パックのURLや形式を変えたら、前のパックのバージョン一覧は使えないので「最新」に戻す
form.source.onchange = () => resetVersions('');
form.type.onchange = () => {
  resetVersions('');
  syncForm();
  // 新規で zip を選んだときは、最初から「自動判定」にする
  if (form.type.value === 'zip' && !editing) { form.minecraft.value = ''; form.loader.value = 'auto'; }
};
$('#showAll').onchange = () => fillVersions(form.minecraft.value);
$('#new').onclick = () => showForm(null);
$('#cancel').onclick = hideForm;
$('#cancelTop').onclick = hideForm;
form.onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    name: form.name.value, description: form.description.value, address: form.address.value, altAddresses: form.altAddresses.value,
    autoConnect: form.autoConnect.checked, autoUpdate: form.autoUpdate.checked,
    packVersion: VERSIONABLE.includes(form.type.value) ? form.packVersion.value : '',
    type: form.type.value, minecraft: form.minecraft.value,
    loader: form.loader.value, loaderVersion: form.loaderVersion.value, source: form.source.value,
  };
  try {
    if (editing) await api('PUT', `/guilds/${gid}/servers/${editing.id}`, body);
    else await api('POST', `/guilds/${gid}/servers`, body);
    toast('保存しました');
    hideForm();
    loadServers();
  } catch (err) { $('#err').textContent = err.message; }
};
$('#logout').onclick = async () => { await api('POST', '/logout', {}); location.reload(); };
$('#tab-servers').onclick = () => showTab('servers');
$('#tab-members').onclick = () => showTab('members');

// 招待URL(?invite=CODE)は、ログインを挟んでも失わないよう sessionStorage に退避
function takeInvite() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('invite');
    if (fromUrl) {
      sessionStorage.setItem('invite', fromUrl);
      history.replaceState(null, '', location.pathname);
    }
    return sessionStorage.getItem('invite');
  } catch { return new URLSearchParams(location.search).get('invite'); }
}
const clearInvite = () => { try { sessionStorage.removeItem('invite'); } catch { /* 無視 */ } };

(async () => {
  const invite = takeInvite();
  let res;
  try { res = await fetch('/admin/api/me', { credentials: 'same-origin' }); } catch { return; }
  if (res.status === 401) { $('#inviteHint').hidden = !invite; $('#login').hidden = false; return; }

  // 招待URLを開いて来た人には、そのURLの権限を付与する
  let joinedGuild = null;
  const notice = $('#notice');
  if (invite) {
    try {
      const r = await api('POST', '/invite/redeem', { code: invite });
      joinedGuild = r.guildId;
      notice.textContent = r.unchanged
        ? `「${r.name}」では、すでに同じかそれ以上の権限があります。`
        : `「${r.name}」の${ROLE_NAME[r.role]}になりました。`;
      notice.className = 'banner ok';
    } catch (err) {
      notice.textContent = `招待URLを使えませんでした: ${err.message}`;
      notice.className = 'banner err';
    }
    notice.hidden = false;
    clearInvite();
    res = await fetch('/admin/api/me', { credentials: 'same-origin' });
  }

  const data = await res.json();
  $('#me').textContent = data.user.name;
  $('#logout').hidden = false;
  $('#app').hidden = false;
  $('#devLink').hidden = !data.isDeveloper; // 開発者にだけ、専用ページへの小さなリンクを出す
  guilds = data.guilds;
  const meta = await api('GET', '/versions');
  versions = meta.versions;
  // CurseForge は API キーが設定されているサーバーでのみ選べる
  if (!meta.curseforge) form.type.querySelector('option[value="curseforge"]')?.remove();

  if (!guilds.length) {
    const empty = $('#empty');
    empty.textContent = '管理・編集できるDiscordサーバーがありません。Discordサーバーの管理者に、招待URLを発行してもらってください。';
    empty.hidden = false;
    return;
  }
  const nav = $('#guilds');
  for (const g of guilds) {
    const b = el('button', 'g');
    b.dataset.id = g.id;
    b.title = g.name;
    b.setAttribute('role', 'listitem');
    b.append(guildIcon(g), el('span', 'gname', g.name));
    if (g.granted) b.append(el('small', 'tag', roleInfo(g)[0]));
    b.onclick = () => selectGuild(g);
    nav.append(b);
  }
  selectGuild(guilds.find((g) => g.id === joinedGuild) || guilds[0]);
})();
