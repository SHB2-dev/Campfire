// 開発者専用ページ。ダウンロード数と、連携しているDiscordサーバーの詳細を表示する
const $ = (s) => document.querySelector(s);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '-');
const fmtNum = (n) => Number(n || 0).toLocaleString('ja-JP');

function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.map((w) => [...w][0]).join('') : [...(words[0] || '?')].slice(0, 2).join('')).slice(0, 3);
}
function guildIcon(g) {
  if (g.icon) { const i = el('img', 'gicon'); i.src = g.icon; i.alt = ''; return i; }
  return el('span', 'gicon ph', initials(g.name || '?'));
}

const TYPE_LABEL = { vanilla: 'バニラ', modrinth: 'Modrinth', curseforge: 'CurseForge', ftb: 'FTB', mrpack: '.mrpack', zip: 'zip', manifest: 'manifest' };
const OS_LABEL = { windows: 'Windows', windowsPortable: 'Windows(ポータブル)', mac: 'macOS', linuxAppImage: 'Linux(AppImage)', linuxDeb: 'Linux(deb)' };

function statCard(value, label, sub) {
  const c = el('div', 'stat');
  c.append(el('b', null, value), el('span', null, label));
  if (sub) c.append(el('small', null, sub));
  return c;
}

function render({ usage, downloads, generatedAt }) {
  const body = $('#body');
  body.replaceChildren();
  const t = usage.totals;
  const dl = downloads && !downloads.error ? downloads : null;
  const p = dl?.platforms || {};
  const typeText = Object.entries(usage.types).map(([k, n]) => `${TYPE_LABEL[k] || k} ${n}`).join(' · ');

  const grid = el('div', 'stat-grid');
  grid.append(
    statCard(dl ? fmtNum(dl.total) : '-', 'ダウンロード数(累計)', dl ? `Windows ${fmtNum((p.windows || 0) + (p.windowsPortable || 0))} · macOS ${fmtNum(p.mac)} · Linux ${fmtNum((p.linuxAppImage || 0) + (p.linuxDeb || 0))}` : downloads?.error || ''),
    statCard(fmtNum(t.users), '利用者数(累計)', `直近30日 ${fmtNum(t.users30d)} · 直近7日 ${fmtNum(t.users7d)}`),
    statCard(fmtNum(t.guilds), '連携中のDiscordサーバー'),
    statCard(fmtNum(t.servers), '登録されたサーバー', typeText),
  );
  body.append(grid);

  // バージョン別のダウンロード数
  if (dl?.releases?.length) {
    const sec = el('div', 'dev-section card');
    sec.append(el('h3', null, 'バージョン別のダウンロード数'));
    const bars = el('div', 'bars');
    const rels = dl.releases.slice(0, 10);
    const max = Math.max(1, ...rels.map((r) => r.total));
    for (const r of rels) {
      const row = el('div', 'bar-row');
      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      fill.style.width = `${(r.total / max) * 100}%`;
      track.append(fill);
      row.append(el('span', null, r.tag), track, el('span', 'num', fmtNum(r.total)));
      bars.append(row);
      const detail = Object.entries(r.platforms).filter(([, n]) => n).map(([k, n]) => `${OS_LABEL[k] || k} ${fmtNum(n)}`).join(' · ');
      if (detail) bars.append(el('div', 'bar-sub', detail));
    }
    sec.append(bars, el('p', 'help', `GitHub のリリースの集計です。ランチャーの自動更新によるダウンロードも含みます。${dl.stale ? '(GitHub に繋がらないため、前回の数字です)' : ''}`));
    body.append(sec);
  } else if (downloads?.error) {
    body.append(el('p', 'banner err', `ダウンロード数を取得できませんでした: ${downloads.error}`));
  }

  // 連携しているDiscordサーバーの詳細
  const sec2 = el('div', 'dev-section');
  sec2.append(el('h3', null, `連携しているDiscordサーバー(${usage.guilds.length})`));
  if (!usage.guilds.length) {
    sec2.append(el('div', 'empty', 'まだ、サーバーが登録されたDiscordサーバーはありません。'));
  } else {
    const wrap = el('div', 'tbl');
    const table = el('table');
    const head = el('tr');
    for (const [text, num] of [['Discordサーバー'], ['サーバー数', 1], ['利用者(30日 / 累計)', 1], ['管理者', 1], ['編集者', 1], ['種類'], ['最終更新']]) {
      head.append(el('th', num ? 'num' : '', text));
    }
    table.append(head);
    for (const g of usage.guilds) {
      const tr = el('tr');
      const cell = el('td');
      const gc = el('div', 'gcell');
      gc.append(guildIcon({ name: g.name || g.id, icon: g.icon }), el('span', null, g.name || `(名前未取得) ${g.id}`));
      cell.append(gc);
      tr.append(cell,
        el('td', 'num', fmtNum(g.servers)),
        el('td', 'num', `${fmtNum(g.users30d)} / ${fmtNum(g.users)}`),
        el('td', 'num', fmtNum(g.admins)),
        el('td', 'num', fmtNum(g.editors)),
        el('td', null, Object.entries(g.types).map(([k, n]) => `${TYPE_LABEL[k] || k} ${n}`).join(' · ')),
        el('td', null, fmtDate(g.updated)));
      table.append(tr);
    }
    wrap.append(table);
    sec2.append(wrap, el('p', 'help', '利用者数は、ランチャーでそのDiscordサーバーを見た人の数です。ユーザーIDは、元に戻せない形(ハッシュ)で保存した集計で、誰かは分かりません。'));
  }
  body.append(sec2, el('p', 'help', `更新: ${fmtDate(generatedAt)}`));
}

async function load() {
  $('#body').replaceChildren(el('p', 'muted', '読み込み中...'));
  try {
    const r = await fetch('/admin/api/dev/stats', { credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `エラー (${r.status})`);
    render(j);
  } catch (err) { $('#body').replaceChildren(el('p', 'banner err', err.message)); }
}

$('#reload').onclick = load;
fetch('/admin/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then((m) => { $('#me').textContent = m.user?.name || ''; }).catch(() => {});
load();
