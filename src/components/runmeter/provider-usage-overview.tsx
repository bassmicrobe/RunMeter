"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useLocalTimeZone } from "@/hooks/use-local-time-zone";
import { formatResetDate, formatTimeUntil } from "@/lib/format";
import { PROVIDER_CONSOLE_LINKS } from "@/lib/provider-console-links";
import type {
  ProviderConnection,
  ProviderId,
  ProviderUsageWindow,
} from "@/lib/runmeter-types";
import { cn } from "@/lib/utils";

import { ProviderConnectionControl } from "./provider-connection-trigger";
import { SectionHeading } from "./section-heading";

const statusLabels = {
  connected: "接続済み",
  degraded: "取得遅延",
  disconnected: "未接続",
} as const;

const connectionGuides = {
  codex: "Codexの公式ログインで接続",
  claude: "Claude Codeと連携",
  gemini: "Google OAuthでGemini APIを接続",
} satisfies Record<ProviderId, string>;

function availableWindows(provider: ProviderConnection) {
  return provider.usageWindows;
}

function primaryWindow(provider: ProviderConnection) {
  const windows = availableWindows(provider);
  return (
    windows.find((window) => window.id === provider.primaryUsageWindowId) ??
    windows[0]
  );
}

function usageTone(percent: number) {
  if (percent >= 90) return "bg-rose-300";
  if (percent >= 75) return "bg-amber-300";
  return "bg-primary";
}

function sourceLabel(window: ProviderUsageWindow) {
  if (window.estimated) return "参考値";
  if (window.source === "local") return "端末内で集計";
  return "取得値";
}

function ResetTime({
  resetsAt,
  generatedAt,
  isDisconnected,
}: {
  resetsAt: string | null;
  generatedAt: string;
  isDisconnected: boolean;
}) {
  const timeZone = useLocalTimeZone();

  if (!resetsAt) {
    return (
      <div className="col-span-2 min-w-0 xl:col-span-1">
        <div className="text-xs text-muted-foreground">次のリセット</div>
        <div className="mt-1 text-sm font-medium text-foreground">—</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {isDisconnected ? "接続後に表示" : "リセット時刻は取得できません"}
        </div>
      </div>
    );
  }

  return (
    <div className="col-span-2 min-w-0 xl:col-span-1">
      <div className="text-xs text-muted-foreground">次のリセット</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums text-foreground">
        {formatResetDate(resetsAt, timeZone)}
        <span className="ms-1 text-xs font-normal text-muted-foreground">
          にリセット
        </span>
      </div>
      <div className="mt-1 text-xs tabular-nums text-muted-foreground">
        {formatTimeUntil(resetsAt, generatedAt)}
      </div>
    </div>
  );
}

function SecondaryUsageWindow({
  window,
  generatedAt,
}: {
  window: ProviderUsageWindow;
  generatedAt: string;
}) {
  const timeZone = useLocalTimeZone();

  return (
    <div className="rounded-md border border-border bg-secondary/35 px-3 py-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 text-muted-foreground">{window.label}</span>
        <span className="shrink-0 font-semibold tabular-nums text-foreground">
          {window.usedPercent === null
            ? "取得できません"
            : `${window.usedPercent.toFixed(0)}%`}
        </span>
      </div>
      <div className="mt-1 text-[11px] leading-4 tabular-nums text-muted-foreground">
        {window.resetsAt
          ? `${formatResetDate(window.resetsAt, timeZone)}にリセット・${formatTimeUntil(
              window.resetsAt,
              generatedAt,
            )}`
          : "リセット時刻は取得できません"}
      </div>
    </div>
  );
}

export function ProviderUsageOverview({
  providers,
  generatedAt,
  isStale = false,
}: {
  providers: ProviderConnection[];
  generatedAt: string;
  isStale?: boolean;
}) {
  const [clock, setClock] = useState(generatedAt);
  const timeZone = useLocalTimeZone();
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString());
    let interval: number | null = null;
    const syncVisibility = () => {
      if (interval !== null) window.clearInterval(interval);
      interval = null;
      if (document.visibilityState === "hidden") return;
      tick();
      interval = window.setInterval(tick, 30_000);
    };
    const initialTick = window.setTimeout(syncVisibility, 0);
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      window.clearTimeout(initialTick);
      if (interval !== null) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);

  const connectedCount = providers.filter(
    (provider) => provider.status !== "disconnected",
  ).length;

  return (
    <Card id="usage" className="scroll-mt-20 gap-0 overflow-hidden py-0 shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-5">
        <SectionHeading
          title="利用率とリセット"
          description="各サービスを個別に接続すると、使用率と次のリセット日時を表示します"
        />
        <Badge
          variant="outline"
          className="shrink-0 rounded-md border-border bg-secondary px-2 py-1 text-[11px] font-normal text-muted-foreground"
        >
          {connectedCount === 0
            ? "すべて未接続"
            : `${connectedCount}/${providers.length} 接続`}
        </Badge>
      </CardHeader>

      <CardContent className="divide-y divide-border p-0">
        {providers.map((provider) => {
          const primary = primaryWindow(provider);
          const percent = primary?.usedPercent ?? null;
          const remaining = percent === null ? null : Math.max(0, 100 - percent);
          const secondary = availableWindows(provider).filter(
            (window) => window.id !== primary?.id,
          );
          const consoleLink = PROVIDER_CONSOLE_LINKS[provider.id];
          const isDisconnected = provider.status === "disconnected";

          return (
            <div
              key={provider.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-4 px-4 py-4 sm:px-5 xl:grid-cols-[150px_92px_minmax(240px,1fr)_210px_auto] xl:items-center xl:gap-x-5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-[15px] font-semibold text-foreground">
                    {provider.name}
                  </h3>
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      provider.status === "connected"
                        ? "bg-emerald-300"
                        : provider.status === "degraded"
                          ? "bg-amber-300"
                          : "bg-muted-foreground/60",
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-xs text-muted-foreground">
                    {isStale && provider.status !== "disconnected"
                      ? "前回取得"
                      : statusLabels[provider.status]}
                  </span>
                </div>
                <div className="mt-1.5 text-xs text-muted-foreground">
                  {isDisconnected
                    ? connectionGuides[provider.id]
                    : (primary?.label ?? "利用枠を取得中")}
                </div>
                {provider.lastSyncAt ? (
                  <div className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                    最終取得 {formatResetDate(provider.lastSyncAt, timeZone)}
                  </div>
                ) : null}
              </div>

              <div className="text-end xl:text-start">
                <div className="text-xs text-muted-foreground">使用率</div>
                <div className="mt-1 text-[30px] font-semibold leading-none tabular-nums tracking-[-0.04em] text-foreground">
                  {percent === null ? "—" : `${percent.toFixed(0)}%`}
                </div>
                <div className="mt-1.5 text-xs text-muted-foreground">
                  {remaining === null
                    ? isDisconnected ? "接続後に表示" : "利用率は取得できません"
                    : `残り ${remaining.toFixed(0)}%`}
                </div>
              </div>

              <div className="col-span-2 min-w-0 xl:col-span-1">
                {percent === null ? (
                  <div className="flex min-h-8 items-center rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground">
                    利用データはまだありません
                  </div>
                ) : (
                  <div
                    className="h-2 overflow-hidden rounded-sm bg-secondary"
                    role="progressbar"
                    aria-label={`${provider.name} ${primary?.label ?? "利用枠"}の使用率`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <div
                      className={cn("h-full rounded-sm", usageTone(percent))}
                      style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                    />
                  </div>
                )}
                {primary && percent !== null ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    {primary.label}・{sourceLabel(primary)}
                  </div>
                ) : null}
                {secondary.length > 0 ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                    {secondary.map((window) => (
                      <SecondaryUsageWindow
                        key={window.id}
                        window={window}
                        generatedAt={clock}
                      />
                    ))}
                  </div>
                ) : null}
              </div>

              <ResetTime
                resetsAt={primary?.resetsAt ?? null}
                generatedAt={clock}
                isDisconnected={isDisconnected}
              />

              <div className="col-span-2 flex items-center justify-self-end gap-1 xl:col-span-1 xl:justify-self-auto">
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="h-11 px-2 text-xs text-muted-foreground sm:h-9"
                >
                  <a
                    href={consoleLink.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={`${consoleLink.label}を開く。${consoleLink.scope}`}
                    aria-label={`${provider.name}の公式管理画面を開く。${consoleLink.scope}`}
                  >
                    <span>公式画面</span>
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                </Button>
                <ProviderConnectionControl provider={provider} />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
