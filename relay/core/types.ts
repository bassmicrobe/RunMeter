export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ProviderState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "degraded"
  | "error";

export type UsageSource = "provider" | "local";

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  source: UsageSource;
  estimated: boolean;
  used?: number;
  limit?: number;
  unit?: string;
}

export interface DailyUsage {
  date: string;
  tokens?: number;
  requests?: number;
  costUsd?: number;
}

export interface TokenSummary {
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  currentContextTokens?: number;
  contextWindowSize?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export interface ProviderSnapshot {
  providerId: string;
  displayName: string;
  status: ProviderState;
  ingestion: "none" | "event" | "poll" | "import";
  updatedAt: string | null;
  windows: UsageWindow[];
  dailyUsage: DailyUsage[];
  tokenSummary?: TokenSummary;
  /** Adapter-owned, credential-free values only. */
  metadata?: JsonObject;
  error?: {
    code: string;
    message: string;
  };
}

export interface ProviderCapabilities {
  connect: boolean;
  disconnect: boolean;
  refresh: boolean;
  ingest: boolean;
  logout?: boolean;
}

export interface ProviderConnectRequest {
  mode?: string;
  /** Ephemeral adapter input. The relay core never logs or persists this object. */
  options?: JsonObject;
}

export type ProviderConnectAction =
  | {
      type: "open-url";
      url: string;
      label?: string;
    }
  | {
      type: "device-code";
      verificationUrl: string;
      userCode: string;
      expiresAt?: string;
    }
  | {
      type: "instructions";
      title: string;
      steps: string[];
      command?: string;
    };

export type ProviderConnectResult =
  | {
      kind: "connected";
      snapshot: ProviderSnapshot;
      message?: string;
    }
  | {
      kind: "action-required";
      action: ProviderConnectAction;
      snapshot?: ProviderSnapshot;
    }
  | {
      kind: "unsupported";
      code?: string;
      message: string;
      url?: string;
      snapshot?: ProviderSnapshot;
    };

export interface ProviderProjectOption {
  id: string;
  displayName: string;
  state: string;
}

export interface ProviderProjectList {
  projects: ProviderProjectOption[];
  truncated: boolean;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  getStatus(): Promise<ProviderSnapshot>;
  connect(request: ProviderConnectRequest): Promise<ProviderConnectResult>;
  disconnect(): Promise<void>;
  refresh(): Promise<ProviderSnapshot>;
  /** Ephemeral choices used during provider connection. Never persisted by the relay core. */
  listProjects?(): Promise<ProviderProjectList>;
  ingest?(payload: unknown): Promise<ProviderSnapshot>;
  /** Explicit provider-wide sign-out. Never called by disconnect(). */
  logout?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface DashboardProvider {
  id: string;
  name: string;
  status: "connected" | "degraded" | "disconnected";
  lastSyncAt: string | null;
  ingestion: "none" | "event" | "poll" | "import";
  agents: number;
  totalTokensToday: number;
  costTodayUsd: number;
  primaryUsageWindowId: string | null;
  usageWindows: UsageWindow[];
}

export interface DashboardSnapshot {
  generatedAt: string;
  windowMinutes: number;
  windowStart: string;
  windowEnd: string;
  summary: {
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
  };
  usageSeries: JsonValue[];
  agents: JsonValue[];
  runs: JsonValue[];
  events: JsonValue[];
  costByModel: JsonValue[];
  dailyHistory: Array<{
    date: string;
    label: string;
    totalTokens: number;
    costUsd: number;
    runs: number;
    successRate: number;
    p95LatencyMs: number;
  }>;
  agentHistoryMatrix: JsonValue[];
  providerHistoryMatrix: Array<{
    providerId: string;
    date: string;
    label: string;
    tokens: number;
    costUsd: number;
    intensity: number;
  }>;
  providers: DashboardProvider[];
}
