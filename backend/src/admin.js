// 管理者向けWebサイト(/admin/)。Discordログイン → 管理できるサーバーにパック/バージョンを登録
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const dc = require('./discord');
const { validate, serialize, mojangVersions, LOADERS } = require('./servers');
const { wrap } = require('./api');

const MAX_PER_GUILD = 25;

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
  const jsonOnly = (req, res, next) =>
    req.method === 'GET' || req.is('application/json') ? next() : res.status(415).json({ error: 'json_only' });

  r.use('/api', express.json({ limit: '10kb' }), auth, jsonOnly);

  const manageable = async (req) => {
    const guilds = await dc.userGuilds(req.session);
    if (!guilds) throw Object.assign(new Error('unauthorized'), { status: 401 });
    return guilds.filter(dc.canManage);
  };
  const guildOf = async (req) => {
    const g = (await manageable(req)).find((x) => x.id === req.params.gid);
    if (!g) throw Object.assign(new Error('forbidden'), { status: 403 });
    return g;
  };

  r.get('/api/me', wrap(async (req, res) => {
    const guilds = await manageable(req);
    res.json({ user: { id: req.session.user_id, name: req.session.username }, guilds: guilds.map(dc.publicGuild) });
  }));

  r.get('/api/versions', wrap(async (_req, res) => res.json({ versions: await mojangVersions(), loaders: LOADERS })));

  r.get('/api/guilds/:gid/servers', wrap(async (req, res) => {
    await guildOf(req);
    res.json({ servers: db.serversOfGuild(req.params.gid).map(serialize) });
  }));

  r.post('/api/guilds/:gid/servers', wrap(async (req, res) => {
    await guildOf(req);
    const { value, error } = await validate(req.body);
    if (error) return res.status(400).json({ error });
    if (db.countServers(req.params.gid) >= MAX_PER_GUILD) return res.status(400).json({ error: `1サーバーにつき${MAX_PER_GUILD}個までです` });
    const id = db.addServer({ ...value, guildId: req.params.gid }, req.session.user_id);
    res.json({ id });
  }));

  r.put('/api/guilds/:gid/servers/:id', wrap(async (req, res) => {
    await guildOf(req);
    const { value, error } = await validate(req.body);
    if (error) return res.status(400).json({ error });
    const n = db.updateServer(Number(req.params.id), { ...value, guildId: req.params.gid });
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
