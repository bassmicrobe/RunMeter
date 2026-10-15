export type IsoTimestamp = string;

export const PROVIDER_IDS = [
  "codex",
  "claude",
  "gemini",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderStatus = "connected" | "degraded" | "disconnected";

export type ProviderIngestion = "none" | "event" | "poll" | "import";

export type ProviderUsageSource = "provider" | "local";

export interface ProviderUsageWindow {
  id: string;
  label: string;
  /** Normalized usage from 0 (unused) through 100 (fully used). */
  usedPercent: number | null;
  resetsAt: IsoTimestamp | null;
  source: ProviderUsageSource;
  estimated: boolean;
  used?: number;
  limit?: number;
  unit?: string;
}

export type AgentStatus = "running" | "tool" | "queued" | "idle" | "degraded";

export type RunStatus = "running" | "queued" | "completed" | "failed";

export type EventSeverity = "info" | "warning" | "error";

export const TELEMETRY_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "run.completed",
  "run.failed",
  "model.completed",
  "tool.started",
  "tool.completed",
] as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

export type DashboardEventType = TelemetryEventType | "budget.warning";

export interface DashboardSummary {
  activeAgents: number;
  runningRuns: number;
  queuedRuns: number;
  failedRuns: number;
  tokensPerMinute: number;
  requestsPerMinute: number;
  estimatedCostToday: number;
  monthlySpend: number;
  monthlyBudget: number;
  budgetUsedPercent: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  errorRate: number;
}

export interface UsageChartPoint {
  timestamp: IsoTimestamp;
  label: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  requests: number;
  costUsd: number;
  errors: number;
  activeAgents: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface AgentTelemetry {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: AgentStatus;
  provider: ProviderId;
  model: string;
  currentRunId: string | null;
  currentTask: string | null;
  tokensToday: number;
  costTodayUsd: number;
  requestsToday: number;
  successRate: number;
  p95LatencyMs: number;
  lastSeenAt: IsoTimestamp;
}

export interface RunTelemetry {
  id: string;
  agentId: string;
  status: RunStatus;
  provider: ProviderId;
  model: string;
  task: string;
  currentStep: string | null;
  queuedAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  lastActivityAt: IsoTimestamp;
  durationMs: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  toolCalls: number;
}

export interface DashboardEvent {
  id: string;
  type: DashboardEventType;
  occurredAt: IsoTimestamp;
  agentId: string;
  runId: string;
  severity: EventSeverity;
  title: string;
  detail: string;
  model?: string;
  toolName?: string;
  durationMs?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface ModelCostBreakdown {
  model: string;
  tokens: number;
  costUsd: number;
  sharePercent: number;
}

export interface DailyHistoryPoint {
  date: string;
  label: string;
  totalTokens: number;
  costUsd: number;
  runs: number;
  successRate: number;
  p95LatencyMs: number;
}

export interface AgentHistoryMatrixCell {
  agentId: string;
  date: string;
  label: string;
  tokens: number;
  costUsd: number;
  runs: number;
  errorRate: number;
  intensity: number;
}

export interface ProviderHistoryMatrixCell {
  providerId: ProviderId;
  date: string;
  label: string;
  tokens: number;
  costUsd: number;
  intensity: number;
}

export interface ProviderConnection {
  id: ProviderId;
  name: string;
  status: ProviderStatus;
  lastSyncAt: IsoTimestamp | null;
  ingestion: ProviderIngestion;
  agents: number;
  totalTokensToday: number;
  costTodayUsd: number;
  primaryUsageWindowId: string | null;
  usageWindows: ProviderUsageWindow[];
}

export interface DashboardSnapshot {
  generatedAt: IsoTimestamp;
  windowMinutes: number;
  windowStart: IsoTimestamp;
  windowEnd: IsoTimestamp;
  summary: DashboardSummary;
  usageSeries: UsageChartPoint[];
  agents: AgentTelemetry[];
  runs: RunTelemetry[];
  events: DashboardEvent[];
  costByModel: ModelCostBreakdown[];
  dailyHistory: DailyHistoryPoint[];
  agentHistoryMatrix: AgentHistoryMatrixCell[];
  providerHistoryMatrix: ProviderHistoryMatrixCell[];
  providers: ProviderConnection[];
}
