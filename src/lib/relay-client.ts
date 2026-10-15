import type { DashboardSnapshot, ProviderId } from "@/lib/runmeter-types";
import {
  DEFAULT_RELAY_ORIGIN,
  clearRelaySession,
  readRelaySession,
  type StoredRelaySession,
} from "@/lib/relay-storage";
import { validateDashboardSnapshot } from "@/lib/validate-dashboard-snapshot";

const REQUEST_TIMEOUT_MS = 8_000;
const PROVIDER_OPERATION_TIMEOUT_MS = 90_000;
const GEMINI_PROJECT_SELECTION_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface RelayHealth {
  ok: true;
  service: "RunMeter Relay";
  version: 1;
  providers: ProviderId[];
}

export interface RelayPairResponse {
  token: string;
  tokenVersion?: string;
  expiresAt?: string;
}

export interface ProviderConnectResult {
  kind?: "connected" | "action-required" | "unsupported";
  code?: string;
  status?: string;
  connected?: boolean;
  message?: string;
  actionType?: "auth-url" | "device-code" | "instructions" | string;
  authUrl?: string;
  deviceCode?: string;
  userCode?: string;
  instructions?: string[];
  command?: string;
  expiresAt?: string;
}

export interface RelayProviderSnapshot {
  providerId: ProviderId;
  displayName: string;
  status: "disconnected" | "connecting" | "connected" | "degraded" | "error";
  ingestion: "none" | "event" | "poll" | "import";
  updatedAt: string | null;
  windows: Array<{
    id: string;
    label: string;
    usedPercent: number | null;
    resetsAt: string | null;
    source: "provider" | "local";
    estimated: boolean;
    used?: number;
    limit?: number;
    unit?: string;
  }>;
  dailyUsage: Array<{
    date: string;
    tokens?: number;
    requests?: number;
    costUsd?: number;
  }>;
  error?: {
    code: string;
    message: string;
  };
  metadata?: {
    connectionStage?: "google-auth" | "choose-project";
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type GeminiProjectState =
  | "STATE_UNSPECIFIED"
  | "ACTIVE"
  | "DELETE_REQUESTED";

export interface GeminiProject {
  id: string;
  displayName: string;
  state: GeminiProjectState;
}

export interface GeminiProjectsResponse {
  projects: GeminiProject[];
  truncated: boolean;
}

export interface ProviderConnectPayload {
  mode?: string;
  options?: Record<string, string>;
}

export class RelayRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RelayRequestError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function secureExternalUrl(value: string | undefined) {
  if (!value || value.length > 4_096) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function validDate(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validNonnegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validJson(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 10_000 && value.every((item) => validJson(item, depth + 1));
  }
  const valueRecord = asRecord(value);
  return (
    Object.keys(valueRecord).length <= 1_000 &&
    Object.values(valueRecord).every((item) => validJson(item, depth + 1))
  );
}

async function readBody(response: Response) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new RelayRequestError("Relayの応答サイズが上限を超えています", 502);
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RelayRequestError("Relayの応答サイズが上限を超えています", 502);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function errorMessage(body: unknown, fallback: string) {
  const record = asRecord(body);
  const nestedError = asRecord(record.error);
  return (
    firstString(record, ["message", "detail"]) ??
    firstString(nestedError, ["message", "detail"]) ??
    fallback
  );
}

function errorCode(body: unknown) {
  const record = asRecord(body);
  const nestedError = asRecord(record.error);
  return firstString(record, ["code", "errorCode", "error_code"]) ??
    firstString(nestedError, ["code", "errorCode", "error_code"]);
}

async function relayFetch(
  path: string,
  init: RequestInit = {},
  token?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  try {
    const response = await fetch(`${DEFAULT_RELAY_ORIGIN}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new RelayRequestError(
        errorMessage(body, "端末のRunMeter Relayでエラーが発生しました"),
        response.status,
        errorCode(body),
      );
    }
    return body;
  } catch (error) {
    if (error instanceof RelayRequestError) throw error;
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new RelayRequestError(
        "Relayでの処理が時間内に完了しませんでした。少し待ってから状態を再確認してください。",
        504,
        "relay_timeout",
      );
    }
    throw new RelayRequestError(
      "この端末のRunMeter Relayに接続できません。Relayを起動してから再試行してください。",
      null,
    );
  }
}

function normalizePairResponse(body: unknown): RelayPairResponse {
  const record = asRecord(body);
  const token = firstString(record, ["token", "pairingToken", "accessToken"]);
  const tokenVersion = firstString(record, ["tokenVersion", "token_version", "version"]);
  const expiresAt = firstString(record, ["expiresAt", "expires_at"]);
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (
    !token ||
    !/^[A-Za-z0-9_-]{40,128}$/.test(token) ||
    tokenVersion !== "1" ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.now() + 31 * 24 * 60 * 60 * 1_000
  ) {
    throw new RelayRequestError("Relayからペアリング情報を受け取れませんでした", 502);
  }
  return {
    token,
    tokenVersion,
    expiresAt,
  };
}

function normalizeHealth(body: unknown): RelayHealth {
  const record = asRecord(body);
  const providerIds = new Set<ProviderId>(["codex", "claude", "gemini"]);
  const providers = Array.isArray(record.providers)
    ? record.providers.filter(
        (provider): provider is ProviderId =>
          typeof provider === "string" && providerIds.has(provider as ProviderId),
      )
    : [];
  if (
    record.ok !== true ||
    record.service !== "RunMeter Relay" ||
    record.version !== 1 ||
    providers.length === 0 ||
    !Array.isArray(record.providers) ||
    providers.length !== record.providers.length ||
    new Set(providers).size !== providers.length
  ) {
    throw new RelayRequestError(
      "このポートでRunMeter Relayを確認できませんでした",
      502,
    );
  }
  return { ok: true, service: "RunMeter Relay", version: 1, providers };
}

function normalizeConnectResult(body: unknown): ProviderConnectResult {
  const record = asRecord(body);
  const action = asRecord(record.action);
  const oauth = asRecord(record.oauth);
  const device = asRecord(record.device);
  const kindValue = firstString(record, ["kind", "result"]);
  const candidateAuthUrl =
    firstString(record, ["authUrl", "url", "verificationUrl", "verificationUri", "verification_uri"]) ??
    firstString(action, ["authUrl", "url", "verificationUrl", "verificationUri", "verification_uri"]) ??
    firstString(oauth, ["authUrl", "url", "verificationUri", "verification_uri"]);
  const authUrl =
    kindValue === "unsupported" ? undefined : secureExternalUrl(candidateAuthUrl);
  const userCode =
    firstString(record, ["userCode", "user_code"]) ??
    firstString(action, ["userCode", "user_code", "code"]) ??
    firstString(device, ["userCode", "user_code"]);
  const deviceCode =
    firstString(record, ["deviceCode", "device_code", "code"]) ??
    firstString(action, ["deviceCode", "device_code"]) ??
    firstString(device, ["deviceCode", "device_code", "code"]);
  const rawInstructions = record.instructions ?? action.instructions ?? action.steps;
  const instructions = Array.isArray(rawInstructions)
    ? rawInstructions
        .filter((item): item is string => typeof item === "string")
        .slice(0, 20)
        .map((item) => item.slice(0, 500))
    : typeof rawInstructions === "string"
      ? [rawInstructions]
      : undefined;

  return {
    kind:
      kindValue === "connected" ||
      kindValue === "action-required" ||
      kindValue === "unsupported"
        ? kindValue
        : undefined,
    code:
      firstString(record, ["code", "errorCode", "error_code"]) ??
      firstString(action, ["code", "errorCode", "error_code"]),
    status: firstString(record, ["status"]),
    connected: typeof record.connected === "boolean" ? record.connected : undefined,
    message: firstString(record, ["message", "detail"]),
    actionType: firstString(action, ["type"]) ?? firstString(record, ["actionType"]),
    authUrl,
    deviceCode,
    userCode,
    instructions,
    command: firstString(action, ["command"]),
    expiresAt:
      firstString(record, ["expiresAt", "expires_at"]) ??
      firstString(action, ["expiresAt", "expires_at"]),
  };
}

function normalizeProviderSnapshot(body: unknown): RelayProviderSnapshot {
  const wrapper = asRecord(body);
  const snapshotRecord = asRecord(wrapper.snapshot);
  const item = Object.keys(snapshotRecord).length > 0 ? snapshotRecord : wrapper;
  const providerId = firstString(item, ["providerId"]);
  const status = firstString(item, ["status"]);
  const ingestion = firstString(item, ["ingestion"]);
  const windows = item.windows;
  const dailyUsage = item.dailyUsage;
  const validWindows =
    Array.isArray(windows) &&
    windows.length <= 1_000 &&
    windows.every((window) => {
      const value = asRecord(window);
      const usedPercent = value.usedPercent;
      return (
        typeof value.id === "string" &&
        value.id.length > 0 &&
        typeof value.label === "string" &&
        (usedPercent === null ||
          (typeof usedPercent === "number" &&
            Number.isFinite(usedPercent) &&
            usedPercent >= 0 &&
            usedPercent <= 100)) &&
        (value.resetsAt === null || validDate(value.resetsAt)) &&
        (value.source === "provider" || value.source === "local") &&
        typeof value.estimated === "boolean" &&
        (value.used === undefined || validNonnegative(value.used)) &&
        (value.limit === undefined || validNonnegative(value.limit)) &&
        (value.unit === undefined || typeof value.unit === "string")
      );
    });
  const validDailyUsage =
    Array.isArray(dailyUsage) &&
    dailyUsage.length <= 100_000 &&
    dailyUsage.every((day) => {
      const value = asRecord(day);
      return (
        validDate(value.date) &&
        (value.tokens === undefined || validNonnegative(value.tokens)) &&
        (value.requests === undefined || validNonnegative(value.requests)) &&
        (value.costUsd === undefined || validNonnegative(value.costUsd))
      );
    });
  const validTokenSummary =
    item.tokenSummary === undefined ||
    Object.values(asRecord(item.tokenSummary)).every(validNonnegative);
  const validError =
    item.error === undefined ||
    (typeof asRecord(item.error).code === "string" &&
      typeof asRecord(item.error).message === "string");
  const metadata = asRecord(item.metadata);
  const connectionStage = metadata.connectionStage;
  const validMetadata =
    item.metadata === undefined ||
    (item.metadata !== null &&
      typeof item.metadata === "object" &&
      !Array.isArray(item.metadata) &&
      validJson(item.metadata) &&
      (connectionStage === undefined ||
        connectionStage === "google-auth" ||
        connectionStage === "choose-project"));

  if (
    !providerId ||
    !["codex", "claude", "gemini"].includes(providerId) ||
    typeof item.displayName !== "string" ||
    !status ||
    !["disconnected", "connecting", "connected", "degraded", "error"].includes(status) ||
    !ingestion ||
    !["none", "event", "poll", "import"].includes(ingestion) ||
    (item.updatedAt !== null && !validDate(item.updatedAt)) ||
    !validWindows ||
    !validDailyUsage ||
    !validTokenSummary ||
    !validMetadata ||
    !validError
  ) {
    throw new RelayRequestError("Relayからサービス状態を安全に読み取れませんでした", 502);
  }

  return item as unknown as RelayProviderSnapshot;
}

const GEMINI_PROJECT_STATES = new Set<GeminiProjectState>([
  "STATE_UNSPECIFIED",
  "ACTIVE",
  "DELETE_REQUESTED",
]);

function normalizeGeminiProjects(body: unknown): GeminiProjectsResponse {
  const record = asRecord(body);
  if (!Array.isArray(record.projects) || record.projects.length > 10_000) {
    throw new RelayRequestError(
      "RelayからGoogle Cloudプロジェクト一覧を安全に読み取れませんでした",
      502,
      "invalid_gemini_projects_response",
    );
  }
  if (typeof record.truncated !== "boolean") {
    throw new RelayRequestError(
      "RelayからGoogle Cloudプロジェクト一覧を安全に読み取れませんでした",
      502,
      "invalid_gemini_projects_response",
    );
  }

  const projects: GeminiProject[] = [];
  const projectIds = new Set<string>();
  for (const projectValue of record.projects) {
    const project = asRecord(projectValue);
    const id = project.id;
    const displayName = project.displayName;
    const state = project.state;
    if (
      typeof id !== "string" ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id) ||
      projectIds.has(id) ||
      typeof displayName !== "string" ||
      displayName.trim().length === 0 ||
      displayName.length > 256 ||
      typeof state !== "string" ||
      !GEMINI_PROJECT_STATES.has(state as GeminiProjectState)
    ) {
      throw new RelayRequestError(
        "RelayからGoogle Cloudプロジェクト一覧を安全に読み取れませんでした",
        502,
        "invalid_gemini_projects_response",
      );
    }
    projectIds.add(id);
    projects.push({
      id,
      displayName: displayName.trim(),
      state: state as GeminiProjectState,
    });
  }

  return { projects, truncated: record.truncated };
}

function normalizeSnapshot(body: unknown): DashboardSnapshot {
  const record = asRecord(body);
  const snapshot = asRecord(record.snapshot);
  const candidate = Object.keys(snapshot).length > 0 ? snapshot : record;
  const validated = validateDashboardSnapshot(candidate);
  if (!validated) {
    throw new RelayRequestError("Relayから利用状況を読み取れませんでした", 502);
  }
  return validated;
}

export class RunMeterRelayClient {
  constructor(private readonly session?: StoredRelaySession) {}

  async forgetSession() {
    return clearRelaySession(this.requireToken());
  }

  async isCurrentSession() {
    return (await readRelaySession())?.token === this.requireToken();
  }

  async health() {
    return normalizeHealth(await relayFetch("/v1/health"));
  }

  async pair(code: string) {
    const body = await relayFetch("/v1/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    return normalizePairResponse(body);
  }

  async snapshot(signal?: AbortSignal) {
    const body = await relayFetch("/v1/snapshot", { signal }, this.requireToken());
    return normalizeSnapshot(body);
  }

  async providerSnapshot(providerId: ProviderId) {
    const body = await relayFetch(
      `/v1/providers/${providerId}`,
      {},
      this.requireToken(),
    );
    return normalizeProviderSnapshot(body);
  }

  async geminiProjects() {
    const body = await relayFetch(
      "/v1/providers/gemini/projects",
      {},
      this.requireToken(),
      PROVIDER_OPERATION_TIMEOUT_MS,
    );
    return normalizeGeminiProjects(body);
  }

  async connectProvider(providerId: ProviderId, payload: ProviderConnectPayload = {}) {
    const timeoutMs =
      providerId === "gemini" && payload.mode === "select-project"
        ? GEMINI_PROJECT_SELECTION_TIMEOUT_MS
        : PROVIDER_OPERATION_TIMEOUT_MS;
    const body = await relayFetch(
      `/v1/providers/${providerId}/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      this.requireToken(),
      timeoutMs,
    );
    return normalizeConnectResult(body);
  }

  async disconnectProvider(providerId: ProviderId) {
    await relayFetch(
      `/v1/providers/${providerId}/disconnect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      this.requireToken(),
    );
  }

  async unpair() {
    try {
      await relayFetch(
        "/v1/pair",
        { method: "DELETE" },
        this.requireToken(),
      );
    } catch (error) {
      if (!(error instanceof RelayRequestError) || error.status !== 404) throw error;
      try {
        await relayFetch(
          "/v1/unpair",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
          this.requireToken(),
        );
      } catch (fallbackError) {
        if (
          !(fallbackError instanceof RelayRequestError) ||
          fallbackError.status !== 404
        ) {
          throw fallbackError;
        }
      }
    }
  }

  async refreshProvider(providerId: ProviderId) {
    const body = await relayFetch(
      `/v1/providers/${providerId}/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      this.requireToken(),
      PROVIDER_OPERATION_TIMEOUT_MS,
    );
    return normalizeConnectResult(body);
  }

  private requireToken() {
    if (!this.session?.token) {
      throw new RelayRequestError("先にこのブラウザを端末とペアリングしてください", 401);
    }
    return this.session.token;
  }
}

export const RELAY_SNAPSHOT_EVENT = "runmeter:relay-snapshot";

export function publishRelaySnapshot(snapshot: DashboardSnapshot) {
  window.dispatchEvent(
    new CustomEvent<DashboardSnapshot>(RELAY_SNAPSHOT_EVENT, { detail: snapshot }),
  );
}

export function subscribeRelaySnapshot(
  listener: (snapshot: DashboardSnapshot) => void,
) {
  const handleSnapshot = (event: Event) => {
    listener((event as CustomEvent<DashboardSnapshot>).detail);
  };
  window.addEventListener(RELAY_SNAPSHOT_EVENT, handleSnapshot);
  return () => window.removeEventListener(RELAY_SNAPSHOT_EVENT, handleSnapshot);
}
