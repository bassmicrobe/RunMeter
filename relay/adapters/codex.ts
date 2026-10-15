import type {
  DailyUsage,
  JsonObject,
  ProviderAdapter,
  ProviderConnectRequest,
  ProviderConnectResult,
  ProviderSnapshot,
  TokenSummary,
  UsageWindow,
} from "../core/types.ts";
import type { RelayStore } from "../storage.ts";
import {
  CodexAppServerClient,
  type CodexRpcClient,
} from "./codex-app-server-client.ts";

type UnknownRecord = Record<string, unknown>;
const STATUS_CACHE_MS = 10_000;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= Number.MAX_SAFE_INTEGER
    ? Math.floor(number)
    : undefined;
}

function isoFromEpochSeconds(value: unknown): string | null {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeString(value: unknown, max = 80): string | null {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, max)
    : null;
}

function durationLabel(minutes: number | null): string {
  if (minutes === null) return "利用枠";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}週間`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}日`;
  if (minutes % 60 === 0) return `${minutes / 60}時間`;
  return `${minutes}分`;
}

interface CodexRateLimitBucket {
  bucket: UnknownRecord;
  limitId: string;
  limitName: string | null;
  canonical: boolean;
  identified: boolean;
}

interface NormalizedCodexRateLimitBucket extends CodexRateLimitBucket {
  windows: UsageWindow[];
}

function normalizedIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function isCodexBucket(limitId: string): boolean {
  return normalizedIdentifier(limitId) === "codex";
}

function isSparkBucket(limitId: string, limitName: string | null): boolean {
  return /spark/i.test(`${limitId} ${limitName ?? ""}`);
}

function bucketRank(bucket: CodexRateLimitBucket): number {
  // RunMeterの主メーターは通常Codex枠を表示する。App Serverの
  // backward-compatible bucketがSparkを指す場合も、Sparkは補助表示に回す。
  if (isCodexBucket(bucket.limitId)) return 0;
  if (bucket.canonical && !isSparkBucket(bucket.limitId, bucket.limitName)) return 1;
  if (bucket.identified && !isSparkBucket(bucket.limitId, bucket.limitName)) return 2;
  if (isSparkBucket(bucket.limitId, bucket.limitName)) return 3;
  return 4;
}

function compareBuckets(
  left: CodexRateLimitBucket,
  right: CodexRateLimitBucket,
): number {
  return (
    bucketRank(left) - bucketRank(right) ||
    normalizedIdentifier(left.limitId).localeCompare(
      normalizedIdentifier(right.limitId),
      "en",
    ) ||
    (left.limitName ?? "").localeCompare(right.limitName ?? "", "en")
  );
}

function preferredWindow(bucket: NormalizedCodexRateLimitBucket): UsageWindow | null {
  return (
    bucket.windows.find((window) => window.id.endsWith(":primary")) ??
    bucket.windows[0] ??
    null
  );
}

function normalizeRateWindow(
  limitId: string,
  limitName: string | null,
  position: "primary" | "secondary",
  raw: unknown,
): UsageWindow | null {
  const window = record(raw);
  if (!window) return null;
  const used = finiteNumber(window.usedPercent);
  const duration = finiteNumber(window.windowDurationMins);
  const durationText = durationLabel(duration);
  const bucketName = isCodexBucket(limitId)
    ? "Codex 通常枠"
    : limitName && normalizedIdentifier(limitName) !== normalizedIdentifier(limitId)
      ? limitName
      : isSparkBucket(limitId, limitName)
        ? "Codex Spark"
        : null;
  return {
    id: `${limitId}:${position}`,
    label: bucketName ? `${bucketName}・${durationText}` : durationText,
    usedPercent: used === null ? null : Math.min(100, Math.max(0, used)),
    resetsAt: isoFromEpochSeconds(window.resetsAt),
    source: "provider",
    estimated: false,
  };
}

export function normalizeCodexRateLimits(value: unknown): {
  windows: UsageWindow[];
  primaryUsageWindowId: string | null;
  metadata: JsonObject;
} {
  const result = record(value);
  const keyed = record(result?.rateLimitsByLimitId);
  const singleBucket = record(result?.rateLimits);
  const canonicalLimitId = safeString(singleBucket?.limitId);
  const canonicalIdentifier = canonicalLimitId
    ? normalizedIdentifier(canonicalLimitId)
    : null;
  const buckets: CodexRateLimitBucket[] = [];
  const bucketIdentifiers = new Set<string>();

  if (keyed) {
    for (const [index, [key, rawBucket]] of Object.entries(keyed).entries()) {
      const bucket = record(rawBucket);
      if (!bucket) continue;
      const explicitLimitId = safeString(bucket.limitId);
      const keyedLimitId = safeString(key);
      const limitId = explicitLimitId ?? keyedLimitId ?? `bucket-${index + 1}`;
      const identifier = normalizedIdentifier(limitId);
      if (bucketIdentifiers.has(identifier)) continue;
      bucketIdentifiers.add(identifier);
      buckets.push({
        bucket,
        limitId,
        limitName: safeString(bucket.limitName),
        canonical: canonicalIdentifier === identifier,
        identified: explicitLimitId !== null || keyedLimitId !== null,
      });
    }
  }

  if (singleBucket) {
    const fallbackLimitId = canonicalLimitId ?? "codex";
    const shouldAddSingleBucket =
      buckets.length === 0 ||
      (canonicalIdentifier !== null && !bucketIdentifiers.has(canonicalIdentifier));
    if (shouldAddSingleBucket) {
      buckets.push({
        bucket: singleBucket,
        limitId: fallbackLimitId,
        limitName: safeString(singleBucket.limitName),
        canonical: canonicalIdentifier !== null,
        identified: canonicalLimitId !== null,
      });
    }
  }

  buckets.sort(compareBuckets);

  const windows: UsageWindow[] = [];
  const reachedTypes: string[] = [];
  const normalizedBuckets: NormalizedCodexRateLimitBucket[] = [];
  for (const descriptor of buckets) {
    const reached = safeString(descriptor.bucket.rateLimitReachedType);
    if (reached) reachedTypes.push(reached);
    const bucketWindows = [
      normalizeRateWindow(
        descriptor.limitId,
        descriptor.limitName,
        "primary",
        descriptor.bucket.primary,
      ),
      normalizeRateWindow(
        descriptor.limitId,
        descriptor.limitName,
        "secondary",
        descriptor.bucket.secondary,
      ),
    ].filter((window): window is UsageWindow => window !== null);
    windows.push(...bucketWindows);
    normalizedBuckets.push({ ...descriptor, windows: bucketWindows });
  }

  const primaryUsageWindowId =
    normalizedBuckets.map(preferredWindow).find((window) => window !== null)?.id ??
    null;

  const resetCredits = record(result?.rateLimitResetCredits);
  const availableResetCredits = nonNegativeInteger(resetCredits?.availableCount);
  return {
    windows,
    primaryUsageWindowId,
    metadata: {
      ...(canonicalLimitId ? { canonicalRateLimitId: canonicalLimitId } : {}),
      ...(reachedTypes.length > 0 ? { rateLimitReachedTypes: reachedTypes } : {}),
      ...(availableResetCredits !== undefined ? { availableResetCredits } : {}),
    },
  };
}

export function normalizeCodexUsage(value: unknown): {
  dailyUsage: DailyUsage[];
  tokenSummary?: TokenSummary;
  metadata: JsonObject;
} {
  const result = record(value);
  const rawSummary = record(result?.summary);
  const summary: TokenSummary = {
    lifetimeTokens: nonNegativeInteger(rawSummary?.lifetimeTokens),
    peakDailyTokens: nonNegativeInteger(rawSummary?.peakDailyTokens),
  };
  const tokenSummary = Object.values(summary).some((entry) => entry !== undefined)
    ? summary
    : undefined;

  const dailyByDate = new Map<string, DailyUsage>();
  if (Array.isArray(result?.dailyUsageBuckets)) {
    for (const rawBucket of result.dailyUsageBuckets) {
      const bucket = record(rawBucket);
      const date = safeString(bucket?.startDate, 10);
      const tokens = nonNegativeInteger(bucket?.tokens);
      if (
        date && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
        new Date(`${date}T00:00:00Z`).toISOString().startsWith(date) &&
        tokens !== undefined
      ) {
        dailyByDate.set(date, { date, tokens });
      }
    }
  }

  const metadata: JsonObject = {};
  const longestRunningTurnSec = nonNegativeInteger(rawSummary?.longestRunningTurnSec);
  const currentStreakDays = nonNegativeInteger(rawSummary?.currentStreakDays);
  const longestStreakDays = nonNegativeInteger(rawSummary?.longestStreakDays);
  if (longestRunningTurnSec !== undefined) metadata.longestRunningTurnSec = longestRunningTurnSec;
  if (currentStreakDays !== undefined) metadata.currentStreakDays = currentStreakDays;
  if (longestStreakDays !== undefined) metadata.longestStreakDays = longestStreakDays;
  return { dailyUsage: [...dailyByDate.values()].sort((a, b) => a.date.localeCompare(b.date)), tokenSummary, metadata };
}

function disconnectedSnapshot(): ProviderSnapshot {
  return {
    providerId: "codex",
    displayName: "Codex",
    status: "disconnected",
    ingestion: "none",
    updatedAt: null,
    windows: [],
    dailyUsage: [],
    metadata: { attached: false },
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return "Codex CLIが見つかりません。Codex CLIをインストールし、RunMeterを再起動してください。";
  }
  return "Codexの利用状況を取得できませんでした。Codex CLIのインストールとログイン状態を確認して、再接続してください。";
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly capabilities = {
    connect: true,
    disconnect: true,
    refresh: true,
    ingest: false,
    logout: true,
  } as const;

  readonly #store: RelayStore;
  readonly #client: CodexRpcClient;
  #attached: boolean;
  #generation = 0;
  #lastStatusRefreshAt: number | null = null;
  #refreshInFlight: { generation: number; promise: Promise<ProviderSnapshot> } | null = null;
  #removeNotificationListener: (() => void) | null = null;

  constructor(store: RelayStore, client: CodexRpcClient = new CodexAppServerClient()) {
    this.#store = store;
    this.#client = client;
    const stored = store.getProviderSnapshot(this.id);
    this.#attached = stored?.metadata?.attached === true;
    this.#removeNotificationListener = client.onNotification((method) => {
      if (
        this.#attached &&
        (method === "account/login/completed" ||
          method === "account/updated" ||
          method === "account/rateLimits/updated")
      ) {
        void this.refresh().catch(() => undefined);
      }
    });
  }

  async getStatus(): Promise<ProviderSnapshot> {
    if (!this.#attached) {
      return this.#store.getProviderSnapshot(this.id) ?? disconnectedSnapshot();
    }
    if (this.#refreshInFlight?.generation === this.#generation) return this.refresh();
    const statusAge = this.#lastStatusRefreshAt === null
      ? null
      : Date.now() - this.#lastStatusRefreshAt;
    if (
      statusAge !== null &&
      statusAge >= 0 &&
      statusAge < STATUS_CACHE_MS
    ) {
      return this.#currentSnapshot();
    }
    return this.refresh();
  }

  async connect(request: ProviderConnectRequest): Promise<ProviderConnectResult> {
    const generation = ++this.#generation;
    this.#lastStatusRefreshAt = null;
    this.#attached = true;
    try {
      return await this.#connectInternal(request, generation);
    } catch (error) {
      if (!this.#isCurrent(generation)) return this.#cancelledConnection();
      const message = safeErrorMessage(error);
      const snapshot: ProviderSnapshot = {
        ...this.#currentSnapshot(),
        status: "error",
        metadata: { attached: true },
        error: { code: "codex_unavailable", message },
      };
      this.#store.saveProviderSnapshot(snapshot);
      return { kind: "unsupported", code: "codex_unavailable", message, snapshot };
    }
  }

  async #connectInternal(request: ProviderConnectRequest, generation: number): Promise<ProviderConnectResult> {
    const accountResult = record(
      await this.#client.request("account/read", { refreshToken: false }),
    );
    if (!this.#isCurrent(generation)) return this.#cancelledConnection();
    const account = record(accountResult?.account);
    if (account?.type === "chatgpt") {
      return { kind: "connected", snapshot: await this.refresh() };
    }

    const mode = request.mode === "device-code" ? "device-code" : "browser";
    const loginResult = record(
      await this.#client.request(
        "account/login/start",
        mode === "device-code"
          ? { type: "chatgptDeviceCode" }
          : {
              type: "chatgpt",
              useHostedLoginSuccessPage: true,
              appBrand: "chatgpt",
            },
        30_000,
      ),
    );
    if (!this.#isCurrent(generation)) return this.#cancelledConnection();
    this.#saveConnecting();

    if (mode === "device-code") {
      const verificationUrl = safeString(loginResult?.verificationUrl, 2_000);
      const userCode = safeString(loginResult?.userCode, 40);
      if (!verificationUrl || !userCode || !verificationUrl.startsWith("https://")) {
        throw new Error("Codex returned an invalid device-code response.");
      }
      return {
        kind: "action-required",
        action: { type: "device-code", verificationUrl, userCode },
        snapshot: this.#store.getProviderSnapshot(this.id) ?? undefined,
      };
    }

    const authUrl = safeString(loginResult?.authUrl, 4_000);
    if (!authUrl || !authUrl.startsWith("https://")) {
      throw new Error("Codex returned an invalid sign-in URL.");
    }
    return {
      kind: "action-required",
      action: { type: "open-url", url: authUrl, label: "ChatGPTでログイン" },
      snapshot: this.#store.getProviderSnapshot(this.id) ?? undefined,
    };
  }

  async disconnect(): Promise<void> {
    // Detach only. account/logout would also invalidate the user's Codex CLI session.
    this.#generation += 1;
    this.#attached = false;
    this.#lastStatusRefreshAt = null;
    this.#store.saveProviderSnapshot(disconnectedSnapshot());
    await this.#client.close();
  }

  async logout(): Promise<void> {
    const generation = ++this.#generation;
    this.#lastStatusRefreshAt = null;
    await this.#client.request("account/logout");
    if (generation !== this.#generation) return;
    this.#attached = false;
    this.#store.saveProviderSnapshot(disconnectedSnapshot());
    await this.#client.close();
  }

  async refresh(): Promise<ProviderSnapshot> {
    if (!this.#attached) return disconnectedSnapshot();
    const generation = this.#generation;
    if (this.#refreshInFlight?.generation === generation) return this.#refreshInFlight.promise;
    const operation = { generation, promise: this.#refreshInternal(generation) };
    this.#refreshInFlight = operation;
    try {
      const snapshot = await operation.promise;
      // Explicit refresh and provider notifications bypass this cache. Only
      // status polling is coalesced, including retries while a CLI is absent.
      if (this.#isCurrent(generation)) this.#lastStatusRefreshAt = Date.now();
      return snapshot;
    } finally {
      if (this.#refreshInFlight === operation) this.#refreshInFlight = null;
    }
  }

  async dispose(): Promise<void> {
    this.#generation += 1;
    this.#attached = false;
    this.#lastStatusRefreshAt = null;
    this.#removeNotificationListener?.();
    this.#removeNotificationListener = null;
    await this.#client.close();
  }

  #isCurrent(generation: number): boolean {
    return this.#attached && generation === this.#generation;
  }

  #currentSnapshot(): ProviderSnapshot {
    return this.#store.getProviderSnapshot(this.id) ?? disconnectedSnapshot();
  }

  #cancelledConnection(): ProviderConnectResult {
    return {
      kind: "unsupported",
      code: "connection_cancelled",
      message: "Codexの接続操作を取り消しました。",
      snapshot: this.#currentSnapshot(),
    };
  }

  async #refreshInternal(generation: number): Promise<ProviderSnapshot> {
    try {
      const accountResult = record(
        await this.#client.request("account/read", { refreshToken: false }),
      );
      if (!this.#isCurrent(generation)) return this.#currentSnapshot();
      const account = record(accountResult?.account);
      if (account?.type !== "chatgpt") {
        const snapshot: ProviderSnapshot = {
          ...disconnectedSnapshot(),
          status: "connecting",
          updatedAt: new Date().toISOString(),
          metadata: { attached: true },
        };
        this.#store.saveProviderSnapshot(snapshot);
        return snapshot;
      }

      const [rateResult, usageResult] = await Promise.allSettled([
        this.#client.request("account/rateLimits/read"),
        this.#client.request("account/usage/read"),
      ]);
      if (!this.#isCurrent(generation)) return this.#currentSnapshot();
      const previous = this.#store.getProviderSnapshot(this.id);
      const rates =
        rateResult.status === "fulfilled"
          ? normalizeCodexRateLimits(rateResult.value)
          : {
              windows: previous?.windows ?? [],
              primaryUsageWindowId: previous?.metadata?.primaryUsageWindowId,
              metadata: {},
            };
      const usage =
        usageResult.status === "fulfilled"
          ? normalizeCodexUsage(usageResult.value)
          : { dailyUsage: previous?.dailyUsage ?? [], tokenSummary: previous?.tokenSummary, metadata: {} };
      const planType = safeString(account.planType, 40);
      const snapshot: ProviderSnapshot = {
        providerId: this.id,
        displayName: this.displayName,
        status:
          rateResult.status === "rejected" || usageResult.status === "rejected"
            ? "degraded"
            : "connected",
        ingestion: "poll",
        updatedAt: rateResult.status === "fulfilled" ? new Date().toISOString() : previous?.updatedAt ?? null,
        windows: rates.windows,
        dailyUsage: usage.dailyUsage,
        ...(usage.tokenSummary ? { tokenSummary: usage.tokenSummary } : {}),
        metadata: {
          attached: true,
          authMode: "chatgpt",
          ...(planType ? { planType } : {}),
          ...(rates.primaryUsageWindowId
            ? { primaryUsageWindowId: rates.primaryUsageWindowId }
            : {}),
          ...rates.metadata,
          ...usage.metadata,
        },
        ...(rateResult.status === "rejected"
          ? { error: { code: "codex_rates_unavailable", message: "利用率を更新できませんでした。表示値は最後に取得できた情報です。" } }
          : usageResult.status === "rejected"
            ? { error: { code: "codex_history_unavailable", message: "利用履歴を更新できませんでした。最新の利用率のみ表示しています。" } }
            : {}),
      };
      this.#store.saveProviderSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (!this.#isCurrent(generation)) return this.#currentSnapshot();
      const previous = this.#store.getProviderSnapshot(this.id);
      const snapshot: ProviderSnapshot = {
        ...(previous ?? disconnectedSnapshot()),
        status: "error",
        updatedAt: previous?.updatedAt ?? null,
        metadata: { ...(previous?.metadata ?? {}), attached: true },
        error: { code: "codex_unavailable", message: safeErrorMessage(error) },
      };
      this.#store.saveProviderSnapshot(snapshot);
      return snapshot;
    }
  }

  #saveConnecting(): void {
    this.#store.saveProviderSnapshot({
      ...disconnectedSnapshot(),
      status: "connecting",
      updatedAt: new Date().toISOString(),
      metadata: { attached: true },
    });
  }
}
