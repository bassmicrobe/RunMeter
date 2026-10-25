"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  ExternalLink,
  LockKeyhole,
  Pause,
  Play,
  PlugZap,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useLocalTimeZone } from "@/hooks/use-local-time-zone";
import {
  formatClock,
  formatCompactNumber,
  formatCurrency,
} from "@/lib/format";
import {
  RelayRequestError,
  RunMeterRelayClient,
  subscribeRelaySnapshot,
} from "@/lib/relay-client";
import { clearRelaySession, readRelaySession } from "@/lib/relay-storage";
import type {
  DashboardSnapshot,
  RunTelemetry,
} from "@/lib/runmeter-types";
import { SITE_CONFIG } from "@/lib/site-config";
import { cn } from "@/lib/utils";

import { AppSidebar } from "./app-sidebar";
import { PrivacyNotice } from "./privacy-notice";
import { ProviderUsageOverview } from "./provider-usage-overview";
import { SectionHeading } from "./section-heading";

const AgentHealth = dynamic(() => import("./health-usage").then((module) => module.AgentHealth));
const BudgetCard = dynamic(() => import("./health-usage").then((module) => module.BudgetCard));
const LiveActivity = dynamic(() => import("./live-activity").then((module) => module.LiveActivity));
const LiveRuns = dynamic(() => import("./live-runs").then((module) => module.LiveRuns));

const UsageChart = dynamic(
  () => import("./usage-chart").then((module) => module.UsageChart),
  {
    loading: () => <Skeleton className="h-[252px] w-full rounded-lg" />,
  },
);

const HistorySection = dynamic(
  () => import("./history-section").then((module) => module.HistorySection),
  {
    loading: () => <Skeleton className="h-[430px] w-full rounded-lg" />,
  },
);

const RunDetailSheet = dynamic(
  () => import("./run-detail-sheet").then((module) => module.RunDetailSheet),
  { ssr: false },
);

const DashboardSearchDialog = dynamic(
  () =>
    import("./dashboard-search-dialog").then(
      (module) => module.DashboardSearchDialog,
    ),
  { ssr: false },
);

const ranges = [
  { value: "15", label: "直近15分" },
  { value: "30", label: "直近30分" },
  { value: "60", label: "直近60分" },
] as const;

function SummaryStrip({ snapshot }: { snapshot: DashboardSnapshot }) {
  const items = [
    {
      label: "実行中",
      value: `${snapshot.summary.runningRuns}件`,
      detail: `待機 ${snapshot.summary.queuedRuns}件`,
    },
    {
      label: "1分あたりのトークン",
      value: formatCompactNumber(snapshot.summary.tokensPerMinute),
      detail: `${snapshot.summary.requestsPerMinute}リクエスト`,
    },
    {
      label: "今日の推定料金",
      value: formatCurrency(snapshot.summary.estimatedCostToday),
      detail: "概算値",
    },
    {
      label: "エラー率",
      value: `${snapshot.summary.errorRate.toFixed(2)}%`,
      detail: "直近60分",
      danger: snapshot.summary.errorRate > 1,
    },
  ];

  return (
    <section
      aria-label="現在の概要"
      className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card md:grid-cols-4"
    >
      {items.map((item, index) => (
        <div
          key={item.label}
          className={cn(
            "p-4",
            index % 2 === 0 && "border-e border-border",
            index < 2 && "border-b border-border",
            "md:border-b-0 md:border-e",
            index === items.length - 1 && "md:border-e-0",
          )}
        >
          <div className="text-xs text-muted-foreground">{item.label}</div>
          <div
            className={cn(
              "mt-2 text-[24px] font-semibold leading-none tabular-nums tracking-[-0.03em] text-foreground",
              item.danger && "text-rose-300",
            )}
          >
            {item.value}
          </div>
          <div className="mt-2 text-[11px] text-muted-foreground">
            {item.detail}
          </div>
        </div>
      ))}
    </section>
  );
}

function hasDetailedTelemetry(snapshot: DashboardSnapshot) {
  return (
    snapshot.providers.some(
      (provider) =>
        provider.status !== "disconnected" ||
        provider.usageWindows.length > 0,
    ) ||
    snapshot.usageSeries.length > 0 ||
    snapshot.agents.length > 0 ||
    snapshot.runs.length > 0 ||
    snapshot.events.length > 0 ||
    snapshot.costByModel.length > 0 ||
    snapshot.dailyHistory.length > 0 ||
    snapshot.agentHistoryMatrix.length > 0 ||
    snapshot.providerHistoryMatrix.length > 0
  );
}

function EmptyTelemetryNotice() {
  return (
    <Card
      className="scroll-mt-20 gap-0 border-border bg-card py-0 shadow-none"
    >
      <CardContent className="flex items-start gap-3 p-4 sm:p-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-secondary text-muted-foreground">
          <PlugZap className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            利用データはまだありません
          </h2>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-5 text-muted-foreground">
            WindowsのスタートメニューからRunMeterを起動し、上のサービス行にある「接続」からペアリングコードを入力してください。
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            接続後は、利用率、次のリセット日時、トークン履歴をこの画面へ自動反映します。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function RunMeterDashboard({
  initialSnapshot,
}: {
  initialSnapshot: DashboardSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [paused, setPaused] = useState(false);
  const [connection, setConnection] = useState<"live" | "reconnecting">("live");
  const [range, setRange] = useState("60");
  const [selectedRun, setSelectedRun] = useState<RunTelemetry | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const timeZone = useLocalTimeZone();
  const hasTelemetry = hasDetailedTelemetry(snapshot);
  const hasUsageSeries = snapshot.usageSeries.length > 0;
  const hasActivity = snapshot.events.length > 0;
  const hasHistory = snapshot.dailyHistory.length > 0;
  const hasRuns = snapshot.runs.length > 0;
  const hasAgents = snapshot.agents.length > 0;
  const hasSearchData = hasRuns || hasAgents;
  const hasBudget =
    snapshot.summary.estimatedCostToday > 0 ||
    snapshot.summary.monthlySpend > 0 ||
    snapshot.summary.monthlyBudget > 0 ||
    snapshot.costByModel.length > 0;
  const hasOperationalSummary =
    hasUsageSeries || hasActivity || hasRuns || hasAgents || hasBudget;

  useEffect(() => {
    if (!hasSearchData) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasSearchData]);

  useEffect(() => {
    let cancelled = false;
    let refreshInFlight = false;
    let refreshRequested = false;
    let revision = 0;
    const controller = new AbortController();
    const unsubscribe = subscribeRelaySnapshot((nextSnapshot) => {
      if (cancelled) return;
      revision += 1;
      setSnapshot(nextSnapshot);
      setConnection("live");
    });

    const refresh = async () => {
      if (cancelled || document.hidden) return;
      if (refreshInFlight) {
        refreshRequested = true;
        return;
      }
      refreshInFlight = true;
      const requestRevision = revision;
      let requestToken: string | undefined;

      try {
        const session = await readRelaySession();
        if (cancelled || requestRevision !== revision) return;
        if (!session) {
          if (!cancelled) {
            setSnapshot(initialSnapshot);
            setConnection("reconnecting");
          }
          return;
        }

        requestToken = session.token;
        const data = await new RunMeterRelayClient(session).snapshot(controller.signal);
        const currentSession = await readRelaySession();
        if (!cancelled && requestRevision === revision && currentSession?.token === requestToken) {
          setSnapshot(data);
          setConnection("live");
        }
      } catch (error) {
        if (cancelled || requestRevision !== revision) return;
        if (error instanceof RelayRequestError && error.status === 401) {
          const currentSession = await readRelaySession().catch(() => null);
          if (currentSession?.token !== requestToken) return;
          const cleared = await clearRelaySession(requestToken).catch(() => false);
          if (cancelled || requestRevision !== revision || !cleared) return;
          setSnapshot(initialSnapshot);
        }
        if (!cancelled) setConnection("reconnecting");
      } finally {
        refreshInFlight = false;
        if (refreshRequested && !cancelled) {
          refreshRequested = false;
          void refresh();
        }
      }
    };

    if (!paused) void refresh();
    const intervalId = paused ? null : window.setInterval(refresh, 15_000);
    const handleVisibilityChange = () => {
      if (!paused && !document.hidden) void refresh();
    };
    const handleRelayRefresh = () => {
      revision += 1;
      void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("runmeter:relay-refresh", handleRelayRefresh);

    return () => {
      cancelled = true;
      controller.abort();
      unsubscribe();
      if (intervalId !== null) window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("runmeter:relay-refresh", handleRelayRefresh);
    };
  }, [initialSnapshot, paused]);

  const visibleUsage = snapshot.usageSeries.slice(-Number(range));
  const agentById = useMemo(
    () => new Map(snapshot.agents.map((agent) => [agent.id, agent])),
    [snapshot.agents],
  );
  const selectedAgent = selectedRun
    ? (agentById.get(selectedRun.agentId) ?? null)
    : null;

  return (
    <SidebarProvider defaultOpen>
      <a
        href="#usage"
        className="fixed left-3 top-3 z-50 -translate-y-24 rounded-md bg-primary px-4 py-3 text-primary-foreground focus:translate-y-0"
      >
        利用率とリセットへ移動
      </a>
      <AppSidebar hasTelemetry={hasTelemetry} connection={connection} />
      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-20 flex min-h-16 shrink-0 items-center justify-between border-b border-border bg-background/95 px-3 backdrop-blur-sm sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <SidebarTrigger className="size-11 text-muted-foreground sm:size-9" />
            <Separator orientation="vertical" className="hidden h-5 sm:block" />
            <Image
              src="/brand/runmeter-mark-dark.svg"
              alt=""
              width={28}
              height={28}
              unoptimized
              className="size-7 shrink-0 md:hidden"
            />
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold tracking-[-0.02em]">
                利用状況
              </h1>
              <p className="mt-0.5 hidden text-xs text-muted-foreground sm:block">
                2サービスの利用枠とリセットを確認
              </p>
            </div>
          </div>

          {hasTelemetry ? (
            <div className="flex items-center gap-2">
              {hasSearchData ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSearchOpen(true)}
                  className="hidden h-9 w-44 justify-start gap-2 border-border bg-card px-3 text-xs text-muted-foreground shadow-none sm:flex"
                >
                  <Search className="size-3.5" aria-hidden="true" />
                  実行を検索
                  <kbd className="ms-auto rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[9px]">
                    Ctrl K
                  </kbd>
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPaused((value) => !value)}
                className="h-11 gap-2 border-border bg-card px-3 text-xs shadow-none sm:h-9"
                aria-label={paused ? "自動更新を再開" : "自動更新を停止"}
              >
                {paused ? (
                  <Play className="size-3.5" />
                ) : (
                  <Pause className="size-3.5" />
                )}
                <span className="hidden sm:inline">
                  {paused
                    ? "更新を再開"
                    : connection === "live"
                      ? "15秒ごとに更新"
                      : "再接続中"}
                </span>
                {!paused ? (
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      connection === "live"
                        ? "bg-emerald-300"
                        : "bg-amber-300",
                    )}
                    aria-hidden="true"
                  />
                ) : null}
              </Button>
            </div>
          ) : (
            <span className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
              未接続
            </span>
          )}
        </header>

        <div
          id="overview"
          className="mx-auto w-full max-w-[1320px] scroll-mt-20 p-3 sm:p-5"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {hasTelemetry
                ? `最終更新 ${formatClock(snapshot.generatedAt, timeZone)}`
                : "現在、サービスとの接続はありません"}
            </p>
            {hasSearchData ? (
              <Button
                variant="outline"
                size="icon"
                className="size-11 sm:hidden"
                onClick={() => setSearchOpen(true)}
                aria-label="実行を検索"
              >
                <Search className="size-4" />
              </Button>
            ) : null}
          </div>

          {hasTelemetry && connection === "reconnecting" ? (
            <div
              className="mb-3 flex items-start gap-2.5 rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-3 text-amber-100"
              role="status"
              aria-live="polite"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">RunMeterとの接続が切れています</p>
                <p className="mt-0.5 text-xs leading-5 text-amber-100/75">
                  表示中の数値は{formatClock(snapshot.generatedAt, timeZone)}時点の前回取得値です。Windowsアプリを起動すると自動で再接続します。
                </p>
              </div>
            </div>
          ) : null}

          <ProviderUsageOverview
            providers={snapshot.providers}
            generatedAt={snapshot.generatedAt}
            isStale={hasTelemetry && connection === "reconnecting"}
          />

          <section className="mt-3" aria-label="データの取り扱い">
            <PrivacyNotice />
          </section>

          {hasTelemetry ? (
            <>
              {hasOperationalSummary ? (
                <div className="mt-3">
                  <SummaryStrip snapshot={snapshot} />
                </div>
              ) : null}

              {hasUsageSeries || hasActivity ? (
                <section
                  className={cn(
                    "mt-3 grid gap-3 xl:gap-4",
                    hasUsageSeries && hasActivity &&
                      "xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]",
                  )}
                >
                  {hasUsageSeries ? (
                    <Card id="tokens" className="scroll-mt-20 gap-0 py-0 shadow-none">
              <CardHeader className="flex flex-row items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-5">
                <SectionHeading
                  title="トークンの推移"
                  description={`${range}分間で ${formatCompactNumber(
                    visibleUsage.reduce((sum, point) => sum + point.totalTokens, 0),
                  )}トークン`}
                />
                <Select value={range} onValueChange={setRange}>
                  <SelectTrigger
                    size="sm"
                    aria-label="グラフの表示期間"
                    className="h-11 w-[112px] border-border bg-card text-xs shadow-none sm:h-9 sm:w-[124px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ranges.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-xs">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardHeader>
              <CardContent className="p-2 pt-4 sm:p-4 sm:pt-4">
                <div className="mb-2 flex items-center justify-end gap-4 pe-2 text-[11px] text-muted-foreground">
                  {[
                    ["入力", "bg-[#858d98]"],
                    ["キャッシュ", "bg-[#b89b72]"],
                    ["出力", "bg-primary"],
                  ].map(([label, color]) => (
                    <span key={label} className="inline-flex items-center gap-1.5">
                      <span className={cn("size-1.5 rounded-full", color)} />
                      {label}
                    </span>
                  ))}
                </div>
                <UsageChart data={visibleUsage} />
              </CardContent>
            </Card>
                  ) : null}
                  {hasActivity ? (
                    <LiveActivity
                      events={snapshot.events}
                      agents={snapshot.agents}
                      generatedAt={snapshot.generatedAt}
                    />
                  ) : null}
                </section>
              ) : null}

              {hasHistory ? (
                <section className="mt-3 xl:mt-4">
                  <HistorySection
                    dailyHistory={snapshot.dailyHistory}
                    matrix={snapshot.agentHistoryMatrix}
                    agents={snapshot.agents}
                    providerMatrix={snapshot.providerHistoryMatrix}
                    providers={snapshot.providers}
                  />
                </section>
              ) : null}

              {hasRuns ? (
                <section className="mt-3 xl:mt-4">
                  <LiveRuns
                    runs={snapshot.runs}
                    agents={snapshot.agents}
                    runningRuns={snapshot.summary.runningRuns}
                    queuedRuns={snapshot.summary.queuedRuns}
                    onSelect={setSelectedRun}
                  />
                </section>
              ) : null}

              {hasAgents || hasBudget ? (
                <section
                  className={cn(
                    "mt-3 grid gap-3 pb-3 xl:mt-4 xl:gap-4",
                    hasAgents && hasBudget && "md:grid-cols-2",
                  )}
                >
                  {hasAgents ? <AgentHealth agents={snapshot.agents} /> : null}
                  {hasBudget ? <BudgetCard snapshot={snapshot} /> : null}
                </section>
              ) : null}
            </>
          ) : (
            <section className="mt-3" aria-label="接続について">
              <EmptyTelemetryNotice />
            </section>
          )}

          <footer
            id="settings"
            className="flex flex-col gap-3 border-t border-border py-5 text-[11px] text-muted-foreground lg:flex-row lg:items-center lg:justify-between"
          >
            <span className="inline-flex items-center gap-1.5">
              <LockKeyhole className="size-3.5" aria-hidden="true" />
              ローカル優先設計・AI認証情報のクラウド保存なし
            </span>
            <span className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <a
                href="/licenses"
                className="inline-flex min-h-11 items-center text-foreground/75 underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
              >
                ライセンス・OSS表記
              </a>
              <a
                href={SITE_CONFIG.developer.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-h-11 items-center gap-1 text-foreground/75 transition-colors hover:text-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
              >
                開発：{SITE_CONFIG.developer.name}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
              <span className="font-mono text-[10px]">
                RunMeter v0.1 ・ Next 16.3 ・ TypeScript 7
              </span>
            </span>
          </footer>
        </div>
      </SidebarInset>

      {selectedRun ? (
        <RunDetailSheet
          run={selectedRun}
          agent={selectedAgent}
          open
          onOpenChange={(open) => {
            if (!open) setSelectedRun(null);
          }}
        />
      ) : null}

      {hasSearchData && searchOpen ? (
        <DashboardSearchDialog
          snapshot={snapshot}
          open={searchOpen}
          onOpenChange={setSearchOpen}
          onSelectRun={setSelectedRun}
        />
      ) : null}
    </SidebarProvider>
  );
}
