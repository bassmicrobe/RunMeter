import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { ClaudeSettingsConflictError } from "./claude-settings.ts";
import { CodexRpcError } from "./adapters/codex-app-server-client.ts";
import { CredentialVaultUnavailableError } from "./credential-vault.ts";
import { buildDashboardSnapshot, DEFAULT_PROVIDERS, MAX_DASHBOARD_HISTORY_DAYS } from "./core/dashboard.ts";
import type {
  JsonObject,
  ProviderAdapter,
  ProviderConnectRequest,
  ProviderSnapshot,
} from "./core/types.ts";
import type { ProviderRegistry } from "./core/registry.ts";
import {
  PairingError,
  type AuthenticatedSession,
  type PairingManager,
} from "./pairing.ts";
import type { RelayStore } from "./storage.ts";
import { GoogleApiError } from "./providers/gemini-api.ts";

export const RELAY_HOST = "127.0.0.1";
export const RELAY_PORT = 47_831;
const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type";
const DASHBOARD_PROVIDER_IDS = new Set<string>(DEFAULT_PROVIDERS.map(({ id }) => id));

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function normalizeOrigins(origins: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const candidate of origins) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const url = new URL(trimmed);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== trimmed ||
      url.username ||
      url.password
    ) {
      throw new Error(`Invalid allowed origin: ${candidate}`);
    }
    normalized.add(url.origin);
  }
  if (normalized.size === 0) throw new Error("At least one browser origin is required");
  return normalized;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "body_too_large", "Request body exceeds 64 KiB.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

function mapProviderError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof PairingError) {
    const messages: Record<string, string> = {
      pairing_rate_limited:
        "入力回数が上限に達しました。1分待ってから新しいコードを入力してください。",
      pairing_code_expired:
        "ペアリングコードの有効期限が切れました。Relayに表示された新しいコードを入力してください。",
      invalid_pairing_code: "ペアリングコードが正しくありません。",
      missing_bearer: "先にこのブラウザをRelayとペアリングしてください。",
      invalid_bearer:
        "Relayとのペアリングが無効です。もう一度ペアリングしてください。",
    };
    return new HttpError(
      error.status,
      error.code,
      messages[error.code] ?? "Relayとのペアリングを確認できませんでした。",
    );
  }
  if (error instanceof ClaudeSettingsConflictError) {
    return new HttpError(
      409,
      "settings_conflict",
      "Claude CodeのstatusLine設定が変更されています。既存設定は上書きしていません。内容を確認してから再試行してください。",
    );
  }
  if (error instanceof GoogleApiError) {
    const details = {
      oauth_denied: [422, "google_oauth_denied", "Google認証が完了しませんでした。"],
      oauth_client_unconfigured: [503, "oauth_client_unconfigured", "RunMeter RelayにGoogle OAuthクライアントが設定されていません。"],
      oauth_scope_missing: [422, "google_oauth_scope_missing", "必要なGoogle Cloudの閲覧権限が許可されませんでした。もう一度認証してください。"],
      project_selection_required: [409, "google_project_selection_required", "先にGoogle認証を完了し、プロジェクトを選択してください。"],
      project_selection_expired: [409, "google_project_selection_expired", "Google認証後のプロジェクト選択期限が切れました。もう一度認証してください。"],
      project_not_available: [422, "google_project_not_available", "選択したGoogle Cloudプロジェクトを現在のGoogleアカウントで確認できません。"],
      unauthorized: [422, "google_auth_expired", "Google認証の有効期限が切れました。再接続してください。"],
      forbidden: [403, "google_permission_required", "Google Cloud Monitoringの閲覧権限が必要です。"],
      rate_limited: [429, "google_rate_limited", "Google Cloud APIの上限に達しました。しばらくしてから再試行してください。"],
      api_disabled: [424, "google_api_disabled", "必要なGoogle Cloud API（Cloud Resource Manager / Monitoring）を有効にしてください。"],
      invalid_response: [502, "google_invalid_response", "Google Cloudから受け取ったデータを確認できませんでした。"],
      provider_error: [502, "google_unavailable", "Google Cloudへ接続できませんでした。"],
    } as const;
    const [status, code, message] = details[error.code];
    return new HttpError(status, code, message);
  }
  if (error instanceof CredentialVaultUnavailableError) {
    return new HttpError(
      503,
      "credential_vault_unavailable",
      "この端末のOS資格情報保管庫を利用できません。",
    );
  }
  if (error instanceof CodexRpcError) {
    return new HttpError(
      503,
      "codex_unavailable",
      "Codex CLIを起動できません。インストールとログイン状態を確認してください。",
    );
  }
  // Provider and OS errors can contain credentials, response bodies or local paths.
  // Only known errors above have messages that are safe to send to a browser.
  return new HttpError(500, "provider_error", "連携先の情報を取得できませんでした。接続状態を確認して再試行してください。");
}

export interface RelayHttpServerOptions {
  registry: ProviderRegistry;
  store: RelayStore;
  pairing: PairingManager;
  allowedOrigins: readonly string[];
  /** Tests may use another port. Production callers must use RELAY_PORT. */
  port?: number;
}

export class RelayHttpServer {
  readonly #registry: ProviderRegistry;
  readonly #store: RelayStore;
  readonly #pairing: PairingManager;
  readonly #allowedOrigins: Set<string>;
  readonly #port: number;
  readonly #providerRevisions = new Map<string, number>();
  #server: Server | null = null;
  #boundPort: number | null = null;

  constructor(options: RelayHttpServerOptions) {
    this.#registry = options.registry;
    this.#store = options.store;
    this.#pairing = options.pairing;
    this.#allowedOrigins = normalizeOrigins(options.allowedOrigins);
    this.#port = options.port ?? RELAY_PORT;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 100;
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#port, RELAY_HOST, () => {
          server.off("error", reject);
          const address = server.address();
          this.#boundPort =
            address && typeof address !== "string" ? address.port : this.#port;
          resolve();
        });
      });
    } catch (error) {
      this.#server = null;
      this.#boundPort = null;
      throw error;
    }
  }

  get port(): number {
    return this.#boundPort ?? this.#port;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#boundPort = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.#setHeaders(response, null, request);
      const origin = this.#validateHostAndOrigin(request);
      this.#setHeaders(response, origin, request);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", `http://${RELAY_HOST}:${this.port}`);
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/v1/health") {
        this.#json(response, 200, {
          ok: true,
          service: "RunMeter Relay",
          version: 1,
          address: `${RELAY_HOST}:${this.port}`,
          providers: this.#registry.list().map((adapter) => adapter.id),
        });
        return;
      }

      if (
        method === "POST" &&
        (url.pathname === "/v1/pairing/claim" || url.pathname === "/v1/pair")
      ) {
        const body = asObject(await readJson(request));
        if (!body) throw new HttpError(400, "invalid_body", "JSON body must be an object.");
        const session = this.#pairing.claim(body.code, body.label);
        this.#json(response, 201, {
          token: session.token,
          tokenType: "Bearer",
          tokenVersion: "1",
          expiresAt: session.expiresAt,
        });
        return;
      }

      const ingestMatch = /^\/v1\/providers\/([a-z][a-z0-9-]{0,31})\/ingest$/.exec(
        url.pathname,
      );
      const session = this.#authenticate(
        request,
        ingestMatch ? ["browser", `ingest:${ingestMatch[1]}`] : ["browser"],
      );

      if (
        (method === "DELETE" && url.pathname === "/v1/pair") ||
        (method === "POST" && url.pathname === "/v1/unpair")
      ) {
        this.#pairing.revoke(session.tokenHash);
        this.#json(response, 200, { revoked: true, tokenVersion: "1" });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/session/revoke") {
        this.#pairing.revoke(session.tokenHash);
        this.#json(response, 200, { revoked: true });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/snapshot") {
        const snapshots = await Promise.all(
          this.#registry.list()
            // Hidden providers do not contribute to the dashboard. In
            // particular, do not open their credential vaults on every poll.
            .filter((adapter) => DASHBOARD_PROVIDER_IDS.has(adapter.id))
            .map((adapter) => this.#safeStatus(adapter)),
        );
        const withHistory = snapshots.map((snapshot) => ({
          ...snapshot,
          dailyUsage: [
            ...this.#store.listDailyUsage(snapshot.providerId, MAX_DASHBOARD_HISTORY_DAYS),
            ...snapshot.dailyUsage,
          ],
        }));
        this.#json(response, 200, buildDashboardSnapshot(withHistory));
        return;
      }

      if (method === "GET" && url.pathname === "/v1/history") {
        const providerId = url.searchParams.get("provider");
        if (providerId && !this.#registry.get(providerId)) {
          throw new HttpError(404, "provider_not_found", "Provider adapter not found.");
        }
        const requestedSince = url.searchParams.get("since");
        const earliest = Date.now() - 400 * 24 * 60 * 60 * 1_000;
        const parsedSince = requestedSince ? Date.parse(requestedSince) : NaN;
        const since = new Date(
          Number.isNaN(parsedSince) ? Date.now() - 30 * 24 * 60 * 60 * 1_000 : Math.max(earliest, parsedSince),
        ).toISOString();
        const observations = this.#store.listUsageHistory(
          providerId,
          since,
          100_001,
        );
        this.#json(response, 200, {
          since,
          truncated: observations.length > 100_000,
          observations: observations.slice(0, 100_000),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/providers") {
        const adapters = this.#registry.list();
        const snapshots = await Promise.all(adapters.map((adapter) => this.#safeStatus(adapter)));
        this.#json(
          response,
          200,
          adapters.map((adapter, index) => ({
            id: adapter.id,
            displayName: adapter.displayName,
            capabilities: adapter.capabilities,
            snapshot: snapshots[index],
          })),
        );
        return;
      }

      const providerMatch = /^\/v1\/providers\/([a-z][a-z0-9-]{0,31})(?:\/(connect|disconnect|refresh|ingest|logout|projects))?$/.exec(
        url.pathname,
      );
      if (providerMatch) {
        const providerId = providerMatch[1];
        const action = providerMatch[2] ?? "status";
        const adapter = this.#registry.get(providerId);
        if (!adapter) throw new HttpError(404, "provider_not_found", "Provider adapter not found.");

        if (method === "GET" && action === "status") {
          this.#json(response, 200, await this.#safeStatus(adapter));
          return;
        }
        if (method === "GET" && action === "projects") {
          if (!adapter.listProjects) {
            throw new HttpError(404, "operation_not_supported", "Provider project selection is not supported.");
          }
          this.#json(response, 200, await adapter.listProjects());
          return;
        }
        if (method !== "POST") {
          throw new HttpError(405, "method_not_allowed", "Method not allowed for this route.");
        }
        if (action === "connect") {
          const body = asObject(await readJson(request));
          if (!body) throw new HttpError(400, "invalid_body", "JSON body must be an object.");
          const connectRequest: ProviderConnectRequest = {
            ...(typeof body.mode === "string" ? { mode: body.mode.slice(0, 40) } : {}),
            ...(asObject(body.options) ? { options: asObject(body.options) as JsonObject } : {}),
          };
          const revision = this.#beginProviderMutation(providerId);
          const result = await adapter.connect(connectRequest);
          this.#assertCurrentProviderRevision(providerId, revision);
          if (result.snapshot) this.#store.saveProviderSnapshot(result.snapshot);
          this.#json(response, 200, result);
          return;
        }
        if (action === "disconnect") {
          const revision = this.#beginProviderMutation(providerId);
          await adapter.disconnect();
          const snapshot = await adapter.getStatus();
          this.#assertCurrentProviderRevision(providerId, revision);
          this.#store.saveProviderSnapshot(snapshot);
          this.#json(response, 200, { disconnected: true });
          return;
        }
        if (action === "refresh") {
          const revision = this.#providerRevision(providerId);
          const snapshot = await adapter.refresh();
          this.#assertCurrentProviderRevision(providerId, revision);
          this.#store.saveProviderSnapshot(snapshot);
          this.#json(response, 200, snapshot);
          return;
        }
        if (action === "logout") {
          if (!adapter.logout) {
            throw new HttpError(404, "operation_not_supported", "Provider logout is not supported.");
          }
          const revision = this.#beginProviderMutation(providerId);
          await adapter.logout();
          const snapshot = await adapter.getStatus();
          this.#assertCurrentProviderRevision(providerId, revision);
          this.#store.saveProviderSnapshot(snapshot);
          this.#json(response, 200, { loggedOut: true });
          return;
        }
        if (action === "ingest") {
          if (!adapter.ingest) {
            throw new HttpError(404, "operation_not_supported", "Provider ingest is not supported.");
          }
          // Browser sessions can diagnose ingest. The Claude helper receives a
          // distinct, provider-scoped bearer that cannot read other data.
          this.#authenticate(request, ["browser", `ingest:${providerId}`]);
          const revision = this.#providerRevision(providerId);
          const snapshot = await adapter.ingest(await readJson(request));
          this.#assertCurrentProviderRevision(providerId, revision);
          this.#store.saveProviderSnapshot(snapshot);
          this.#json(response, 200, snapshot);
          return;
        }
      }

      throw new HttpError(404, "not_found", "Route not found.");
    } catch (error) {
      const mapped = mapProviderError(error);
      if (!response.headersSent) {
        this.#json(response, mapped.status, {
          error: { code: mapped.code, message: mapped.message },
        });
      } else {
        response.end();
      }
    }
  }

  #validateHostAndOrigin(request: IncomingMessage): string | null {
    const expectedHosts = new Set([
      `${RELAY_HOST}:${this.port}`,
      `localhost:${this.port}`,
    ]);
    const host = request.headers.host?.toLowerCase();
    if (!host || !expectedHosts.has(host)) {
      throw new HttpError(421, "invalid_host", "Host header is not allowed.");
    }
    const originHeader = request.headers.origin;
    if (!originHeader) return null;
    if (Array.isArray(originHeader) || !this.#allowedOrigins.has(originHeader)) {
      throw new HttpError(403, "origin_not_allowed", "Browser origin is not allowed.");
    }
    return originHeader;
  }

  #authenticate(
    request: IncomingMessage,
    scopes: readonly string[],
  ): AuthenticatedSession {
    return this.#pairing.authenticate(request.headers.authorization, scopes);
  }

  #setHeaders(
    response: ServerResponse,
    origin: string | null,
    request: IncomingMessage,
  ): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Vary", "Origin, Access-Control-Request-Private-Network");
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      response.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      response.setHeader("Access-Control-Max-Age", "600");
      if (request.headers["access-control-request-private-network"] === "true") {
        response.setHeader("Access-Control-Allow-Private-Network", "true");
      }
    }
  }

  #json(response: ServerResponse, status: number, value: unknown): void {
    if (response.writableEnded) return;
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value));
  }

  #providerRevision(providerId: string): number {
    return this.#providerRevisions.get(providerId) ?? 0;
  }

  #beginProviderMutation(providerId: string): number {
    const revision = this.#providerRevision(providerId) + 1;
    this.#providerRevisions.set(providerId, revision);
    return revision;
  }

  #assertCurrentProviderRevision(providerId: string, revision: number): void {
    if (revision !== this.#providerRevision(providerId)) {
      throw new HttpError(409, "provider_operation_superseded", "接続状態が変更されました。最新の状態を確認してください。");
    }
  }

  #currentProviderSnapshot(adapter: ProviderAdapter): ProviderSnapshot {
    return this.#store.getProviderSnapshot(adapter.id) ?? {
      providerId: adapter.id,
      displayName: adapter.displayName,
      status: "disconnected",
      ingestion: "none",
      updatedAt: null,
      windows: [],
      dailyUsage: [],
    };
  }

  async #safeStatus(adapter: ProviderAdapter): Promise<ProviderSnapshot> {
    const revision = this.#providerRevision(adapter.id);
    try {
      const snapshot = await adapter.getStatus();
      if (revision !== this.#providerRevision(adapter.id)) {
        return this.#currentProviderSnapshot(adapter);
      }
      this.#store.saveProviderSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (revision !== this.#providerRevision(adapter.id)) {
        return this.#currentProviderSnapshot(adapter);
      }
      const stored = this.#store.getProviderSnapshot(adapter.id);
      return {
        providerId: adapter.id,
        displayName: adapter.displayName,
        status: "error",
        ingestion: stored?.ingestion ?? "none",
        updatedAt: stored?.updatedAt ?? null,
        windows: stored?.windows ?? [],
        dailyUsage: stored?.dailyUsage ?? [],
        ...(stored?.tokenSummary ? { tokenSummary: stored.tokenSummary } : {}),
        metadata: stored?.metadata ?? {},
        error: { code: "provider_unavailable", message: mapProviderError(error).message },
      };
    }
  }
}
