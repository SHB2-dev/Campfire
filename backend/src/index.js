const express = require('express');
const path = require('path');
const fs = require('fs');
const { createApi } = require('./api');
const { mountAdmin } = require('./admin');

// 紹介サイト(リポジトリの site/)をルートで配信する
const siteDir = process.env.SITE_DIR || path.join(__dirname, '..', '..', 'site');
// Google アナリティクス(任意)。測定ID(G-XXXXXXXXXX)が設定されているときだけ、紹介サイトに組み込む。
// 訪問者が同意するまで読み込まない(site/analytics.js)。管理サイトには入れない
const GA_ID = /^G-[A-Z0-9]{4,20}$/i.test(process.env.GA_MEASUREMENT_ID || '') ? process.env.GA_MEASUREMENT_ID.toUpperCase() : '';
const CSP_BASE = "default-src 'self'; connect-src 'self' https://api.github.com; img-src 'self' data:; frame-ancestors 'none'";
const CSP_GA = "default-src 'self'; script-src 'self' https://www.googletagmanager.com; " +
  "connect-src 'self' https://api.github.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com; " +
  "img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com; frame-ancestors 'none'";
// 測定IDを差し込むページ(Googleの確認用ファイルなど、ほかのhtmlには触らない)
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/privacy.html': 'privacy.html' };

function mountSite(app, publicUrl) {
  // 検索エンジン向け。管理サイトとAPIはインデックスさせない
  app.get('/robots.txt', (_req, res) =>
    res.type('text/plain').send(`User-agent: *\nDisallow: /admin/\nDisallow: /api/\nDisallow: /auth/\nSitemap: ${publicUrl}/sitemap.xml\n`));
  app.get('/sitemap.xml', (_req, res) =>
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${publicUrl}/</loc></url></urlset>\n`));
  app.get(Object.keys(PAGES), (req, res, next) => {
    fs.readFile(path.join(siteDir, PAGES[req.path]), 'utf8', (e, html) => {
      if (e) return next();
      if (GA_ID) html = html.replace('</head>', `<meta name="ga-id" content="${GA_ID}">
</head>`);
      res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': GA_ID ? CSP_GA : CSP_BASE, 'X-Content-Type-Options': 'nosniff' }).send(html);
    });
  });
  app.use((_req, res, next) => {
    res.set('Content-Security-Policy', GA_ID ? CSP_GA : CSP_BASE);
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.static(siteDir, { index: false }));
}

const need = (k) => {
  if (!process.env[k]) { console.error(`環境変数 ${k} が未設定です (.env.example 参照)`); process.exit(1); }
  return process.env[k];
};

const clientId = need('DISCORD_CLIENT_ID');
const clientSecret = need('DISCORD_CLIENT_SECRET');
// ホスト名は大文字小文字を区別しない。Discord のリダイレクトURIは文字列で一致を見るため、小文字に正規化する
const publicUrl = (() => {
  try {
    const u = new URL(need('PUBLIC_URL'));
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    console.error('PUBLIC_URL が正しいURLではありません'); process.exit(1);
  }
})();
// ランチャーのループバックのリダイレクトURI(Discord開発者ポータルにも登録すること)
const allowedRedirects = (process.env.ALLOWED_REDIRECTS || 'http://127.0.0.1:53682/callback').split(',');

require('./db').purgeExpiredSessions();
setInterval(() => require('./db').purgeExpiredSessions(), 3600_000).unref();

const port = Number(process.env.PORT || process.env.SERVER_PORT || 8787);
const app = createApi({
  clientId, clientSecret, publicUrl, allowedRedirects,
  extra: (a) => { mountAdmin(a, { clientId, clientSecret, publicUrl }); mountSite(a, publicUrl); },
});
app.listen(port, () => console.log(`listening on :${port}  admin: ${publicUrl}/admin/`));
