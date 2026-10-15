import {
  PROVIDER_IDS,
  TELEMETRY_EVENT_TYPES,
  type DashboardSnapshot,
} from "@/lib/runmeter-types";

type JsonRecord = Record<string, unknown>;

const providerIds = new Set<string>(PROVIDER_IDS);
const providerStatuses = new Set(["connected", "degraded", "disconnected"]);
const providerIngestions = new Set(["none", "event", "poll", "import"]);
const usageSources = new Set(["provider", "local"]);
const agentStatuses = new Set(["running", "tool", "queued", "idle", "degraded"]);
const runStatuses = new Set(["running", "queued", "completed", "failed"]);
const eventTypes = new Set<string>([...TELEMETRY_EVENT_TYPES, "budget.warning"]);
const eventSeverities = new Set(["info", "warning", "error"]);
const MAX_ARRAY_LENGTH = 100_000;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function string(value: unknown) {
  return typeof value === "string";
}

function nonempty(value: unknown) {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function nullableString(value: unknown) {
  return value === null || typeof value === "string";
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonnegative(value: unknown) {
  return finite(value) && (value as number) >= 0;
}

function percentage(value: unknown) {
  return finite(value) && (value as number) >= 0 && (value as number) <= 100;
}

function nullablePercentage(value: unknown) {
  return value === null || percentage(value);
}

function isoDate(value: unknown) {
  return nonempty(value) && !Number.isNaN(Date.parse(value as string));
}

function nullableIsoDate(value: unknown) {
  return value === null || isoDate(value);
}

function safeArray(value: unknown) {
  return Array.isArray(value) && value.length <= MAX_ARRAY_LENGTH;
}

function everyRecord(value: unknown, validate: (item: JsonRecord) => boolean) {
  return (
    safeArray(value) &&
    (value as unknown[]).every((item) => {
      const itemRecord = record(item);
      return itemRecord !== null && validate(itemRecord);
    })
  );
}

function validSummary(value: unknown) {
  const item = record(value);
  return (
    item !== null &&
    nonnegative(item.activeAgents) &&
    nonnegative(item.runningRuns) &&
    nonnegative(item.queuedRuns) &&
    nonnegative(item.failedRuns) &&
    nonnegative(item.tokensPerMinute) &&
    nonnegative(item.requestsPerMinute) &&
    nonnegative(item.estimatedCostToday) &&
    nonnegative(item.monthlySpend) &&
    nonnegative(item.monthlyBudget) &&
    percentage(item.budgetUsedPercent) &&
    nonnegative(item.p50LatencyMs) &&
    nonnegative(item.p95LatencyMs) &&
    percentage(item.errorRate)
  );
}

function validUsageWindow(value: unknown) {
  const item = record(value);
  return (
    item !== null &&
    nonempty(item.id) &&
    nonempty(item.label) &&
    nullablePercentage(item.usedPercent) &&
    nullableIsoDate(item.resetsAt) &&
    usageSources.has(String(item.source)) &&
    typeof item.estimated === "boolean" &&
    (item.used === undefined || nonnegative(item.used)) &&
    (item.limit === undefined || nonnegative(item.limit)) &&
    optionalString(item.unit)
  );
}

function validProvider(item: JsonRecord) {
  return (
    providerIds.has(String(item.id)) &&
    nonempty(item.name) &&
    providerStatuses.has(String(item.status)) &&
    nullableIsoDate(item.lastSyncAt) &&
    providerIngestions.has(String(item.ingestion)) &&
    nonnegative(item.agents) &&
    nonnegative(item.totalTokensToday) &&
    nonnegative(item.costTodayUsd) &&
    nullableString(item.primaryUsageWindowId) &&
    safeArray(item.usageWindows) &&
    (item.usageWindows as unknown[]).every(validUsageWindow)
  );
}

function validUsagePoint(item: JsonRecord) {
  return (
    isoDate(item.timestamp) &&
    string(item.label) &&
    nonnegative(item.inputTokens) &&
    nonnegative(item.cachedTokens) &&
    nonnegative(item.outputTokens) &&
    nonnegative(item.reasoningTokens) &&
    nonnegative(item.totalTokens) &&
    nonnegative(item.requests) &&
    nonnegative(item.costUsd) &&
    nonnegative(item.errors) &&
    nonnegative(item.activeAgents) &&
    nonnegative(item.p50LatencyMs) &&
    nonnegative(item.p95LatencyMs)
  );
}

function validAgent(item: JsonRecord) {
  return (
    nonempty(item.id) &&
    nonempty(item.name) &&
    nonempty(item.slug) &&
    string(item.description) &&
    agentStatuses.has(String(item.status)) &&
    providerIds.has(String(item.provider)) &&
    nonempty(item.model) &&
    nullableString(item.currentRunId) &&
    nullableString(item.currentTask) &&
    nonnegative(item.tokensToday) &&
    nonnegative(item.costTodayUsd) &&
    nonnegative(item.requestsToday) &&
    percentage(item.successRate) &&
    nonnegative(item.p95LatencyMs) &&
    isoDate(item.lastSeenAt)
  );
}

function validRun(item: JsonRecord) {
  return (
    nonempty(item.id) &&
    nonempty(item.agentId) &&
    runStatuses.has(String(item.status)) &&
    providerIds.has(String(item.provider)) &&
    nonempty(item.model) &&
    nonempty(item.task) &&
    nullableString(item.currentStep) &&
    isoDate(item.queuedAt) &&
    nullableIsoDate(item.startedAt) &&
    nullableIsoDate(item.completedAt) &&
    isoDate(item.lastActivityAt) &&
    nonnegative(item.durationMs) &&
    nonnegative(item.inputTokens) &&
    nonnegative(item.cachedTokens) &&
    nonnegative(item.outputTokens) &&
    nonnegative(item.reasoningTokens) &&
    nonnegative(item.totalTokens) &&
    nonnegative(item.estimatedCostUsd) &&
    nonnegative(item.toolCalls)
  );
}

function validEvent(item: JsonRecord) {
  return (
    nonempty(item.id) &&
    eventTypes.has(String(item.type)) &&
    isoDate(item.occurredAt) &&
    nonempty(item.agentId) &&
    nonempty(item.runId) &&
    eventSeverities.has(String(item.severity)) &&
    nonempty(item.title) &&
    string(item.detail) &&
    optionalString(item.model) &&
    optionalString(item.toolName) &&
    (item.durationMs === undefined || nonnegative(item.durationMs)) &&
    (item.totalTokens === undefined || nonnegative(item.totalTokens)) &&
    (item.estimatedCostUsd === undefined || nonnegative(item.estimatedCostUsd))
  );
}

function validModelCost(item: JsonRecord) {
  return (
    nonempty(item.model) &&
    nonnegative(item.tokens) &&
    nonnegative(item.costUsd) &&
    percentage(item.sharePercent)
  );
}

function validDailyHistory(item: JsonRecord) {
  return (
    isoDate(item.date) &&
    string(item.label) &&
    nonnegative(item.totalTokens) &&
    nonnegative(item.costUsd) &&
    nonnegative(item.runs) &&
    percentage(item.successRate) &&
    nonnegative(item.p95LatencyMs)
  );
}

function validMatrixCell(item: JsonRecord) {
  return (
    nonempty(item.agentId) &&
    isoDate(item.date) &&
    string(item.label) &&
    nonnegative(item.tokens) &&
    nonnegative(item.costUsd) &&
    nonnegative(item.runs) &&
    percentage(item.errorRate) &&
    percentage(item.intensity)
  );
}

function validProviderMatrixCell(item: JsonRecord) {
  return (
    providerIds.has(String(item.providerId)) &&
    isoDate(item.date) &&
    string(item.label) &&
    nonnegative(item.tokens) &&
    nonnegative(item.costUsd) &&
    finite(item.intensity) &&
    (item.intensity as number) >= 0 &&
    (item.intensity as number) <= 1
  );
}

export function validateDashboardSnapshot(value: unknown): DashboardSnapshot | null {
  const snapshot = record(value);
  if (
    snapshot === null ||
    !isoDate(snapshot.generatedAt) ||
    !nonnegative(snapshot.windowMinutes) ||
    !isoDate(snapshot.windowStart) ||
    !isoDate(snapshot.windowEnd) ||
    !validSummary(snapshot.summary) ||
    !everyRecord(snapshot.usageSeries, validUsagePoint) ||
    !everyRecord(snapshot.agents, validAgent) ||
    !everyRecord(snapshot.runs, validRun) ||
    !everyRecord(snapshot.events, validEvent) ||
    !everyRecord(snapshot.costByModel, validModelCost) ||
    !everyRecord(snapshot.dailyHistory, validDailyHistory) ||
    !everyRecord(snapshot.agentHistoryMatrix, validMatrixCell) ||
    !everyRecord(snapshot.providerHistoryMatrix, validProviderMatrixCell) ||
    !everyRecord(snapshot.providers, validProvider)
  ) {
    return null;
  }

  return snapshot as unknown as DashboardSnapshot;
}
