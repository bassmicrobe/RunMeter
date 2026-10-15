import { createServer, type Server } from "node:http";

import type { CredentialVault } from "../credential-vault.ts";
import type {
  JsonObject,
  ProviderAdapter,
  ProviderConnectRequest,
  ProviderConnectResult,
  ProviderProjectList,
  ProviderSnapshot,
} from "../core/types.ts";
import {
  buildGoogleAuthorizationUrl,
  createGooglePkce,
  exchangeGoogleAuthorizationCode,
  fetchGeminiUsageReport,
  getGoogleCloudProject,
  GOOGLE_OAUTH_SCOPES,
  GoogleApiError,
  isValidGoogleProjectId,
  listGoogleCloudProjects,
  refreshGoogleAccessToken,
  type GeminiUsageReport,
  type GoogleToken,
} from "../providers/gemini-api.ts";

const CREDENTIAL_STATE_KEY = "connection-v1";
const LEGACY_REFRESH_TOKEN_KEY = "refresh-token";
const LEGACY_PENDING_REFRESH_TOKEN_KEY = "pending-refresh-token";
const LEGACY_CLIENT_SECRET_KEY = "client-secret";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1_000;
const PENDING_CREDENTIAL_TTL_MS = 10 * 60 * 1_000;
const REFRESH_INTERVAL_MS = 60_000;
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 30_000;
const MAX_REFRESH_TOKEN_LENGTH = 32_768;

interface GeminiPendingCredential {
  refreshToken: string;
  createdAt: string;
}

interface GeminiActiveCredential {
  refreshToken: string;
  projectId: string;
}

interface GeminiCredentialState {
  version: 1;
  pending?: GeminiPendingCredential;
  active?: GeminiActiveCredential;
}

interface OAuthTimer {
  server: Server;
  handle: ReturnType<typeof setTimeout>;
}

function validRefreshToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REFRESH_TOKEN_LENGTH &&
    !/[\u0000\r\n]/.test(value)
  );
}

function parseCredentialState(value: string): GeminiCredentialState | null {
  if (value.length === 0 || value.length > 100_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const state = parsed as Record<string, unknown>;
  if (state.version !== 1) return null;

  let pending: GeminiPendingCredential | undefined;
  if (state.pending !== undefined) {
    if (!state.pending || typeof state.pending !== "object" || Array.isArray(state.pending)) {
      return null;
    }
    const candidate = state.pending as Record<string, unknown>;
    if (
      !validRefreshToken(candidate.refreshToken) ||
      typeof candidate.createdAt !== "string" ||
      Number.isNaN(Date.parse(candidate.createdAt))
    ) {
      return null;
    }
    pending = {
      refreshToken: candidate.refreshToken,
      createdAt: new Date(candidate.createdAt).toISOString(),
    };
  }

  let active: GeminiActiveCredential | undefined;
  if (state.active !== undefined) {
    if (!state.active || typeof state.active !== "object" || Array.isArray(state.active)) {
      return null;
    }
    const candidate = state.active as Record<string, unknown>;
    if (
      !validRefreshToken(candidate.refreshToken) ||
      typeof candidate.projectId !== "string" ||
      !isValidGoogleProjectId(candidate.projectId)
    ) {
      return null;
    }
    active = {
      refreshToken: candidate.refreshToken,
      projectId: candidate.projectId,
    };
  }

  return pending || active ? { version: 1, ...{ pending, active } } : null;
}

function pendingCredentialExpired(
  pending: GeminiPendingCredential,
  now = Date.now(),
): boolean {
  const createdAt = Date.parse(pending.createdAt);
  return (
    Number.isNaN(createdAt) ||
    createdAt > now + 60_000 ||
    now - createdAt >= PENDING_CREDENTIAL_TTL_MS
  );
}

export type GoogleOAuthClientConfig = {
  clientId: string;
  clientSecret: string | null;
};

export function googleOAuthClientConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GoogleOAuthClientConfig | null {
  const clientId = environment.RUNMETER_GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = environment.RUNMETER_GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId) return null;
  if (
    clientId.length > 256 ||
    !/^[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(clientId)
  ) {
    throw new Error(
      "RUNMETER_GOOGLE_CLIENT_IDにはGoogle Desktop OAuthクライアントIDを設定してください。",
    );
  }
  if (clientSecret.length > 512 || /[\u0000-\u001f\u007f]/.test(clientSecret)) {
    throw new Error("RUNMETER_GOOGLE_CLIENT_SECRETの形式を確認してください。");
  }
  return { clientId, clientSecret: clientSecret || null };
}

function disconnectedSnapshot(): ProviderSnapshot {
  return {
    providerId: "gemini",
    displayName: "Gemini API",
    status: "disconnected",
    ingestion: "none",
    updatedAt: null,
    windows: [],
    dailyUsage: [],
    metadata: { scope: "google-cloud-project" },
  };
}

function snapshotFromReport(
  report: GeminiUsageReport,
  projectId: string,
): ProviderSnapshot {
  const lifetimeTokens = report.daily.reduce((sum, day) => sum + day.totalTokens, 0);
  return {
    providerId: "gemini",
    displayName: "Gemini API",
    status: "connected",
    ingestion: "poll",
    updatedAt: report.fetchedAt,
    windows: report.windows.map((window) => ({
      id: window.id,
      label: window.label,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
      source: "provider",
      // Google provides usage/limit. The reset time is inferred from the official
      // minute/day window definition, so the combined row is marked estimated.
      estimated: window.estimatedReset,
      used: window.used,
      limit: window.limit,
      unit: window.unit,
    })),
    dailyUsage: report.daily.map((day) => ({
      date: day.date,
      tokens: day.totalTokens,
    })),
    tokenSummary: {
      lifetimeTokens,
      inputTokens: report.daily.reduce((sum, day) => sum + day.inputTokens, 0),
      outputTokens: report.daily.reduce((sum, day) => sum + day.outputTokens, 0),
    },
    metadata: {
      scope: "google-cloud-project",
      projectId,
      credentialState: "active",
      metricDelaySeconds: 150,
    },
  };
}

function errorSnapshot(
  error: unknown,
  metadata: JsonObject = {},
  previous: ProviderSnapshot = disconnectedSnapshot(),
): ProviderSnapshot {
  const code = error instanceof GoogleApiError ? error.code : "provider_error";
  const previousMetadata = { ...(previous.metadata ?? {}) };
  if (metadata.credentialState === "active") {
    delete previousMetadata.connectionStage;
  }
  const messages: Record<string, string> = {
    oauth_denied: "Google認証が完了しませんでした。もう一度お試しください。",
    oauth_client_unconfigured:
      "RunMeter RelayにGoogle OAuthクライアントが設定されていません。",
    oauth_scope_missing:
      "必要なGoogle Cloudの閲覧権限が許可されませんでした。もう一度認証してください。",
    project_selection_required: "先にGoogle Cloudプロジェクトを選択してください。",
    project_selection_expired:
      "Google Cloudプロジェクトの選択期限が切れました。もう一度Google認証を行ってください。",
    project_not_available:
      "選択したGoogle Cloudプロジェクトを現在のGoogleアカウントで確認できません。",
    unauthorized: "Google認証の有効期限が切れました。再接続してください。",
    forbidden: "Google Cloud Monitoringの閲覧権限が必要です。",
    rate_limited: "Google Cloud APIの上限に達しました。しばらくして再試行します。",
    api_disabled:
      "必要なGoogle Cloud API（Cloud Resource Manager / Monitoring）を有効にしてください。",
    invalid_response: "Google Cloudの応答形式を確認できませんでした。",
    provider_error: "Gemini APIの利用状況を取得できませんでした。",
  };
  return {
    ...previous,
    status:
      previous.windows.length > 0 || previous.dailyUsage.length > 0
        ? "degraded"
        : "error",
    updatedAt: previous.updatedAt,
    metadata: {
      scope: "google-cloud-project",
      ...previousMetadata,
      ...metadata,
    },
    error: { code, message: messages[code] ?? messages.provider_error },
  };
}

function isFresh(snapshot: ProviderSnapshot): boolean {
  if (!snapshot.updatedAt) return false;
  const updatedAt = Date.parse(snapshot.updatedAt);
  return !Number.isNaN(updatedAt) && Date.now() - updatedAt < REFRESH_INTERVAL_MS;
}

function connectionStage(snapshot: ProviderSnapshot): string | null {
  const stage = snapshot.metadata?.connectionStage;
  return typeof stage === "string" ? stage : null;
}

function callbackHtml(success: boolean): string {
  const title = success
    ? "Google認証が完了しました"
    : "Google認証を完了できませんでした";
  const detail = success
    ? "RunMeterへ戻り、利用状況を確認するGoogle Cloudプロジェクトを選択してください。"
    : "RunMeterへ戻り、表示された内容を確認してからもう一度お試しください。";
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${title}</title><body style="font:16px system-ui;background:#0d1117;color:#f3f4f6;padding:48px"><main style="max-width:560px;margin:auto"><h1 style="font-size:24px">${title}</h1><p style="color:#9ca3af;line-height:1.8">${detail}</p></main></body></html>`;
}

function selectedProjectId(request: ProviderConnectRequest): string {
  const projectId =
    typeof request.options?.projectId === "string"
      ? request.options.projectId.trim()
      : "";
  if (!isValidGoogleProjectId(projectId)) {
    throw new GoogleApiError(
      "Google Cloud project ID is invalid.",
      422,
      "project_not_available",
    );
  }
  return projectId;
}

function ensureRequiredScopes(token: GoogleToken): void {
  if (!token.scope) return;
  const granted = new Set(token.scope.split(/\s+/).filter(Boolean));
  if (GOOGLE_OAUTH_SCOPES.some((scope) => !granted.has(scope))) {
    throw new GoogleApiError(
      "Google OAuth did not grant all required scopes.",
      403,
      "oauth_scope_missing",
    );
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini";
  readonly displayName = "Gemini API";
  readonly capabilities = {
    connect: true,
    disconnect: true,
    refresh: true,
    ingest: false,
  } as const;

  readonly #vault: CredentialVault;
  readonly #oauthClient: GoogleOAuthClientConfig | null;
  #snapshot: ProviderSnapshot;
  #callbackServer: Server | null = null;
  #oauthTimer: OAuthTimer | null = null;
  #pendingAccessToken: {
    value: string;
    expiresAt: string;
    generation: number;
    pendingCreatedAt: string;
  } | null = null;
  #generation = 0;
  #operationTail: Promise<void> = Promise.resolve();
  #legacyMigrationChecked = false;

  constructor(
    vault: CredentialVault,
    initialSnapshot?: ProviderSnapshot | null,
    oauthClient: GoogleOAuthClientConfig | null = null,
  ) {
    this.#vault = vault;
    this.#oauthClient = oauthClient;
    this.#snapshot =
      initialSnapshot?.providerId === this.id
        ? initialSnapshot
        : disconnectedSnapshot();
  }

  async getStatus(): Promise<ProviderSnapshot> {
    return this.#exclusive(() => this.#getStatusInternal());
  }

  async connect(request: ProviderConnectRequest): Promise<ProviderConnectResult> {
    return this.#exclusive(async () => {
      const mode = request.mode ?? "oauth";
      if (mode === "select-project") return this.#selectProject(request);
      if (mode !== "oauth") {
        return {
          kind: "unsupported",
          code: "unsupported_connect_mode",
          message: "このGemini接続方法には対応していません。",
          snapshot: this.#snapshot,
        };
      }
      if (!this.#oauthClient) {
        return {
          kind: "unsupported",
          code: "oauth_client_unconfigured",
          message:
            "RunMeter RelayにGoogle OAuthクライアントが設定されていません。開発元の設定を確認してください。",
          snapshot: this.#snapshot,
        };
      }
      return this.#startOAuth();
    });
  }

  async listProjects(): Promise<ProviderProjectList> {
    return this.#exclusive(() => this.#listProjectsInternal(this.#generation));
  }

  async disconnect(): Promise<void> {
    await this.#exclusive(async () => {
      this.#generation += 1;
      await this.#closeCallbackServer();
      this.#pendingAccessToken = null;
      await Promise.all([
        this.#vault.delete(this.id, CREDENTIAL_STATE_KEY),
        this.#vault.delete(this.id, LEGACY_REFRESH_TOKEN_KEY),
        this.#vault.delete(this.id, LEGACY_PENDING_REFRESH_TOKEN_KEY),
        this.#vault.delete(this.id, LEGACY_CLIENT_SECRET_KEY),
      ]);
      this.#legacyMigrationChecked = true;
      this.#snapshot = disconnectedSnapshot();
    });
  }

  async refresh(): Promise<ProviderSnapshot> {
    return this.#exclusive(() => {
      const stage = connectionStage(this.#snapshot);
      if (stage === "google-auth" || stage === "choose-project") {
        return Promise.resolve(this.#snapshot);
      }
      return this.#refreshInternal(this.#generation);
    });
  }

  async dispose(): Promise<void> {
    await this.#exclusive(async () => {
      this.#generation += 1;
      this.#pendingAccessToken = null;
      await this.#closeCallbackServer();
    });
  }

  async #getStatusInternal(): Promise<ProviderSnapshot> {
    const stage = connectionStage(this.#snapshot);
    if (stage === "google-auth" && this.#callbackServer) return this.#snapshot;

    const generation = this.#generation;
    const { state, expiredPending } = await this.#freshCredentialState();
    this.#assertGeneration(generation);
    if (state?.pending) {
      this.#snapshot = this.#chooseProjectSnapshot();
      return this.#snapshot;
    }

    if (!state?.active) {
      if (stage === "google-auth" || stage === "choose-project") {
        const code = expiredPending
          ? "project_selection_expired"
          : stage === "google-auth"
            ? "oauth_denied"
            : "project_selection_required";
        this.#snapshot = errorSnapshot(
          new GoogleApiError("Gemini connection state is unavailable.", 409, code),
        );
        return this.#snapshot;
      }
      this.#snapshot = disconnectedSnapshot();
      return this.#snapshot;
    }

    if (!this.#oauthClient) {
      this.#snapshot = errorSnapshot(
        new GoogleApiError(
          "Google OAuth client is not configured.",
          0,
          "oauth_client_unconfigured",
        ),
        {},
        this.#snapshot,
      );
      return this.#snapshot;
    }
    if (
      this.#snapshot.status === "connected" &&
      this.#snapshot.metadata?.projectId === state.active.projectId &&
      isFresh(this.#snapshot)
    ) {
      return this.#snapshot;
    }
    return this.#refreshInternal(generation, state);
  }

  async #startOAuth(): Promise<ProviderConnectResult> {
    const oauthClient = this.#oauthClient;
    if (!oauthClient) {
      throw new GoogleApiError(
        "Google OAuth client is not configured.",
        0,
        "oauth_client_unconfigured",
      );
    }
    const generation = ++this.#generation;
    await this.#closeCallbackServer();
    this.#assertGeneration(generation);
    this.#pendingAccessToken = null;
    const { state } = await this.#freshCredentialState();
    this.#assertGeneration(generation);
    if (state?.pending) {
      await this.#saveCredentialState(
        state.active ? { version: 1, active: state.active } : null,
      );
      this.#assertGeneration(generation);
    }

    const pkce = createGooglePkce();
    const callbackServer = createServer();
    this.#callbackServer = callbackServer;
    const callbackState = { started: false };

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      callbackServer.once("error", onError);
      callbackServer.listen(0, "127.0.0.1", () => {
        callbackServer.off("error", onError);
        resolve();
      });
    });
    this.#assertGeneration(generation);
    const address = callbackServer.address();
    if (!address || typeof address === "string") {
      await this.#closeCallbackServer();
      throw new Error("Google OAuthのコールバックを開始できませんでした。");
    }
    const callbackHost = `127.0.0.1:${address.port}`;
    const redirectUri = `http://${callbackHost}/oauth/google/callback`;
    const authUrl = buildGoogleAuthorizationUrl({
      clientId: oauthClient.clientId,
      redirectUri,
      pkce,
    });

    this.#snapshot = {
      ...disconnectedSnapshot(),
      status: "connecting",
      updatedAt: new Date().toISOString(),
      metadata: {
        scope: "google-cloud-project",
        connectionStage: "google-auth",
        ...(state?.active ? { credentialState: "active" } : {}),
      },
    };

    callbackServer.on("request", (requestMessage, response) => {
      void this.#handleCallback({
        requestUrl: requestMessage.url ?? "/",
        requestMethod: requestMessage.method ?? "GET",
        requestHost: requestMessage.headers.host ?? "",
        response,
        expectedHost: callbackHost,
        expectedState: pkce.state,
        codeVerifier: pkce.verifier,
        redirectUri,
        oauthClient,
        generation,
        server: callbackServer,
        callbackState,
      });
    });
    const timer = setTimeout(() => {
      void this.#exclusive(() => this.#expireOAuth(generation, callbackServer)).catch(
        () => undefined,
      );
    }, OAUTH_TIMEOUT_MS);
    this.#oauthTimer = { server: callbackServer, handle: timer };

    return {
      kind: "action-required",
      action: { type: "open-url", url: authUrl, label: "Googleで認証" },
      snapshot: this.#snapshot,
    };
  }

  async #selectProject(
    request: ProviderConnectRequest,
  ): Promise<ProviderConnectResult> {
    if (!this.#oauthClient) {
      return {
        kind: "unsupported",
        code: "oauth_client_unconfigured",
        message: "RunMeter RelayにGoogle OAuthクライアントが設定されていません。",
        snapshot: this.#snapshot,
      };
    }
    const generation = ++this.#generation;
    await this.#closeCallbackServer();
    this.#assertGeneration(generation);
    const projectId = selectedProjectId(request);
    const { state } = await this.#freshCredentialState();
    this.#assertGeneration(generation);
    const pending = state?.pending;
    if (!pending) {
      throw new GoogleApiError(
        "Project selection session is missing.",
        409,
        "project_selection_required",
      );
    }
    const accessToken = await this.#projectSelectionAccessToken(
      generation,
      pending,
    );
    this.#assertGeneration(generation);
    await getGoogleCloudProject(accessToken, projectId);
    this.#assertGeneration(generation);
    const report = await fetchGeminiUsageReport(accessToken, projectId);
    this.#assertGeneration(generation);
    const current = await this.#loadCredentialState();
    this.#assertGeneration(generation);
    if (
      !current?.pending ||
      current.pending.createdAt !== pending.createdAt ||
      current.pending.refreshToken !== pending.refreshToken ||
      pendingCredentialExpired(current.pending)
    ) {
      throw new GoogleApiError(
        "Project selection session is missing.",
        409,
        "project_selection_required",
      );
    }
    await this.#saveCredentialState({
      version: 1,
      active: {
        refreshToken: current.pending.refreshToken,
        projectId,
      },
    });
    this.#assertGeneration(generation);
    this.#pendingAccessToken = null;
    this.#snapshot = snapshotFromReport(report, projectId);
    return {
      kind: "connected",
      snapshot: this.#snapshot,
      message: "Gemini APIを接続しました。",
    };
  }

  async #listProjectsInternal(generation: number): Promise<ProviderProjectList> {
    const { state } = await this.#freshCredentialState();
    this.#assertGeneration(generation);
    if (!state?.pending) {
      throw new GoogleApiError(
        "Google authentication must finish before project selection.",
        409,
        "project_selection_required",
      );
    }
    this.#snapshot = this.#chooseProjectSnapshot();
    const accessToken = await this.#projectSelectionAccessToken(
      generation,
      state.pending,
    );
    this.#assertGeneration(generation);
    const projects = await listGoogleCloudProjects(accessToken);
    this.#assertGeneration(generation);
    return projects;
  }

  async #projectSelectionAccessToken(
    generation: number,
    pendingCredential: GeminiPendingCredential,
  ): Promise<string> {
    const oauthClient = this.#oauthClient;
    if (!oauthClient) {
      throw new GoogleApiError(
        "Google OAuth client is not configured.",
        0,
        "oauth_client_unconfigured",
      );
    }
    const pending = this.#pendingAccessToken;
    if (
      pending &&
      pending.generation === generation &&
      pending.pendingCreatedAt === pendingCredential.createdAt &&
      Date.parse(pending.expiresAt) - Date.now() > ACCESS_TOKEN_EXPIRY_MARGIN_MS
    ) {
      return pending.value;
    }
    const token = await refreshGoogleAccessToken({
      clientId: oauthClient.clientId,
      clientSecret: oauthClient.clientSecret,
      refreshToken: pendingCredential.refreshToken,
    });
    this.#assertGeneration(generation);
    ensureRequiredScopes(token);
    this.#pendingAccessToken = {
      value: token.accessToken,
      expiresAt: token.expiresAt,
      generation,
      pendingCreatedAt: pendingCredential.createdAt,
    };
    return token.accessToken;
  }

  async #refreshInternal(
    generation: number,
    knownState?: GeminiCredentialState | null,
  ): Promise<ProviderSnapshot> {
    const { state } = knownState
      ? { state: knownState }
      : await this.#freshCredentialState();
    this.#assertGeneration(generation);
    if (state?.pending) {
      this.#snapshot = this.#chooseProjectSnapshot();
      return this.#snapshot;
    }
    const oauthClient = this.#oauthClient;
    const active = state?.active;
    const projectId = active?.projectId;
    if (!oauthClient) {
      if (generation === this.#generation) {
        this.#snapshot = errorSnapshot(
          new GoogleApiError(
            "Google OAuth client is not configured.",
            0,
            "oauth_client_unconfigured",
          ),
          {},
          this.#snapshot,
        );
      }
      return this.#snapshot;
    }
    if (!active || !projectId) {
      this.#snapshot = disconnectedSnapshot();
      return this.#snapshot;
    }
    try {
      const token = await refreshGoogleAccessToken({
        clientId: oauthClient.clientId,
        clientSecret: oauthClient.clientSecret,
        refreshToken: active.refreshToken,
      });
      this.#assertGeneration(generation);
      const report = await fetchGeminiUsageReport(token.accessToken, projectId);
      this.#assertGeneration(generation);
      const snapshot = snapshotFromReport(report, projectId);
      this.#snapshot = snapshot;
    } catch (error) {
      if (generation === this.#generation) {
        this.#snapshot = errorSnapshot(
          error,
          { projectId, credentialState: "active" },
          this.#snapshot,
        );
      }
    }
    return this.#snapshot;
  }

  async #handleCallback(input: {
    requestUrl: string;
    requestMethod: string;
    requestHost: string;
    response: import("node:http").ServerResponse;
    expectedHost: string;
    expectedState: string;
    codeVerifier: string;
    redirectUri: string;
    oauthClient: GoogleOAuthClientConfig;
    generation: number;
    server: Server;
    callbackState: { started: boolean };
  }): Promise<void> {
    const url = new URL(input.requestUrl, input.redirectUri);
    if (input.requestHost.toLowerCase() !== input.expectedHost) {
      input.response.writeHead(421, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      input.response.end("Invalid host");
      return;
    }
    if (input.requestMethod !== "GET") {
      input.response.writeHead(405, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        Allow: "GET",
      });
      input.response.end("Method not allowed");
      return;
    }
    if (url.pathname !== "/oauth/google/callback") {
      input.response.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      input.response.end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== input.expectedState) {
      input.response.writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      input.response.end("Invalid OAuth state");
      return;
    }
    if (input.callbackState.started) {
      input.response.writeHead(409, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      input.response.end("OAuth callback already received");
      return;
    }
    input.callbackState.started = true;

    let success = false;
    try {
      if (url.searchParams.has("error")) {
        throw new GoogleApiError("OAuth was denied.", 400, "oauth_denied");
      }
      const code = url.searchParams.get("code");
      if (!code) {
        throw new GoogleApiError("OAuth code is missing.", 400, "oauth_denied");
      }

      const token = await exchangeGoogleAuthorizationCode({
        clientId: input.oauthClient.clientId,
        clientSecret: input.oauthClient.clientSecret,
        code,
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
      });
      const refreshToken = token.refreshToken;
      if (!refreshToken) {
        throw new GoogleApiError(
          "Google did not return a refresh token.",
          0,
          "invalid_response",
        );
      }
      ensureRequiredScopes(token);
      await this.#exclusive(() =>
        this.#commitOAuthCallback(input, { ...token, refreshToken }),
      );
      success = true;
    } catch (error) {
      await this.#exclusive(() => this.#failOAuthCallback(input, error));
    } finally {
      if (!input.response.destroyed && !input.response.writableEnded) {
        input.response.writeHead(success ? 200 : 400, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        });
        input.response.end(callbackHtml(success));
      }
      setTimeout(() => void this.#closeCallbackServer(input.server), 100);
    }
  }

  async #commitOAuthCallback(
    input: { generation: number; server: Server },
    token: GoogleToken & { refreshToken: string },
  ): Promise<void> {
    this.#assertCurrentOAuth(input.generation, input.server);
    const { state } = await this.#freshCredentialState();
    this.#assertCurrentOAuth(input.generation, input.server);
    const createdAt = new Date().toISOString();
    await this.#saveCredentialState({
      version: 1,
      ...(state?.active ? { active: state.active } : {}),
      pending: { refreshToken: token.refreshToken, createdAt },
    });
    this.#assertCurrentOAuth(input.generation, input.server);
    this.#pendingAccessToken = {
      value: token.accessToken,
      expiresAt: token.expiresAt,
      generation: input.generation,
      pendingCreatedAt: createdAt,
    };
    this.#snapshot = this.#chooseProjectSnapshot();
  }

  async #failOAuthCallback(
    input: { generation: number; server: Server },
    error: unknown,
  ): Promise<void> {
    if (
      input.generation !== this.#generation ||
      input.server !== this.#callbackServer
    ) {
      return;
    }
    this.#pendingAccessToken = null;
    let activeProjectId: string | null = null;
    try {
      const { state } = await this.#freshCredentialState();
      this.#assertCurrentOAuth(input.generation, input.server);
      activeProjectId = state?.active?.projectId ?? null;
      if (state?.pending) {
        await this.#saveCredentialState(
          state.active ? { version: 1, active: state.active } : null,
        );
      }
    } catch {
      // Report the OAuth failure even if the OS credential vault is unavailable.
    }
    this.#snapshot = errorSnapshot(
      error,
      activeProjectId
        ? { projectId: activeProjectId, credentialState: "active" }
        : {},
    );
  }

  async #expireOAuth(generation: number, server: Server): Promise<void> {
    if (generation !== this.#generation || server !== this.#callbackServer) return;
    this.#generation += 1;
    this.#pendingAccessToken = null;
    await this.#closeCallbackServer(server);
    const { state } = await this.#freshCredentialState();
    if (state?.pending) {
      await this.#saveCredentialState(
        state.active ? { version: 1, active: state.active } : null,
      );
    }
    this.#snapshot = errorSnapshot(
      new GoogleApiError("OAuth timed out.", 0, "oauth_denied"),
      state?.active
        ? {
            projectId: state.active.projectId,
            credentialState: "active",
          }
        : {},
    );
  }

  #chooseProjectSnapshot(): ProviderSnapshot {
    return {
      ...disconnectedSnapshot(),
      status: "connecting",
      updatedAt: new Date().toISOString(),
      metadata: {
        scope: "google-cloud-project",
        connectionStage: "choose-project",
        credentialState: "pending",
      },
    };
  }

  async #freshCredentialState(): Promise<{
    state: GeminiCredentialState | null;
    expiredPending: boolean;
  }> {
    const state = await this.#loadCredentialState();
    if (!state?.pending || !pendingCredentialExpired(state.pending)) {
      return { state, expiredPending: false };
    }
    this.#pendingAccessToken = null;
    const next = state.active ? { version: 1 as const, active: state.active } : null;
    await this.#saveCredentialState(next);
    return { state: next, expiredPending: true };
  }

  async #loadCredentialState(): Promise<GeminiCredentialState | null> {
    const serialized = await this.#vault.get(this.id, CREDENTIAL_STATE_KEY);
    if (serialized !== null) {
      const state = parseCredentialState(serialized);
      if (state) {
        await this.#cleanLegacyCredentials();
        return state;
      }
      await this.#vault.delete(this.id, CREDENTIAL_STATE_KEY);
    }

    if (this.#legacyMigrationChecked) return null;
    const [activeRefreshToken, pendingRefreshToken] = await Promise.all([
      this.#vault.get(this.id, LEGACY_REFRESH_TOKEN_KEY),
      this.#vault.get(this.id, LEGACY_PENDING_REFRESH_TOKEN_KEY),
    ]);
    const projectId = this.#snapshot.metadata?.projectId;
    const active =
      validRefreshToken(activeRefreshToken) &&
      typeof projectId === "string" &&
      isValidGoogleProjectId(projectId)
        ? { refreshToken: activeRefreshToken, projectId }
        : undefined;
    const snapshotUpdatedAt = this.#snapshot.updatedAt;
    const pending = validRefreshToken(pendingRefreshToken)
      ? {
          refreshToken: pendingRefreshToken,
          createdAt:
            snapshotUpdatedAt && !Number.isNaN(Date.parse(snapshotUpdatedAt))
              ? new Date(snapshotUpdatedAt).toISOString()
              : new Date(0).toISOString(),
        }
      : undefined;
    const migrated: GeminiCredentialState | null =
      active || pending
        ? {
            version: 1,
            ...(active ? { active } : {}),
            ...(pending ? { pending } : {}),
          }
        : null;
    if (migrated) await this.#saveCredentialState(migrated);
    await this.#cleanLegacyCredentials();
    return migrated;
  }

  async #saveCredentialState(state: GeminiCredentialState | null): Promise<void> {
    if (!state?.active && !state?.pending) {
      await this.#vault.delete(this.id, CREDENTIAL_STATE_KEY);
      return;
    }
    await this.#vault.set(this.id, CREDENTIAL_STATE_KEY, JSON.stringify(state));
  }

  async #cleanLegacyCredentials(): Promise<void> {
    if (this.#legacyMigrationChecked) return;
    await Promise.all([
      this.#vault.delete(this.id, LEGACY_REFRESH_TOKEN_KEY),
      this.#vault.delete(this.id, LEGACY_PENDING_REFRESH_TOKEN_KEY),
      this.#vault.delete(this.id, LEGACY_CLIENT_SECRET_KEY),
    ]);
    this.#legacyMigrationChecked = true;
  }

  #assertGeneration(generation: number): void {
    if (generation !== this.#generation) {
      throw new GoogleApiError(
        "Gemini connection operation was superseded.",
        409,
        "project_selection_required",
      );
    }
  }

  #assertCurrentOAuth(generation: number, server: Server): void {
    this.#assertGeneration(generation);
    if (server !== this.#callbackServer) {
      throw new GoogleApiError(
        "Google OAuth connection was superseded.",
        409,
        "oauth_denied",
      );
    }
  }

  async #closeCallbackServer(expected?: Server): Promise<void> {
    const server = this.#callbackServer;
    if (!server || (expected && expected !== server)) return;
    this.#callbackServer = null;
    if (this.#oauthTimer?.server === server) {
      clearTimeout(this.#oauthTimer.handle);
      this.#oauthTimer = null;
    }
    server.closeAllConnections();
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release: () => void = () => undefined;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
