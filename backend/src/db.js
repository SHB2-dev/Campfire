const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, '..', 'data.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  auto_connect INTEGER NOT NULL DEFAULT 1,
  source_type TEXT NOT NULL CHECK (source_type IN ('vanilla','modrinth','mrpack','manifest')),
  source TEXT NOT NULL DEFAULT '',
  minecraft TEXT NOT NULL DEFAULT '',
  loader TEXT NOT NULL DEFAULT 'vanilla',
  loader_version TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS servers_guild ON servers(guild_id);
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
  saveSession: (s) =>
    db.prepare('INSERT OR REPLACE INTO sessions (token,user_id,username,access_token,expires_at) VALUES (?,?,?,?,?)')
      .run(s.token, s.userId, s.username, s.accessToken, s.expiresAt),
  getSession: (token) => {
    const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
    if (s && s.expires_at < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      return null;
    }
    return s || null;
  },
  deleteSession: (token) => db.prepare('DELETE FROM sessions WHERE token=?').run(token),
};
