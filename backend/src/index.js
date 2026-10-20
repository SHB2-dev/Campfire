const express = require('express');
const path = require('path');
const { createApi } = require('./api');
const { mountAdmin } = require('./admin');

// 紹介サイト(リポジトリの site/)をルートで配信する
const siteDir = process.env.SITE_DIR || path.join(__dirname, '..', '..', 'site');
function mountSite(app) {
  app.use((_req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'self'; connect-src 'self' https://api.github.com; img-src 'self' data:; frame-ancestors 'none'");
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.static(siteDir));
}

const need = (k) => {
  if (!process.env[k]) { console.error(`環境変数 ${k} が未設定です (.env.example 参照)`); process.exit(1); }
  return process.env[k];
};

const clientId = need('DISCORD_CLIENT_ID');
const clientSecret = need('DISCORD_CLIENT_SECRET');
const publicUrl = need('PUBLIC_URL').replace(/\/$/, '');
// ランチャーのループバックのリダイレクトURI(Discord開発者ポータルにも登録すること)
const allowedRedirects = (process.env.ALLOWED_REDIRECTS || 'http://127.0.0.1:53682/callback').split(',');

require('./db').purgeExpiredSessions();
setInterval(() => require('./db').purgeExpiredSessions(), 3600_000).unref();

const port = Number(process.env.PORT || process.env.SERVER_PORT || 8787);
const app = createApi({
  clientId, clientSecret, publicUrl, allowedRedirects,
  extra: (a) => { mountAdmin(a, { clientId, clientSecret, publicUrl }); mountSite(a); },
});
app.listen(port, () => console.log(`listening on :${port}  admin: ${publicUrl}/admin/`));
