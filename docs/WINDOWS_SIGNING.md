# Windows版の署名と正式版の準備

RunMeterのWindows署名にはAzure Artifact Signing（旧Trusted Signing）を使用します。秘密鍵を端末やGitHubへ配布せず、Azure上の証明書プロファイルで署名します。現時点の公開済みv0.1.0は未署名プレビューです。この設定を追加しても、既存の配布ファイルが署名済みに変わることはありません。

## 日本法人の利用条件

2026年10月26日に確認した[Microsoftの専用Quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)では、日本法人はPublic Trustの対象で、Japan Eastの署名エンドポイントは`https://jpe.codesigning.azure.net`です。日本に居住する個人開発者の申請とは区別してください。[Windows全般の署名比較ページ](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)とは対象国の記載が一致していないため、ここではArtifact Signing専用の案内を参照します。対象国であることと、個別の法人審査が承認されることは別です。

[Microsoft製品FAQ](https://azure.microsoft.com/en-us/products/artifact-signing)のBasicプランは月額US$9.99、月5,000署名まで、超過分は1署名US$0.005です。実際の通貨・税・契約条件はAzureの作成画面で確認してください。RunMeterは署名時に複数の実行ファイルを処理するため、インストーラー1個が必ず1署名になるわけではありません。

## Azureで最初に行う設定

この段階は、法人のAzure管理者・申請担当者が行います。RunMeterの利用者には不要です。

1. Microsoft EntraテナントとAzureサブスクリプションを用意し、`Microsoft.CodeSigning`リソースプロバイダーを登録します。
2. Artifact Signingアカウントを作成します。新規構成はJapan East／Basicを選べます。既存アカウントを使う場合は、その実際のリージョンのエンドポイントを使います。
3. 申請担当者に`Artifact Signing Identity Verifier`と、サブスクリプションに対する`Reader`を割り当てます。アカウント・証明書プロファイル作成には`Contributor`以上、権限を割り当てる担当者にはロール割り当て権限も必要です。
4. Azure PortalでIdentity validations → Organization → New identity → Publicから法人審査を申請します。会社の正式名・登記住所・企業識別番号・会社Webサイト・同じ会社ドメインの異なる2つの受信可能なメールアドレスを用意します。担当者の氏名は本人確認書類と一致させ、案内に従って本人確認を行います。求められた登記・ドメイン所有等の証明書類はAzure側へ提出します。リポジトリには保存しません。
5. 審査が`Completed`になった後、承認された法人を選び、**Public Trust**証明書プロファイルを作成します。公開配布にPrivate TrustやPublic Trust Testは使用しません。Program Typeは通常`None`です。証明書に住所の詳細や郵便番号を追加するオプションは、必要がなければ有効にしません。
6. 証明書プロファイルの正式なSubject（発行者ではなく署名者の識別名）を控えます。`CN=...`から始まる完全な文字列を設定に使います。製品名や推測した法人の英語表記には置き換えません。

審査はAzure Portalで行います。Microsoftの目安は1～20営業日で、追加資料が必要な場合は長くなります。詳細は[Quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)、[ロールの割り当て](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)、[証明書のCN/Oに関するFAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)を参照してください。

## GitHub Actionsで署名ビルドする

Windows署名用ワークフローは手動実行です。対象を`main`に限定し、GitHub Environment `windows-signing`を利用します。成果物はActions artifactとして保存し、GitHub Releasesへの公開は自動実行しません。

### 認証と権限

1. Microsoft EntraにRunMeterビルド用アプリとservice principalを作成します。
2. GitHub Environment `windows-signing`を作り、許可するブランチを`main`に限定し、必要なレビュー担当者を設定します。
3. EntraアプリにGitHub OIDCのfederated credentialを追加します。対象は実際のリポジトリのEnvironment `windows-signing`です。Subjectの形式は`repo:<OWNER>/<REPOSITORY>:environment:windows-signing`、Audienceは`api://AzureADTokenExchange`です。別のリポジトリや任意ブランチに広げません。
4. ビルド用service principalへ、対象証明書プロファイルのスコープで`Artifact Signing Certificate Profile Signer`を割り当てます。署名のためにサブスクリプション全体のOwnerを付与する必要はありません。

ワークフローは`azure/login`のOIDCログイン後、Azure CLIの認証セッションを署名で参照します。長期client secretやPFXは不要です。[Azure LoginのOIDC手順](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect)と[Artifact SigningのOIDC案内](https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md)も参照してください。

### Environment secretsとvariables

GitHubのSettings → Environments → `windows-signing`へ次の値を設定します。実値はソースコードへ埋め込まず、ワークフローのログへ表示しないでください。AzureのIDは秘密鍵ではありませんが、ログをマスクするためEnvironment secretsへ保存します。長期client secretを作成する必要はありません。

| 設定先 | 名前 | 値 |
| --- | --- | --- |
| Environment secrets | `AZURE_CLIENT_ID` | ビルド用EntraアプリのClient ID |
| Environment secrets | `AZURE_TENANT_ID` | Microsoft EntraテナントID |
| Environment secrets | `AZURE_SUBSCRIPTION_ID` | Artifact SigningアカウントのサブスクリプションID |
| Environment variables | `RUNMETER_SIGNING_ENDPOINT` | Japan Eastなら`https://jpe.codesigning.azure.net` |
| Environment variables | `RUNMETER_SIGNING_ACCOUNT` | 作成したArtifact Signingアカウント名 |
| Environment variables | `RUNMETER_SIGNING_PROFILE` | 承認されたPublic Trust証明書プロファイル名 |
| Environment variables | `RUNMETER_SIGNING_PUBLISHER` | 承認された署名証明書の完全なSubject文字列 |

ActionsでWindows署名ビルドのワークフローを選び、`main`で手動実行します。Windows SDKの署名ツールとArtifact Signing DLibは`desktop/scripts/prepare-signing-tools.ps1`でrunnerの一時領域へ取得し、.NET 8もCIで用意します。これらの署名ツールはアプリやSetupに同梱しません。署名設定の不足や、署名処理・署名検証の失敗時はビルドを停止します。

## ローカルのWindowsで署名する

署名担当者のWindowsへ[Microsoft公式の署名ツール](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)を準備します。

- 最新Windows SDKのx64版`signtool.exe`
- .NET 8 Runtimeのx64版
- Artifact Signing Client Toolsに含まれるx64版`Azure.CodeSigning.Dlib.dll`と、その付属ファイル一式
- Azure CLI
- RunMeterのビルド用Node.js 24系と、ロックファイルに一致する依存関係

SignToolとDLibは同じx64構成を使います。DLL単体だけを別の場所へコピーせず、公式配布物の依存ファイルを保持してください。次のパス・アカウント名・Subjectは説明用です。実際の承認済み設定に置き換えて、リポジトリのルートで実行します。

```powershell
az login

$env:RUNMETER_SIGNING_ENDPOINT = "https://jpe.codesigning.azure.net"
$env:RUNMETER_SIGNING_ACCOUNT = "your-signing-account"
$env:RUNMETER_SIGNING_PROFILE = "your-public-trust-profile"
$env:RUNMETER_SIGNING_PUBLISHER = "CN=YOUR APPROVED LEGAL NAME, O=YOUR APPROVED LEGAL NAME, C=JP"
$env:RUNMETER_SIGNTOOL_PATH = "C:\Signing\WindowsSDK\x64\signtool.exe"
$env:RUNMETER_SIGNING_DLIB_PATH = "C:\Signing\ArtifactSigning\x64\Azure.CodeSigning.Dlib.dll"

npm --prefix desktop run signing:check
npm run desktop:make:signed
```

`az login`した本人にも、対象証明書プロファイルの`Artifact Signing Certificate Profile Signer`が必要です。`signing:check`でローカル設定を確認できても、法人審査・Azureの権限・実際の署名成功まで証明したことにはなりません。Desktopフォルダー内では`npm run make:signed`を使えます。

## 正式版として公開する前の確認

署名済みビルドはアプリ本体・Squirrelのインストーラー内実行ファイル・最終`RunMeterSetup.exe`を処理します。既に有効な第三者の署名は保持します。SHA-256とRFC 3161タイムスタンプを使用し、署名を要求したビルドが未署名へ自動的に切り替わることはありません。

最終成果物は`desktop/out/make/squirrel.windows/x64/`です。Squirrelが署名用コピーを使うため、元の`desktop/out/RunMeter-win32-x64/`だけを見て判定しません。`make:signed`は配布するSetupと実際の`.nupkg`の内容で、署名の信頼・署名者Subject・SHA-256・タイムスタンプまで検査します。OSSライセンスの同梱検査も維持します。ビルド後に署名検査だけを再実行する場合は、署名設定を保持したまま次を実行します。

```powershell
npm --prefix desktop run verify:signatures
```

署名ビルド成功後に、別のクリーンなWindows環境で新規インストール・既存版からの更新・起動・連携・アンインストールを確認します。確認した新バージョンのファイルとSHA-256をGitHub Releasesへ公開します。既存の未署名プレビューを同じバージョンのまま差し替えません。

署名は発行元と改変有無を検証する仕組みです。SmartScreenの警告が即座に消える保証にはなりません。[MicrosoftのSmartScreenに関する説明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options#azure-artifact-signing-formerly-trusted-signing--recommended-for-non-store-distribution)を参照してください。
