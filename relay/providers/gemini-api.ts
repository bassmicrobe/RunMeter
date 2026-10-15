import { createHash, randomBytes } from "node:crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MONITORING_API = "https://monitoring.googleapis.com/v3";
const RESOURCE_MANAGER_API =
  "https://cloudresourcemanager.googleapis.com/v3/projects:search";
const RESOURCE_MANAGER_PROJECT_API =
  "https://cloudresourcemanager.googleapis.com/v3/projects";
export const GOOGLE_MONITORING_SCOPE =
  "https://www.googleapis.com/auth/monitoring.read";
export const GOOGLE_PROJECTS_SCOPE =
  "https://www.googleapis.com/auth/cloudplatformprojects.readonly";
export const GOOGLE_OAUTH_SCOPES = [
  GOOGLE_MONITORING_SCOPE,
  GOOGLE_PROJECTS_SCOPE,
] as const;
const REQUEST_TIMEOUT_MS = 20_000;
const PROJECT_PAGE_SIZE = 100;
const MAX_PROJECT_PAGES = 10;
export const MAX_GOOGLE_PROJECTS = 500;

export type GooglePkce = {
  verifier: string;
  challenge: string;
  state: string;
};

export type GoogleToken = {
  accessToken: string;
  expiresAt: string;
  refreshToken: string | null;
  scope: string | null;
};

export type GeminiQuotaWindow = {
  id: string;
  label: string;
  model: string | null;
  used: number;
  limit: number;
  usedPercent: number;
  unit: string;
  resetsAt: string | null;
  estimatedReset: boolean;
};

export type GeminiDailyUsage = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type GeminiUsageReport = {
  windows: GeminiQuotaWindow[];
  daily: GeminiDailyUsage[];
  fetchedAt: string;
};

export type GoogleCloudProject = {
  id: string;
  displayName: string;
  state: "ACTIVE";
};

export type GoogleCloudProjectList = {
  projects: GoogleCloudProject[];
  truncated: boolean;
};

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code:
      | "oauth_denied"
      | "unauthorized"
      | "forbidden"
      | "rate_limited"
      | "api_disabled"
      | "provider_error"
      | "invalid_response"
      | "oauth_client_unconfigured"
      | "oauth_scope_missing"
      | "project_selection_required"
      | "project_selection_expired"
      | "project_not_available",
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

type JsonRecord = Record<string, unknown>;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createGooglePkce(): GooglePkce {
  const verifier = base64Url(randomBytes(48));
  return {
    verifier,
    challenge: base64Url(createHash("sha256").update(verifier).digest()),
    state: base64Url(randomBytes(24)),
  };
}

export function buildGoogleAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  pkce: GooglePkce;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: input.pkce.challenge,
    code_challenge_method: "S256",
    state: input.pkce.state,
  }).toString();
  return url.toString();
}

export function isValidGoogleProjectId(value: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
}

function safeProjectDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 128);
  return normalized || fallback;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function googleErrorCode(
  status: number,
  body: string,
  url: string,
): GoogleApiError["code"] {
  if (
    status === 400 &&
    url === GOOGLE_TOKEN_URL &&
    /(?:"error"\s*:\s*"invalid_grant"|\binvalid_grant\b)/i.test(body)
  ) {
    return "unauthorized";
  }
  if (status === 401) return "unauthorized";
  if (status === 403 && /SERVICE_DISABLED|API has not been used|disabled/i.test(body)) {
    return "api_disabled";
  }
  if (
    (status === 403 || status === 404) &&
    url.startsWith(`${RESOURCE_MANAGER_PROJECT_API}/`)
  ) {
    return "project_not_available";
  }
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

async function googleFetch(
  url: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new GoogleApiError(
        `Google API returned HTTP ${response.status}.`,
        response.status,
        googleErrorCode(response.status, body, url),
      );
    }
    try {
      return body ? (JSON.parse(body) as unknown) : {};
    } catch {
      throw new GoogleApiError(
        "Google API returned invalid JSON.",
        response.status,
        "invalid_response",
      );
    }
  } catch (error) {
    if (error instanceof GoogleApiError) throw error;
    throw new GoogleApiError(
      error instanceof Error && error.name === "AbortError"
        ? "Google API request timed out."
        : error instanceof Error
          ? error.message
          : "Google API request failed.",
      0,
      "provider_error",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseToken(payload: unknown, fallbackRefreshToken?: string): GoogleToken {
  const value = record(payload);
  const accessToken = value?.access_token;
  const expiresIn = finiteNumber(value?.expires_in);
  if (typeof accessToken !== "string" || accessToken === "" || expiresIn === null) {
    throw new GoogleApiError(
      "Google OAuth token response is incomplete.",
      0,
      "invalid_response",
    );
  }
  return {
    accessToken,
    expiresAt: new Date(Date.now() + Math.max(0, expiresIn - 30) * 1_000).toISOString(),
    refreshToken:
      typeof value?.refresh_token === "string"
        ? value.refresh_token
        : (fallbackRefreshToken ?? null),
    scope: typeof value?.scope === "string" ? value.scope : null,
  };
}

export async function exchangeGoogleAuthorizationCode(input: {
  clientId: string;
  clientSecret?: string | null;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GoogleToken> {
  const parameters = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  if (input.clientSecret) parameters.set("client_secret", input.clientSecret);
  const payload = await googleFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: parameters,
  });
  return parseToken(payload);
}

export async function refreshGoogleAccessToken(input: {
  clientId: string;
  clientSecret?: string | null;
  refreshToken: string;
}): Promise<GoogleToken> {
  const parameters = new URLSearchParams({
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    grant_type: "refresh_token",
  });
  if (input.clientSecret) parameters.set("client_secret", input.clientSecret);
  const payload = await googleFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: parameters,
  });
  return parseToken(payload, input.refreshToken);
}

export async function listGoogleCloudProjects(
  accessToken: string,
  limit = MAX_GOOGLE_PROJECTS,
): Promise<GoogleCloudProjectList> {
  const finiteLimit = Number.isFinite(limit) ? Math.trunc(limit) : MAX_GOOGLE_PROJECTS;
  const normalizedLimit = Math.min(
    MAX_GOOGLE_PROJECTS,
    Math.max(1, finiteLimit),
  );
  const projects = new Map<string, GoogleCloudProject>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | null = null;
  let truncated = false;
  let pageCount = 0;

  do {
    pageCount += 1;
    const url = new URL(RESOURCE_MANAGER_API);
    const remaining = normalizedLimit - projects.size;
    url.searchParams.set(
      "pageSize",
      String(Math.min(PROJECT_PAGE_SIZE, Math.max(1, remaining))),
    );
    url.searchParams.set("query", "state:ACTIVE");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const payload = record(await googleFetch(url.toString(), {}, accessToken));
    if (!payload || (payload.projects !== undefined && !Array.isArray(payload.projects))) {
      throw new GoogleApiError(
        "Google Cloud project response is invalid.",
        0,
        "invalid_response",
      );
    }

    const entries = Array.isArray(payload.projects) ? payload.projects : [];
    const capacityBeforePage = normalizedLimit - projects.size;
    for (const entry of entries) {
      const item = record(entry);
      const projectId = typeof item?.projectId === "string" ? item.projectId : "";
      const state = item?.state;
      if (!isValidGoogleProjectId(projectId) || state !== "ACTIVE") continue;
      projects.set(projectId, {
        id: projectId,
        displayName: safeProjectDisplayName(item?.displayName, projectId),
        state: "ACTIVE",
      });
      if (projects.size >= normalizedLimit) break;
    }

    const nextPageToken = payload.nextPageToken;
    if (nextPageToken !== undefined && typeof nextPageToken !== "string") {
      throw new GoogleApiError(
        "Google Cloud project page token is invalid.",
        0,
        "invalid_response",
      );
    }
    if (typeof nextPageToken === "string" && nextPageToken.length > 4_096) {
      throw new GoogleApiError(
        "Google Cloud project page token is too large.",
        0,
        "invalid_response",
      );
    }
    pageToken = typeof nextPageToken === "string" && nextPageToken
      ? nextPageToken
      : null;
    if (projects.size >= normalizedLimit) {
      truncated = pageToken !== null || entries.length > capacityBeforePage;
      break;
    }
    if (pageToken && seenPageTokens.has(pageToken)) {
      throw new GoogleApiError(
        "Google Cloud project pagination repeated a page token.",
        0,
        "invalid_response",
      );
    }
    if (pageToken) seenPageTokens.add(pageToken);
    if (pageToken && pageCount >= MAX_PROJECT_PAGES) {
      truncated = true;
      break;
    }
  } while (pageToken);

  return {
    projects: [...projects.values()].sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName, "ja") ||
        left.id.localeCompare(right.id),
    ),
    truncated,
  };
}

export async function getGoogleCloudProject(
  accessToken: string,
  projectId: string,
): Promise<GoogleCloudProject> {
  if (!isValidGoogleProjectId(projectId)) {
    throw new GoogleApiError(
      "Google Cloud project ID is invalid.",
      422,
      "project_not_available",
    );
  }
  const url = `${RESOURCE_MANAGER_PROJECT_API}/${encodeURIComponent(projectId)}`;
  const payload = record(await googleFetch(url, {}, accessToken));
  if (
    !payload ||
    payload.projectId !== projectId ||
    payload.state !== "ACTIVE"
  ) {
    throw new GoogleApiError(
      "Google Cloud project is not active or does not match the selection.",
      403,
      "project_not_available",
    );
  }
  return {
    id: projectId,
    displayName: safeProjectDisplayName(payload.displayName, projectId),
    state: "ACTIVE",
  };
}

type MetricDescriptor = {
  type: string;
  displayName: string;
  unit: string;
};

async function listQuotaDescriptors(
  accessToken: string,
  projectId: string,
): Promise<MetricDescriptor[]> {
  const url = new URL(
    `${MONITORING_API}/projects/${encodeURIComponent(projectId)}/metricDescriptors`,
  );
  url.search = new URLSearchParams({
    filter:
      'metric.type = starts_with("generativelanguage.googleapis.com/quota/")',
    pageSize: "500",
  }).toString();
  const payload = record(await googleFetch(url.toString(), {}, accessToken));
  const descriptors = Array.isArray(payload?.metricDescriptors)
    ? payload.metricDescriptors
    : [];
  return descriptors.flatMap((entry) => {
    const item = record(entry);
    if (!item || typeof item.type !== "string" || !item.type.endsWith("/usage")) {
      return [];
    }
    return [
      {
        type: item.type,
        displayName:
          typeof item.displayName === "string"
            ? item.displayName.replace(/ quota usage$/i, "")
            : item.type.split("/").at(-2) ?? "Gemini API quota",
        unit: typeof item.unit === "string" && item.unit ? item.unit : "1",
      },
    ];
  });
}

type TimeSeriesValue = {
  labels: Record<string, string>;
  value: number;
};

function pointValue(value: unknown): number | null {
  const item = record(value);
  if (!item) return null;
  for (const key of ["int64Value", "doubleValue", "floatValue"]) {
    const parsed = finiteNumber(item[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function labelsFromSeries(value: JsonRecord): Record<string, string> {
  const metric = record(value.metric);
  const labels = record(metric?.labels);
  if (!labels) return {};
  return Object.fromEntries(
    Object.entries(labels).flatMap(([key, label]) =>
      typeof label === "string" ? [[key, label]] : [],
    ),
  );
}

async function latestMetricValues(input: {
  accessToken: string;
  projectId: string;
  metricType: string;
  startTime: string;
  endTime: string;
}): Promise<TimeSeriesValue[]> {
  const url = new URL(
    `${MONITORING_API}/projects/${encodeURIComponent(input.projectId)}/timeSeries`,
  );
  url.search = new URLSearchParams({
    filter: `metric.type = "${input.metricType}"`,
    "interval.startTime": input.startTime,
    "interval.endTime": input.endTime,
    view: "FULL",
    pageSize: "1000",
  }).toString();
  const payload = record(await googleFetch(url.toString(), {}, input.accessToken));
  const series = Array.isArray(payload?.timeSeries) ? payload.timeSeries : [];
  return series.flatMap((entry) => {
    const item = record(entry);
    if (!item || !Array.isArray(item.points)) return [];
    const point = record(item.points[0]);
    const value = pointValue(point?.value);
    return value === null ? [] : [{ labels: labelsFromSeries(item), value }];
  });
}

function quotaKey(labels: Record<string, string>): string {
  return [labels.limit_name ?? "", labels.model ?? labels.model_name ?? ""].join("|");
}

function nextMinute(now: Date): string {
  const result = new Date(now);
  result.setUTCSeconds(0, 0);
  result.setUTCMinutes(result.getUTCMinutes() + 1);
  return result.toISOString();
}

function partsInZone(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts.flatMap((part) =>
      part.type === "literal" ? [] : [[part.type, Number(part.value)]],
    ),
  );
}

function zoneOffsetMilliseconds(date: Date, timeZone: string): number {
  const parts = partsInZone(date, timeZone);
  const representedUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return representedUtc - date.getTime();
}

function nextPacificMidnight(now: Date): string {
  const timeZone = "America/Los_Angeles";
  const current = partsInZone(now, timeZone);
  const nominal = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  let candidate = new Date(
    nominal.getTime() - zoneOffsetMilliseconds(nominal, timeZone),
  );
  candidate = new Date(
    nominal.getTime() - zoneOffsetMilliseconds(candidate, timeZone),
  );
  return candidate.toISOString();
}

function inferredReset(metricType: string, labels: Record<string, string>, now: Date) {
  const value = `${metricType} ${labels.limit_name ?? ""}`.toLowerCase();
  return /per[_ -]?day|daily|rpd/.test(value)
    ? nextPacificMidnight(now)
    : nextMinute(now);
}

function preferredDescriptor(descriptor: MetricDescriptor): boolean {
  const value = descriptor.type.toLowerCase();
  return (
    value.includes("generate_content") &&
    (value.includes("request") || value.includes("input_token"))
  );
}

async function quotaWindows(input: {
  accessToken: string;
  projectId: string;
  now: Date;
}): Promise<GeminiQuotaWindow[]> {
  const descriptors = await listQuotaDescriptors(input.accessToken, input.projectId);
  const selected = [
    ...descriptors.filter(preferredDescriptor),
    ...descriptors.filter((descriptor) => !preferredDescriptor(descriptor)),
  ].slice(0, 16);
  const endTime = input.now.toISOString();
  const startTime = new Date(input.now.getTime() - 24 * 60 * 60 * 1_000).toISOString();

  const groups = await Promise.all(
    selected.map(async (descriptor) => {
      const limitType = descriptor.type.replace(/\/usage$/, "/limit");
      const [usage, limits] = await Promise.all([
        latestMetricValues({ ...input, metricType: descriptor.type, startTime, endTime }),
        latestMetricValues({ ...input, metricType: limitType, startTime, endTime }),
      ]);
      const limitByKey = new Map<
        string,
        { value: number; labels: Record<string, string> }
      >();
      for (const entry of limits) {
        const key = quotaKey(entry.labels);
        const current = limitByKey.get(key);
        limitByKey.set(key, {
          value: Math.max(current?.value ?? 0, entry.value),
          labels: current?.labels ?? entry.labels,
        });
      }
      const usageByKey = new Map<
        string,
        { value: number; labels: Record<string, string> }
      >();
      for (const entry of usage) {
        const key = quotaKey(entry.labels);
        const current = usageByKey.get(key);
        usageByKey.set(key, {
          value: (current?.value ?? 0) + entry.value,
          labels: current?.labels ?? entry.labels,
        });
      }

      const keys = new Set([...limitByKey.keys(), ...usageByKey.keys()]);
      return [...keys].flatMap((key) => {
        const usageEntry = usageByKey.get(key);
        const limitEntry = limitByKey.get(key);
        const limit = limitEntry?.value ?? 0;
        if (!(limit > 0)) return [];
        const labels = usageEntry?.labels ?? limitEntry?.labels ?? {};
        const used = Math.max(0, usageEntry?.value ?? 0);
        const model = labels.model ?? labels.model_name ?? null;
        return [
          {
            id: `${descriptor.type}:${key}`,
            label: model ? `${descriptor.displayName}・${model}` : descriptor.displayName,
            model,
            used,
            limit,
            usedPercent: Math.min(
              100,
              Math.max(0, (used / limit) * 100),
            ),
            unit: descriptor.unit,
            resetsAt: inferredReset(descriptor.type, labels, input.now),
            estimatedReset: true,
          },
        ];
      });
    }),
  );

  return groups
    .flat()
    .sort(
      (left, right) =>
        right.usedPercent - left.usedPercent || left.id.localeCompare(right.id),
    )
    .slice(0, 12);
}

async function dailyMetric(input: {
  accessToken: string;
  projectId: string;
  metricType: string;
  now: Date;
}): Promise<Map<string, number>> {
  const url = new URL(
    `${MONITORING_API}/projects/${encodeURIComponent(input.projectId)}/timeSeries`,
  );
  url.search = new URLSearchParams({
    filter: `metric.type = "${input.metricType}"`,
    "interval.startTime": new Date(
      input.now.getTime() - 7 * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    "interval.endTime": input.now.toISOString(),
    "aggregation.alignmentPeriod": "86400s",
    "aggregation.perSeriesAligner": "ALIGN_SUM",
    "aggregation.crossSeriesReducer": "REDUCE_SUM",
    view: "FULL",
  }).toString();
  const payload = record(await googleFetch(url.toString(), {}, input.accessToken));
  const result = new Map<string, number>();
  const series = Array.isArray(payload?.timeSeries) ? payload.timeSeries : [];
  for (const entry of series) {
    const item = record(entry);
    if (!item || !Array.isArray(item.points)) continue;
    for (const entryPoint of item.points) {
      const point = record(entryPoint);
      const interval = record(point?.interval);
      const endTime = typeof interval?.endTime === "string" ? interval.endTime : null;
      const value = pointValue(point?.value);
      if (!endTime || value === null) continue;
      const date = endTime.slice(0, 10);
      result.set(date, (result.get(date) ?? 0) + Math.max(0, value));
    }
  }
  return result;
}

export async function fetchGeminiUsageReport(
  accessToken: string,
  projectId: string,
  now = new Date(),
): Promise<GeminiUsageReport> {
  if (!accessToken.trim()) {
    throw new GoogleApiError("Google access token is required.", 0, "unauthorized");
  }
  if (!isValidGoogleProjectId(projectId)) {
    throw new GoogleApiError("Google Cloud project ID is invalid.", 0, "invalid_response");
  }
  const [windows, inputTokens, outputTokens] = await Promise.all([
    quotaWindows({ accessToken, projectId, now }),
    dailyMetric({
      accessToken,
      projectId,
      metricType: "generativelanguage.googleapis.com/generate_content_usage_input_token_count",
      now,
    }),
    dailyMetric({
      accessToken,
      projectId,
      metricType: "generativelanguage.googleapis.com/generate_content_usage_output_token_count",
      now,
    }),
  ]);
  const dates = new Set([...inputTokens.keys(), ...outputTokens.keys()]);
  const daily = [...dates]
    .sort()
    .map((date) => {
      const input = inputTokens.get(date) ?? 0;
      const output = outputTokens.get(date) ?? 0;
      return { date, inputTokens: input, outputTokens: output, totalTokens: input + output };
    });
  return { windows, daily, fetchedAt: now.toISOString() };
}
