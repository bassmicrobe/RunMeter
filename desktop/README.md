# RunMeter Desktop for Windows

RunMeterのWeb UIとLocal RelayをElectronにまとめたWindows版です。利用者はNode.jsやnpmをインストールする必要がありません。

## 利用者の流れ

1. `RunMeterSetup.exe`をダブルクリック
2. RunMeterが起動すると表示される6桁コードをコピー
3. CodexまたはClaudeの「接続」を押し、ペアリングコード欄へ入力

画面の表示にはインターネット接続が必要です。接続できない場合は「もう一度読み込む」、または通知領域メニューの「画面を再読み込み」から復帰できます。

Relayは通知領域で動作します。初回はWindowsログイン時の自動起動を有効にし、通知領域メニューから無効化できます。

Claudeを接続すると、既存の`~/.claude/settings.json`を保持したまま、Claude Code公式`statusLine`を使うRunMeterブリッジを追加します。必要なNode.jsランタイムはアプリに同梱するため、利用者による追加インストールは不要です。切断時はRunMeterが設定した内容との一致を確認してから以前の設定へ戻します。

Codex連携には公式Codex CLIまたは対応するCodexデスクトップ環境、Claude連携にはClaude Codeが別途必要です。RunMeterのSetupにはこれらの製品本体は含まれません。

## 更新とアンインストール

この版には自動更新はありません。新しい署名済み`RunMeterSetup.exe`を実行して更新してください。Web UIは起動時に公開中の版を読み込みますが、同梱Relay・Electron・Node.jsはSetupによる更新が必要です。

Windowsの「インストールされているアプリ」からRunMeterを削除できます。アンインストール時にはWindows自動起動を解除し、RunMeterが設定したClaudeのステータスラインを元へ戻します。手動で変更された設定は上書きしません。競合やバックアップ復号の失敗時は設定を保持し、`%LOCALAPPDATA%\RunMeter\desktop-uninstall-warning.json`に記録します。アプリから先にClaudeを切断して復元しておくこともできます。

再インストール時の復旧のため、端末内の利用履歴・接続情報・Claude用ブリッジは自動削除されません。

## 開発・パッケージ作成

リポジトリのルートから実行します。

```powershell
npm run desktop:setup
npm run desktop:start
```

Windows用インストーラーを生成します。

```powershell
npm run desktop:make
```

生成先：`desktop/out/make/squirrel.windows/x64/RunMeterSetup.exe`

検証用コマンド：

```powershell
npm --prefix desktop test
npm --prefix desktop run typecheck
npm --prefix desktop run verify:bridge
npm --prefix desktop run verify:desktop
```

`verify:bridge`はビルド後に実行し、一時ディレクトリだけを使用します。利用中のRelay認証情報やClaude設定にはアクセスしません。ビルドはNode.js 24系を使用します。Electron ForgeのZIP展開には、未修正の`extract-zip`に代えてElectron公式の`@electron-internal/extract-zip@1.0.5`を使用します。

`verify:desktop`はビルド後に実行し、一時データ・一時ブラウザープロファイルで非表示のElectronを起動します。オフライン復帰画面・外部遷移制限・Relay起動・終了待機を確認します。ポート47831を使用中の場合は、既存Relayに触れず検証を中止します。

## 同梱Bridgeランタイムのセキュリティ更新

Claudeステータスライン用Bridgeの同梱Node.jsを24.21.0から24.22.1へ更新しました。[Node.js公式のセキュリティリリース](https://nodejs.org/en/blog/release/v24.22.1/)に含まれるBrotli修正（CVE-2026-111497）を取り込みます。メジャー更新による検証範囲の拡大を避け、既存の24系を維持しています。依存宣言・ロックファイル・ランタイム準備スクリプトの固定バージョンを同期し、24.22.1の公式LICENSEが既存の固定SHA-256と一致することも確認しています。

この更新はBridge専用のNode.jsのみが対象です。Electron内蔵Node.jsは別のランタイムであり、本変更では更新されません。アプリ全体のBrotli対策完了を意味しないため、修正済みElectronの確認・更新とWindows上の検証が別途必要です。既存のインストール済みアプリも変わらないため、全ランタイムの対策と検証後に署名済みSetupを再生成・配布する必要があります。

## コード署名

未署名ビルドは開発・社内検証専用です。一般公開前にWindows Authenticode証明書を用意し、次の環境変数を設定して`npm run desktop:make`を実行します。

```powershell
$env:RUNMETER_WINDOWS_CERTIFICATE_FILE = "C:\path\to\certificate.pfx"
$env:RUNMETER_WINDOWS_CERTIFICATE_PASSWORD = "..."
```

証明書ファイルとパスワードはGitへコミットしません。
