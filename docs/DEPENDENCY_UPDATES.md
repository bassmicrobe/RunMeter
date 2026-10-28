# 依存更新メモ

README から移した、Web UI・Desktop の依存更新記録です。署名済み Windows インストーラーの公開状況は各項目を参照してください。

## 2026-10-16 Web UI dependency update

Next.js and eslint-config-next are pinned to 16.4.2. The npm lockfile is regenerated. The Vercel Web UI is deployed from main after verification; this dependency update does not publish or sign a new Windows installer.

## 2026-10-17 Electron dependency update

Electronを43.7.5から43.8.0へ更新し、`desktop/package-lock.json`のバージョン・配布URL・整合性ハッシュを同期しました。Forgeと同梱Node.jsのバージョンは変更していません。

Linux環境でDesktop単体テスト、Relayテスト、型検査とmain/bridgeのコンパイルを確認しました。Windows実機での起動・インストール・更新・アンインストール、署名とSmartScreen評価は未検証です。署名済みWindowsインストーラーの本番公開は未完了です。Web UIのデプロイだけでは、インストール済みのElectronは更新されません。

Desktopの依存監査には更新前からの開発ツール依存の指摘が残っています（high 8件、moderate 18件）。今回の更新で新しい指摘は増えていません。一般公開前にWindows上で[Desktopの検証・署名手順](../desktop/README.md)を実施し、承認済みの配布先から署名済みSetupを公開してください。

## 2026-10-24 security dependency update

- Desktop Electronを43.8.0から43.8.3へ更新しました。[GHSA-jr5w-w6x2-84p9](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)の侵害されたeMudhra中間証明書対策はChromiumとElectron内Node.jsのTLS双方に含まれます。Electron同梱Nodeの表示が24.22.0でもこのElectron側修正は含まれます。別体のBridge Node.js 24.21.0とForgeは変更しておらず、別のNode/Brotli問題まで解決したという意味ではありません。
- 開発専用shadcn→MCP→Express経由のbody-parserを2.3.0から2.4.0へ、必須依存qsを6.16.0から6.16.1へ更新しました。実行時のLocal RelayはNode標準HTTPを使い、body-parserを使いません。通常のNext.js等の更新は含めません。
- Windows CIは固定lockのインストール、Web/Relay/Desktopの検査、隔離Desktop/Bridge smoke、実ElectronのバージョンとNode/Chromium双方の証明書検証付きHTTPS、未署名パッケージ生成を検証します。CIは署名・配布・artifact保存をしません。
- ソース／検証用ビルドの更新です。署名済みSetupの公開と既存端末への適用は未完了で、自動更新もありません。Windowsで[署名・実機検証](../desktop/README.md)後、適切な配布先でSetupを更新する必要があります。Web UI配備だけではインストール済みElectronは更新されません。

Windows の frozen install 検証で既存の node-fetch の optional peer encoding が lockfile に欠けていたため、encoding 0.1.14 と必要な iconv-lite 0.7.3 の lock エントリだけを補完しています。既存パッケージの追加更新や npm ci の回避は行いません。
