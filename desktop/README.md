# RunMeter Desktop for Windows / macOS

RunMeterのWeb UIとLocal RelayをElectronにまとめたWindows版・Mac版です。利用者はNode.jsやnpmをインストールする必要がありません。利用者向けの手順は[使い方マニュアル](https://run-meter.vercel.app/guide)にあります。

[Windows x64版のダウンロード](https://github.com/bassmicrobe/RunMeter/releases/tag/v0.1.0)。v0.1.0は未署名プレビューです。配布ファイルと検証範囲は[リリース案内](../docs/releases/v0.1.0.md)を参照してください。

## 利用者の流れ

1. `RunMeterSetup.exe`をダブルクリック
2. RunMeterが起動すると表示される6桁コードをコピー
3. CodexまたはClaudeの「接続」を押し、ペアリングコード欄へ入力

画面の表示にはインターネット接続が必要です。接続できない場合は「もう一度読み込む」、または通知領域メニューの「画面を再読み込み」から復帰できます。

Relayは通知領域で動作します。初回はWindowsログイン時の自動起動を有効にし、通知領域メニューから無効化できます。

Claudeを接続すると、既存の`~/.claude/settings.json`を保持したまま、Claude Code公式`statusLine`を使うRunMeterブリッジを追加します。必要なNode.jsランタイムはアプリに同梱するため、利用者による追加インストールは不要です。切断時はRunMeterが設定した内容との一致を確認してから以前の設定へ戻します。

Codex連携には公式Codex CLIまたは対応するCodexデスクトップ環境、Claude連携にはClaude Codeが別途必要です。RunMeterのSetupにはこれらの製品本体は含まれません。

## Mac版の仕様

- 対象：Apple Silicon（arm64）。ForgeとBridge用Node.jsはビルドしたMacのアーキテクチャに合わせるため、Intel Mac用はIntel Macでビルドします（未検証）。
- 配布形式：`@electron-forge/maker-zip`で`RunMeter.app`だけを入れたZIP。DMGは作りません。
- Bundle ID：`jp.cybereye-tech.runmeter`。カテゴリは開発ツールです。
- 署名：Developer ID署名とAppleの公証は未設定です。名前変更とInfo.plistの書き換えでElectronのアドホック署名が無効になるため、`postPackage`でバンドル全体をアドホック署名し直し、`codesign --verify --deep --strict`で確認します。同梱Bridge用`node`はNode.js公式の署名をそのまま保ちます。正式配布にはDeveloper ID Application証明書での署名・公証・staplingが必要です。
- 常駐：メニューバーにテンプレート画像のアイコンを表示します。ウィンドウを閉じるとDockからも隠し、メニューバーの「RunMeterを開く」かDockのアイコンで再表示します。
- 自動起動：Windows版と同じく初回に有効にし、メニューバーの「ログイン時に起動」で切り替えます。macOSは起動引数を渡せないため、`app.getLoginItemSettings().wasOpenedAtLogin`でログイン時の起動を判定し、ウィンドウを出さずに常駐します。
- 配置：「アプリケーション」フォルダー以外から起動すると移動を確認します（App Translocationで一時的な場所から起動されると、ログイン項目が壊れるため）。
- PATH：Finderやログイン項目から起動したアプリはシステムの最小PATHで動くため、パッケージ版は起動時にログインシェル（`$SHELL -ilc`、5秒で打ち切り）のPATHを読み取ります。そのあとに`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.npm-global/bin`、`~/.volta/bin`、`/Applications/Codex.app/Contents/Resources`を加えてCodexを探します。
- 保存先：Relayのデータと、Electronのブラウザープロファイルはどちらも`~/Library/Application Support/RunMeter`に置きます。ファイル名は重なりません。
- アンインストール：Mac版には削除時の処理がありません。削除前にアプリからClaudeの接続を解除してください。解除せずに削除しても、Bridgeはデータフォルダー側にあるためClaude Codeのステータスラインは動き続けます。
- CI：`security-dependencies.yml`の`macos-desktop`ジョブ（macos-latest、arm64）が、Desktopの単体テスト・型検査・Bridge検証・隔離smoke・Electronの版とTLS・未署名ZIPの生成・Bundle ID・アドホック署名の封印を確認します。配布やartifact保存はしません。

## 更新とアンインストール

この版には自動更新はありません。新しい版の`RunMeterSetup.exe`を実行して更新してください。プレビューの署名状態はリリースページで確認できます。Web UIは起動時に公開中の版を読み込みますが、同梱Relay・Electron・Node.jsはSetupによる更新が必要です。

Windowsの「インストールされているアプリ」からRunMeterを削除できます。アンインストール時にはWindows自動起動を解除し、RunMeterが設定したClaudeのステータスラインを元へ戻します。手動で変更された設定は上書きしません。競合やバックアップ復号の失敗時は設定を保持し、`%LOCALAPPDATA%\RunMeter\desktop-uninstall-warning.json`に記録します。アプリから先にClaudeを切断して復元しておくこともできます。

再インストール時の復旧のため、端末内の利用履歴・接続情報・Claude用ブリッジは自動削除されません。

## 開発・パッケージ作成

リポジトリのルートから実行します。

```powershell
npm run desktop:setup
npm run desktop:start
```

Windows用インストーラーを生成します（Windows上で実行）。

```powershell
npm run desktop:make
```

生成先：`desktop/out/make/squirrel.windows/x64/RunMeterSetup.exe`

Mac用ZIPを生成します（Mac上で実行）。`desktop:package:mac`はZIPを作らずアプリだけを生成します。

```bash
npm run desktop:make:mac
```

生成先：`desktop/out/make/zip/darwin/arm64/RunMeter-darwin-arm64-<版>.zip`（アプリ本体は`desktop/out/RunMeter-darwin-arm64/RunMeter.app`）

Bridge用Node.jsは、Windowsでは`node-win-x64`パッケージから、Macではnodejs.orgの公式`node-v<版>-darwin-<arch>.tar.gz`から取り出します。`node-darwin-arm64`パッケージは24系が公開されていないためです。アーカイブは`scripts/prepare-bridge-runtime.mjs`に固定したSHA-256（公式`SHASUMS256.txt`の値）と一致した場合だけ展開し、`node_modules/.cache/runmeter-node/`に保存します。`node-win-x64`はMacで`npm ci`できるように`optionalDependencies`に置き、`app.asar`には入れません。

検証用コマンド：

```powershell
npm --prefix desktop test
npm --prefix desktop run typecheck
npm --prefix desktop run verify:bridge
npm --prefix desktop run verify:desktop
npm --prefix desktop run verify:licenses
npm --prefix desktop run verify:installer-licenses
```

`verify:installer-licenses`と署名関連のコマンドはWindows専用です。Macでは`verify:licenses`が`RunMeter.app/Contents/Resources`を検査します。

`verify:bridge`はビルド後に実行し、一時ディレクトリだけを使用します。利用中のRelay認証情報やClaude設定にはアクセスしません。ビルドはNode.js 24系を使用します。Electron ForgeのZIP展開には、未修正の`extract-zip`に代えてElectron公式の`@electron-internal/extract-zip@1.0.5`を使用します。

`verify:desktop`はビルド後に実行し、一時データ・一時ブラウザープロファイルで非表示のElectronを起動します。オフライン復帰画面・外部遷移制限・Relay起動・終了待機を確認します。ポート47831を使用中の場合は、既存Relayに触れず検証を中止します。

## ライセンス文書の同梱

RunMeter本体のコードはMITライセンス、ロゴ・ブランド素材は別の権利表記です。詳細はリポジトリの`LICENSE`と`BRANDING_LICENSE.md`を参照してください。

ビルドではnccのライセンス出力を有効にし、Desktopにバンドルする`electron-squirrel-startup`・`debug`・`ms`の原文LICENSEと、存在する場合のNOTICEを保持します。配布物の`resources/licenses/`には、本体・ブランド素材・Web依存の文書、Desktop依存の原文、同梱Node.jsのライセンスをまとめます。アプリ最上位にあるElectronの`LICENSE`と`LICENSES.chromium.html`、`resources/bridge/NODE-LICENSE.txt`も保持します。Squirrelの既定設定では最上位のHTMLが収録されないため、`LICENSES.chromium.html`を追加ファイルとして明示し、Setupの配布内容にも含めます。

`package`では`verify:licenses`を、`make`では加えて`verify:installer-licenses`を自動実行します。前者はアプリの配布フォルダーと`app.asar`、後者は実際のSquirrel `.nupkg`に入った全ライセンス文書を調べ、原文とのSHA-256一致を確認します。検証だけを再実行する場合は上記コマンドを使用してください。不足する必須文書や変更された原文を検出すると検証は失敗します。依存を更新した場合は、先にルートのOSS表記生成手順を実行してから再ビルドします。

Mac版では、Electronが`RunMeter.app`の外に置く`LICENSE`と`LICENSES.chromium.html`を、Forgeの`packageAfterExtract`で`Contents/Resources/`へコピーします。ZIPにはアプリだけが入るためです。Squirrel.Windowsの文書はWindows版にだけ同梱します。

Squirrel.Windows本体・Setup・実行スタブと、その中に組み込まれたコードの原文は`licenses/native-installer/`で固定し、配布時は`resources/licenses/native-installer/`へコピーします。`sources.json`には、公式vendorバイナリと一致を確認したSHA-256、対応ソースrevision、各原文の出典・ハッシュ・ソース入手先を記録しています。WTLなどの条件は対象コンポーネントに適用され、RunMeter本体のMIT表記は変わりません。同梱バイナリや原文が固定値から変わるとビルドは失敗するため、Desktop依存更新時にはこの表記も再確認してください。

Updater内の`Microsoft.Web.Xdt 2.1.1`には当時のMicrosoft専用EULAが適用されます。Windows上での使用・再配布条件と、配布者・利用者に求められる保護条項は、`native-installer/managed/`に保存した専用EULA原文を参照してください。

## 同梱Bridgeランタイムのセキュリティ更新

Claudeステータスライン用Bridgeの同梱Node.jsを24.21.0から24.22.1へ更新しました。[Node.js公式のセキュリティリリース](https://nodejs.org/en/blog/release/v24.22.1/)に含まれるBrotli修正（CVE-2026-111497）を取り込みます。メジャー更新による検証範囲の拡大を避け、既存の24系を維持しています。依存宣言・ロックファイル・ランタイム準備スクリプトの固定バージョンを同期し、24.22.1の公式LICENSEが既存の固定SHA-256と一致することも確認しています。

この更新はBridge専用のNode.jsのみが対象です。Electron内蔵Node.jsは別のランタイムであり、本変更では更新されません。アプリ全体のBrotli対策完了を意味しないため、修正済みElectronの確認・更新とWindows上の検証が別途必要です。既存のインストール済みアプリも変わらないため、全ランタイムの対策と検証後に署名済みSetupを再生成・配布する必要があります。

## コード署名

Windows正式版の署名にはAzure Artifact SigningのPublic Trustを使用します。日本法人の審査・GitHub ActionsのOIDC設定・ローカルツールの準備は[Windows署名手順](../docs/WINDOWS_SIGNING.md)を参照してください。PFXや長期client secretは不要です。

承認済みの署名設定とAzureへのログインを用意して、リポジトリのルートから実行します。

```powershell
npm --prefix desktop run signing:check
npm run desktop:make:signed
```

署名を要求したビルドは設定不足や署名失敗時に停止します。GitHub Actionsの手動署名ビルドは成果物の保存までを行い、GitHub Releasesへは自動公開しません。正式版の公開前には最終Setup・実際のインストーラー内容の署名検査と、クリーンなWindowsでのインストール・更新・アンインストール確認を行います。

未署名ビルドの`npm run desktop:make`も開発用に利用できます。配布する場合はGitHub Releasesのprereleaseとして、未署名であることと検証範囲を明記します。
