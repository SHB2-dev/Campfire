const crypto = require('crypto');
const db = require('./db');

const API = 'https://discord.com/api/v10';
const cache = new Map(); // session token -> { at, guilds }

// OAuth の code をセッションに交換する(ランチャー/管理サイト共通)
async function login({ clientId, clientSecret, code, redirectUri }) {
  const tr = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    }),
  });
  if (!tr.ok) throw Object.assign(new Error('discord_token_failed'), { status: 400 });
  const tok = await tr.json();
  const ur = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!ur.ok) throw Object.assign(new Error('discord_user_failed'), { status: 502 });
  const user = await ur.json();
  const token = crypto.randomBytes(32).toString('hex');
  const name = user.global_name || user.username;
  db.saveSession({ token, userId: user.id, username: name, accessToken: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 });
  return { token, user: { id: user.id, name }, maxAge: tok.expires_in };
}

// 所属サーバー一覧(60秒キャッシュ)。トークン失効時は null
async function userGuilds(session) {
  const hit = cache.get(session.token);
  if (hit && Date.now() - hit.at < 60_000) return hit.guilds;
  const res = await fetch(`${API}/users/@me/guilds`, { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (res.status === 401) { db.deleteSession(session.token); return null; }
  if (!res.ok) throw new Error(`Discord ${res.status}`);
  const guilds = await res.json();
  cache.set(session.token, { at: Date.now(), guilds });
  return guilds;
}

// サーバー管理 or 管理者権限 or オーナー
const canManage = (g) => g.owner || (BigInt(g.permissions || 0) & 0x28n) !== 0n;
const iconUrl = (g) => (g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null);
const publicGuild = (g) => ({ id: g.id, name: g.name, icon: iconUrl(g) });

module.exports = { login, userGuilds, canManage, publicGuild };
