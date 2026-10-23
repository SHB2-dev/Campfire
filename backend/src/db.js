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
CREATE TABLE IF NOT EXISTS address_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  address TEXT NOT NULL,
  alt_addresses TEXT NOT NULL DEFAULT '',
  auto_update INTEGER NOT NULL DEFAULT 1,
  pack_version TEXT NOT NULL DEFAULT '',
  changed_by TEXT NOT NULL,
  changed_by_name TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS address_history_server ON address_history(server_id);
CREATE TABLE IF NOT EXISTS editors (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'editor'
);
CREATE INDEX IF NOT EXISTS invites_guild ON invites(guild_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS guilds_seen (
  guild_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guild_users (
  guild_id TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_hash)
);
CREATE TABLE IF NOT EXISTS users_seen (
  user_hash TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  access_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

const COLS = 'guild_id,name,description,address,alt_addresses,auto_connect,auto_update,source_type,source,minecraft,loader,loader_version,pack_version';
const joinAlt = (list) => (list || []).join('\n');
const vals = (s) => [s.guildId, s.name, s.description, s.address, joinAlt(s.altAddresses), s.autoConnect ? 1 : 0, s.autoUpdate === false ? 0 : 1, s.type, s.source, s.minecraft, s.loader, s.loaderVersion, s.packVersion || ''];

// 既存DBへの列追加(新規DBでは何もしない)
if (!db.prepare('PRAGMA table_info(servers)').all().some((c) => c.name === 'alt_addresses')) {
  db.exec("ALTER TABLE servers ADD COLUMN alt_addresses TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare('PRAGMA table_info(servers)').all().some((c) => c.name === 'auto_update')) {
  db.exec('ALTER TABLE servers ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 1');
}
// 権限は「管理者(admin)」と「編集者(editor)」の2つ。招待URLで付与し、あとから取り消せる
for (const table of ['editors', 'invites']) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'role')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN role TEXT NOT NULL DEFAULT 'editor'`);
  }
}
// 廃止した「オーナー(最初に登録した人)」は、管理者として引き継ぐ
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guild_owners'").get()) {
  db.exec(`INSERT OR REPLACE INTO editors (guild_id,user_id,username,added_by,added_at,role)
           SELECT guild_id,user_id,username,user_id,claimed_at,'admin' FROM guild_owners`);
  db.exec('DROP TABLE guild_owners');
}

// パックのバージョン指定(空 = 最新に自動で追従)
if (!db.prepare('PRAGMA table_info(servers)').all().some((c) => c.name === 'pack_version')) {
  db.exec("ALTER TABLE servers ADD COLUMN pack_version TEXT NOT NULL DEFAULT ''");
}

// ユーザーIDは、このDB専用のランダムな値(salt)と合わせてハッシュ化して保存する。元のIDには戻せない
function userHash(userId) {
  let salt = db.prepare("SELECT value FROM meta WHERE key='stats_salt'").get()?.value;
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
    db.prepare("INSERT INTO meta (key,value) VALUES ('stats_salt',?)").run(salt);
  }
  return crypto.createHash('sha256').update(salt + ':' + userId).digest('hex').slice(0, 32);
}

module.exports = {
  addServer: (s, userId) =>
    db.prepare(`INSERT INTO servers (${COLS},created_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(...vals(s), userId, Date.now()).lastInsertRowid,
  updateServer: (id, s) =>
    db.prepare(
      `UPDATE servers SET name=?,description=?,address=?,alt_addresses=?,auto_connect=?,auto_update=?,source_type=?,source=?,minecraft=?,loader=?,loader_version=?,pack_version=?,updated_at=?
       WHERE id=? AND guild_id=?`
    ).run(s.name, s.description, s.address, joinAlt(s.altAddresses), s.autoConnect ? 1 : 0, s.autoUpdate === false ? 0 : 1, s.type, s.source, s.minecraft, s.loader, s.loaderVersion, s.packVersion || '', Date.now(), id, s.guildId).changes,
  logAddress: (h) =>
    db.prepare('INSERT INTO address_history (server_id,guild_id,address,alt_addresses,changed_by,changed_by_name,changed_at) VALUES (?,?,?,?,?,?,?)')
      .run(h.serverId, h.guildId, h.address, joinAlt(h.altAddresses), h.userId, h.userName, Date.now()),
  addressHistory: (serverId, guildId) =>
    db.prepare('SELECT address,alt_addresses,changed_by_name,changed_at FROM address_history WHERE server_id=? AND guild_id=? ORDER BY id DESC LIMIT 20').all(serverId, guildId),
  countServers: (guildId) => db.prepare('SELECT COUNT(*) AS n FROM servers WHERE guild_id=?').get(guildId).n,
  serversOfGuild: (guildId) => db.prepare('SELECT * FROM servers WHERE guild_id=? ORDER BY id').all(guildId),
  serversForGuilds: (ids) => {
    if (!ids.length) return [];
    return db.prepare(`SELECT * FROM servers WHERE guild_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);
  },
  getServer: (id) => db.prepare('SELECT * FROM servers WHERE id=?').get(id),
  removeServer: (guildId, id) => db.prepare('DELETE FROM servers WHERE guild_id=? AND id=?').run(guildId, id).changes,
  // --- 付与された権限(管理者 / 編集者)と招待URL。Discordの管理権限は、ここには入れない(Discord側で判定) ---
  getMemberRole: (guildId, userId) => db.prepare('SELECT role FROM editors WHERE guild_id=? AND user_id=?').get(guildId, userId)?.role || null,
  listMembers: (guildId) => db.prepare('SELECT user_id,username,role,added_at FROM editors WHERE guild_id=? ORDER BY role, added_at').all(guildId),
  countMembers: (guildId) => db.prepare('SELECT COUNT(*) AS n FROM editors WHERE guild_id=?').get(guildId).n,
  // 付与(すでにいれば権限を上書き)
  grantMember: (guildId, userId, username, role, addedBy) =>
    db.prepare(`INSERT INTO editors (guild_id,user_id,username,added_by,added_at,role) VALUES (?,?,?,?,?,?)
                ON CONFLICT(guild_id,user_id) DO UPDATE SET role=excluded.role, username=excluded.username`)
      .run(guildId, userId, username, addedBy, Date.now(), role),
  setMemberRole: (guildId, userId, role) => db.prepare('UPDATE editors SET role=? WHERE guild_id=? AND user_id=?').run(role, guildId, userId).changes,
  // 取り消し
  removeMember: (guildId, userId) => db.prepare('DELETE FROM editors WHERE guild_id=? AND user_id=?').run(guildId, userId).changes,
  createInvite: (i) =>
    db.prepare('INSERT INTO invites (code,guild_id,created_by,expires_at,max_uses,role) VALUES (?,?,?,?,?,?)')
      .run(i.code, i.guildId, i.createdBy, i.expiresAt, i.maxUses, i.role === 'admin' ? 'admin' : 'editor'),
  getInvite: (code) => db.prepare('SELECT * FROM invites WHERE code=?').get(code),
  // 有効な招待を1回分消費する(成功なら true)
  useInvite: (code) =>
    db.prepare('UPDATE invites SET uses=uses+1 WHERE code=? AND uses<max_uses AND expires_at>?').run(code, Date.now()).changes === 1,
  activeInvites: (guildId) =>
    db.prepare('SELECT * FROM invites WHERE guild_id=? AND uses<max_uses AND expires_at>? ORDER BY expires_at').all(guildId, Date.now()),
  deleteInvite: (guildId, code) => db.prepare('DELETE FROM invites WHERE guild_id=? AND code=?').run(guildId, code).changes,
  // --- 開発者向けの利用状況(集計だけ。誰が使っているかは分からない形で保存する) ---
  // guilds: [{ id, name, icon }]。ランチャー/管理サイトでユーザーが見えたサーバーを記録する
  recordSeen: (userId, guilds) => {
    const h = userHash(userId);
    const now = Date.now();
    db.prepare('INSERT INTO users_seen (user_hash,first_seen,last_seen) VALUES (?,?,?) ON CONFLICT(user_hash) DO UPDATE SET last_seen=excluded.last_seen').run(h, now, now);
    for (const g of guilds) {
      db.prepare('INSERT INTO guilds_seen (guild_id,name,icon,first_seen,last_seen) VALUES (?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name, icon=excluded.icon, last_seen=excluded.last_seen')
        .run(g.id, String(g.name).slice(0, 100), g.icon || null, now, now);
      db.prepare('INSERT INTO guild_users (guild_id,user_hash,last_seen) VALUES (?,?,?) ON CONFLICT(guild_id,user_hash) DO UPDATE SET last_seen=excluded.last_seen').run(g.id, h, now);
    }
  },
  publicTotals: () => ({
    guilds: db.prepare('SELECT COUNT(DISTINCT guild_id) AS n FROM servers').get().n,
    servers: db.prepare('SELECT COUNT(*) AS n FROM servers').get().n,
  }),
  devUsage: () => {
    const now = Date.now();
    const day = 86400_000;
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    const guilds = db.prepare(`
      SELECT s.guild_id AS id, COUNT(*) AS servers, MAX(s.updated_at) AS updated, MIN(s.updated_at) AS created,
             g.name AS name, g.icon AS icon, g.last_seen AS lastSeen
      FROM servers s LEFT JOIN guilds_seen g ON g.guild_id = s.guild_id
      GROUP BY s.guild_id ORDER BY servers DESC, updated DESC`).all();
    for (const g of guilds) {
      g.users = count('SELECT COUNT(*) AS n FROM guild_users WHERE guild_id=?', g.id);
      g.users30d = count('SELECT COUNT(*) AS n FROM guild_users WHERE guild_id=? AND last_seen>?', g.id, now - 30 * day);
      g.admins = count("SELECT COUNT(*) AS n FROM editors WHERE guild_id=? AND role='admin'", g.id);
      g.editors = count("SELECT COUNT(*) AS n FROM editors WHERE guild_id=? AND role='editor'", g.id);
      g.types = Object.fromEntries(db.prepare('SELECT source_type AS t, COUNT(*) AS n FROM servers WHERE guild_id=? GROUP BY source_type').all(g.id).map((r) => [r.t, r.n]));
    }
    return {
      totals: {
        guilds: guilds.length,
        servers: count('SELECT COUNT(*) AS n FROM servers'),
        users: count('SELECT COUNT(*) AS n FROM users_seen'),
        users7d: count('SELECT COUNT(*) AS n FROM users_seen WHERE last_seen>?', now - 7 * day),
        users30d: count('SELECT COUNT(*) AS n FROM users_seen WHERE last_seen>?', now - 30 * day),
      },
      types: Object.fromEntries(db.prepare('SELECT source_type AS t, COUNT(*) AS n FROM servers GROUP BY source_type').all().map((r) => [r.t, r.n])),
      guilds,
    };
  },
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
