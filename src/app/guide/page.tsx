import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Windows版の使い方",
  description: "RunMeterのインストール、ペアリング、CodexとClaudeの接続手順。",
};

export default function GuidePage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8 text-sm leading-7 sm:py-12">
      <Link href="/" className="inline-flex min-h-11 items-center text-primary underline underline-offset-4">
        利用状況へ戻る
      </Link>
      <h1 className="mt-6 text-2xl font-semibold">Windows版の使い方</h1>
      <p className="mt-3 text-muted-foreground">
        RunMeterは、このPCのCodexとClaude Codeから利用率とリセット日時を取得します。
        Node.jsやnpmのインストール、コマンドの入力は不要です。
      </p>
      <section className="mt-8" aria-labelledby="installation">
        <h2 id="installation" className="text-lg font-semibold">インストールと接続</h2>
        <ol className="mt-3 list-decimal space-y-3 ps-5">
          <li>配布元から受け取ったRunMeterSetup.exeを実行します。</li>
          <li>WindowsのスタートメニューからRunMeterを起動し、表示される6桁のペアリングコードを確認します。</li>
          <li>利用状況画面のCodexまたはClaudeの「接続」を押して、コードを入力します。</li>
          <li>Codexは公式ログイン画面で認証します。Claudeは「Claude Codeを検出」を押し、Claude Codeでメッセージを送ると反映されます。</li>
        </ol>
        <p className="mt-4 text-muted-foreground">
          Codex CLIまたは対応するCodexデスクトップ環境と、Claude Codeは別途必要です。
          設定済みの同じブラウザでは、保存されたペアリングを次回も利用します。
        </p>
      </section>
      <section className="mt-8" aria-labelledby="troubleshooting">
        <h2 id="troubleshooting" className="text-lg font-semibold">接続できないとき</h2>
        <p className="mt-3 text-muted-foreground">
          通知領域にRunMeterがあるか確認してください。起動していなければスタートメニューから開き、接続画面の「再確認」を押します。
          ペアリングの期限が切れた場合は、通知領域メニューから新しいコードを表示して入力してください。
        </p>
      </section>
      <section className="mt-8 rounded-lg border border-border bg-card p-4" aria-labelledby="privacy">
        <h2 id="privacy" className="font-semibold">利用データはこの端末に保存します</h2>
        <p className="mt-2 text-muted-foreground">
          利用データやAIサービスの認証情報をRunMeterのWebサーバーへ送信・保存しません。
          公式サービスへの認証・取得通信は、このPCから行います。
        </p>
        <p className="mt-3 text-muted-foreground">
          スマートフォンの画面サイズにも対応していますが、標準のローカル連携はWindows PC上で使用します。
          スマートフォンから別のPCの利用データを取得する機能はありません。
        </p>
      </section>
    </main>
  );
}
