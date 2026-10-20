// 配布用ビルドの前に、ランチャーの接続先と署名の有無を src/config.json に書き込む
//   BACKEND_URL=https://launcher.example.com [APP_SIGNED=1] npm run set-backend
// APP_SIGNED=1 は「このビルドは署名済み」の意味で、macOS の自動更新を有効にするために使う
const fs = require('fs');
const path = require('path');

const url = process.env.BACKEND_URL;
if (!url || !/^https:\/\//.test(url)) {
  console.error('BACKEND_URL に https:// で始まるバックエンドのURLを指定してください');
  process.exit(1);
}
const config = { backendUrl: url.replace(/\/$/, ''), signed: process.env.APP_SIGNED === '1' };
fs.writeFileSync(path.join(__dirname, '..', 'src', 'config.json'), JSON.stringify(config, null, 2) + '\n');
console.log('config:', config);
