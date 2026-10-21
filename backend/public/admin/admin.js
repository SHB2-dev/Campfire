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

const SRC = {
  modrinth: ['Modrinth のモッドパックURL', 'https://modrinth.com/modpack/... を貼り付けてください。パックが更新されると、プレイヤーは次回起動時に自動で更新されます。'],
  curseforge: ['CurseForge のモッドパックURL(またはパックzipのURL)', 'https://www.curseforge.com/minecraft/modpacks/... を貼り付けてください。最新のリリースが次回起動時に自動で反映されます。作者が外部配布を禁止しているMODは、ダウンロードできずエラーになることがあります。'],
  zip: ['zipファイルのURL(https)', 'mods/ や config/ などをそのまま詰めたzipです。Minecraft バージョンとローダーは「自動判定」のままで、zipの中身(MODの情報やパックの設定ファイル)から自動で判定されます。判定できなかったときだけ、手で指定してください。zipを差し替えると、次回起動時に config も含めて更新されます。'],
  mrpack: ['.mrpack ファイルのURL(https)', 'Modrinth 形式のパックファイルを置いた場所のURLです。ファイルを差し替えると次回起動時に更新されます。'],
  manifest: ['manifest.json のURL(https)', '上級者向け。README の manifest 形式に従ったJSONのURLです。'],
};

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

function showForm(s) {
  editing = s || null;
  $('#ftitle').textContent = s ? 'サーバーを編集' : 'サーバーを追加';
  $('#err').textContent = '';
  form.name.value = s?.name || '';
  form.description.value = s?.description || '';
  form.address.value = s?.address || '';
  form.altAddresses.value = (s?.altAddresses || []).join('\n');
  $('#testResult').textContent = '';
  loadHistory(s);
  form.autoConnect.checked = s ? s.autoConnect : true;
  form.type.value = s?.type || 'vanilla';
  form.loader.value = s?.loader || 'vanilla';
  form.loaderVersion.value = s?.loaderVersion || '';
  form.source.value = s?.source || '';
  const isOld = s?.minecraft && !versions.some((v) => v.id === s.minecraft && v.type === 'release');
  $('#showAll').checked = !!isOld;
  fillVersions(s?.minecraft);
  syncForm();
  form.hidden = false;
  $('#new').hidden = true;
  form.scrollIntoView({ behavior: 'smooth' });
}
function hideForm() { form.hidden = true; $('#new').hidden = false; }

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
    row.append(el('b', null, new Date(h.at).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })), el('span', null, `  ${h.by}  →  ${[h.address, ...h.altAddresses].join(' , ') || '(なし)'}`));
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

const describe = (s) =>
  ({
    vanilla: `Minecraft ${s.minecraft}${s.loader !== 'vanilla' ? ' / ' + s.loader : ''}`,
    modrinth: `Modrinth: ${s.source}`, curseforge: `CurseForge: ${s.source}`,
    mrpack: '.mrpack', zip: `zip · ${s.minecraft || '自動判定'} / ${s.loader === 'auto' ? '自動' : s.loader}`, manifest: 'manifest',
  })[s.type];

async function loadServers() {
  const { servers } = await api('GET', `/guilds/${gid}/servers`);
  const list = $('#list');
  list.replaceChildren();
  if (!servers.length) list.append(el('p', 'muted', 'まだ登録されていません。'));
  for (const s of servers) {
    const row = el('div', 'item');
    const info = el('div');
    info.append(el('b', null, s.name), el('small', 'muted', `${describe(s)}${s.address ? ' · ' + s.address : ''}`));
    const edit = el('button', 'ghost', '編集');
    edit.onclick = () => showForm(s);
    const del = el('button', 'danger', '削除');
    del.onclick = async () => {
      if (!confirm(`「${s.name}」を削除しますか?`)) return;
      await api('DELETE', `/guilds/${gid}/servers/${s.id}`);
      loadServers();
    };
    row.append(info, edit, del);
    list.append(row);
  }
}

function selectGuild(g) {
  gid = g.id;
  document.querySelectorAll('#guilds button').forEach((b) => b.classList.toggle('on', b.dataset.id === g.id));
  $('#gname').textContent = g.name;
  $('#panel').hidden = false;
  $('#invNote').textContent = '';
  hideForm();
  loadServers();
  const canInvite = g.role === 'admin' || g.role === 'owner';
  $('#team').hidden = !canInvite;
  if (canInvite) loadTeam(g.role);
}

const ROLE_LABEL = { editor: '編集者', owner: '登録者' };

const fmtDate = (ms) => new Date(ms).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

async function loadTeam(role) {
  const forGuild = gid;
  const { owner, editors, invites } = await api('GET', `/guilds/${forGuild}/editors`);
  if (forGuild !== gid) return; // 読み込み中に別のサーバーへ切り替えた
  const ow = $('#owner');
  ow.replaceChildren();
  if (owner) {
    const row = el('div', 'item');
    const info = el('div');
    info.append(el('b', null, owner.name), el('small', 'muted', 'このサーバーの登録者(オーナー)'));
    row.append(info);
    if (role === 'admin') {
      const del = el('button', 'danger', '外す');
      del.onclick = async () => {
        if (!confirm(`${owner.name} の登録者権限を外しますか?`)) return;
        await api('DELETE', `/guilds/${forGuild}/owner`);
        location.reload();
      };
      row.append(del);
    }
    ow.append(row);
  }
  const ed = $('#editors');
  ed.replaceChildren();
  if (!editors.length) ed.append(el('p', 'muted', '編集者はまだいません。'));
  for (const e of editors) {
    const row = el('div', 'item');
    const info = el('div');
    info.append(el('b', null, e.name));
    const del = el('button', 'danger', '外す');
    del.onclick = async () => {
      if (!confirm(`${e.name} の編集権限を外しますか?`)) return;
      await api('DELETE', `/guilds/${forGuild}/editors/${e.userId}`);
      loadTeam();
    };
    row.append(info, del);
    ed.append(row);
  }
  const inv = $('#invites');
  inv.replaceChildren();
  for (const i of invites) {
    const row = el('div', 'item');
    const info = el('div');
    info.append(el('code', null, i.url), el('small', 'muted', `残り${i.usesLeft}人 · ${fmtDate(i.expiresAt)} まで`));
    const copy = el('button', 'ghost', 'コピー');
    copy.onclick = async () => { try { await navigator.clipboard.writeText(i.url); copy.textContent = 'コピーしました'; } catch { prompt('コピーしてください', i.url); } };
    const del = el('button', 'danger', '無効化');
    del.onclick = async () => { await api('DELETE', `/guilds/${forGuild}/invites/${i.code}`); loadTeam(); };
    row.append(info, copy, del);
    inv.append(row);
  }
}

$('#invNew').onclick = async () => {
  try {
    const { url } = await api('POST', `/guilds/${gid}/invites`, { hours: Number($('#invHours').value), maxUses: Number($('#invUses').value) });
    $('#invNote').textContent = '招待リンクを発行しました。信頼できる人にだけ渡してください。';
    try { await navigator.clipboard.writeText(url); $('#invNote').textContent += '(クリップボードにコピー済み)'; } catch { /* 手動コピー */ }
    loadTeam();
  } catch (err) { $('#invNote').textContent = err.message; }
};

form.type.onchange = () => {
  syncForm();
  // 新規で zip を選んだときは、最初から「自動判定」にする
  if (form.type.value === 'zip' && !editing) { form.minecraft.value = ''; form.loader.value = 'auto'; }
};
$('#showAll').onchange = () => fillVersions(form.minecraft.value);
$('#new').onclick = () => showForm(null);
$('#cancel').onclick = hideForm;
form.onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    name: form.name.value, description: form.description.value, address: form.address.value, altAddresses: form.altAddresses.value,
    autoConnect: form.autoConnect.checked, type: form.type.value, minecraft: form.minecraft.value,
    loader: form.loader.value, loaderVersion: form.loaderVersion.value, source: form.source.value,
  };
  try {
    if (editing) await api('PUT', `/guilds/${gid}/servers/${editing.id}`, body);
    else await api('POST', `/guilds/${gid}/servers`, body);
    hideForm();
    loadServers();
  } catch (err) { $('#err').textContent = err.message; }
};
$('#logout').onclick = async () => { await api('POST', '/logout', {}); location.reload(); };

function renderClaimable(list) {
  $('#claim').hidden = !list.length;
  const box = $('#claimList');
  box.replaceChildren();
  for (const g of list) {
    const b = el('button', 'g');
    if (g.icon) { const i = el('img'); i.src = g.icon; i.alt = ''; b.append(i); }
    b.append(el('span', null, g.name), el('small', 'tag', '登録する'));
    b.onclick = async () => {
      if (!confirm(`「${g.name}」を登録しますか?\n最初に登録した人がこのサーバーの登録者になり、編集者を招待できます。`)) return;
      try { await api('POST', `/guilds/${g.id}/claim`, {}); location.reload(); }
      catch (err) { alert(err.message); location.reload(); }
    };
    box.append(b);
  }
}

// 招待リンク(?invite=CODE)はログインを挟んでも失わないよう sessionStorage に退避
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
  let me;
  try { me = await fetch('/admin/api/me', { credentials: 'same-origin' }); } catch { return; }
  if (me.status === 401) { $('#inviteHint').hidden = !invite; $('#login').hidden = false; return; }

  let joinedGuild = null;
  if (invite) {
    try {
      const r = await api('POST', '/invite/redeem', { code: invite });
      joinedGuild = r.guildId;
      $('#notice').textContent = `「${r.name}」の編集者になりました。`;
    } catch (err) {
      $('#notice').textContent = `招待を使えませんでした: ${err.message}`;
      $('#notice').classList.replace('ok', 'err');
    }
    $('#notice').hidden = false;
    clearInvite();
    me = await fetch('/admin/api/me', { credentials: 'same-origin' });
  }
  const data = await me.json();
  $('#me').textContent = data.user.name;
  $('#logout').hidden = false;
  $('#app').hidden = false;
  guilds = data.guilds;
  const meta = await api('GET', '/versions');
  versions = meta.versions;
  // CurseForge は API キーが設定されているサーバーでのみ選べる
  if (!meta.curseforge) form.type.querySelector('option[value="curseforge"]')?.remove();
  renderClaimable(data.claimable || []);
  if (!guilds.length) {
    $('#empty').textContent = data.claimable?.length
      ? '編集できるサーバーがまだありません。左の「未登録のサーバー」から登録するか、管理者に招待リンクを発行してもらってください。'
      : '編集できるDiscordサーバーがありません。管理者に招待リンクを発行してもらってください。';
    $('#empty').hidden = false;
    return;
  }
  const nav = $('#guilds');
  for (const g of guilds) {
    const b = el('button', 'g');
    b.dataset.id = g.id;
    if (g.icon) { const i = el('img'); i.src = g.icon; i.alt = ''; b.append(i); }
    b.append(el('span', null, g.name));
    if (ROLE_LABEL[g.role]) b.append(el('small', 'tag', ROLE_LABEL[g.role]));
    b.onclick = () => selectGuild(g);
    nav.append(b);
  }
  selectGuild(guilds.find((g) => g.id === joinedGuild) || guilds[0]);
})();
