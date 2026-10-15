import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  GeminiAdapter,
  googleOAuthClientConfigFromEnvironment,
} from "../adapters/gemini.ts";
import type { CredentialVault } from "../credential-vault.ts";
import type { ProviderSnapshot } from "../core/types.ts";
import {
  buildGoogleAuthorizationUrl,
  createGooglePkce,
  exchangeGoogleAuthorizationCode,
  fetchGeminiUsageReport,
  GOOGLE_OAUTH_SCOPES,
  listGoogleCloudProjects,
  refreshGoogleAccessToken,
} from "../providers/gemini-api.ts";
import { RelayStore } from "../storage.ts";

const originalFetch = globalThis.fetch;
const quotaUsageMetric =
  "generativelanguage.googleapis.com/quota/generate_content_free_tier_requests_per_minute/usage";
const quotaLimitMetric = quotaUsageMetric.replace(/\/usage$/, "/limit");
const inputTokenMetric =
  "generativelanguage.googleapis.com/generate_content_usage_input_token_count";
const outputTokenMetric =
  "generativelanguage.googleapis.com/generate_content_usage_output_token_count";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type FetchCall = {
  url: URL;
  init: RequestInit | undefined;
};

function urlFromFetchInput(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function timeSeries(metricType: string): unknown {
  if (metricType === quotaUsageMetric || metricType === quotaLimitMetric) {
    return {
      timeSeries: [
        {
          metric: {
            labels: {
              limit_name: "GenerateContentRequestsPerMinutePerProjectPerModel",
              model: "gemini-2.5-pro",
            },
          },
          points: [
            {
              value: {
                int64Value: metricType === quotaUsageMetric ? "25" : "100",
              },
            },
          ],
        },
      ],
    };
  }
  if (metricType === inputTokenMetric || metricType === outputTokenMetric) {
    const values =
      metricType === inputTokenMetric
        ? [
            ["2026-08-19T23:59:59Z", "120"],
            ["2026-08-20T23:59:59Z", "80"],
          ]
        : [
            ["2026-08-19T23:59:59Z", "30"],
            ["2026-08-20T23:59:59Z", "20"],
          ];
    return {
      timeSeries: [
        {
          points: values.map(([endTime, value]) => ({
            interval: { endTime },
            value: { int64Value: value },
          })),
        },
      ],
    };
  }
  return { timeSeries: [] };
}

function installMonitoringFetch(
  accessToken: string,
  options: {
    refreshTokenResponse?: boolean;
    projects?: unknown;
    limitOnly?: boolean;
  } = {},
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = urlFromFetchInput(input);
    calls.push({ url, init });

    if (url.hostname === "oauth2.googleapis.com") {
      return jsonResponse({
        access_token: accessToken,
        expires_in: 3_600,
        scope: GOOGLE_OAUTH_SCOPES.join(" "),
        ...(options.refreshTokenResponse
          ? { refresh_token: "google-refresh-secret" }
          : {}),
      });
    }

    if (url.hostname === "cloudresourcemanager.googleapis.com") {
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        `Bearer ${accessToken}`,
      );
      if (/^\/v3\/projects\/[a-z][a-z0-9-]+$/.test(url.pathname)) {
        return jsonResponse({
          projectId: url.pathname.split("/").at(-1),
          displayName: "RunMeter Test",
          state: "ACTIVE",
        });
      }
      return jsonResponse(
        options.projects ?? {
          projects: [
            {
              projectId: "runmeter-test-project",
              displayName: "RunMeter Test",
              state: "ACTIVE",
            },
          ],
        },
      );
    }

    assert.equal(url.hostname, "monitoring.googleapis.com");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Bearer ${accessToken}`,
    );
    if (url.pathname.endsWith("/metricDescriptors")) {
      return jsonResponse({
        metricDescriptors: [
          {
            type: quotaUsageMetric,
            displayName: "Generate content requests per minute quota usage",
            unit: "1",
          },
          {
            type: "generativelanguage.googleapis.com/quota/ignored/limit",
            displayName: "Ignored limit descriptor",
          },
        ],
      });
    }

    const filter = url.searchParams.get("filter") ?? "";
    const metricMatch = /metric\.type = "([^"]+)"/.exec(filter);
    if (options.limitOnly && metricMatch?.[1] === quotaUsageMetric) {
      return jsonResponse({ timeSeries: [] });
    }
    return jsonResponse(timeSeries(metricMatch?.[1] ?? ""));
  }) as typeof fetch;
  return calls;
}

class MemoryVault implements CredentialVault {
  readonly backend = "windows-dpapi" as const;
  readonly values = new Map<string, string>();

  async get(providerId: string, key: string): Promise<string | null> {
    return this.values.get(`${providerId}:${key}`) ?? null;
  }

  async set(providerId: string, key: string, value: string): Promise<void> {
    this.values.set(`${providerId}:${key}`, value);
  }

  async delete(providerId: string, key: string): Promise<void> {
    this.values.delete(`${providerId}:${key}`);
  }
}

test("Google authorization URL uses an S256 PKCE challenge and local callback", () => {
  const pkce = createGooglePkce();
  const redirectUri = "http://127.0.0.1:49152/oauth/google/callback";
  const authorizationUrl = new URL(
    buildGoogleAuthorizationUrl({
      clientId: "runmeter-test.apps.googleusercontent.com",
      redirectUri,
      pkce,
    }),
  );

  assert.equal(authorizationUrl.origin, "https://accounts.google.com");
  assert.equal(authorizationUrl.pathname, "/o/oauth2/v2/auth");
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(pkce.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pkce.state, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(authorizationUrl.searchParams.get("code_challenge"), pkce.challenge);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("state"), pkce.state);
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
  assert.equal(authorizationUrl.searchParams.get("prompt"), "consent");
  assert.equal(
    authorizationUrl.searchParams.get("scope"),
    GOOGLE_OAUTH_SCOPES.join(" "),
  );
  assert.equal(authorizationUrl.search.includes(pkce.verifier), false);
  assert.equal(authorizationUrl.searchParams.has("client_secret"), false);
});

test("shared Google OAuth client configuration is read only from Relay environment", () => {
  assert.equal(googleOAuthClientConfigFromEnvironment({}), null);
  assert.deepEqual(
    googleOAuthClientConfigFromEnvironment({
      RUNMETER_GOOGLE_CLIENT_ID: "runmeter-test.apps.googleusercontent.com",
      RUNMETER_GOOGLE_CLIENT_SECRET: "desktop-client-secret",
    }),
    {
      clientId: "runmeter-test.apps.googleusercontent.com",
      clientSecret: "desktop-client-secret",
    },
  );
  assert.throws(
    () =>
      googleOAuthClientConfigFromEnvironment({
        RUNMETER_GOOGLE_CLIENT_ID: "not-a-google-client",
      }),
    /Desktop OAuth/,
  );
});

test("Gemini OAuth reports an explicit unsupported result when shared client is absent", async () => {
  const adapter = new GeminiAdapter(new MemoryVault());
  const result = await adapter.connect({ mode: "oauth" });
  assert.equal(result.kind, "unsupported");
  if (result.kind !== "unsupported") assert.fail("Expected unsupported result");
  assert.equal(result.code, "oauth_client_unconfigured");
});

test("Google project search paginates, filters and sanitizes local choices", async () => {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = urlFromFetchInput(input);
    calls.push({ url, init });
    assert.equal(url.hostname, "cloudresourcemanager.googleapis.com");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer local-access-token",
    );
    if (!url.searchParams.has("pageToken")) {
      return jsonResponse({
        projects: [
          {
            projectId: "zeta-project-123",
            displayName: "Zeta\u0000 Project",
            state: "ACTIVE",
          },
          {
            projectId: "deleted-project-123",
            displayName: "Deleted",
            state: "DELETE_REQUESTED",
          },
          { projectId: "invalid project", displayName: "Invalid", state: "ACTIVE" },
        ],
        nextPageToken: "next-page",
      });
    }
    assert.equal(url.searchParams.get("pageToken"), "next-page");
    return jsonResponse({
      projects: [
        {
          projectId: "alpha-project-123",
          displayName: "Alpha Project",
          state: "ACTIVE",
        },
      ],
    });
  }) as typeof fetch;

  const result = await listGoogleCloudProjects("local-access-token");
  assert.deepEqual(result, {
    projects: [
      {
        id: "alpha-project-123",
        displayName: "Alpha Project",
        state: "ACTIVE",
      },
      {
        id: "zeta-project-123",
        displayName: "Zeta Project",
        state: "ACTIVE",
      },
    ],
    truncated: false,
  });
  const limited = await listGoogleCloudProjects("local-access-token", 1);
  assert.equal(limited.projects.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url.searchParams.get("query"), "state:ACTIVE");
});

test("Google OAuth exchange and refresh responses are normalized", async () => {
  const calls: FetchCall[] = [];
  let exchangeCount = 0;
  globalThis.fetch = (async (input, init) => {
    const url = urlFromFetchInput(input);
    calls.push({ url, init });
    exchangeCount += 1;
    return jsonResponse({
      access_token: `google-access-${exchangeCount}`,
      expires_in: "3600",
      scope: "monitoring.read",
      ...(exchangeCount === 1 ? { refresh_token: "google-refresh-secret" } : {}),
    });
  }) as typeof fetch;

  const before = Date.now();
  const exchanged = await exchangeGoogleAuthorizationCode({
    clientId: "runmeter-test.apps.googleusercontent.com",
    clientSecret: "google-client-secret",
    code: "authorization-code",
    codeVerifier: "pkce-verifier",
    redirectUri: "http://127.0.0.1:49152/oauth/google/callback",
  });
  const after = Date.now();

  assert.equal(exchanged.accessToken, "google-access-1");
  assert.equal(exchanged.refreshToken, "google-refresh-secret");
  assert.equal(exchanged.scope, "monitoring.read");
  assert.ok(Date.parse(exchanged.expiresAt) >= before + 3_570_000);
  assert.ok(Date.parse(exchanged.expiresAt) <= after + 3_570_000);

  const exchangeBody = new URLSearchParams(String(calls[0]?.init?.body));
  assert.equal(exchangeBody.get("grant_type"), "authorization_code");
  assert.equal(exchangeBody.get("code"), "authorization-code");
  assert.equal(exchangeBody.get("code_verifier"), "pkce-verifier");
  assert.equal(exchangeBody.get("client_secret"), "google-client-secret");

  const refreshed = await refreshGoogleAccessToken({
    clientId: "runmeter-test.apps.googleusercontent.com",
    clientSecret: "google-client-secret",
    refreshToken: "google-refresh-secret",
  });
  assert.equal(refreshed.accessToken, "google-access-2");
  assert.equal(refreshed.refreshToken, "google-refresh-secret");

  const refreshBody = new URLSearchParams(String(calls[1]?.init?.body));
  assert.equal(refreshBody.get("grant_type"), "refresh_token");
  assert.equal(refreshBody.get("refresh_token"), "google-refresh-secret");
});

test("Google invalid_grant token errors are classified as expired authorization", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(
      {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      },
      400,
    )) as typeof fetch;

  await assert.rejects(
    refreshGoogleAccessToken({
      clientId: "runmeter-test.apps.googleusercontent.com",
      clientSecret: null,
      refreshToken: "expired-refresh-token",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "unauthorized" &&
      !error.message.includes("Token has been expired"),
  );
});

test("Gemini callback stores only a pending refresh token and waits for project choice", async () => {
  const vault = new MemoryVault();
  const adapter = new GeminiAdapter(vault, null, {
    clientId: "runmeter-test.apps.googleusercontent.com",
    clientSecret: null,
  });
  globalThis.fetch = (async (input, init) => {
    const url = urlFromFetchInput(input);
    if (url.hostname === "oauth2.googleapis.com") {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("client_id"), "runmeter-test.apps.googleusercontent.com");
      assert.equal(body.has("client_secret"), false);
      return jsonResponse({
        access_token: "pending-access-secret",
        refresh_token: "pending-refresh-secret",
        expires_in: 3_600,
        scope: GOOGLE_OAUTH_SCOPES.join(" "),
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const result = await adapter.connect({ mode: "oauth" });
    assert.equal(result.kind, "action-required");
    if (result.kind !== "action-required" || result.action.type !== "open-url") {
      assert.fail("Expected Google authorization URL");
    }
    const authorizationUrl = new URL(result.action.url);
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(redirectUri);
    assert.ok(state);
    const callback = await originalFetch(
      `${redirectUri}?code=authorization-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /プロジェクトを選択/);

    const snapshot = await adapter.getStatus();
    assert.equal(snapshot.status, "connecting");
    assert.equal(snapshot.metadata?.connectionStage, "choose-project");
    assert.equal(snapshot.metadata?.credentialState, "pending");
    assert.equal(snapshot.metadata?.projects, undefined);
    const saved = JSON.parse(
      (await vault.get("gemini", "connection-v1")) ?? "null",
    ) as Record<string, unknown>;
    assert.equal(saved.version, 1);
    assert.equal(
      (saved.pending as Record<string, unknown>).refreshToken,
      "pending-refresh-secret",
    );
    assert.equal(
      Number.isNaN(
        Date.parse(String((saved.pending as Record<string, unknown>).createdAt)),
      ),
      false,
    );
    assert.equal(saved.active, undefined);
    assert.equal(await vault.get("gemini", "pending-refresh-token"), null);
    assert.equal(await vault.get("gemini", "refresh-token"), null);
  } finally {
    await adapter.dispose();
  }
});

test("Gemini selection revalidates a listed project before promoting credentials", async () => {
  const accessToken = "project-selection-access-secret";
  const refreshToken = "project-selection-refresh-secret";
  const clientSecret = "shared-desktop-client-secret";
  const calls = installMonitoringFetch(accessToken);
  const vault = new MemoryVault();
  vault.values.set(
    "gemini:connection-v1",
    JSON.stringify({
      version: 1,
      pending: { refreshToken, createdAt: new Date().toISOString() },
    }),
  );
  const adapter = new GeminiAdapter(
    vault,
    {
      providerId: "gemini",
      displayName: "Gemini API",
      status: "connecting",
      ingestion: "none",
      updatedAt: "2026-08-20T00:00:00.000Z",
      windows: [],
      dailyUsage: [],
      metadata: {
        scope: "google-cloud-project",
        connectionStage: "choose-project",
      },
    },
    {
      clientId: "runmeter-test.apps.googleusercontent.com",
      clientSecret,
    },
  );

  const choices = await adapter.listProjects();
  assert.deepEqual(choices, {
    projects: [
      {
        id: "runmeter-test-project",
        displayName: "RunMeter Test",
        state: "ACTIVE",
      },
    ],
    truncated: false,
  });
  const result = await adapter.connect({
    mode: "select-project",
    options: { projectId: "runmeter-test-project" },
  });
  assert.equal(result.kind, "connected");
  if (result.kind !== "connected") assert.fail("Expected connected result");
  assert.equal(result.snapshot.metadata?.projectId, "runmeter-test-project");
  assert.equal(result.snapshot.metadata?.credentialState, "active");
  assert.equal(result.snapshot.metadata?.connectionStage, undefined);
  assert.equal(result.snapshot.metadata?.projects, undefined);
  assert.equal(JSON.stringify(result.snapshot).includes(clientSecret), false);
  assert.equal(JSON.stringify(result.snapshot).includes(accessToken), false);
  const credential = JSON.parse(
    (await vault.get("gemini", "connection-v1")) ?? "null",
  ) as Record<string, unknown>;
  assert.deepEqual(credential, {
    version: 1,
    active: {
      refreshToken,
      projectId: "runmeter-test-project",
    },
  });
  assert.equal(await vault.get("gemini", "refresh-token"), null);
  assert.equal(await vault.get("gemini", "pending-refresh-token"), null);
  assert.equal(
    calls.filter(
      (call) => call.url.hostname === "cloudresourcemanager.googleapis.com",
    ).length,
    2,
  );
  assert.equal(
    calls.some((call) => call.url.pathname === "/v3/projects/runmeter-test-project"),
    true,
  );
  assert.equal(
    calls.filter((call) => call.url.pathname === "/v3/projects:search").length,
    1,
  );
});

test("Gemini restores a pending project choice from the OS vault after restart", async () => {
  const vault = new MemoryVault();
  vault.values.set(
    "gemini:connection-v1",
    JSON.stringify({
      version: 1,
      pending: {
        refreshToken: "restart-pending-refresh-token",
        createdAt: new Date().toISOString(),
      },
    }),
  );
  const adapter = new GeminiAdapter(vault, null, {
    clientId: "runmeter-test.apps.googleusercontent.com",
    clientSecret: null,
  });

  const status = await adapter.getStatus();
  assert.equal(status.status, "connecting");
  assert.equal(status.metadata?.connectionStage, "choose-project");
  assert.equal(status.metadata?.credentialState, "pending");
  assert.equal((await adapter.refresh()).metadata?.connectionStage, "choose-project");
});

test("Gemini discards an expired pending credential", async () => {
  const vault = new MemoryVault();
  vault.values.set(
    "gemini:connection-v1",
    JSON.stringify({
      version: 1,
      pending: {
        refreshToken: "expired-pending-refresh-token",
        createdAt: new Date(Date.now() - 11 * 60 * 1_000).toISOString(),
      },
    }),
  );
  const adapter = new GeminiAdapter(
    vault,
    {
      providerId: "gemini",
      displayName: "Gemini API",
      status: "connecting",
      ingestion: "none",
      updatedAt: new Date().toISOString(),
      windows: [],
      dailyUsage: [],
      metadata: {
        scope: "google-cloud-project",
        connectionStage: "choose-project",
      },
    },
    {
      clientId: "runmeter-test.apps.googleusercontent.com",
      clientSecret: null,
    },
  );

  const status = await adapter.getStatus();
  assert.equal(status.status, "error");
  assert.equal(status.error?.code, "project_selection_expired");
  assert.equal(await vault.get("gemini", "connection-v1"), null);
});

test("Gemini restores an atomically promoted active credential after restart", async () => {
  installMonitoringFetch("restart-active-access-token");
  const vault = new MemoryVault();
  vault.values.set(
    "gemini:connection-v1",
    JSON.stringify({
      version: 1,
      active: {
        refreshToken: "restart-active-refresh-token",
        projectId: "runmeter-test-project",
      },
    }),
  );
  const adapter = new GeminiAdapter(
    vault,
    {
      providerId: "gemini",
      displayName: "Gemini API",
      status: "connecting",
      ingestion: "none",
      updatedAt: new Date().toISOString(),
      windows: [],
      dailyUsage: [],
      metadata: {
        scope: "google-cloud-project",
        connectionStage: "choose-project",
      },
    },
    {
      clientId: "runmeter-test.apps.googleusercontent.com",
      clientSecret: null,
    },
  );

  const status = await adapter.getStatus();
  assert.equal(status.status, "connected");
  assert.equal(status.metadata?.projectId, "runmeter-test-project");
  assert.equal(status.metadata?.connectionStage, undefined);
  assert.equal(status.metadata?.credentialState, "active");
});

test("Gemini keeps active credential metadata on a degraded refresh", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({ error: "invalid_grant" }, 400)) as typeof fetch;
  const vault = new MemoryVault();
  vault.values.set(
    "gemini:connection-v1",
    JSON.stringify({
      version: 1,
      active: {
        refreshToken: "revoked-active-refresh-token",
        projectId: "runmeter-test-project",
      },
    }),
  );
  const adapter = new GeminiAdapter(
    vault,
    {
      providerId: "gemini",
      displayName: "Gemini API",
      status: "connecting",
      ingestion: "none",
      updatedAt: new Date().toISOString(),
      windows: [],
      dailyUsage: [],
      metadata: {
        scope: "google-cloud-project",
        connectionStage: "choose-project",
      },
    },
    {
      clientId: "runmeter-test.apps.googleusercontent.com",
      clientSecret: null,
    },
  );

  const status = await adapter.getStatus();
  assert.equal(status.status, "error");
  assert.equal(status.error?.code, "unauthorized");
  assert.equal(status.metadata?.credentialState, "active");
  assert.equal(status.metadata?.projectId, "runmeter-test-project");
  assert.equal(status.metadata?.connectionStage, undefined);
});

test("Gemini disconnect wins over an in-flight project selection", async () => {
  const baseFetchCalls = installMonitoringFetch("race-access-token");
  const baseFetch = globalThis.fetch;
  const projectRequestStarted = deferred();
  const releaseProjectRequest = deferred();
  globalThis.fetch = (async (input, init) => {
    const url = urlFromFetchInput(input);
    if (
      url.hostname === "cloudresourcemanager.googleapis.com" &&
      /^\/v3\/projects\/[a-z][a-z0-9-]+$/.test(url.pathname)
    ) {
      projectRequestStarted.resolve(undefined);
      await releaseProjectRequest.promise;
    }
    return baseFetch(input, init);
  }) as typeof fetch;

  const vault = new MemoryVault();
  vault.values.set(
    "gemini:connection-v1",
    JSON.stringify({
      version: 1,
      pending: {
        refreshToken: "race-refresh-token",
        createdAt: new Date().toISOString(),
      },
    }),
  );
  const adapter = new GeminiAdapter(vault, null, {
    clientId: "runmeter-test.apps.googleusercontent.com",
    clientSecret: null,
  });

  const selection = adapter.connect({
    mode: "select-project",
    options: { projectId: "runmeter-test-project" },
  });
  await projectRequestStarted.promise;
  const disconnect = adapter.disconnect();
  releaseProjectRequest.resolve(undefined);
  const [selectionResult] = await Promise.all([selection, disconnect]);
  assert.equal(selectionResult.kind, "connected");
  assert.equal((await adapter.getStatus()).status, "disconnected");
  assert.equal(await vault.get("gemini", "connection-v1"), null);
  assert.equal(baseFetchCalls.length > 0, true);
});

test("Gemini OAuth callback cannot restore credentials after disconnect", async () => {
  const tokenRequestStarted = deferred();
  const releaseTokenRequest = deferred();
  globalThis.fetch = (async (input) => {
    const url = urlFromFetchInput(input);
    assert.equal(url.hostname, "oauth2.googleapis.com");
    tokenRequestStarted.resolve(undefined);
    await releaseTokenRequest.promise;
    return jsonResponse({
      access_token: "late-oauth-access-token",
      refresh_token: "late-oauth-refresh-token",
      expires_in: 3_600,
      scope: GOOGLE_OAUTH_SCOPES.join(" "),
    });
  }) as typeof fetch;

  const vault = new MemoryVault();
  const adapter = new GeminiAdapter(vault, null, {
    clientId: "runmeter-test.apps.googleusercontent.com",
    clientSecret: null,
  });
  try {
    const result = await adapter.connect({ mode: "oauth" });
    if (result.kind !== "action-required" || result.action.type !== "open-url") {
      assert.fail("Expected Google authorization URL");
    }
    assert.equal((await adapter.refresh()).metadata?.connectionStage, "google-auth");
    const authorizationUrl = new URL(result.action.url);
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(redirectUri);
    assert.ok(state);
    const callback = originalFetch(
      `${redirectUri}?code=authorization-code&state=${encodeURIComponent(state)}`,
    ).catch(() => null);
    await tokenRequestStarted.promise;
    const disconnect = adapter.disconnect();
    releaseTokenRequest.resolve(undefined);
    await disconnect;
    await callback;
    assert.equal((await adapter.getStatus()).status, "disconnected");
    assert.equal(await vault.get("gemini", "connection-v1"), null);
  } finally {
    await adapter.dispose();
  }
});

test("Cloud Monitoring quota and token series are normalized", async () => {
  const calls = installMonitoringFetch("google-access-secret");
  const now = new Date("2026-08-20T12:34:56.000Z");

  const report = await fetchGeminiUsageReport(
    "google-access-secret",
    "runmeter-test-project",
    now,
  );

  assert.equal(report.fetchedAt, now.toISOString());
  assert.deepEqual(report.windows, [
    {
      id: `${quotaUsageMetric}:GenerateContentRequestsPerMinutePerProjectPerModel|gemini-2.5-pro`,
      label: "Generate content requests per minute・gemini-2.5-pro",
      model: "gemini-2.5-pro",
      used: 25,
      limit: 100,
      usedPercent: 25,
      unit: "1",
      resetsAt: "2026-08-20T12:35:00.000Z",
      estimatedReset: true,
    },
  ]);
  assert.deepEqual(report.daily, [
    {
      date: "2026-08-19",
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    },
    {
      date: "2026-08-20",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    },
  ]);
  assert.equal(
    calls.filter((call) => call.url.hostname === "monitoring.googleapis.com").length,
    5,
  );
});

test("Cloud Monitoring limit-only series produces a zero-percent quota window", async () => {
  installMonitoringFetch("limit-only-access-token", { limitOnly: true });
  const report = await fetchGeminiUsageReport(
    "limit-only-access-token",
    "runmeter-test-project",
    new Date("2026-08-20T12:34:56.000Z"),
  );

  assert.equal(report.windows.length, 1);
  assert.equal(report.windows[0]?.used, 0);
  assert.equal(report.windows[0]?.limit, 100);
  assert.equal(report.windows[0]?.usedPercent, 0);
  assert.equal(report.windows[0]?.model, "gemini-2.5-pro");
});

test("Google tokens and shared client secret never enter Gemini snapshots or SQLite", async () => {
  const accessToken = "google-access-secret";
  const refreshToken = "google-refresh-secret";
  const clientSecret = "google-client-secret";
  const calls = installMonitoringFetch(accessToken);
  const vault = new MemoryVault();
  vault.values.set(
    "gemini:connection-v1",
    JSON.stringify({
      version: 1,
      active: { refreshToken, projectId: "runmeter-test-project" },
    }),
  );
  const initialSnapshot: ProviderSnapshot = {
    providerId: "gemini",
    displayName: "Gemini API",
    status: "degraded",
    ingestion: "poll",
    updatedAt: "2026-08-19T00:00:00.000Z",
    windows: [],
    dailyUsage: [],
    metadata: {
      scope: "google-cloud-project",
      projectId: "runmeter-test-project",
    },
  };
  const clientId = "runmeter-test.apps.googleusercontent.com";
  const adapter = new GeminiAdapter(vault, initialSnapshot, {
    clientId,
    clientSecret,
  });

  const snapshot = await adapter.refresh();
  assert.equal(snapshot.status, "connected");
  const serialized = JSON.stringify(snapshot);
  for (const secret of [accessToken, refreshToken, clientSecret]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes(clientId), false);
  const tokenCall = calls.find((call) => call.url.hostname === "oauth2.googleapis.com");
  assert.ok(tokenCall);
  assert.equal(
    new URLSearchParams(String(tokenCall.init?.body)).get("refresh_token"),
    refreshToken,
  );

  const directory = mkdtempSync(join(tmpdir(), "runmeter-gemini-store-test-"));
  const store = new RelayStore(join(directory, "relay.sqlite"));
  try {
    store.saveProviderSnapshot(snapshot);
    assert.equal(
      JSON.stringify(store.getProviderSnapshot("gemini")),
      serialized,
    );
    assert.throws(
      () =>
        store.saveProviderSnapshot({
          ...snapshot,
          metadata: { accessToken },
        }),
      /Sensitive metadata key rejected/,
    );
    for (const key of ["clientSecret", "refresh-token"]) {
      assert.throws(
        () =>
          store.saveProviderSnapshot({
            ...snapshot,
            metadata: { [key]: "redacted-test-value" },
          }),
        /Sensitive metadata key rejected/,
      );
    }
    for (const credentialLikeValue of [
      "GOCSPX-abcdefghijklmnopqrstuvwxyz",
      "ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz",
      "1//0abcdefghijklmnopqrstuvwxyz",
    ]) {
      assert.throws(
        () =>
          store.saveProviderSnapshot({
            ...snapshot,
            metadata: { scope: credentialLikeValue },
          }),
        /Credential-like value rejected/,
      );
    }
  } finally {
    store.close();
  }

  try {
    for (const file of readdirSync(directory)) {
      const contents = readFileSync(join(directory, file));
      for (const secret of [accessToken, refreshToken, clientSecret]) {
        assert.equal(contents.includes(Buffer.from(secret)), false);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
