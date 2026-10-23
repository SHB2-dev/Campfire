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
const { loadDownloads } = require('./downloads');

// 開発者(あなた)だけが見られる画面用。環境変数 DEVELOPER_DISCORD_IDS に DiscordのユーザーID(カンマ区切り)を入れる
const DEVELOPERS = new Set((process.env.DEVELOPER_DISCORD_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));

const MAX_PER_GUILD = 25;
const MAX_MEMBERS = 20;
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

  // 権限は2つ。
  //   admin  : Discordの管理権限を持つ人、または「管理者のURL」で付与された人。パックの編集・招待URLの発行・権限の付与と取り消し
  //   editor : 「編集者のURL」で付与された人。パックの編集のみ
  const manageable = async (req) => {
    const guilds = await dc.userGuilds(req.session);
    if (!guilds) throw fail(401, 'unauthorized');
    const uid = req.session.user_id;
    const out = [];
    for (const g of guilds) {
      if (dc.canManage(g)) {
        out.push({ ...g, role: 'admin', granted: false });
      } else {
        const role = db.getMemberRole(g.id, uid);
        if (role) out.push({ ...g, role, granted: true });
      }
    }
    return { out, all: guilds };
  };
  const guildOf = async (req, { adminOnly = false } = {}) => {
    const g = (await manageable(req)).out.find((x) => x.id === req.params.gid);
    if (!g) throw fail(403, '権限がありません');
    if (adminOnly && g.role !== 'admin') throw fail(403, 'この操作は管理者のみ可能です');
    return g;
  };

  r.get('/api/me', wrap(async (req, res) => {
    const { out } = await manageable(req);
    db.recordSeen(req.session.user_id, out.map(dc.publicGuild)); // 利用状況の集計(IDはハッシュ化して保存)
    res.json({
      user: { id: req.session.user_id, name: req.session.username },
      isDeveloper: DEVELOPERS.has(req.session.user_id),
      guilds: out.map((g) => ({ ...dc.publicGuild(g), role: g.role, granted: g.granted })),
    });
  }));

  // --- 開発者専用: ダウンロード数と、連携しているDiscordサーバーの詳細 ---
  r.get('/api/dev/stats', wrap(async (req, res) => {
    if (!DEVELOPERS.has(req.session.user_id)) throw fail(403, '開発者のみ見られます');
    const downloads = await loadDownloads().catch((e) => ({ error: e.message }));
    res.json({ usage: db.devUsage(), downloads, generatedAt: Date.now() });
  }));

  // --- 招待URLで権限を付与する(管理者のURL / 編集者のURL) ---
  const randomCode = () => crypto.randomBytes(12).toString('base64url');

  // 招待コードを使うと、使った本人のアカウントに、そのURLの権限が付与される(そのDiscordサーバーの参加者のみ)
  r.post('/api/invite/redeem', wrap(async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const inv = db.getInvite(code);
    if (!inv || inv.expires_at < Date.now() || inv.uses >= inv.max_uses) throw fail(400, '招待URLが無効か、期限切れです');
    const guilds = await dc.userGuilds(req.session);
    if (!guilds) throw fail(401, 'unauthorized');
    const g = guilds.find((x) => x.id === inv.guild_id);
    if (!g) throw fail(403, 'このDiscordサーバーに参加していないため、招待URLを使えません');
    const uid = req.session.user_id;
    const want = inv.role === 'admin' ? 'admin' : 'editor';
    // すでにDiscordの管理者の人や、同じ(またはより上の)権限を持つ人には、何も変えない(URLの使用回数も消費しない)
    const current = dc.canManage(g) ? 'admin' : db.getMemberRole(g.id, uid);
    if (current === 'admin' || current === want) return res.json({ guildId: g.id, name: g.name, role: current, unchanged: true });
    if (!current && db.countMembers(g.id) >= MAX_MEMBERS) throw fail(400, `付与できる人数は1サーバーにつき${MAX_MEMBERS}人までです`);
    if (!db.useInvite(code)) throw fail(400, '招待URLが無効か、期限切れです');
    db.grantMember(g.id, uid, req.session.username, want, inv.created_by);
    res.json({ guildId: g.id, name: g.name, role: want });
  }));

  // 権限を付与されている人の一覧と、有効な招待URL(管理者のみ)
  r.get('/api/guilds/:gid/members', wrap(async (req, res) => {
    await guildOf(req, { adminOnly: true });
    res.json({
      members: db.listMembers(req.params.gid).map((m) => ({ userId: m.user_id, name: m.username, role: m.role, isSelf: m.user_id === req.session.user_id })),
      invites: db.activeInvites(req.params.gid).map((i) => ({
        code: i.code, url: `${publicUrl}/admin/?invite=${i.code}`, role: i.role, expiresAt: i.expires_at, usesLeft: i.max_uses - i.uses,
      })),
    });
  }));

  r.post('/api/guilds/:gid/invites', wrap(async (req, res) => {
    await guildOf(req, { adminOnly: true });
    if (db.activeInvites(req.params.gid).length >= MAX_INVITES) throw fail(400, `有効な招待URLは${MAX_INVITES}個までです。不要なものを無効化してください`);
    const hours = Math.min(Math.max(Number(req.body?.hours) || 24, 1), 24 * 30);
    const maxUses = Math.min(Math.max(Number(req.body?.maxUses) || 1, 1), 20);
    const role = req.body?.role === 'admin' ? 'admin' : 'editor';
    const code = randomCode();
    db.createInvite({ code, guildId: req.params.gid, createdBy: req.session.user_id, expiresAt: Date.now() + hours * 3600_000, maxUses, role });
    res.json({ url: `${publicUrl}/admin/?invite=${code}`, role });
  }));

  r.delete('/api/guilds/:gid/invites/:code', wrap(async (req, res) => {
    await guildOf(req, { adminOnly: true });
    res.json({ ok: !!db.deleteInvite(req.params.gid, req.params.code) });
  }));

  // 付与した権限の変更(管理者 ⇔ 編集者)と取り消し。自分自身の権限は、締め出されないよう変更・取り消しできない
  r.put('/api/guilds/:gid/members/:userId', wrap(async (req, res) => {
    await guildOf(req, { adminOnly: true });
    if (req.params.userId === req.session.user_id) throw fail(400, '自分自身の権限は変更できません');
    const role = req.body?.role;
    if (role !== 'admin' && role !== 'editor') throw fail(400, '権限が不正です');
    res.json({ ok: !!db.setMemberRole(req.params.gid, req.params.userId, role) });
  }));

  r.delete('/api/guilds/:gid/members/:userId', wrap(async (req, res) => {
    await guildOf(req, { adminOnly: true });
    if (req.params.userId === req.session.user_id) throw fail(400, '自分自身の権限は取り消せません');
    res.json({ ok: !!db.removeMember(req.params.gid, req.params.userId) });
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

  // 開発者専用ページ。開発者以外(未ログインも含む)には、ページが存在しないように 404 を返す。
  // ファイルは public/ ではなく private/ に置き、このルートからだけ配信する(静的配信には含めない)
  const DEV_DIR = path.join(__dirname, '..', 'private', 'dev');
  const devOnly = (file) => (req, res) => {
    const sid = cookies(req).sid;
    const s = sid && db.getSession(sid);
    if (!s || !DEVELOPERS.has(s.user_id)) return res.status(404).type('text/plain').send('Not found');
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }).sendFile(path.join(DEV_DIR, file));
  };
  r.get('/dev', devOnly('index.html'));
  r.get('/dev/dev.js', devOnly('dev.js'));

  r.use(express.static(path.join(__dirname, '..', 'public', 'admin')));
  app.use('/admin', r);
}

module.exports = { mountAdmin };
