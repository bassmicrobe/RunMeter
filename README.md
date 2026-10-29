# RunMeter

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/runmeter-logo-dark.svg">
  <img src="public/brand/runmeter-logo-light.svg" alt="RunMeter" width="278" height="64">
</picture>

**Codex / Claude の使用率、次のリセット日時、トークン履歴を1画面で確認する、local-firstの利用メーター。**

## 概要

[開発：サイバーアイ・テクノロジー株式会社](https://cybereye-tech.jp/)

同一PC上のLocal Relay経由で、Codex・Claude・Geminiの利用枠を確認します。架空の利用データは表示しません。AIサービスの認証情報と利用履歴は端末内に保存し、RunMeter運営サーバー・サイバーアイ・テクノロジー株式会社・Vercelへは送信・保存しません。

- サービスごとの使用率と残り割合を最上段に表示
- 5時間・週次・日次など、Providerが返す利用枠と次のリセット日時
- 日別トークンのグラフと「サービス × 日付」の利用マトリクス
- 再起動・切断後も、記録のある直近90日分までの日別履歴を表示
- 15秒ごとの画面更新。取得遅延・認証エラーを明示
- 各サービスの公式利用画面への直リンク
- サービスごとの接続・解除

Windows x64プレビュー版は[GitHub Releasesのv0.1.0](https://github.com/bassmicrobe/RunMeter/releases/tag/v0.1.0)から入手できます。この配布版は未署名です。[確認済みの範囲と配布ファイル](docs/releases/v0.1.0.md)も参照してください。

```text
Vercel / Next.js Web UI
        │  http://127.0.0.1:47831（ペアリング後のみ）
        ▼
RunMeter Local Relay
        ├─ Codex App Server / Claude statusLine / Gemini API
        ├─ OS資格情報保管庫
        └─ ローカルSQLite履歴
```

- VercelはWeb UIと未接続の初期状態だけを配信します。通常のページ配信に伴うアクセスログはVercelで処理される場合がありますが、利用メーターの値やAI認証情報はWebサーバーへ送信しません。
- Claudeの既存statusLine退避値とGeminiの認証状態はOS資格情報保管庫に保存します（Windows：DPAPI、macOS：Keychain、Linux：Secret Service）。
- SQLiteには正規化した利用Snapshot、日別履歴、ハッシュ化したRelayセッションだけを保存し、AIサービスの生の認証情報は保存しません。
- 利用履歴はこのPCのサービス単位です。複数アカウントを切り替えても同じ履歴になり、アカウント別には分離されません。
- ブラウザのIndexedDBに保存するのは、失効可能なRelay用Bearer token、版、有効期限だけです。
- Relayは`127.0.0.1:47831`だけで待ち受け、Host、Origin、CORS、Private Network Accessを検証します。
- 標準Relayは同じPCのブラウザ専用です。画面はスマホ幅に対応していますが、スマホからPCのRelayへ直接接続するLAN公開モードは搭載していません。

保存先:

- Windows：`%LOCALAPPDATA%\RunMeter`
- macOS：`~/Library/Application Support/RunMeter`
- Linux：`$XDG_STATE_HOME/runmeter`、未設定時は`~/.local/state/runmeter`

## 技術スタック

- Next.js 16.4.2（App Router） / React 19.2.8 / TypeScript 7.0.2（CLI型検査。ESLint互換のためTypeScript 6互換APIも併用）
- Tailwind CSS 4 / shadcn/ui / Recharts
- Local Relay：Node.js 24以上、Node.js標準SQLite
- Windows版：Electron 43.8.3 / Electron Forge / Squirrel.Windows
- テスト：Node.js組み込みtest、Playwright

## 使い方

### Windows版

一般利用者は`RunMeterSetup.exe`をダブルクリックするだけで使えます。Node.js、npm、PowerShellコマンドは不要です。

必要環境:

- Windows 10/11（x64）
- Codex連携：Codex CLI
- Claude連携：Claude Code

1. `RunMeterSetup.exe`を起動
2. CodexまたはClaudeの「接続」を押す
3. 初回に表示される6桁コードを入力し、サービスごとの接続を進める

アプリを閉じても通知領域でLocal Relayが動作し、Windowsログイン時の自動起動は通知領域メニューから切り替えられます。認証情報と利用履歴はPC内だけに保存されます。

インストーラーは`desktop/out/make/squirrel.windows/x64/RunMeterSetup.exe`に生成されます。正式版はAuthenticode署名が必要です。署名手順は[Windows署名ガイド](docs/WINDOWS_SIGNING.md)を参照してください。

### 接続方法

| サービス | 接続方法 | 取得範囲 |
| --- | --- | --- |
| Codex | 公式Codex App Serverが管理するChatGPTログイン | 使用率、5時間・週次などのリセット。トークン履歴は利用中のCodex CLIが`account/usage/read`を提供する場合に表示 |
| Claude | Claude Codeの公式`statusLine` | 5時間・7日の使用率、リセット、現在のコンテキストトークン。独自のClaude.ai OAuthは使いません |
| Gemini | Googleログイン後にCloudプロジェクトを選択 | 選択したGoogle CloudプロジェクトのGemini API利用量。個人向け`gemini.google.com`プランの利用枠ではありません |

公式仕様:

- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [Claude Code statusLine](https://code.claude.com/docs/en/statusline)

更新頻度:

- Web画面：15秒ごと。非表示タブでは取得を止め、再表示時に即時更新
- Codex：画面更新時にApp Serverから利用枠を取得
- Claude：statusLineの更新に追従（通常5〜30秒）

料金・請求・最終的なquota値は、画面内の「公式画面」で各Providerの正本を確認してください。

## セットアップ

### 開発環境

- Node.js 24以上
- Windows 10/11、macOS、またはSecret Serviceを利用できるLinux
- Codex連携：Codex CLI
- Claude連携：Claude Code

```bash
npm install
```

ターミナル1でLocal Relayを起動します。

```bash
npm --prefix relay start
```

`ペアリングコード: 123456`のように6桁のコードが表示されます。コードは5分で失効し、1回だけ使えます。

ローカルでWeb UIも起動する場合は、ターミナル2で次を実行します。

```bash
npm run dev
```

`http://localhost:3000`を開き、各サービス行の「接続」からペアリングコードを入力します。Vercel版のWeb UIでも同じLocal Relayへ接続できます。Gemini接続用のGoogle OAuth設定は[relay/README.md](relay/README.md)を参照してください。

### 検証

```bash
npm run lint
npm run typecheck
npm run relay:typecheck
npm test
npm run build
npx playwright install chromium
npm run test:web
```

`test:web`は本番ビルドをポート3210で起動し、PC・スマートフォン幅の接続/解除/更新停止/通信失敗を確認します。Relay通信はテスト内で置き換えるため、実際の認証情報や利用データにはアクセスしません。

Windows版の開発・パッケージ作成は[desktop/README.md](desktop/README.md)を参照してください。

ロゴ・favicon・Windows用アイコンの更新:

```bash
npm run brand:generate
```

依存更新後のOSS表記:

```bash
npm run licenses:generate
npm run licenses:check
```

公開用ソースの作成は[公開手順](docs/PUBLIC_REPOSITORY.md)を参照してください。

## 構成

```text
.
├── src/          Web UI（Next.js App Router）
├── relay/        Local Relay（127.0.0.1:47831）
├── desktop/      Windows向けElectronアプリ
├── public/       静的資産・ブランド素材
├── docs/         ドキュメント
├── scripts/      ライセンス生成・公開検査など
├── tests/        Web E2Eなど
└── licenses/     第三者ライセンス原文
```

## ドキュメント

- [Windows署名ガイド](docs/WINDOWS_SIGNING.md)
- [v0.1.0 リリース案内](docs/releases/v0.1.0.md)
- [公開リポジトリの準備](docs/PUBLIC_REPOSITORY.md)
- [OGP画像](docs/OGP_IMAGE.md)
- [依存更新メモ](docs/DEPENDENCY_UPDATES.md)
- [パフォーマンス・UI/UX・公開データ監査（2026-10-15）](docs/PERFORMANCE_UX_PUBLIC_AUDIT_2026-10-15.md)
- [リリース前監査（2026-09-26）](docs/RELEASE_AUDIT_2026-09-26.md)
- [Windows版](desktop/README.md)
- [Local Relay](relay/README.md)

## ライセンス

- 本体コード：[MIT](LICENSE)
- ロゴ・シンボル・派生アイコン・共有画像：[ブランド素材の権利表記](BRANDING_LICENSE.md)（MITの対象外）
- 第三者OSSとGeist / Geist Monoフォント：[OSSライセンス一覧](THIRD_PARTY_NOTICES.txt)

Web画面のフッターから「ライセンス・OSS表記」を開けます。Windows配布物にも本体・ブランド・OSS・ランタイムの文書を同梱します。開発専用ツールや別途インストールするCodex / Claude Code本体のライセンスをRunMeterのMITで置き換えることはありません。
