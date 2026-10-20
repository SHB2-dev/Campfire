const express = require('express');
const db = require('./db');
const dc = require('./discord');
const { serialize } = require('./servers');
const curseforge = require('./curseforge');

// 簡易レート制限(IPごと 1分に120回)
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const rec = hits.get(req.ip) || { n: 0, reset: now + 60_000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 60_000; }
  if (++rec.n > 120) return res.status(429).json({ error: 'rate_limited' });
  hits.set(req.ip, rec);
  next();
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60_000).unref();

function bearer(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const s = m && db.getSession(m[1]);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  req.session = { ...s, token: m[1] };
  next();
}

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!e.status || e.status >= 500) console.error(e); // 4xx(権限・入力ミス)はログに出さない
  res.status(e.status || 502).json({ error: e.message || 'upstream_error' });
});

function createApi({ clientId, clientSecret, publicUrl, allowedRedirects, extra }) {
  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === '1');
  app.use(rateLimit);
  app.use(express.json({ limit: '64kb' })); // CurseForge の大きなパック(fileId 数百件)に対応

  app.get('/api/config', (_req, res) => res.json({ clientId, adminUrl: `${publicUrl}/admin/` }));

  // ランチャーが受け取った OAuth code を交換してセッショントークンを発行
  app.post('/auth/discord', wrap(async (req, res) => {
    const { code, redirect_uri: redirectUri } = req.body || {};
    if (typeof code !== 'string' || !allowedRedirects.includes(redirectUri)) return res.status(400).json({ error: 'bad_request' });
    const { token, user } = await dc.login({ clientId, clientSecret, code, redirectUri });
    res.json({ token, user });
  }));

  app.post('/auth/logout', bearer, (req, res) => { db.deleteSession(req.session.token); res.json({ ok: true }); });

  // ユーザーが所属する Discord サーバーのうち、サーバーが登録されているものと、その一覧
  app.get('/api/guilds', bearer, wrap(async (req, res) => {
    const guilds = await dc.userGuilds(req.session);
    if (!guilds) return res.status(401).json({ error: 'unauthorized' });
    const byId = new Map(guilds.map((g) => [g.id, g]));
    const groups = new Map();
    for (const row of db.serversForGuilds([...byId.keys()])) {
      const g = byId.get(row.guild_id);
      if (!groups.has(g.id)) groups.set(g.id, { guild: dc.publicGuild(g), canManage: dc.canManage(g), servers: [] });
      groups.get(g.id).servers.push(serialize(row));
    }
    res.json({ groups: [...groups.values()] });
  }));

  // 起動時の最新情報確認用
  app.get('/api/servers/:id', bearer, wrap(async (req, res) => {
    const row = db.getServer(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'not_found' });
    const guilds = await dc.userGuilds(req.session);
    if (!guilds) return res.status(401).json({ error: 'unauthorized' });
    if (!guilds.some((g) => g.id === row.guild_id)) return res.status(403).json({ error: 'not_member' });
    res.json({ server: serialize(row) });
  }));

  // CurseForge パック用の中継(APIキーが設定されているときのみ)
  if (curseforge.enabled()) {
    app.post('/api/curseforge/files', bearer, wrap(async (req, res) => {
      const ids = req.body?.fileIds;
      if (!Array.isArray(ids)) return res.status(400).json({ error: 'bad_request' });
      res.json({ files: await curseforge.filesInfo(ids) });
    }));
    app.get('/api/curseforge/pack', bearer, wrap(async (req, res) => {
      res.json(await curseforge.latestPack(String(req.query.slug || '')));
    }));
  }

  extra?.(app);
  return app;
}

module.exports = { createApi, wrap };
