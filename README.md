# RunMeter

[開発：サイバーアイ・テクノロジー株式会社](https://cybereye-tech.jp/)

Codex / Claude の使用率、次のリセット日時、トークン履歴を1画面で確認する、local-firstの利用メーターです。架空の利用データは表示しません。

## Windows版

一般利用者は`RunMeterSetup.exe`をダブルクリックするだけで使えます。Node.js、npm、PowerShellコマンドは不要です。

1. `RunMeterSetup.exe`を起動
2. CodexまたはClaudeの「接続」を押す
3. 初回に表示される6桁コードを入力し、サービスごとの接続を進める

アプリを閉じても通知領域でLocal Relayが動作し、Windowsログイン時の自動起動は通知領域メニューから切り替えられます。Web画面と同じ表示を使いますが、認証情報と利用履歴はPC内だけに保存され、RunMeterのサーバーには送信・保存されません。

開発用の未署名インストーラーは`desktop/out/make/squirrel.windows/x64/RunMeterSetup.exe`に生成されます。一般公開版は発行元を確認できるようAuthenticode署名が必要です。署名後もSmartScreenの評価は別途確認します。

## できること

- サービスごとの使用率と残り割合を最上段に表示
- 5時間・週次・日次など、Providerが返す利用枠と次のリセット日時を表示
- 日別トークンのグラフと「サービス × 日付」の利用マトリクス
- 再起動・切断後も保存済みの日別履歴を表示（記録のある直近90日分まで）
- 15秒ごとの画面更新と、取得遅延・認証エラーの明示
- 各サービスの公式利用画面への直リンク
- 2サービスを別々に接続・解除

## Windows版の必要環境

- Windows 10/11（x64）
- Codex連携：Codex CLI
- Claude連携：Claude Code

## 開発環境

- Node.js 24以上
- Windows 10/11、macOS、またはSecret Serviceを利用できるLinux
- Codex連携：Codex CLI
- Claude連携：Claude Code

## 開発時の起動方法

最初に依存関係をインストールします。

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

`http://localhost:3000`を開き、各サービス行の「接続」からペアリングコードを入力します。Vercel版のWeb UIでも同じLocal Relayへ接続できます。

## 接続方法

| サービス | 接続方法 | 取得範囲 |
| --- | --- | --- |
| Codex | 公式Codex App Serverが管理するChatGPTログイン | 使用率、5時間・週次などのリセット。トークン履歴は利用中のCodex CLIが`account/usage/read`を提供する場合に表示 |
| Claude | Claude Codeの公式`statusLine` | 5時間・7日の使用率、リセット、現在のコンテキストトークン。独自のClaude.ai OAuthは使いません |

公式仕様：

- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [Claude Code statusLine](https://code.claude.com/docs/en/statusline)

## データと認証情報の扱い

```text
Vercel / Next.js Web UI
        │  http://127.0.0.1:47831（ペアリング後のみ）
        ▼
RunMeter Local Relay
        ├─ Codex App Server / Claude statusLine
        ├─ OS資格情報保管庫
        └─ ローカルSQLite履歴
```

- VercelはWeb UIと未接続の初期状態だけを配信します。
- AIサービスのAPIキー、OAuth token、利用履歴は、RunMeter運営サーバー、サイバーアイ・テクノロジー株式会社、Vercelへ送信・保存しません。
- Claudeの既存statusLine退避値はOS資格情報保管庫に保存します。
  - Windows：DPAPI（Current User）
  - macOS：Keychain
  - Linux：Secret Service / `secret-tool`
- SQLiteには正規化した利用Snapshot、日別履歴、ハッシュ化したRelayセッションだけを保存し、AIサービスの生の認証情報は保存しません。
- 利用履歴はこのPCのサービス単位で保存します。複数のアカウントを切り替えた場合も同じ履歴になり、アカウント別には分離されません。
- ブラウザのIndexedDBに保存するのは、失効可能なRelay用Bearer token、版、有効期限だけです。AIサービスのキーはブラウザへ永続保存しません。
- Relayは`127.0.0.1:47831`だけで待ち受け、Host、Origin、CORS、Private Network Accessを検証します。
- 通常のページ配信に伴うアクセスログはVercelで処理される場合がありますが、利用メーターの値やAI認証情報はWebサーバーへ送信しません。

標準Relayは安全のため同じPCのブラウザ専用です。画面はスマホ幅に対応していますが、スマホからPCのRelayへ直接接続するLAN公開モードは搭載していません。

## 更新頻度

- Web画面：15秒ごと。非表示タブでは取得を止め、再表示時に即時更新
- Codex：画面更新時にApp Serverから利用枠を取得
- Claude：statusLineの更新に追従（通常5〜30秒）

料金・請求・最終的なquota値は、画面内の「公式画面」で各Providerの正本を確認してください。

## 保存先

- Windows：`%LOCALAPPDATA%\RunMeter`
- macOS：`~/Library/Application Support/RunMeter`
- Linux：`$XDG_STATE_HOME/runmeter`、未設定時は`~/.local/state/runmeter`

## 開発

- Next.js 16.4.2 App Router
- React 19.2.8
- TypeScript 7.0.2
- Tailwind CSS 4 / shadcn/ui / Recharts
- Node.js標準SQLite

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

TypeScript 7をCLI型検査に使い、ESLint互換性のためにTypeScript 6互換APIも併用しています。Relayは独立したNodeサービスとして`relay/tsconfig.json`で型検査します。

## 公開リポジトリの準備

個人情報の検査と、開発履歴を持ち込まない公開用ソースの作成方法は[公開手順](docs/PUBLIC_REPOSITORY.md)を参照してください。`node scripts/check-public-data.mjs`は検出値を表示せず、公開候補のファイルを確認します。


## 2026-10-16 Web UI dependency update

Next.js and eslint-config-next are pinned to 16.4.2. The npm lockfile is regenerated. The Vercel Web UI is deployed from main after verification; this dependency update does not publish or sign a new Windows installer.
