import type {
  DashboardProvider,
  DashboardSnapshot,
  ProviderSnapshot,
} from "./types.ts";

export const DEFAULT_PROVIDERS = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
] as const;

export const MAX_DASHBOARD_HISTORY_DAYS = 90;

function dashboardStatus(
  status: ProviderSnapshot["status"],
): DashboardProvider["status"] {
  if (status === "connected") return "connected";
  if (status === "degraded" || status === "error") return "degraded";
  return "disconnected";
}

function todayInLocalTime(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function historyLabel(date: string): string {
  const [, month, day] = date.split("-");
  return month && day
    ? `${Number(month)}/${Number(day)}`
    : date;
}

function codexWindowRank(id: string, label: string): number {
  const separator = id.lastIndexOf(":");
  const limitId = separator >= 0 ? id.slice(0, separator) : id;
  if (limitId.toLocaleLowerCase("en-US") === "codex") return 0;
  return /spark/i.test(`${limitId} ${label}`) ? 2 : 1;
}

function preferredUsageWindowId(snapshot: ProviderSnapshot): string | null {
  const requestedId = snapshot.metadata?.primaryUsageWindowId;
  if (
    typeof requestedId === "string" &&
    snapshot.windows.some((window) => window.id === requestedId)
  ) {
    return requestedId;
  }

  if (snapshot.providerId !== "codex") return snapshot.windows[0]?.id ?? null;
  const ordered = [...snapshot.windows].sort(
    (left, right) =>
      codexWindowRank(left.id, left.label) - codexWindowRank(right.id, right.label) ||
      Number(!left.id.endsWith(":primary")) -
        Number(!right.id.endsWith(":primary")) ||
      left.id.localeCompare(right.id, "en"),
  );
  return ordered[0]?.id ?? null;
}

export function buildDashboardSnapshot(
  providerSnapshots: ProviderSnapshot[],
  now = new Date(),
): DashboardSnapshot {
  const byId = new Map(providerSnapshots.map((snapshot) => [snapshot.providerId, snapshot]));
  const uniqueSnapshots = [...byId.values()].map((snapshot) => ({
    ...snapshot,
    dailyUsage: [...new Map(snapshot.dailyUsage.map((day) => [day.date, day])).values()],
  }));
  const visibleProviderIds = new Set<string>(DEFAULT_PROVIDERS.map(({ id }) => id));
  const historyDates = new Set(
    uniqueSnapshots
      .filter((snapshot) => visibleProviderIds.has(snapshot.providerId))
      .flatMap((snapshot) => snapshot.dailyUsage.map((day) => day.date)),
  );
  const visibleHistoryDates = new Set([...historyDates].sort().slice(-MAX_DASHBOARD_HISTORY_DAYS));
  for (const snapshot of uniqueSnapshots) {
    snapshot.dailyUsage = snapshot.dailyUsage.filter((day) => visibleHistoryDates.has(day.date));
  }
  for (const snapshot of uniqueSnapshots) byId.set(snapshot.providerId, snapshot);
  const today = todayInLocalTime(now);
  const providers = DEFAULT_PROVIDERS.map(({ id, name }) => {
    const snapshot = byId.get(id);
    if (!snapshot) {
      return {
        id,
        name,
        status: "disconnected" as const,
        lastSyncAt: null,
        ingestion: "none" as const,
        agents: 0,
        totalTokensToday: 0,
        costTodayUsd: 0,
        primaryUsageWindowId: null,
        usageWindows: [],
      };
    }

    const todayUsage = snapshot.dailyUsage.find((entry) => entry.date === today);
    return {
      id,
      name: snapshot.displayName,
      status: dashboardStatus(snapshot.status),
      lastSyncAt: snapshot.updatedAt,
      ingestion: snapshot.ingestion,
      agents: 0,
      totalTokensToday: todayUsage?.tokens ?? 0,
      costTodayUsd: todayUsage?.costUsd ?? 0,
      primaryUsageWindowId: preferredUsageWindowId(snapshot),
      usageWindows: snapshot.windows,
    };
  });

  const providerOrder = new Map<string, number>(
    DEFAULT_PROVIDERS.map((provider, index) => [provider.id, index]),
  );
  const dailyTotals = new Map<string, { tokens: number; costUsd: number }>();
  for (const snapshot of uniqueSnapshots) {
    if (!providerOrder.has(snapshot.providerId)) continue;
    for (const entry of snapshot.dailyUsage) {
      const aggregate = dailyTotals.get(entry.date) ?? { tokens: 0, costUsd: 0 };
      aggregate.tokens += entry.tokens ?? 0;
      aggregate.costUsd += entry.costUsd ?? 0;
      dailyTotals.set(entry.date, aggregate);
    }
  }

  const providerHistoryRows = uniqueSnapshots
    .filter((snapshot) => providerOrder.has(snapshot.providerId))
    .flatMap((snapshot) =>
      snapshot.dailyUsage.map((entry) => ({
        providerId: snapshot.providerId,
        date: entry.date,
        label: historyLabel(entry.date),
        tokens: entry.tokens ?? 0,
        costUsd: entry.costUsd ?? 0,
      })),
    );
  const maximumProviderTokens = Math.max(
    0,
    ...providerHistoryRows.map((entry) => entry.tokens),
  );
  const providerHistoryMatrix = providerHistoryRows
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        (providerOrder.get(left.providerId) ?? 0) -
          (providerOrder.get(right.providerId) ?? 0),
    )
    .map((entry) => ({
      ...entry,
      intensity:
        maximumProviderTokens > 0 ? entry.tokens / maximumProviderTokens : 0,
    }));

  const generatedAt = now.toISOString();
  return {
    generatedAt,
    windowMinutes: 0,
    windowStart: generatedAt,
    windowEnd: generatedAt,
    summary: {
      activeAgents: 0,
      runningRuns: 0,
      queuedRuns: 0,
      failedRuns: 0,
      tokensPerMinute: 0,
      requestsPerMinute: 0,
      estimatedCostToday: 0,
      monthlySpend: 0,
      monthlyBudget: 0,
      budgetUsedPercent: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      errorRate: 0,
    },
    usageSeries: [],
    agents: [],
    runs: [],
    events: [],
    costByModel: [],
    dailyHistory: [...dailyTotals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, aggregate]) => ({
        date,
        label: historyLabel(date),
        totalTokens: aggregate.tokens,
        costUsd: aggregate.costUsd,
        runs: 0,
        successRate: 0,
        p95LatencyMs: 0,
      })),
    agentHistoryMatrix: [],
    providerHistoryMatrix,
    providers,
  };
}
