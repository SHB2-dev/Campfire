// 配布用ビルドの前に、ランチャーが接続するバックエンドURLを src/config.json に書き込む
//   BACKEND_URL=https://launcher.example.com npm run set-backend
const fs = require('fs');
const path = require('path');

const url = process.env.BACKEND_URL;
if (!url || !/^https:\/\//.test(url)) {
  console.error('BACKEND_URL に https:// で始まるバックエンドのURLを指定してください');
  process.exit(1);
}
fs.writeFileSync(path.join(__dirname, '..', 'src', 'config.json'), JSON.stringify({ backendUrl: url.replace(/\/$/, '') }, null, 2) + '\n');
console.log('backendUrl =', url);
