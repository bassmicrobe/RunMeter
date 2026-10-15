# RunMeter Local Relay

RunMeterのWeb画面と、同じPC上のCodex・Claude・Geminiを接続するローカル専用プロセスです。`127.0.0.1:47831`以外では待ち受けません。AIサービスの認証情報や利用履歴をVercelへ送信する機能はありません。

## 起動

Node.js 24以降が必要です。リポジトリのルートで次を実行します。

```powershell
npm --prefix relay start
```

起動すると、5分間だけ有効な6桁のペアリングコードがターミナルに表示されます。コードはHTTP APIから取得できません。RunMeterの接続画面へコードを入力すると、30日間有効なブラウザ用Bearerセッションが発行されます。コードは1回使うと失効し、5回間違えると一時的に受付を停止します。

開発時に別のWeb Originを許可する場合のみ、完全なOriginをカンマ区切りで指定します。パスやワイルドカードは利用できません。

```powershell
$env:RUNMETER_ALLOWED_ORIGINS = "https://run-meter.vercel.app,http://localhost:3000"
npm --prefix relay start
```

## サービス別の接続

### Codex

`codex app-server`を子プロセスとしてstdioで起動し、公式のChatGPTログインを使用します。OAuthトークンの保存・更新はCodex自身が行い、Relayはトークンを読みません。

- 通常ログイン: `POST /v1/providers/codex/connect` に `{}`
- デバイスコード: `POST /v1/providers/codex/connect` に `{"mode":"device-code"}`
- 切断: Relayとの紐付けだけを解除します。Codex CLIからはログアウトしません。
- 明示的ログアウト: `POST /v1/providers/codex/logout`。Codex CLIのセッションにも影響するため、通常の切断とは分離しています。

取得対象は`account/rateLimits/read`の使用率・リセット日時と、`account/usage/read`の日別トークン集計です。複数の利用枠が返る場合は、通常の`codex`枠、App Serverが示す非Sparkのcanonical枠、その他の非Spark枠の順で主メーターを決めます。Spark枠も補助表示として保持します。

状態確認は10秒間だけ直近の取得結果を共有し、複数タブや接続画面からの重複取得を抑えます。手動更新とCodexからの更新通知は、この待ち時間を挟まず取得します。Web画面に非表示のProviderはダッシュボード更新時に取得しません。

### Claude

`POST /v1/providers/claude/connect`で、Claude Codeの`~/.claude/settings.json`へ公式`statusLine`ブリッジを組み込みます。

- 既存の設定キーは保持します。
- 既存の`statusLine`がある場合、その出力も実行・表示します。
- 以前の`statusLine`は平文ファイルへ複製せず、OS資格情報保管庫へ保存します。
- RunMeterが設定した後にユーザーが`statusLine`を変更した場合、切断時に上書きせず競合として停止します。
- 切断時は、RunMeterが設定した内容と一致することを確認してから以前の設定へ戻します。

ブリッジはClaude Codeから渡されるJSONのうち、`rate_limits`と`context_window`の数値だけをRelayへ送ります。セッションID、作業ディレクトリ、リポジトリ、会話ファイルのパスは送信・保存しません。専用Bearerは`ingest:claude`だけに制限され、スナップショットなど他のAPIは読めません。

### Gemini

Relayの配布者がGoogle Desktop OAuthクライアントを1回だけ設定します。`google-oauth.env.example`を`.env`へコピーし、クライアントIDを書き換えてください。`npm --prefix relay start`はこの`.env`を自動で読み込みます。利用者がWeb画面へクライアントID・シークレット・プロジェクトIDを入力する必要はありません。

```powershell
Copy-Item relay/google-oauth.env.example relay/.env
# relay/.env の RUNMETER_GOOGLE_CLIENT_ID を書き換える
npm --prefix relay start
```

`POST /v1/providers/gemini/connect`へ`{"mode":"oauth"}`を送ると、Google認証を開始します。認証後は`GET /v1/providers/gemini/projects`で、このGoogleアカウントから参照できる有効なプロジェクトを取得します。選択したIDを`{"mode":"select-project","options":{"projectId":"..."}}`として同じconnect APIへ送ると、RelayがGoogle Cloudの単一プロジェクト取得APIでアクセス権と有効状態を再確認してから接続します。

Google認証画面から戻るコールバックは一時的な`127.0.0.1`ポートで受け取ります。リフレッシュトークン、選択状態、プロジェクトIDはversion付きの1レコードとしてOS資格情報保管庫へ原子的に保存します。プロジェクト選択前の認証は10分で失効し、再起動後も期限内だけ復元します。アクセストークンとプロジェクト一覧はメモリ上だけで扱い、プロジェクト一覧はスナップショットやSQLiteへ保存しません。対象はGoogle Cloud上のGemini API利用量であり、個人向け`gemini.google.com`プランの利用枠ではありません。

## HTTP API

すべてJSONです。`/v1/health`と`POST /v1/pair`以外は`Authorization: Bearer ...`が必要です。

| メソッド | パス | 用途 |
|---|---|---|
| `GET` | `/v1/health` | Relayの起動確認。ペアリングコードや秘密情報は返しません |
| `POST` | `/v1/pair` | ターミナル表示コードを1回だけ交換し、ブラウザBearerを発行 |
| `DELETE` | `/v1/pair` | 現在のブラウザBearerを失効 |
| `GET` | `/v1/snapshot` | Web版の`DashboardSnapshot`互換レスポンス |
| `GET` | `/v1/providers` | 登録済みProviderと機能一覧 |
| `GET` | `/v1/providers/:id` | Providerの最新状態 |
| `GET` | `/v1/providers/gemini/projects` | Google認証後に参照可能なプロジェクトを一時取得 |
| `POST` | `/v1/providers/:id/connect` | Providerごとの接続を開始 |
| `POST` | `/v1/providers/:id/disconnect` | Providerとの接続を解除 |
| `POST` | `/v1/providers/:id/refresh` | 利用状況を更新 |
| `POST` | `/v1/providers/:id/ingest` | Provider専用のローカル取り込み |
| `GET` | `/v1/history?provider=codex&since=...` | 最大400日前までの1分単位の利用率履歴 |

後方互換として`POST /v1/pairing/claim`、`POST /v1/unpair`、`POST /v1/session/revoke`も利用できます。

接続開始レスポンスは次のいずれかです。

```ts
type ProviderConnectResult =
  | { kind: "connected"; snapshot: ProviderSnapshot }
  | {
      kind: "action-required";
      action:
        | { type: "open-url"; url: string; label?: string }
        | { type: "device-code"; verificationUrl: string; userCode: string }
        | { type: "instructions"; title: string; steps: string[] };
      snapshot?: ProviderSnapshot;
    }
  | { kind: "unsupported"; message: string; url?: string };
```

追加Providerは`relay/core/types.ts`の`ProviderAdapter`を実装し、`ProviderRegistry.register()`へ渡します。

## 保存場所と安全境界

- Windows: `%LOCALAPPDATA%\RunMeter`
- macOS: `~/Library/Application Support/RunMeter`
- Linux: `$XDG_STATE_HOME/runmeter`または`~/.local/state/runmeter`

SQLiteへ保存するのは正規化済みスナップショット、日別集計、1分単位の使用率履歴、BearerのSHA-256検証値だけです。Providerのトークン・APIキー・クライアントシークレットは保存前検査でも拒否します。

資格情報はWindowsではユーザー単位DPAPI、macOSではKeychain、LinuxではSecret Serviceへ保存します。ブラウザ用Bearerの生値はブラウザのIndexedDB、Claude専用Bearerの生値はユーザー専用権限のローカルファイルにだけ置かれます。後者はProvider資格情報ではなく、Claude取り込み以外には使えません。

HTTP側では次を強制します。

- `127.0.0.1:47831`固定バインド
- `Host`を`127.0.0.1:47831`または`localhost:47831`に限定
- 完全一致Origin allowlist
- Private Network Access preflight対応
- 64 KiBのリクエスト上限
- `Cache-Control: no-store`
- 秘密値を含むリクエスト本文をログへ出力しない

## 検証

```powershell
npm --prefix relay run typecheck
npm --prefix relay test
```
