# Community Launcher

初心者でも MOD やバージョン違いのマイクラを楽しめる、Discord コミュニティ向けランチャー。
Windows / macOS / Linux 対応(Electron)。

## 仕組み

```
管理者 ─▶ 管理サイト(/admin/)で Discord サーバーに「s1」などの名前でパック/バージョンを登録
プレイヤー ─▶ ランチャーで Discord ログイン
          ─▶ 左に所属 Discord サーバーのアイコン → クリック → サーバー名を押すとマイリストに追加
          ─▶ プレイ(起動のたびにパックの更新を確認して自動更新)
```

- 登録できる遊び方: **バニラ(全バージョン・スナップショット含む)** / **Modrinth モッドパックURL(自動更新)** / `.mrpack` URL / 独自 `manifest.json`
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
管理サイトは `<PUBLIC_URL>/admin/` です。

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

注意:
- Windows でビルドするとき「シンボリックリンクを作成できません」と出る場合は、Windows の設定で**開発者モード**を有効にするか、管理者権限のターミナルで実行してください
- コード署名をしていないため、初回は Windows SmartScreen / macOS Gatekeeper の警告が出ます(macOS は右クリック→開く)

## manifest.json 形式(上級者向け)

`server-manifest.example.json` を参照。`loader` は `vanilla|fabric|quilt|forge|neoforge`、`loaderVersion` は省略で最新。
`files[]` は `{ path, url, sha1 }`。

## 注意

- パックの MOD は任意コードを実行できます。初回起動時に確認ダイアログを出しますが、信頼できる管理者のパックのみ起動してください
- Forge は古いバージョン(1.5.2 未満は不可)、Fabric/Quilt は 1.14 以降、NeoForge は 1.20.2 以降のみ対応(ローダー側の制約)
