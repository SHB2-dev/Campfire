const { createApi } = require('./api');
const { mountAdmin } = require('./admin');

const need = (k) => {
  if (!process.env[k]) { console.error(`環境変数 ${k} が未設定です (.env.example 参照)`); process.exit(1); }
  return process.env[k];
};

const clientId = need('DISCORD_CLIENT_ID');
const clientSecret = need('DISCORD_CLIENT_SECRET');
const publicUrl = need('PUBLIC_URL').replace(/\/$/, '');
// ランチャーのループバックのリダイレクトURI(Discord開発者ポータルにも登録すること)
const allowedRedirects = (process.env.ALLOWED_REDIRECTS || 'http://127.0.0.1:53682/callback').split(',');

const port = Number(process.env.PORT || 8787);
const app = createApi({
  clientId, clientSecret, publicUrl, allowedRedirects,
  extra: (a) => mountAdmin(a, { clientId, clientSecret, publicUrl }),
});
app.listen(port, () => console.log(`listening on :${port}  admin: ${publicUrl}/admin/`));
