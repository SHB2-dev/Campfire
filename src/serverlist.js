// マイクラ内の「マルチプレイ」のサーバー一覧(インスタンスの servers.dat)に、サーバーを追加する。
//
//  - プレイヤーが自分で追加したサーバーや、名前を変えた項目は、そのまま残す
//  - 管理者が登録したアドレスが変わったら、前に自動で追加した項目を片付ける(名前を変えていなければ)
//  - 同じアドレスの項目が「hidden」のときは表示に直す。
//    --quickPlayMultiplayer で起動すると、マイクラ自身が hidden=1 の項目を勝手に作り、一覧に出ないため
//  - 書き込む前に、元のファイルを1度だけバックアップする。壊れていて読めないファイルには触らない
const fs = require('fs');
const path = require('path');
const { T, parse, write } = require('./nbt');

const getStr = (item, key) => item.find((e) => e.name === key && e.tag.type === T.STRING)?.tag.value;
const setStr = (item, key, value) => {
  const e = item.find((x) => x.name === key);
  if (e) e.tag = { type: T.STRING, value };
  else item.push({ name: key, tag: { type: T.STRING, value } });
};
const isHidden = (item) => item.find((e) => e.name === 'hidden')?.tag.value === 1;
const setVisible = (item) => {
  const e = item.find((x) => x.name === 'hidden');
  if (e) e.tag = { type: T.BYTE, value: 0 };
};

function readManaged(stateFile) {
  try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}

// entries: [{ ip, name }]。戻り値: { changed, error? }
function syncServerList(gameDir, entries) {
  const file = path.join(gameDir, 'servers.dat');
  const stateFile = path.join(gameDir, '.packhearth-servers.json');

  let root;
  let original = null;
  if (fs.existsSync(file)) {
    original = fs.readFileSync(file);
    try { root = parse(original); } catch (e) { return { changed: false, error: `servers.dat を読めませんでした(${e.message})` }; }
  } else {
    root = { name: '', tag: { type: T.COMPOUND, value: [] } };
  }

  let list = root.tag.value.find((e) => e.name === 'servers');
  if (!list || list.tag.type !== T.LIST) {
    list = { name: 'servers', tag: { type: T.LIST, value: { itemType: T.COMPOUND, items: [] } } };
    root.tag.value = root.tag.value.filter((e) => e.name !== 'servers');
    root.tag.value.push(list);
  }
  const lv = list.tag.value;
  if (lv.itemType !== T.COMPOUND) lv.itemType = T.COMPOUND; // 空のリストは itemType が END になっている
  const wanted = new Set(entries.map((e) => e.ip));

  // 1) 前に自動で追加した項目のうち、いまの登録に無く、名前も変えられていないものを消す
  const managed = readManaged(stateFile);
  lv.items = lv.items.filter((item) => !managed.some((m) => m.ip === getStr(item, 'ip') && m.name === getStr(item, 'name') && !wanted.has(m.ip)));

  // 2) 足りない項目を追加。同じアドレスで hidden のものは表示に直して名前を付け直す。表示中のものは触らない
  for (const e of entries) {
    const existing = lv.items.find((item) => getStr(item, 'ip') === e.ip);
    if (!existing) {
      lv.items.push([{ name: 'ip', tag: { type: T.STRING, value: e.ip } }, { name: 'name', tag: { type: T.STRING, value: e.name } }]);
    } else if (isHidden(existing)) {
      setVisible(existing);
      setStr(existing, 'name', e.name);
    }
  }

  const next = write(root);
  const changed = !original || Buffer.compare(original, next) !== 0;
  if (changed) {
    if (original) {
      const backup = `${file}.packhearth-backup`;
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, original); // 最初の1回だけ
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
  }
  fs.writeFileSync(stateFile, JSON.stringify(entries.map((e) => ({ ip: e.ip, name: e.name }))));
  return { changed };
}

module.exports = { syncServerList };
