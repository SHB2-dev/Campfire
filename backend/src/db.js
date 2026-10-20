const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, '..', 'data.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  auto_connect INTEGER NOT NULL DEFAULT 1,
  source_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  minecraft TEXT NOT NULL DEFAULT '',
  loader TEXT NOT NULL DEFAULT 'vanilla',
  loader_version TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS servers_guild ON servers(guild_id);
CREATE TABLE IF NOT EXISTS editors (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS guild_owners (
  guild_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invites_guild ON invites(guild_id);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  access_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

const COLS = 'guild_id,name,description,address,auto_connect,source_type,source,minecraft,loader,loader_version';
const vals = (s) => [s.guildId, s.name, s.description, s.address, s.autoConnect ? 1 : 0, s.type, s.source, s.minecraft, s.loader, s.loaderVersion];

module.exports = {
  addServer: (s, userId) =>
    db.prepare(`INSERT INTO servers (${COLS},created_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(...vals(s), userId, Date.now()).lastInsertRowid,
  updateServer: (id, s) =>
    db.prepare(
      `UPDATE servers SET name=?,description=?,address=?,auto_connect=?,source_type=?,source=?,minecraft=?,loader=?,loader_version=?,updated_at=?
       WHERE id=? AND guild_id=?`
    ).run(s.name, s.description, s.address, s.autoConnect ? 1 : 0, s.type, s.source, s.minecraft, s.loader, s.loaderVersion, Date.now(), id, s.guildId).changes,
  countServers: (guildId) => db.prepare('SELECT COUNT(*) AS n FROM servers WHERE guild_id=?').get(guildId).n,
  serversOfGuild: (guildId) => db.prepare('SELECT * FROM servers WHERE guild_id=? ORDER BY id').all(guildId),
  serversForGuilds: (ids) => {
    if (!ids.length) return [];
    return db.prepare(`SELECT * FROM servers WHERE guild_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
  },
  getServer: (id) => db.prepare('SELECT * FROM servers WHERE id=?').get(id),
  removeServer: (guildId, id) => db.prepare('DELETE FROM servers WHERE guild_id=? AND id=?').run(guildId, id).changes,
  // --- 編集者(管理者権限なしでパックを編集できる人)と招待リンク ---
  isEditor: (guildId, userId) => !!db.prepare('SELECT 1 FROM editors WHERE guild_id=? AND user_id=?').get(guildId, userId),
  editorGuilds: (userId) => db.prepare('SELECT guild_id FROM editors WHERE user_id=?').all(userId).map((r) => r.guild_id),
  listEditors: (guildId) => db.prepare('SELECT user_id,username,added_at FROM editors WHERE guild_id=? ORDER BY added_at').all(guildId),
  countEditors: (guildId) => db.prepare('SELECT COUNT(*) AS n FROM editors WHERE guild_id=?').get(guildId).n,
  addEditor: (guildId, userId, username, addedBy) =>
    db.prepare('INSERT OR IGNORE INTO editors (guild_id,user_id,username,added_by,added_at) VALUES (?,?,?,?,?)')
      .run(guildId, userId, username, addedBy, Date.now()),
  removeEditor: (guildId, userId) => db.prepare('DELETE FROM editors WHERE guild_id=? AND user_id=?').run(guildId, userId).changes,
  // --- オーナー(そのDiscordサーバーを最初に「登録する」と押した人) ---
  getOwner: (guildId) => db.prepare('SELECT user_id,username FROM guild_owners WHERE guild_id=?').get(guildId) || null,
  // 先着1人だけ成功する
  claimOwner: (guildId, userId, username) =>
    db.prepare('INSERT OR IGNORE INTO guild_owners (guild_id,user_id,username,claimed_at) VALUES (?,?,?,?)')
      .run(guildId, userId, username, Date.now()).changes === 1,
  removeOwner: (guildId) => db.prepare('DELETE FROM guild_owners WHERE guild_id=?').run(guildId).changes,
  ownerGuilds: (userId) => db.prepare('SELECT guild_id FROM guild_owners WHERE user_id=?').all(userId).map((r) => r.guild_id),
  isRegistered: (guildId) =>
    !!db.prepare('SELECT 1 FROM guild_owners WHERE guild_id=?').get(guildId) ||
    db.prepare('SELECT COUNT(*) AS n FROM servers WHERE guild_id=?').get(guildId).n > 0 ||
    db.prepare('SELECT COUNT(*) AS n FROM editors WHERE guild_id=?').get(guildId).n > 0,
  createInvite: (i) =>
    db.prepare('INSERT INTO invites (code,guild_id,created_by,expires_at,max_uses) VALUES (?,?,?,?,?)')
      .run(i.code, i.guildId, i.createdBy, i.expiresAt, i.maxUses),
  getInvite: (code) => db.prepare('SELECT * FROM invites WHERE code=?').get(code),
  // 有効な招待を1回分消費する(成功なら true)
  useInvite: (code) =>
    db.prepare('UPDATE invites SET uses=uses+1 WHERE code=? AND uses<max_uses AND expires_at>?').run(code, Date.now()).changes === 1,
  activeInvites: (guildId) =>
    db.prepare('SELECT * FROM invites WHERE guild_id=? AND uses<max_uses AND expires_at>? ORDER BY expires_at').all(guildId, Date.now()),
  deleteInvite: (guildId, code) => db.prepare('DELETE FROM invites WHERE guild_id=? AND code=?').run(guildId, code).changes,
  // セッショントークンは SHA-256 で保存(DBが漏れてもトークンそのものは使えない)
  saveSession: (s) =>
    db.prepare('INSERT OR REPLACE INTO sessions (token,user_id,username,access_token,expires_at) VALUES (?,?,?,?,?)')
      .run(hashToken(s.token), s.userId, s.username, s.accessToken, s.expiresAt),
  getSession: (token) => {
    const h = hashToken(token);
    const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(h);
    if (s && s.expires_at < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token=?').run(h);
      return null;
    }
    return s || null;
  },
  deleteSession: (token) => db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(token)),
  purgeExpiredSessions: () => db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now()).changes,
};
