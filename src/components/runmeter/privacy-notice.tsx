import { LockKeyhole } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { SITE_CONFIG } from "@/lib/site-config";

export function PrivacyNotice() {
  return (
    <Card
      id="connection-status"
      role="note"
      className="scroll-mt-20 gap-0 border-border bg-card py-0 shadow-none"
    >
      <CardContent className="flex items-start gap-3 p-4 sm:items-center">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-secondary text-primary">
          <LockKeyhole className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            RunMeterのサーバーには利用データを送りません
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            Codexの認証情報は公式CodexアプリがこのPCで管理します。Claudeはログイン済みのClaude Codeから利用状況を受け取り、ブラウザとのペアリング情報もこの端末内に保存します。
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            認証情報と利用履歴はRunMeter運営サーバー、{SITE_CONFIG.developer.name}
            、Vercelには送信・保存しません。ページ配信に伴う通常のアクセスログはVercelで処理される場合があります。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
