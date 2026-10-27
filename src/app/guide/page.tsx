import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/runmeter/brand-mark";
import {
  GuideNote,
  GuideQuestion,
  GuideSection,
  type GuideSectionMeta,
  GuideStep,
  GuideSteps,
  GuideToc,
  PlatformPanel,
  UiLabel,
} from "@/components/runmeter/guide-parts";

export const metadata: Metadata = {
  title: "使い方マニュアル",
  description:
    "RunMeterのWindows版・Mac版のインストール、ペアリング、CodexとClaudeの接続、画面の見方、困ったときの対処。",
};

const SECTIONS = [
  { id: "overview", number: "01", title: "RunMeterでできること" },
  { id: "install", number: "02", title: "インストール" },
  { id: "pairing", number: "03", title: "この画面とつなぐ" },
  { id: "codex", number: "04", title: "Codexを接続する" },
  { id: "claude", number: "05", title: "Claudeを接続する" },
  { id: "reading", number: "06", title: "画面の見方" },
  { id: "resident", number: "07", title: "常駐と自動起動" },
  { id: "troubleshooting", number: "08", title: "困ったとき" },
  { id: "uninstall", number: "09", title: "接続の解除・削除" },
  { id: "privacy", number: "10", title: "データの保存先" },
] as const satisfies readonly GuideSectionMeta[];

const section = (id: (typeof SECTIONS)[number]["id"]) =>
  SECTIONS.find((item) => item.id === id) as GuideSectionMeta;

const linkClass =
  "text-primary underline underline-offset-4 hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function GuidePage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 text-sm leading-7 sm:px-6 sm:py-12">
      <header className="max-w-3xl">
        <BrandMark className="mb-4" />
        <Link href="/" className={`inline-flex min-h-11 items-center ${linkClass}`}>
          利用状況へ戻る
        </Link>
        <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          User manual · Windows / Mac
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">使い方マニュアル</h1>
        <p className="mt-4 max-w-prose text-[15px] leading-8 text-muted-foreground">
          RunMeterは、このPCのCodexとClaude Codeから利用率と次のリセット日時を取得し、ブラウザの画面にまとめて表示します。
          インストールから接続まで、Node.jsやコマンドの入力は必要ありません。
        </p>
      </header>

      <div className="mt-10 grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14">
        <GuideToc sections={SECTIONS} />

        <div className="min-w-0 max-w-3xl space-y-12">
          <GuideSection
            section={section("overview")}
            lead="AIサービスの利用枠を「あとどれだけ使えるか」「いつ戻るか」の2点で確認するためのメーターです。"
          >
            <ul className="grid gap-3 sm:grid-cols-2">
              {[
                ["利用率と残り", "サービスごとの使用率と残り割合を最上段に表示します。"],
                ["リセット日時", "5時間・週次など、各サービスが返す利用枠ごとに次のリセットを表示します。"],
                ["トークン履歴", "日別のトークン数をグラフと「サービス × 日付」の表で、直近90日分まで表示します。"],
                ["端末内で完結", "認証情報と利用履歴はこのPCだけに保存し、RunMeterのサーバーへ送りません。"],
              ].map(([title, body]) => (
                <li key={title} className="rounded-lg border border-border bg-card p-4">
                  <p className="font-medium text-foreground">{title}</p>
                  <p className="mt-1 text-muted-foreground">{body}</p>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              Codex連携には公式のCodex CLIまたはCodexデスクトップアプリ、Claude連携にはClaude Codeが別途必要です。
              RunMeterにはこれらの製品本体は含まれません。
            </p>
          </GuideSection>

          <GuideSection
            section={section("install")}
            lead="お使いのPCに合わせて手順を選んでください。どちらも画面の表示にはインターネット接続が必要です。"
          >
            <div className="grid gap-4 xl:grid-cols-2">
              <PlatformPanel platform="Windows" requirement="Windows 10 / 11 · x64">
                <GuideSteps>
                  <GuideStep title="RunMeterSetup.exeを実行します">
                    <a href="https://github.com/bassmicrobe/RunMeter/releases/tag/v0.1.0" className={linkClass}>
                      GitHubのリリースページ
                    </a>
                    から取得できます。プレビュー版は未署名のため、発行元を確認できない旨の警告が出る場合があります。
                  </GuideStep>
                  <GuideStep title="RunMeterが自動で起動します">
                    次回からはスタートメニューの「RunMeter」から開けます。
                  </GuideStep>
                </GuideSteps>
              </PlatformPanel>
              <PlatformPanel platform="Mac" requirement="macOS · Apple Silicon">
                <GuideSteps>
                  <GuideStep title="ZIPを開き、RunMeterを「アプリケーション」へ移動します">
                    ほかの場所で起動すると移動を確認する画面が出ます。<UiLabel>移動する</UiLabel>を選ぶと、移動後に再起動します。
                  </GuideStep>
                  <GuideStep title="初回だけ、開く操作を許可します">
                    プレビュー版はApple公証前のため「開発元を確認できない」と表示されます。
                    <UiLabel>システム設定</UiLabel>→<UiLabel>プライバシーとセキュリティ</UiLabel>で
                    <UiLabel>このまま開く</UiLabel>を押してください。
                  </GuideStep>
                </GuideSteps>
              </PlatformPanel>
            </div>
            <GuideNote title="Mac版の配布について">
              Mac版は現在プレビューの準備中です。配布開始まではリポジトリから開発者がビルドしたものを使用してください。
            </GuideNote>
          </GuideSection>

          <GuideSection
            section={section("pairing")}
            lead="ブラウザの画面と、このPCで動くRunMeterを6桁のコードで結びます。最初の1回だけ必要です。"
          >
            <GuideSteps>
              <GuideStep title="RunMeterに表示される6桁のペアリングコードを確認します">
                初回起動時に自動で表示されます。<UiLabel>コードをコピー</UiLabel>でコピーできます。
              </GuideStep>
              <GuideStep title="利用状況画面で、CodexまたはClaudeの「接続」を押します" />
              <GuideStep title="ペアリングコード欄に入力し、「この端末とペアリング」を押します">
                コードは5分間・1回だけ有効です。期限が切れたら、常駐アイコンのメニューから
                <UiLabel>ペアリングコードを表示</UiLabel>を選んで新しいコードを使ってください。
              </GuideStep>
            </GuideSteps>
            <p className="text-muted-foreground">
              一度ペアリングしたブラウザは、次回以降も同じ接続を使います。ほかのブラウザで開くときは、もう一度ペアリングしてください。
            </p>
          </GuideSection>

          <GuideSection section={section("codex")} lead="ChatGPTアカウントの公式ログイン画面で認証します。パスワードをRunMeterに入力することはありません。">
            <GuideSteps>
              <GuideStep title="Codexの「接続」を開き、「Codexへログイン」を押します" />
              <GuideStep title="表示された公式ログインURLを開いて認証します">
                ログインが済むと、利用率とリセット日時が自動で表示されます。
              </GuideStep>
            </GuideSteps>
            <p className="text-muted-foreground">
              トークン履歴は、お使いのCodex CLIが利用量の取得に対応している場合に表示されます。
            </p>
          </GuideSection>

          <GuideSection section={section("claude")} lead="Claude Codeの公式ステータスライン機能を使って、5時間・7日の利用枠を読み取ります。">
            <GuideSteps>
              <GuideStep title="Claude CodeをこのPCにインストールし、ログインしておきます" />
              <GuideStep title="Claudeの「接続」を開き、「Claude Codeを検出」を押します">
                既存の<code className="font-mono text-[0.92em] text-foreground">~/.claude/settings.json</code>
                の内容を保ったまま、RunMeter用のステータスラインを追加します。
              </GuideStep>
              <GuideStep title="Claude Codeで1回メッセージを送ります">
                送信後、通常5〜30秒で画面に反映されます。
              </GuideStep>
            </GuideSteps>
            <GuideNote title="以前のステータスラインは保持されます">
              すでに独自のステータスラインを設定している場合も、その表示はそのまま続きます。接続を解除すると、RunMeterが追加した内容だけを元へ戻します。
            </GuideNote>
          </GuideSection>

          <GuideSection section={section("reading")} lead="画面は15秒ごとに自動で更新されます。タブを表示していない間は取得を止め、戻ったときにすぐ更新します。">
            <dl className="divide-y divide-border rounded-lg border border-border bg-card">
              {[
                ["利用率とリセット", "サービスごとの使用率、残り割合、利用枠の種類（5時間・週次など）と次のリセット日時です。"],
                ["トークンの推移", "日別トークン数のグラフです。表示期間を切り替えられます。"],
                ["利用履歴", "「サービス × 日付」の表で日ごとの使用量を確認できます。横にスクロールできます。"],
                ["公式画面", "各サービスの公式の利用状況ページへのリンクです。料金や最終的な上限は公式画面を正としてください。"],
              ].map(([term, description]) => (
                <div key={term} className="grid gap-1 p-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
                  <dt className="font-medium text-foreground">{term}</dt>
                  <dd className="text-muted-foreground">{description}</dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground">
              取得が遅れている場合や認証が切れた場合は、該当するサービスの行に理由を表示します。
            </p>
          </GuideSection>

          <GuideSection
            section={section("resident")}
            lead="ウィンドウを閉じてもRunMeterは動き続け、利用状況を取得します。Windowsでは通知領域、Macではメニューバーにアイコンが表示されます。"
          >
            <dl className="divide-y divide-border rounded-lg border border-border bg-card">
              {[
                ["RunMeterを開く", "閉じたウィンドウをもう一度表示します。"],
                ["画面を再読み込み", "通信が切れたあとなど、画面を読み込み直します。"],
                ["ペアリングコードを表示", "新しいブラウザとつなぐときに使います。"],
                ["ログイン時に起動", "PCへのログイン時に自動で起動します（Windowsでは「Windowsログイン時に起動」）。初回は有効になっており、ここで切り替えられます。"],
                ["終了", "RunMeterを完全に終了します。終了中は利用状況を取得しません。"],
              ].map(([term, description]) => (
                <div key={term} className="grid gap-1 p-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                  <dt>
                    <UiLabel>{term}</UiLabel>
                  </dt>
                  <dd className="text-muted-foreground">{description}</dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground">
              Macでは、ウィンドウを閉じるとDockのアイコンも消え、メニューバーだけに残ります。
            </p>
          </GuideSection>

          <GuideSection section={section("troubleshooting")}>
            <div className="space-y-3">
              <GuideQuestion question="「このPCでRunMeterが起動していません」と表示される">
                <p>
                  RunMeterが起動しているか確認してください。Windowsはスタートメニュー、Macは「アプリケーション」フォルダーから開き、接続画面の
                  <UiLabel>再確認</UiLabel>を押します。
                </p>
                <p>RunMeterと同じPCのブラウザで開いているかも確認してください。別のPCやスマートフォンからはつながりません。</p>
              </GuideQuestion>
              <GuideQuestion question="ペアリングコードが通らない">
                <p>コードは5分で失効し、1回しか使えません。常駐アイコンのメニューから新しいコードを表示して入力してください。</p>
              </GuideQuestion>
              <GuideQuestion question="Codexに接続できない">
                <p>
                  Codex CLIまたはCodexデスクトップアプリがこのPCにインストールされているか確認してください。Mac版は、ターミナルで使える
                  <code className="font-mono text-[0.92em] text-foreground">codex</code>
                  と、「アプリケーション」フォルダーのCodexアプリを自動で探します。
                </p>
                <p>インストール直後の場合は、RunMeterを終了してから起動し直してください。</p>
              </GuideQuestion>
              <GuideQuestion question="Claudeの値が表示されない">
                <p>
                  <UiLabel>Claude Codeを検出</UiLabel>のあと、Claude Codeで1回以上メッセージを送ってください。値はClaude Codeのステータスラインが更新されたときに届きます。
                </p>
              </GuideQuestion>
              <GuideQuestion question="「画面に接続できませんでした」と表示される">
                <p>
                  インターネット接続を確認して<UiLabel>もう一度読み込む</UiLabel>を押してください。保存済みの接続情報や利用履歴は消えません。
                </p>
              </GuideQuestion>
              <GuideQuestion question="Macで「開発元を確認できない」「開けません」と表示される">
                <p>
                  <UiLabel>システム設定</UiLabel>→<UiLabel>プライバシーとセキュリティ</UiLabel>を開き、RunMeterの
                  <UiLabel>このまま開く</UiLabel>を押してください。Apple公証前のプレビュー版で必要な操作です。
                </p>
              </GuideQuestion>
              <GuideQuestion question="接続ポートを別のアプリが使用していると表示される">
                <p>
                  RunMeterは<code className="font-mono text-[0.92em] text-foreground">127.0.0.1:47831</code>
                  を使います。開発用のRelayなど、同じポートを使うアプリを終了してから起動してください。
                </p>
              </GuideQuestion>
            </div>
          </GuideSection>

          <GuideSection section={section("uninstall")}>
            <p className="text-muted-foreground">
              各サービスの接続画面の<UiLabel>接続を解除</UiLabel>で、そのサービスだけを切り離せます。
              <UiLabel>Relayとの連携を解除</UiLabel>は、このブラウザとRunMeterのペアリングを取り消します。
            </p>
            <div className="grid gap-4 xl:grid-cols-2">
              <PlatformPanel platform="Windows" requirement="設定 › アプリ">
                <p className="text-muted-foreground">
                  「インストールされているアプリ」からRunMeterを削除します。自動起動の解除と、RunMeterが追加したClaudeのステータスラインの復元は自動で行います。
                </p>
              </PlatformPanel>
              <PlatformPanel platform="Mac" requirement="アプリケーション › ゴミ箱">
                <p className="text-muted-foreground">
                  先にClaudeの<UiLabel>接続を解除</UiLabel>を行い、ステータスラインを元へ戻してから、RunMeterをゴミ箱へ移動してください。Mac版には削除時の自動処理がありません。
                </p>
              </PlatformPanel>
            </div>
            <p className="text-muted-foreground">
              再インストール時に復旧できるよう、利用履歴と接続情報は削除後も残ります。不要な場合は次の保存先を削除してください。
            </p>
          </GuideSection>

          <GuideSection
            section={section("privacy")}
            lead="AIサービスの認証情報、利用履歴は、RunMeterの運営サーバー・開発元・Vercelへ送信・保存しません。"
          >
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[32rem] text-left">
                <caption className="sr-only">OSごとの保存先</caption>
                <thead className="bg-muted/50 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">項目</th>
                    <th scope="col" className="px-4 py-2 font-medium">Windows</th>
                    <th scope="col" className="px-4 py-2 font-medium">Mac</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border bg-card">
                  <tr>
                    <th scope="row" className="px-4 py-3 font-medium">利用履歴・設定</th>
                    <td className="px-4 py-3 font-mono text-xs">%LOCALAPPDATA%\RunMeter</td>
                    <td className="px-4 py-3 font-mono text-xs">~/Library/Application Support/RunMeter</td>
                  </tr>
                  <tr>
                    <th scope="row" className="px-4 py-3 font-medium">Claudeの以前の設定（退避分）</th>
                    <td className="px-4 py-3">DPAPI（現在のユーザー）</td>
                    <td className="px-4 py-3">キーチェーン</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-muted-foreground">
              ブラウザに保存するのは、取り消し可能なRunMeter用のトークンだけです。利用履歴はPC単位で保存し、アカウントを切り替えても同じ履歴にまとまります。
              詳しくは<Link href="/licenses" className={linkClass}>ライセンス・OSS表記</Link>と
              <a href="https://github.com/bassmicrobe/RunMeter" className={linkClass}>ソースコード</a>
              も参照してください。
            </p>
          </GuideSection>
        </div>
      </div>
    </main>
  );
}
