<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/runmeter-logo-dark.svg">
  <img src="public/brand/runmeter-logo-light.svg" alt="RunMeter" width="278" height="64">
</picture>

# RunMeter

[開発：サイバーアイ・テクノロジー株式会社](https://cybereye-tech.jp/)

本体コードは[MITライセンス](LICENSE)です。ロゴ・ブランド素材は[会社の権利留保](BRANDING_LICENSE.md)で、MITの対象外です。第三者OSS・フォントは[OSSライセンス一覧](THIRD_PARTY_NOTICES.txt)に記載した条件に従います。

Codex / Claude の使用率、次のリセット日時、トークン履歴を1画面で確認する、local-firstの利用メーターです。架空の利用データは表示しません。

## ロゴとアイコン

ロゴのSVG原本は`public/brand/`にあります。READMEは明暗テーマに合わせてロゴを切り替え、アプリのサイドバーは折りたたむとシンボルだけを表示します。

favicon・ホーム画面用アイコン・Windows用アイコンは、添付ロゴの正方形SVGから生成しています。更新時は次を実行します。

```bash
npm run brand:generate
```

## ライセンス・OSS表記

- 本体コード：MIT。著作権・許諾文の保持など、[原文](LICENSE)の条件を確認してください。
- ロゴ、シンボル、派生アイコン、共有画像：[ブランド素材の権利表記](BRANDING_LICENSE.md)に従います。公開する派生製品では、別途許諾がなければ独自のブランド素材へ置き換えてください。
- 第三者OSSとGeist / Geist Monoフォント：[ライセンス原文と著作権表記](THIRD_PARTY_NOTICES.txt)を保持しています。MITを第三者の素材に一律に適用するものではありません。
- Web画面のフッターから「ライセンス・OSS表記」を開けます。Windows配布物にも本体・ブランド・OSS・ランタイムの文書を同梱します。

依存を更新した場合は、ライセンス文書を再生成して差分を確認します。

```bash
npm run licenses:generate
npm run licenses:check
```

開発専用ツールや別途インストールするCodex / Claude Code本体のライセンスをRunMeterのMITライセンスで置き換えることはありません。同梱範囲と生成方法はOSS一覧と[Windows版の説明](desktop/README.md)を参照してください。

## Windows版

[Windows x64 プレビュー版をダウンロード](https://github.com/bassmicrobe/RunMeter/releases/tag/v0.1.0)。この配布版は未署名です。発行元の署名を確認できないため、Windowsで警告が表示される場合があります。[確認済みの範囲と配布ファイル](docs/releases/v0.1.0.md)も参照してください。

一般利用者は`RunMeterSetup.exe`をダブルクリックするだけで使えます。Node.js、npm、PowerShellコマンドは不要です。

1. `RunMeterSetup.exe`を起動
2. CodexまたはClaudeの「接続」を押す
3. 初回に表示される6桁コードを入力し、サービスごとの接続を進める

アプリを閉じても通知領域でLocal Relayが動作し、Windowsログイン時の自動起動は通知領域メニューから切り替えられます。Web画面と同じ表示を使いますが、認証情報と利用履歴はPC内だけに保存され、RunMeterのサーバーには送信・保存されません。

インストーラーは`desktop/out/make/squirrel.windows/x64/RunMeterSetup.exe`に生成されます。未署名の配布はプレビューとして明示します。正式版は発行元を確認できるようAuthenticode署名が必要で、署名後もSmartScreenの評価は別途確認します。

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

## 2026-10-17 Electron dependency update

Electronを43.7.5から43.8.0へ更新し、`desktop/package-lock.json`のバージョン・配布URL・整合性ハッシュを同期しました。Forgeと同梱Node.jsのバージョンは変更していません。

Linux環境でDesktop単体テスト、Relayテスト、型検査とmain/bridgeのコンパイルを確認しました。Windows実機での起動・インストール・更新・アンインストール、署名とSmartScreen評価は未検証です。署名済みWindowsインストーラーの本番公開は未完了です。Web UIのデプロイだけでは、インストール済みのElectronは更新されません。

Desktopの依存監査には更新前からの開発ツール依存の指摘が残っています（high 8件、moderate 18件）。今回の更新で新しい指摘は増えていません。一般公開前にWindows上で[Desktopの検証・署名手順](desktop/README.md)を実施し、承認済みの配布先から署名済みSetupを公開してください。

## 2026-10-24 security dependency update

- Desktop Electronを43.8.0から43.8.3へ更新しました。[GHSA-jr5w-w6x2-84p9](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)の侵害されたeMudhra中間証明書対策はChromiumとElectron内Node.jsのTLS双方に含まれます。Electron同梱Nodeの表示が24.22.0でもこのElectron側修正は含まれます。別体のBridge Node.js 24.21.0とForgeは変更しておらず、別のNode/Brotli問題まで解決したという意味ではありません。
- 開発専用shadcn→MCP→Express経由のbody-parserを2.3.0から2.4.0へ、必須依存qsを6.16.0から6.16.1へ更新しました。実行時のLocal RelayはNode標準HTTPを使い、body-parserを使いません。通常のNext.js等の更新は含めません。
- Windows CIは固定lockのインストール、Web/Relay/Desktopの検査、隔離Desktop/Bridge smoke、実ElectronのバージョンとNode/Chromium双方の証明書検証付きHTTPS、未署名パッケージ生成を検証します。CIは署名・配布・artifact保存をしません。
- ソース／検証用ビルドの更新です。署名済みSetupの公開と既存端末への適用は未完了で、自動更新もありません。Windowsで[署名・実機検証](desktop/README.md)後、適切な配布先でSetupを更新する必要があります。Web UI配備だけではインストール済みElectronは更新されません。

Windows の frozen install 検証で既存の node-fetch の optional peer encoding が lockfile に欠けていたため、encoding 0.1.14 と必要な iconv-lite 0.7.3 の lock エントリだけを補完しています。既存パッケージの追加更新や npm ci の回避は行いません。
