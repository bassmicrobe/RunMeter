import type { DashboardSnapshot, ProviderId } from "@/lib/runmeter-types";

const VISIBLE_PROVIDER_IDS = ["codex", "claude"] as const satisfies readonly ProviderId[];

const PROVIDER_NAMES = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
} satisfies Record<ProviderId, string>;

/**
 * Initial state before a local data source is paired.
 * It deliberately contains no sample usage, history, run, agent, or cost data.
 */
export function createDisconnectedDashboardSnapshot(
  now = new Date(),
): DashboardSnapshot {
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
    dailyHistory: [],
    agentHistoryMatrix: [],
    providerHistoryMatrix: [],
    providers: VISIBLE_PROVIDER_IDS.map((id) => ({
      id,
      name: PROVIDER_NAMES[id],
      status: "disconnected",
      lastSyncAt: null,
      ingestion: "none",
      agents: 0,
      totalTokensToday: 0,
      costTodayUsd: 0,
      primaryUsageWindowId: null,
      usageWindows: [],
    })),
  };
}
