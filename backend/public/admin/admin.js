const $ = (s) => document.querySelector(s);
const form = $('#form');
let versions = [];
let guilds = [];
let gid = null;
let editing = null;

async function api(method, url, body) {
  const r = await fetch('/admin/api' + url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
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
  mrpack: ['.mrpack ファイルのURL(https)', 'Modrinth 形式のパックファイルを置いた場所のURLです。ファイルを差し替えると次回起動時に更新されます。'],
  manifest: ['manifest.json のURL(https)', '上級者向け。README の manifest 形式に従ったJSONのURLです。'],
};

function syncForm() {
  const t = form.type.value;
  document.querySelectorAll('[data-for]').forEach((d) => { d.hidden = !d.dataset.for.split(' ').includes(t); });
  if (SRC[t]) { $('#srcLabel').textContent = SRC[t][0]; $('#srcHelp').textContent = SRC[t][1]; }
  form.source.required = t !== 'vanilla';
}

function fillVersions(selected) {
  const all = $('#showAll').checked;
  form.minecraft.replaceChildren(...versions.filter((v) => all || v.type === 'release').map((v) => {
    const o = el('option', null, v.id); o.value = v.id; return o;
  }));
  if (selected) form.minecraft.value = selected;
}

function showForm(s) {
  editing = s || null;
  $('#ftitle').textContent = s ? 'サーバーを編集' : 'サーバーを追加';
  $('#err').textContent = '';
  form.name.value = s?.name || '';
  form.description.value = s?.description || '';
  form.address.value = s?.address || '';
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

const describe = (s) =>
  ({ vanilla: `Minecraft ${s.minecraft}${s.loader !== 'vanilla' ? ' / ' + s.loader : ''}`, modrinth: `Modrinth: ${s.source}`, mrpack: '.mrpack', manifest: 'manifest' })[s.type];

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
  hideForm();
  loadServers();
}

form.type.onchange = syncForm;
$('#showAll').onchange = () => fillVersions(form.minecraft.value);
$('#new').onclick = () => showForm(null);
$('#cancel').onclick = hideForm;
form.onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    name: form.name.value, description: form.description.value, address: form.address.value,
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

(async () => {
  let me;
  try { me = await fetch('/admin/api/me', { credentials: 'same-origin' }); } catch { return; }
  if (me.status === 401) { $('#login').hidden = false; return; }
  const data = await me.json();
  $('#me').textContent = data.user.name;
  $('#logout').hidden = false;
  $('#app').hidden = false;
  guilds = data.guilds;
  versions = (await api('GET', '/versions')).versions;
  if (!guilds.length) { $('#empty').hidden = false; return; }
  const nav = $('#guilds');
  for (const g of guilds) {
    const b = el('button', 'g');
    b.dataset.id = g.id;
    if (g.icon) { const i = el('img'); i.src = g.icon; i.alt = ''; b.append(i); }
    b.append(el('span', null, g.name));
    b.onclick = () => selectGuild(g);
    nav.append(b);
  }
  selectGuild(guilds[0]);
})();
