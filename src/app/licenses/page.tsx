import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/runmeter/brand-mark";

export const metadata: Metadata = {
  title: "ライセンス・OSS表記",
  description: "RunMeter本体のMITライセンス、ロゴの権利、および利用するOSSのライセンス表記。",
};

export default function LicensesPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8 text-sm leading-7 sm:py-12">
      <BrandMark className="mb-4" />
      <Link href="/" className="inline-flex min-h-11 items-center text-primary underline underline-offset-4">
        利用状況へ戻る
      </Link>
      <h1 className="mt-6 text-2xl font-semibold">ライセンス・OSS表記</h1>
      <section className="mt-8" aria-labelledby="software">
        <h2 id="software" className="text-lg font-semibold">RunMeter本体：MITライセンス</h2>
        <p className="mt-3 text-muted-foreground">
          Copyright © 2026 サイバーアイ・テクノロジー株式会社
        </p>
        <p className="mt-2 text-muted-foreground">
          本体コードは、著作権表示と許諾文の保持など、MITライセンスの条件に従って利用・改変・再配布できます。ソフトウェアは無保証で提供されます。詳細はライセンス原文をご確認ください。
        </p>
        <a href="/licenses/LICENSE.txt" className="inline-flex min-h-11 items-center text-primary underline underline-offset-4">
          MITライセンス原文を開く
        </a>
      </section>
      <section className="mt-8" aria-labelledby="branding">
        <h2 id="branding" className="text-lg font-semibold">ロゴ・ブランド素材：権利留保</h2>
        <p className="mt-3 text-muted-foreground">
          RunMeterのロゴ、シンボル、ワードマークと派生アイコンはMITライセンスの対象外です。これらの権利はサイバーアイ・テクノロジー株式会社が留保します。
        </p>
        <a href="/licenses/BRANDING_LICENSE.txt" className="inline-flex min-h-11 items-center text-primary underline underline-offset-4">
          ブランド素材の権利表記を開く
        </a>
      </section>
      <section className="mt-8" aria-labelledby="third-party">
        <h2 id="third-party" className="text-lg font-semibold">第三者OSS・フォント</h2>
        <p className="mt-3 text-muted-foreground">
          RunMeterは第三者のオープンソースソフトウェアとGeistフォントを利用しています。各著作権者の権利と、それぞれのライセンス条件は引き続き適用されます。
        </p>
        <a href="/licenses/THIRD_PARTY_NOTICES.txt" className="inline-flex min-h-11 items-center text-primary underline underline-offset-4">
          OSSの一覧・ライセンス原文を開く
        </a>
        <p className="mt-3 text-muted-foreground">
          Windows版・Mac版にもライセンス文書を同梱しています。Electron・Chromium・同梱Node.jsの表記は、Windowsでは配布物内のLICENSE、LICENSES.chromium.html、resources/licenses、MacではRunMeter.app/Contents/Resources内の同名ファイルとlicensesから確認できます。
        </p>
      </section>
    </main>
  );
}
