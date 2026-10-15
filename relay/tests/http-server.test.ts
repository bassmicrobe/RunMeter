import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { buildDashboardSnapshot } from "../core/dashboard.ts";
import { ProviderRegistry } from "../core/registry.ts";
import type {
  DailyUsage,
  DashboardSnapshot,
  ProviderAdapter,
  ProviderConnectResult,
  ProviderProjectList,
  ProviderSnapshot,
} from "../core/types.ts";
import { RELAY_HOST, RelayHttpServer } from "../http-server.ts";
import { PairingManager } from "../pairing.ts";
import { RelayStore } from "../storage.ts";

function requestWithHost(input: {
  port: number;
  hostHeader: string;
  origin: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      {
        hostname: RELAY_HOST,
        port: input.port,
        path: "/v1/health",
        method: "GET",
        headers: {
          Host: input.hostHeader,
          Origin: input.origin,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolveRequest({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", rejectRequest);
    request.end();
  });
}

function disconnected(): ProviderSnapshot {
  return {
    providerId: "claude",
    displayName: "Claude",
    status: "disconnected",
    ingestion: "none",
    updatedAt: null,
    windows: [],
    dailyUsage: [],
  };
}

class FakeClaudeAdapter implements ProviderAdapter {
  readonly id = "claude";
  readonly displayName = "Claude";
  readonly capabilities = {
    connect: true,
    disconnect: true,
    refresh: true,
    ingest: true,
  } as const;
  snapshot = disconnected();

  async getStatus(): Promise<ProviderSnapshot> {
    return this.snapshot;
  }

  async connect(): Promise<ProviderConnectResult> {
    return { kind: "connected", snapshot: this.snapshot };
  }

  async disconnect(): Promise<void> {
    this.snapshot = disconnected();
  }

  async refresh(): Promise<ProviderSnapshot> {
    return this.snapshot;
  }

  async ingest(): Promise<ProviderSnapshot> {
    this.snapshot = {
      ...disconnected(),
      status: "connected",
      ingestion: "event",
      updatedAt: new Date().toISOString(),
      windows: [
        {
          id: "claude:five-hour",
          label: "5時間",
          usedPercent: 10,
          resetsAt: null,
          source: "provider",
          estimated: false,
        },
      ],
    };
    return this.snapshot;
  }
}

class FakeGeminiAdapter implements ProviderAdapter {
  readonly id = "gemini";
  readonly displayName = "Gemini API";
  readonly capabilities = {
    connect: true,
    disconnect: true,
    refresh: true,
    ingest: false,
  } as const;

  async getStatus(): Promise<ProviderSnapshot> {
    return {
      providerId: this.id,
      displayName: this.displayName,
      status: "connecting",
      ingestion: "none",
      updatedAt: "2026-08-20T00:00:00.000Z",
      windows: [],
      dailyUsage: [],
      metadata: { connectionStage: "choose-project" },
    };
  }

  async connect(): Promise<ProviderConnectResult> {
    return { kind: "connected", snapshot: await this.getStatus() };
  }

  async disconnect(): Promise<void> {}

  async refresh(): Promise<ProviderSnapshot> {
    return this.getStatus();
  }

  async listProjects(): Promise<ProviderProjectList> {
    return {
      projects: [
        {
          id: "runmeter-test-project",
          displayName: "RunMeter Test",
          state: "ACTIVE",
        },
      ],
      truncated: false,
    };
  }
}

async function testRelay(context: TestContext, adapter = new FakeClaudeAdapter()) {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-http-regression-")));
  const store = new RelayStore(join(directory, "test.sqlite3"));
  const pairing = new PairingManager(store, directory);
  const server = new RelayHttpServer({
    registry: new ProviderRegistry().register(adapter),
    store,
    pairing,
    allowedOrigins: ["https://run-meter.vercel.app"],
    port: 0,
  });
  await server.start();
  context.after(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const session = pairing.claim(pairing.getPairingCode().code, "test");
  return {
    server, store, pairing, adapter,
    url: `http://${RELAY_HOST}:${server.port}`,
    headers: { Authorization: `Bearer ${session.token}`, Origin: "https://run-meter.vercel.app" },
  };
}

test("dashboard keeps locally saved daily history when the API period shrinks and after disconnect", async (context) => {
  const { store, adapter, url, headers } = await testRelay(context);
  const previous = {
    ...disconnected(),
    status: "connected" as const,
    ingestion: "event" as const,
    updatedAt: "2026-08-19T12:00:00.000Z",
    dailyUsage: [{ date: "2026-08-19", tokens: 100 }, { date: "2026-08-20", tokens: 150 }],
  };
  store.saveProviderSnapshot(previous);
  adapter.snapshot = {
    ...previous,
    updatedAt: "2026-08-20T12:00:00.000Z",
    dailyUsage: [{ date: "2026-08-20", tokens: 200 }],
    windows: [{ id: "claude:five-hour", label: "5時間", usedPercent: 42, resetsAt: null, source: "provider", estimated: false }],
  };
  const before = await fetch(`${url}/v1/snapshot`, { headers });
  assert.equal(before.status, 200);
  const beforeSnapshot = await before.json() as DashboardSnapshot;
  assert.deepEqual(beforeSnapshot.dailyHistory.map(({ date, totalTokens }) => ({ date, totalTokens })), [
    { date: "2026-08-19", totalTokens: 100 },
    { date: "2026-08-20", totalTokens: 200 },
  ]);
  assert.equal(beforeSnapshot.providers.find(({ id }) => id === "claude")?.usageWindows.length, 1);
  assert.equal((await fetch(`${url}/v1/providers/claude/disconnect`, { method: "POST", headers })).status, 200);
  const after = await fetch(`${url}/v1/snapshot`, { headers });
  const afterSnapshot = await after.json() as DashboardSnapshot;
  assert.deepEqual(afterSnapshot.dailyHistory, beforeSnapshot.dailyHistory);
  assert.deepEqual(afterSnapshot.providerHistoryMatrix, beforeSnapshot.providerHistoryMatrix);
  const disconnectedProvider = afterSnapshot.providers.find(({ id }) => id === "claude");
  assert.equal(disconnectedProvider?.status, "disconnected");
  assert.deepEqual(disconnectedProvider?.usageWindows, []);
  assert.deepEqual(store.getProviderSnapshot("claude")?.dailyUsage, []);
});

test("dashboard polling does not read a hidden provider's status or credentials", async (context) => {
  const { store, pairing } = await testRelay(context);
  const hidden = new FakeGeminiAdapter();
  let hiddenStatusReads = 0;
  const originalGetStatus = hidden.getStatus.bind(hidden);
  hidden.getStatus = async () => { hiddenStatusReads += 1; return originalGetStatus(); };
  const server = new RelayHttpServer({
    registry: new ProviderRegistry().register(new FakeClaudeAdapter()).register(hidden),
    store,
    pairing,
    allowedOrigins: ["https://run-meter.vercel.app"],
    port: 0,
  });
  await server.start();
  context.after(() => server.close());
  const session = pairing.claim(pairing.getPairingCode().code, "test");
  const response = await fetch(`http://${RELAY_HOST}:${server.port}/v1/snapshot`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as DashboardSnapshot).providers.map(({ id }) => id), ["codex", "claude"]);
  assert.equal(hiddenStatusReads, 0);
});

test("provider failures never return private error details or mark cached data fresh", async (context) => {
  const { adapter, store, url, headers } = await testRelay(context);
  const previous = {
    ...disconnected(),
    status: "connected" as const,
    ingestion: "event" as const,
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
  store.saveProviderSnapshot(previous);
  const privateError = "refresh_token=unrecognized-private-token at C:\\Users\\private-user\\secret.json";
  adapter.getStatus = async () => { throw new Error(privateError); };
  adapter.refresh = async () => { throw new Error(privateError); };
  for (const path of ["/v1/providers/claude", "/v1/providers/claude/refresh"]) {
    const response = await fetch(`${url}${path}`, {
      method: path.endsWith("refresh") ? "POST" : "GET",
      headers,
    });
    const body = await response.text();
    assert.equal(body.includes("unrecognized-private-token"), false);
    assert.equal(body.includes("private-user"), false);
    if (!path.endsWith("refresh")) {
      assert.equal(JSON.parse(body).updatedAt, previous.updatedAt);
    }
  }
});

test("a refresh completed after disconnect cannot restore cached connection data", async (context) => {
  const { adapter, store, url, headers } = await testRelay(context);
  const previous = {
    ...disconnected(),
    status: "connected" as const,
    ingestion: "event" as const,
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
  adapter.snapshot = previous;
  store.saveProviderSnapshot(previous);
  const started = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<ProviderSnapshot>();
  adapter.refresh = async () => {
    started.resolve();
    return completed.promise;
  };
  const refreshing = fetch(`${url}/v1/providers/claude/refresh`, { method: "POST", headers });
  await started.promise;
  const disconnectedResponse = await fetch(`${url}/v1/providers/claude/disconnect`, { method: "POST", headers });
  assert.equal(disconnectedResponse.status, 200);
  completed.resolve(previous);
  assert.equal((await refreshing).status, 409);
  assert.equal(store.getProviderSnapshot("claude")?.status, "disconnected");
});

test("a status read completed after disconnect returns the current connection state", async (context) => {
  const { adapter, store, url, headers } = await testRelay(context);
  const previous = {
    ...disconnected(),
    status: "connected" as const,
    ingestion: "event" as const,
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
  store.saveProviderSnapshot(previous);
  const started = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<ProviderSnapshot>();
  let firstRead = true;
  adapter.getStatus = async () => {
    if (!firstRead) return disconnected();
    firstRead = false;
    started.resolve();
    return completed.promise;
  };
  const reading = fetch(`${url}/v1/providers/claude`, { headers });
  await started.promise;
  await fetch(`${url}/v1/providers/claude/disconnect`, { method: "POST", headers });
  completed.resolve(previous);
  const response = await reading;
  assert.equal(((await response.json()) as ProviderSnapshot).status, "disconnected");
  assert.equal(store.getProviderSnapshot("claude")?.status, "disconnected");
});

test("cached error and connecting snapshots do not add usage observations", async (context) => {
  const { store } = await testRelay(context);
  const snapshot: ProviderSnapshot = {
    ...disconnected(),
    status: "connected",
    ingestion: "event",
    updatedAt: "2026-08-20T12:00:00.000Z",
    windows: [{ id: "claude:five-hour", label: "5時間", usedPercent: 23, resetsAt: null, source: "provider", estimated: false }],
  };
  store.saveProviderSnapshot(snapshot);
  store.saveProviderSnapshot({ ...snapshot, status: "connecting", updatedAt: "2026-08-20T12:01:00.000Z" });
  store.saveProviderSnapshot({ ...snapshot, status: "error", updatedAt: "2026-08-20T12:02:00.000Z" });
  store.saveProviderSnapshot({ ...snapshot, status: "degraded", error: { code: "offline", message: "offline" }, updatedAt: "2026-08-20T12:03:00.000Z" });
  const history = store.listUsageHistory("claude", "2026-08-20T00:00:00.000Z");
  assert.equal(history.length, 1);
  assert.equal(history[0]?.observedAt, snapshot.updatedAt);
});

test("HTTP relay can retry a failed listen after the occupied port is released", async (context) => {
  const { server, store, pairing } = await testRelay(context);
  const retrying = new RelayHttpServer({
    registry: new ProviderRegistry().register(new FakeClaudeAdapter()),
    store,
    pairing,
    allowedOrigins: ["https://run-meter.vercel.app"],
    port: server.port,
  });
  context.after(() => retrying.close());
  await assert.rejects(retrying.start(), { code: "EADDRINUSE" });
  await server.close();
  await retrying.start();
  const health = await fetch(`http://${RELAY_HOST}:${retrying.port}/v1/health`);
  assert.equal(health.status, 200);
});

test("pairing rejects oversized JSON before claiming a code", async (context) => {
  const { url, headers, pairing } = await testRelay(context);
  const code = pairing.getPairingCode().code;
  const oversized = await fetch(`${url}/v1/pair`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ code, label: "x".repeat(65_536) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(pairing.getPairingCode().code, code);
});

test("HTTP relay enforces pairing, revocation, strict origin, and scoped ingest", async (context) => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-http-")));
  const store = new RelayStore(join(directory, "test.sqlite3"));
  const pairing = new PairingManager(store, directory);
  const adapter = new FakeClaudeAdapter();
  const registry = new ProviderRegistry()
    .register(adapter)
    .register(new FakeGeminiAdapter());
  const server = new RelayHttpServer({
    registry,
    store,
    pairing,
    allowedOrigins: ["https://run-meter.vercel.app"],
    port: 0,
  });
  await server.start();
  const origin = `http://${RELAY_HOST}:${server.port}`;
  const allowedOrigin = "https://run-meter.vercel.app";
  context.after(async () => {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const health = await fetch(`${origin}/v1/health`, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(health.headers.get("access-control-allow-origin")?.includes("*"), false);
  assert.match(health.headers.get("vary") ?? "", /Origin/);

  const forbiddenOrigin = await fetch(`${origin}/v1/health`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(forbiddenOrigin.status, 403);
  assert.equal(forbiddenOrigin.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await forbiddenOrigin.json(), {
    error: {
      code: "origin_not_allowed",
      message: "Browser origin is not allowed.",
    },
  });

  const invalidHost = await requestWithHost({
    port: server.port,
    hostHeader: "evil.example",
    origin: allowedOrigin,
  });
  assert.equal(invalidHost.status, 421);
  assert.equal(invalidHost.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(JSON.parse(invalidHost.body), {
    error: {
      code: "invalid_host",
      message: "Host header is not allowed.",
    },
  });

  const preflight = await fetch(`${origin}/v1/pair`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
      "Access-Control-Request-Private-Network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(
    preflight.headers.get("access-control-allow-methods"),
    "GET, POST, DELETE, OPTIONS",
  );
  assert.equal(
    preflight.headers.get("access-control-allow-headers"),
    "Authorization, Content-Type",
  );
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
  assert.equal(preflight.headers.get("access-control-max-age"), "600");

  const unpairedProjects = await fetch(
    `${origin}/v1/providers/gemini/projects`,
    { headers: { Origin: allowedOrigin } },
  );
  assert.equal(unpairedProjects.status, 401);

  const code = pairing.getPairingCode().code;
  assert.ok(code);
  const pairResponse = await fetch(`${origin}/v1/pair`, {
    method: "POST",
    headers: {
      Origin: allowedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
  const paired = (await pairResponse.json()) as {
    token: string;
    tokenVersion: string;
  };
  assert.equal(pairResponse.status, 201);
  assert.equal(paired.tokenVersion, "1");
  assert.equal(pairResponse.headers.get("access-control-allow-origin"), allowedOrigin);

  const reusedCode = await fetch(`${origin}/v1/pair`, {
    method: "POST",
    headers: {
      Origin: allowedOrigin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
  assert.equal(reusedCode.status, 401);
  assert.equal(
    ((await reusedCode.json()) as { error: { code: string } }).error.code,
    "invalid_pairing_code",
  );

  const snapshot = await fetch(`${origin}/v1/snapshot`, {
    headers: {
      Authorization: `Bearer ${paired.token}`,
      Origin: allowedOrigin,
    },
  });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers.get("access-control-allow-origin"), allowedOrigin);
  const dashboard = (await snapshot.json()) as { providers: Array<{ id: string }> };
  assert.deepEqual(
    dashboard.providers.map((provider) => provider.id),
    ["codex", "claude"],
  );

  const projects = await fetch(`${origin}/v1/providers/gemini/projects`, {
    headers: {
      Authorization: `Bearer ${paired.token}`,
      Origin: allowedOrigin,
    },
  });
  assert.equal(projects.status, 200);
  assert.deepEqual(await projects.json(), {
    projects: [
      {
        id: "runmeter-test-project",
        displayName: "RunMeter Test",
        state: "ACTIVE",
      },
    ],
    truncated: false,
  });

  const servicePath = pairing.ensureServiceCredential("claude-statusline", "ingest:claude");
  const serviceToken = readFileSync(servicePath, "utf8").trim();
  const ingest = await fetch(`${origin}/v1/providers/claude/ingest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(ingest.status, 200);

  const serviceCannotRead = await fetch(`${origin}/v1/snapshot`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(serviceCannotRead.status, 401);
  assert.equal(
    ((await serviceCannotRead.json()) as { error: { code: string } }).error.code,
    "invalid_bearer",
  );
  const serviceCannotListProjects = await fetch(
    `${origin}/v1/providers/gemini/projects`,
    { headers: { Authorization: `Bearer ${serviceToken}` } },
  );
  assert.equal(serviceCannotListProjects.status, 401);

  const revoke = await fetch(`${origin}/v1/pair`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${paired.token}`,
      Origin: allowedOrigin,
    },
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.headers.get("access-control-allow-origin"), allowedOrigin);
  const revokedRead = await fetch(`${origin}/v1/snapshot`, {
    headers: {
      Authorization: `Bearer ${paired.token}`,
      Origin: allowedOrigin,
    },
  });
  assert.equal(revokedRead.status, 401);
  assert.equal(
    ((await revokedRead.json()) as { error: { code: string } }).error.code,
    "invalid_bearer",
  );
});

function providerSnapshot(
  providerId: string,
  dailyUsage: DailyUsage[],
): ProviderSnapshot {
  return {
    providerId,
    displayName: providerId,
    status: "connected",
    ingestion: "poll",
    updatedAt: "2026-08-20T12:00:00.000Z",
    windows: [],
    dailyUsage,
  };
}

test("dashboard daily history sums only visible providers by date", () => {
  const dashboard = buildDashboardSnapshot(
    [
      providerSnapshot("codex", [
        { date: "2026-08-19", tokens: 100, costUsd: 1 },
        { date: "2026-08-20", tokens: 50, costUsd: 0.5 },
      ]),
      providerSnapshot("claude", [
        { date: "2026-08-19", tokens: 300, costUsd: 2 },
      ]),
      providerSnapshot("gemini", [
        { date: "2026-08-20", tokens: 150, costUsd: 1.5 },
      ]),
    ],
    new Date("2026-08-20T12:00:00.000Z"),
  );

  assert.deepEqual(dashboard.dailyHistory, [
    {
      date: "2026-08-19",
      label: "8/19",
      totalTokens: 400,
      costUsd: 3,
      runs: 0,
      successRate: 0,
      p95LatencyMs: 0,
    },
    {
      date: "2026-08-20",
      label: "8/20",
      totalTokens: 50,
      costUsd: 0.5,
      runs: 0,
      successRate: 0,
      p95LatencyMs: 0,
    },
  ]);
});

test("provider history matrix excludes unsupported providers and normalizes intensity", () => {
  const dashboard = buildDashboardSnapshot(
    [
      providerSnapshot("codex", [
        { date: "2026-08-19", tokens: 100, costUsd: 1 },
        { date: "2026-08-20", tokens: 50, costUsd: 0.5 },
      ]),
      providerSnapshot("claude", [
        { date: "2026-08-19", tokens: 300, costUsd: 2 },
      ]),
      providerSnapshot("gemini", [
        { date: "2026-08-20", tokens: 150, costUsd: 1.5 },
      ]),
      providerSnapshot("unsupported-provider", [
        { date: "2026-08-19", tokens: 10_000, costUsd: 999 },
      ]),
    ],
    new Date("2026-08-20T12:00:00.000Z"),
  );

  assert.equal(
    dashboard.providerHistoryMatrix.some(
      (entry) => entry.providerId === "unsupported-provider",
    ),
    false,
  );
  assert.deepEqual(
    [...new Set(dashboard.providerHistoryMatrix.map((entry) => entry.providerId))].sort(),
    ["claude", "codex"],
  );
  assert.equal(
    dashboard.providerHistoryMatrix.every(
      (entry) => entry.intensity >= 0 && entry.intensity <= 1,
    ),
    true,
  );
  assert.equal(
    Math.max(...dashboard.providerHistoryMatrix.map((entry) => entry.intensity)),
    1,
  );
  assert.equal(
    dashboard.providerHistoryMatrix.find(
      (entry) => entry.providerId === "claude" && entry.date === "2026-08-19",
    )?.intensity,
    1,
  );
  assert.equal(
    dashboard.providerHistoryMatrix.find(
      (entry) => entry.providerId === "codex" && entry.date === "2026-08-19",
    )?.intensity,
    1 / 3,
  );
});
