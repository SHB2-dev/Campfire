// 管理者向けWebサイト(/admin/)。Discordログイン → 管理できるサーバーにパック/バージョンを登録
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const dc = require('./discord');
const { validate, serialize, mojangVersions, LOADERS } = require('./servers');
const { wrap } = require('./api');
const cf = require('./curseforge');
const { validateAddress } = require('./netguard');
const { ping } = require('./mcping');
const { listVersions } = require('./packversions');

const MAX_PER_GUILD = 25;
const MAX_EDITORS = 20;
const MAX_INVITES = 10;

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
}

function mountAdmin(app, { clientId, clientSecret, publicUrl }) {
  const redirectUri = `${publicUrl}/admin/callback`;
  const secure = publicUrl.startsWith('https://') ? '; Secure' : '';
  const setCookie = (res, name, value, maxAge) =>
    res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);

  const r = express.Router();
  r.use((_req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' https://cdn.discordapp.com; frame-ancestors 'none'");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer'); // ?invite= の招待コードを外部へ漏らさない
    res.set('Cache-Control', 'no-store');
    next();
  });

  r.get('/login', (_req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'oauth_state', state, 600);
    const q = new URLSearchParams({
      client_id: clientId, response_type: 'code', scope: 'identify guilds', redirect_uri: redirectUri, state,
    });
    res.redirect(`https://discord.com/oauth2/authorize?${q}`);
  });

  r.get('/callback', wrap(async (req, res) => {
    const { code, state } = req.query;
    if (typeof code !== 'string' || !state || state !== cookies(req).oauth_state) return res.status(400).send('ログインに失敗しました。もう一度お試しください。');
    const { token, maxAge } = await dc.login({ clientId, clientSecret, code, redirectUri });
    setCookie(res, 'oauth_state', '', 0);
    setCookie(res, 'sid', token, Math.min(maxAge, 7 * 86400));
    res.redirect('/admin/');
  }));

  const auth = (req, res, next) => {
    const sid = cookies(req).sid;
    const s = sid && db.getSession(sid);
    if (!s) return res.status(401).json({ error: 'unauthorized' });
    req.session = { ...s, token: sid };
    next();
  };
  // Cookie 認証の変更系は JSON のみ許可(クロスサイトのフォーム送信を防ぐ)
  // (ボディのない DELETE もあるため、req.is ではなくヘッダーで判定)
  const jsonOnly = (req, res, next) =>
    req.method === 'GET' || /^application\/json/i.test(req.headers['content-type'] || '') ? next() : res.status(415).json({ error: 'json_only' });

  r.use('/api', express.json({ limit: '10kb' }), auth, jsonOnly);

  const fail = (status, error) => Object.assign(new Error(error), { status });

  // 参加中のサーバーのうち、管理者権限 or 招待された編集者として編集できるもの(role 付き)
  const manageable = async (req) => {
    const guilds = await dc.userGuilds(req.session);
    if (!guilds) throw fail(401, 'unauthorized');
    const out = [];
    const uid = req.session.user_id;
    for (const g of guilds) {
      if (dc.canManage(g)) out.push({ ...g, role: 'admin' });
      else if (db.getOwner(g.id)?.user_id === uid) out.push({ ...g, role: 'owner' });
      else if (db.isEditor(g.id, uid)) out.push({ ...g, role: 'editor' });
    }
    return { out, all: guilds };
  };
  // admin(Discordの管理権限) と owner(最初に登録した人) は、編集者の招待・管理もできる
  const canInvite = (role) => role === 'admin' || role === 'owner';
  const guildOf = async (req, { inviteRights = false } = {}) => {
    const g = (await manageable(req)).out.find((x) => x.id === req.params.gid);
    if (!g) throw fail(403, '権限がありません');
    if (inviteRights && !canInvite(g.role)) throw fail(403, 'この操作はサーバーの管理者または登録者のみ可能です');
    return g;
  };

  r.get('/api/me', wrap(async (req, res) => {
    const { out, all } = await manageable(req);
    const mine = new Set(out.map((g) => g.id));
    // まだ誰も登録していないサーバーは、参加者なら誰でも最初の登録者(オーナー)になれる
    const claimable = all.filter((g) => !mine.has(g.id) && !db.isRegistered(g.id)).map(dc.publicGuild);
    res.json({
      user: { id: req.session.user_id, name: req.session.username },
      guilds: out.map((g) => ({ ...dc.publicGuild(g), role: g.role })),
      claimable,
    });
  }));

  // 「このサーバーを登録する」: 先着1人がオーナーになる
  r.post('/api/guilds/:gid/claim', wrap(async (req, res) => {
    const guilds = await dc.userGuilds(req.session);
    if (!guilds) throw fail(401, 'unauthorized');
    const g = guilds.find((x) => x.id === req.params.gid);
    if (!g) throw fail(403, 'このDiscordサーバーに参加していません');
    if (db.isRegistered(g.id) || !db.claimOwner(g.id, req.session.user_id, req.session.username)) {
      throw fail(409, 'このサーバーは既に登録されています。編集者になるには招待リンクが必要です');
    }
    res.json({ guildId: g.id });
  }));

  // 管理者がオーナーを外す(誤登録・乗っ取り対策)
  r.delete('/api/guilds/:gid/owner', wrap(async (req, res) => {
    const g = await guildOf(req);
    if (g.role !== 'admin') throw fail(403, 'オーナーを外せるのはDiscordサーバーの管理者のみです');
    res.json({ ok: !!db.removeOwner(g.id) });
  }));

  // --- 招待リンクで編集者を追加 ---
  const randomCode = () => crypto.randomBytes(12).toString('base64url');

  // 招待コードを使って、自分をそのサーバーの編集者にする(サーバー参加者のみ)
  r.post('/api/invite/redeem', wrap(async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const inv = db.getInvite(code);
    if (!inv || inv.expires_at < Date.now() || inv.uses >= inv.max_uses) throw fail(400, '招待リンクが無効か、期限切れです');
    const guilds = await dc.userGuilds(req.session);
    if (!guilds) throw fail(401, 'unauthorized');
    const g = guilds.find((x) => x.id === inv.guild_id);
    if (!g) throw fail(403, 'このDiscordサーバーに参加していないため、招待を使えません');
    const already = dc.canManage(g) || db.isEditor(g.id, req.session.user_id) || db.getOwner(g.id)?.user_id === req.session.user_id;
    if (!already) {
      if (db.countEditors(g.id) >= MAX_EDITORS) throw fail(400, `編集者は1サーバーにつき${MAX_EDITORS}人までです`);
      if (!db.useInvite(code)) throw fail(400, '招待リンクが無効か、期限切れです');
      db.addEditor(g.id, req.session.user_id, req.session.username, inv.created_by);
    }
    res.json({ guildId: g.id, name: g.name });
  }));

  r.get('/api/guilds/:gid/editors', wrap(async (req, res) => {
    await guildOf(req, { inviteRights: true });
    const owner = db.getOwner(req.params.gid);
    res.json({
      owner: owner && { userId: owner.user_id, name: owner.username },
      editors: db.listEditors(req.params.gid).map((e) => ({ userId: e.user_id, name: e.username })),
      invites: db.activeInvites(req.params.gid).map((i) => ({
        code: i.code, url: `${publicUrl}/admin/?invite=${i.code}`, expiresAt: i.expires_at, usesLeft: i.max_uses - i.uses,
      })),
    });
  }));

  r.post('/api/guilds/:gid/invites', wrap(async (req, res) => {
    await guildOf(req, { inviteRights: true });
    if (db.activeInvites(req.params.gid).length >= MAX_INVITES) throw fail(400, `有効な招待リンクは${MAX_INVITES}個までです。不要なものを無効化してください`);
    const hours = Math.min(Math.max(Number(req.body?.hours) || 24, 1), 24 * 30);
    const maxUses = Math.min(Math.max(Number(req.body?.maxUses) || 1, 1), 20);
    const code = randomCode();
    db.createInvite({ code, guildId: req.params.gid, createdBy: req.session.user_id, expiresAt: Date.now() + hours * 3600_000, maxUses });
    res.json({ url: `${publicUrl}/admin/?invite=${code}` });
  }));

  r.delete('/api/guilds/:gid/invites/:code', wrap(async (req, res) => {
    await guildOf(req, { inviteRights: true });
    res.json({ ok: !!db.deleteInvite(req.params.gid, req.params.code) });
  }));

  r.delete('/api/guilds/:gid/editors/:userId', wrap(async (req, res) => {
    await guildOf(req, { inviteRights: true });
    res.json({ ok: !!db.removeEditor(req.params.gid, req.params.userId) });
  }));

  r.get('/api/versions', wrap(async (_req, res) => res.json({ versions: await mojangVersions(), loaders: LOADERS, curseforge: cf.enabled() })));

  r.get('/api/guilds/:gid/servers', wrap(async (req, res) => {
    await guildOf(req);
    res.json({ servers: db.serversOfGuild(req.params.gid).map(serialize) });
  }));

  r.post('/api/guilds/:gid/servers', wrap(async (req, res) => {
    await guildOf(req);
    const { value, error } = await validate(req.body, { curseforge: cf.enabled() });
    if (error) return res.status(400).json({ error });
    if (db.countServers(req.params.gid) >= MAX_PER_GUILD) return res.status(400).json({ error: `1サーバーにつき${MAX_PER_GUILD}個までです` });
    const id = db.addServer({ ...value, guildId: req.params.gid }, req.session.user_id);
    if (value.address) logAddress(req, id, value);
    res.json({ id });
  }));

  // 接続先アドレスの変更履歴(誰がいつ変えたか)
  const logAddress = (req, serverId, v) =>
    db.logAddress({
      serverId, guildId: req.params.gid, address: v.address, altAddresses: v.altAddresses,
      userId: req.session.user_id, userName: req.session.username,
    });

  r.get('/api/guilds/:gid/servers/:id/history', wrap(async (req, res) => {
    await guildOf(req);
    res.json({
      history: db.addressHistory(Number(req.params.id), req.params.gid).map((h) => ({
        address: h.address, altAddresses: h.alt_addresses ? h.alt_addresses.split('\n') : [], by: h.changed_by_name, at: h.changed_at,
      })),
    });
  }));

  // パックのバージョン一覧(Modrinth / CurseForge / FTB)。固定の配布元へ問い合わせるだけなので、利用者ごとに1分20回まで
  const versionUsage = new Map();
  r.post('/api/pack-versions', wrap(async (req, res) => {
    if (!(await manageable(req)).out.length) throw fail(403, '権限がありません');
    const now = Date.now();
    const rec = versionUsage.get(req.session.user_id) || { n: 0, reset: now + 60_000 };
    if (now > rec.reset) { rec.n = 0; rec.reset = now + 60_000; }
    if (++rec.n > 20) throw fail(429, '少し待ってからもう一度お試しください');
    versionUsage.set(req.session.user_id, rec);
    res.json({ versions: await listVersions(String(req.body?.type || ''), String(req.body?.source || '').slice(0, 300)) });
  }));

  // 接続テスト。バックエンドが外部へ接続するので、利用者ごとに1分10回まで(SSRF対策は mcping 側で実施)
  const pingUsage = new Map();
  r.post('/api/ping', wrap(async (req, res) => {
    if (!(await manageable(req)).out.length) throw fail(403, '権限がありません');
    const now = Date.now();
    const rec = pingUsage.get(req.session.user_id) || { n: 0, reset: now + 60_000 };
    if (now > rec.reset) { rec.n = 0; rec.reset = now + 60_000; }
    if (++rec.n > 10) throw fail(429, '接続テストは1分に10回までです。少し待ってください');
    pingUsage.set(req.session.user_id, rec);

    const check = validateAddress(String(req.body?.address || ''));
    if (check.error) return res.status(400).json({ error: check.error });
    try {
      res.json(await ping(check.value));
    } catch (e) {
      res.json({ online: false, error: e.message });
    }
  }));

  r.put('/api/guilds/:gid/servers/:id', wrap(async (req, res) => {
    await guildOf(req);
    const { value, error } = await validate(req.body, { curseforge: cf.enabled() });
    if (error) return res.status(400).json({ error });
    const before = db.getServer(Number(req.params.id));
    const n = db.updateServer(Number(req.params.id), { ...value, guildId: req.params.gid });
    if (n && before && before.guild_id === req.params.gid) {
      const oldAlt = before.alt_addresses ? before.alt_addresses.split('\n') : [];
      if (before.address !== value.address || oldAlt.join('\n') !== value.altAddresses.join('\n')) logAddress(req, before.id, value);
    }
    res.status(n ? 200 : 404).json({ ok: !!n });
  }));

  r.delete('/api/guilds/:gid/servers/:id', wrap(async (req, res) => {
    await guildOf(req);
    res.json({ ok: !!db.removeServer(req.params.gid, Number(req.params.id)) });
  }));

  r.post('/api/logout', (req, res) => { db.deleteSession(req.session.token); setCookie(res, 'sid', '', 0); res.json({ ok: true }); });

  r.use(express.static(path.join(__dirname, '..', 'public', 'admin')));
  app.use('/admin', r);
}

module.exports = { mountAdmin };
