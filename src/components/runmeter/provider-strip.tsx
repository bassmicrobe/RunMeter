import { Cable, DatabaseZap, PlugZap, RefreshCw } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import type { ProviderConnection } from "@/lib/runmeter-types";
import {
  formatCompactNumber,
  formatRelativeTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";

const ingestionIcon = {
  none: PlugZap,
  event: Cable,
  poll: RefreshCw,
  import: DatabaseZap,
} as const;

export function ProviderStrip({
  providers,
  generatedAt,
}: {
  providers: ProviderConnection[];
  generatedAt: string;
}) {
  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardContent
        className="flex items-center gap-3 overflow-x-auto p-3 sm:gap-4 sm:px-4"
        tabIndex={0}
        role="region"
        aria-label="Connected provider sources"
      >
        <div className="hidden shrink-0 pe-1 sm:block">
          <div className="text-[10px] font-medium text-foreground">Sources</div>
          <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">
            {providers.length} sources
          </div>
        </div>
        <div className="hidden h-8 w-px shrink-0 bg-border sm:block" />
        {providers.map((provider) => {
          const Icon = ingestionIcon[provider.ingestion];
          return (
            <div
              key={provider.id}
              className="flex min-w-[122px] flex-1 items-center gap-2.5 rounded-lg border border-border/80 bg-secondary/35 px-3 py-2"
            >
              <span
                className="relative grid size-7 shrink-0 place-items-center rounded-md bg-background text-muted-foreground"
                role="img"
                aria-label={`${provider.name} status: ${provider.status}`}
              >
                <Icon className="size-3.5" strokeWidth={1.7} aria-hidden="true" />
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute -end-0.5 -top-0.5 size-2 rounded-full border-2 border-card",
                    provider.status === "connected"
                      ? "bg-emerald-400"
                      : provider.status === "degraded"
                        ? "bg-amber-300"
                        : "bg-rose-400",
                  )}
                />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[10px] font-medium text-foreground">
                  {provider.name}
                </div>
                <div className="mt-1 whitespace-nowrap font-mono text-[8px] text-muted-foreground">
                  {provider.lastSyncAt
                    ? `${formatCompactNumber(provider.totalTokensToday)} tok ・ ${formatRelativeTime(provider.lastSyncAt, generatedAt)}`
                    : "未同期"}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
