# Packhearth

初心者でも MOD やバージョン違いのマイクラを楽しめる、Discord コミュニティ向けランチャー。
Windows / macOS / Linux 対応(Electron)。

## 仕組み

```
管理者 ─▶ 管理サイト(/admin/)で Discord サーバーに「s1」などの名前でパック/バージョンを登録
プレイヤー ─▶ ランチャーで Discord ログイン
          ─▶ 左に所属 Discord サーバーのアイコン → クリック → サーバー名を押すとマイリストに追加
          ─▶ プレイ(起動のたびにパックの更新を確認して自動更新)
```

- 登録できる遊び方: **バニラ(全バージョン・スナップショット含む)** / **Modrinth モッドパックURL(自動更新)** / **CurseForge モッドパックURL(自動更新)** / **FTB(Feed The Beast)パック(自動更新、APIキー不要)** / `.mrpack` URL / **普通の zip**(mods/ config/ を詰めたもの) / 独自 `manifest.json`
- CurseForge は API キー(`CURSEFORGE_API_KEY`)をバックエンドに設定したときだけ有効。キーはサーバーだけが保持します。作者が外部配布を禁止している MOD は取得できずエラーになります
- ローダー: Fabric / Quilt / Forge / NeoForge(バニラの指定でも、パック内の指定でも可)
- **Java は自動導入**(Mojang 公式ランタイム。バージョンごとに必要な Java を自動で選択)
- 更新確認: 起動時に管理者の最新設定を取得 → パックの差分だけ取得/不要ファイル削除。通信できなければ保存済みの設定で起動
- 管理者側に Bot は不要。Discord のサーバー管理権限があれば、管理サイトから登録できます

## 1. バックエンド + 管理サイト

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリを作成
2. **OAuth2 → Redirects** に次の2つを登録
   - `http://127.0.0.1:53682/callback` (ランチャー用)
   - `<PUBLIC_URL>/admin/callback` (管理サイト用)
3. `.env.example` を参考に環境変数を設定して起動(Node 22.5 以降)

```
cd backend
npm install
npm start
```

HTTPS のリバースプロキシ配下で公開してください(`PUBLIC_URL` は https、`TRUST_PROXY=1`)。

1つのサーバーで次の3つを配信します。

| パス | 内容 |
|---|---|
| `/` | 紹介サイト (`site/`、最新リリースへのダウンロードリンク付き) |
| `/admin/` | 管理ページ(Discord ログイン) |
| `/api/*`, `/auth/*` | ランチャー用 API |

### 接続先アドレスの管理

- サーバーごとに、**メインのアドレス + 予備アドレス(最大3つ)**を登録できます。`host` / `host:port` 形式で、SRV レコードにも対応します
- 管理ページの**接続テスト**で、オンライン/オフライン、人数、応答時間、バージョン、MOTD を確認できます
- **変更履歴**(誰がいつ変えたか)が、サーバーの編集画面に出ます
- ランチャーの一覧に、各サーバーの**稼働状況**(オンライン・人数・応答時間)を表示します
- 起動時にメインのアドレスへ繋がらなければ、**繋がる予備アドレスへ自動で切り替えて**接続します
- `localhost` やプライベートIP(`192.168.x.x` など)は、他の人から繋がらないため登録できません。接続テストは、バックエンドから内部ネットワークへ接続できないよう保護されています

### 誰がパックを登録できるか

| 立場 | できること |
|---|---|
| Discord の管理者 (サーバー管理権限) | パックの追加/編集/削除、編集者の招待、登録者(オーナー)を外す |
| **登録者(オーナー)** = まだ誰も登録していないDiscordサーバーを、最初に管理サイトで「登録する」と押した人(管理者権限は不要) | パックの追加/編集/削除、編集者の招待 |
| **編集者** = 管理者または登録者が発行した招待リンクを使った人 | パックの追加/編集/削除 |

- 招待リンクは `<PUBLIC_URL>/admin/?invite=...` 形式で、有効期間と使用回数を指定して発行します。そのDiscordサーバーの参加者だけが使えます
- すでにパックや編集者がいるサーバーは「登録する」で乗っ取れません
- 誤登録や乗っ取りは、Discord の管理者がオーナーを外せば解除できます

### Pterodactyl (egg) + Cloudflare Tunnel で公開する

1. [deploy/pterodactyl/egg-packhearth-backend.json](deploy/pterodactyl/egg-packhearth-backend.json) をパネルにインポートし、サーバーを作成
2. Cloudflare Zero Trust → Networks → Tunnels でトンネルを作成し、**トークン**を控える
3. トンネルの Public Hostname に `launcher.example.com` を追加し、サービスを `http://localhost:<サーバーのポート>` にする
4. パネルの変数を設定: `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `PUBLIC_URL=https://launcher.example.com` / `CF_TUNNEL_TOKEN`(+ 非公開リポジトリなら `GIT_TOKEN`)
5. 起動すると `cloudflared` が自動で取得・起動され、バックエンドと同時に動きます(起動のたびに `git pull` で更新)

## 2. ランチャー

開発:
```
npm install
set BACKEND_URL=https://your.backend.example
npm start
```

### 配布用ビルド(exe など)

```
set BACKEND_URL=https://your.backend.example
npm run set-backend      # src/config.json に接続先を書き込む
npm run dist:win         # Windows: インストーラー(.exe) + ポータブル(.exe) → dist/
```

| OS | コマンド | 成果物 |
|---|---|---|
| Windows | `npm run dist:win` | NSIS インストーラー / ポータブル exe |
| macOS | `npm run dist:mac`(Mac上で) | dmg (Intel / Apple Silicon) |
| Linux | `npm run dist:linux` | AppImage / deb |

各OS用のビルドはそのOS上で行う必要があります。**GitHub Actions** ([.github/workflows/build.yml](.github/workflows/build.yml)) が3OSを一括ビルドします。
リポジトリの Variables に `BACKEND_URL` を登録し、`v1.0.0` のようなタグを push するか手動実行してください。

### ランチャーの自動更新

起動時と6時間ごとに GitHub の最新リリースを確認します (`electron-updater`)。タグ `v1.2.3` を push すると、そのバージョンでビルド・公開され、旧バージョンが自動で検知します。

| 配布形式 | 更新方法 |
|---|---|
| Windows インストーラー / Linux AppImage | 自動ダウンロード → 終了時または「今すぐ再起動」で更新 |
| Windows ポータブル / macOS (未署名) / deb | 「新しいバージョンがあります」を表示し、ダウンロードページへ誘導 |

自動更新が動くには、**リリースが公開(public)**であること、`latest*.yml` がリリースに含まれること(ワークフローが自動で添付)が必要です。

### コード署名

署名用の Secrets / Variables がリポジトリに登録されていれば、リリース時に**自動で署名**します(無ければ警告を出して署名なしでビルドします)。証明書は購入・発行が必要で、こちらで用意することはできません。

**Windows**(SmartScreen の警告を減らす / 自動更新の発行元チェック)
1. コード署名証明書(`.pfx`)を用意。EV 証明書は SmartScreen の警告がすぐ消えます。OV は利用実績が貯まるまで警告が出ます。OSS なら [SignPath Foundation](https://signpath.org/) の無料枠もあります
2. `base64 -w0 cert.pfx` の出力を Secret `WIN_CSC_LINK` に、パスワードを `WIN_CSC_PASSWORD` に登録
3. (推奨) Variable `WIN_PUBLISHER_NAME` に証明書の発行先名 (CN) を登録すると、自動更新は**同じ発行元で署名されたものだけ**を受け入れます

**macOS**(Gatekeeper の警告をなくす / 自動更新)
1. Apple Developer Program(年額)に加入し、「Developer ID Application」証明書を書き出して `.p12` にする
2. `base64` した内容を Secret `MAC_CSC_LINK`、パスワードを `MAC_CSC_PASSWORD` に登録
3. 公証用に Secret `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`(appleid.apple.com で発行)、`APPLE_TEAM_ID` を登録
4. 署名済みビルドでは macOS でも自動更新が有効になります

**Linux** は署名なしです(自動更新は `latest-linux.yml` のハッシュで検証します)。

手元でビルドするときは、`CSC_LINK=<pfxのパス> CSC_KEY_PASSWORD=<パスワード> APP_SIGNED=1 npm run set-backend && npm run dist` のように環境変数を渡します。

注意:
- Windows でビルドするとき「シンボリックリンクを作成できません」と出る場合は、Windows の設定で**開発者モード**を有効にするか、管理者権限のターミナルで実行してください
- 署名用の証明書を登録していない間は、初回に Windows SmartScreen / macOS Gatekeeper の警告が出ます(macOS は右クリック→開く)。上の「コード署名」を参照

## manifest.json 形式(上級者向け)

`server-manifest.example.json` を参照。`loader` は `vanilla|fabric|quilt|forge|neoforge`、`loaderVersion` は省略で最新。
`files[]` は `{ path, url, sha1 }`。

## ライセンス

[MIT License](LICENSE)。Minecraft は Mojang AB の商標で、本ツールは非公式です。

## 注意

- macOS 版は署名していません。初回は右クリック →「開く」で起動してください。自動更新は行わず、新しい版があるとダウンロードページへ案内します
- パックの MOD は任意コードを実行できます。初回起動時に確認ダイアログを出しますが、信頼できる管理者のパックのみ起動してください
- Forge は古いバージョン(1.5.2 未満は不可)、Fabric/Quilt は 1.14 以降、NeoForge は 1.20.2 以降のみ対応(ローダー側の制約)
