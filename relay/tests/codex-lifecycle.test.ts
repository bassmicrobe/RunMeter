import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CodexAdapter } from "../adapters/codex.ts";
import { CodexAppServerClient, type CodexRpcClient } from "../adapters/codex-app-server-client.ts";
import type { ProviderSnapshot } from "../core/types.ts";
import { RelayStore } from "../storage.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const storedSnapshot: ProviderSnapshot = {
  providerId: "codex",
  displayName: "Codex",
  status: "connected",
  ingestion: "poll",
  updatedAt: "2026-08-20T12:00:00.000Z",
  windows: [{ id: "codex:primary", label: "5時間", usedPercent: 24, resetsAt: null, source: "provider", estimated: false }],
  dailyUsage: [{ date: "2026-08-20", tokens: 200 }],
  metadata: { attached: true, primaryUsageWindowId: "codex:primary" },
};

function mockRpc(request: CodexRpcClient["request"]): CodexRpcClient {
  return { request, onNotification: () => () => undefined, close: async () => undefined };
}

test("Codex disconnect wins over a pending successful refresh", async (t) => {
  const store = new RelayStore(":memory:");
  t.after(() => store.close());
  store.saveProviderSnapshot(storedSnapshot);
  const started = deferred<void>();
  const rates = deferred<unknown>();
  const client = mockRpc(async (method) => {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "account/rateLimits/read") { started.resolve(); return rates.promise; }
    return {};
  });
  const adapter = new CodexAdapter(store, client);
  const refreshing = adapter.refresh();
  await started.promise;
  await adapter.disconnect();
  rates.resolve({ rateLimits: { primary: { usedPercent: 90 } } });
  assert.equal((await refreshing).status, "disconnected");
  assert.equal(store.getProviderSnapshot("codex")?.metadata?.attached, false);
  await adapter.dispose();
});

test("Codex disconnect cancels a pending account login without starting OAuth", async (t) => {
  const store = new RelayStore(":memory:");
  t.after(() => store.close());
  const account = deferred<unknown>();
  const methods: string[] = [];
  const adapter = new CodexAdapter(store, mockRpc(async (method) => { methods.push(method); return account.promise; }));
  const connecting = adapter.connect({ mode: "browser" });
  await adapter.disconnect();
  account.resolve({ account: null });
  assert.equal((await connecting).kind, "unsupported");
  assert.deepEqual(methods, ["account/read"]);
  assert.equal(store.getProviderSnapshot("codex")?.status, "disconnected");
  await adapter.dispose();
});

test("Codex failed refresh preserves last successful measurement time and usage", async (t) => {
  const store = new RelayStore(":memory:");
  t.after(() => store.close());
  store.saveProviderSnapshot(storedSnapshot);
  const adapter = new CodexAdapter(store, mockRpc(async (method) => {
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "account/usage/read") return { dailyUsageBuckets: [{ startDate: "2026-08-20", tokens: 300 }] };
    throw new Error("secret-provider-response");
  }));
  const result = await adapter.refresh();
  assert.equal(result.status, "degraded");
  assert.equal(result.updatedAt, storedSnapshot.updatedAt);
  assert.deepEqual(result.windows, storedSnapshot.windows);
  assert.equal(result.dailyUsage[0]?.tokens, 300);
  assert.equal(JSON.stringify(result).includes("secret-provider-response"), false);
  await adapter.dispose();
});

test("Codex missing CLI yields actionable Japanese instructions without leaking errors", async (t) => {
  const store = new RelayStore(":memory:");
  t.after(() => store.close());
  const adapter = new CodexAdapter(store, mockRpc(async () => {
    throw Object.assign(new Error("spawn C:/private/name/codex.exe ENOENT"), { code: "ENOENT" });
  }));
  const result = await adapter.connect({});
  assert.equal(result.kind, "unsupported");
  assert.match(result.snapshot?.error?.message ?? "", /Codex CLI.*インストール/);
  assert.equal(JSON.stringify(result).includes("private"), false);
  await adapter.dispose();
});

test("Codex status polling shares a short cache while explicit refresh and notifications stay immediate", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-20T12:00:00.000Z") });
  const store = new RelayStore(":memory:");
  t.after(() => store.close());
  store.saveProviderSnapshot(storedSnapshot);
  const methods: string[] = [];
  let notify: (method: string, params: unknown) => void = () => undefined;
  const adapter = new CodexAdapter(store, {
    request: async (method) => {
      methods.push(method);
      if (method === "account/read") return { account: { type: "chatgpt" } };
      return {};
    },
    onNotification: (listener) => { notify = listener; return () => undefined; },
    close: async () => undefined,
  });
  t.after(() => adapter.dispose());
  await adapter.getStatus();
  await adapter.getStatus();
  assert.equal(methods.length, 3, "sequential status reads reuse one provider fetch");
  await adapter.refresh();
  assert.equal(methods.length, 6, "manual refresh bypasses the status cache");
  notify("account/rateLimits/updated", {});
  await adapter.getStatus();
  assert.equal(methods.length, 9, "notifications refresh immediately and status joins the in-flight request");
  t.mock.timers.tick(10_000);
  await adapter.getStatus();
  assert.equal(methods.length, 12, "status refreshes after ten seconds");
  await adapter.disconnect();
  await adapter.getStatus();
  assert.equal(methods.length, 12, "disconnect drops the cache without restarting Codex");
});

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  ended = false;
  requests: Array<{ id?: number; method?: string }> = [];
  onRequest?: (request: { id?: number; method?: string }) => void;

  constructor() {
    super();
    this.stdin.on("data", (data: Buffer) => {
      const request = JSON.parse(data.toString()) as { id?: number; method?: string };
      this.requests.push(request);
      this.onRequest?.(request);
    });
    this.stdin.on("finish", () => { this.ended = true; this.kill(); });
  }

  kill() { this.exitCode = 0; this.emit("exit", 0); return true; }
  respond(id: number | undefined, result: unknown) { this.stdout.write(`${JSON.stringify({ id, result })}\n`); }
  asChild() { return this as unknown as ChildProcessWithoutNullStreams; }
}

test("Codex app-server ignores malformed JSON values and malformed error messages", async () => {
  const process = new FakeProcess();
  process.onRequest = ({ id, method }) => {
    if (method === "initialize") {
      process.stdout.write("null\n[]\n42\nnot-json\n");
      process.respond(id, {});
    } else if (id) {
      process.stdout.write(`${JSON.stringify({ id, error: { message: { unexpected: true } } })}\n`);
    }
  };
  const client = new CodexAppServerClient("runmeter-test-fake", { spawnProcess: () => process.asChild() });
  try {
    await assert.rejects(client.request("account/read"), /request failed/);
  } finally {
    await client.close();
  }
  assert.equal(process.ended, true);
});

test("Codex app-server initialization timeout closes the child before retrying", async () => {
  const children: FakeProcess[] = [];
  const client = new CodexAppServerClient("runmeter-test-fake", {
    initializeTimeoutMs: 20,
    spawnProcess: () => {
      const process = new FakeProcess();
      if (children.length > 0) process.onRequest = ({ id }) => { if (id) process.respond(id, { ok: true }); };
      children.push(process);
      return process.asChild();
    },
  });
  try {
    await assert.rejects(client.request("account/read"), /timed out/);
    assert.equal(children[0]?.ended, true);
    assert.deepEqual(await client.request("account/read"), { ok: true });
    children[0]?.emit("error", new Error("late old process error"));
    assert.deepEqual(await client.request("account/read"), { ok: true });
    assert.equal(children.length, 2);
  } finally {
    await client.close();
  }
});

test("Codex app-server handles stdin errors and recovers on the next request", async () => {
  const children: FakeProcess[] = [];
  const client = new CodexAppServerClient("runmeter-test-fake", {
    spawnProcess: () => {
      const process = new FakeProcess();
      process.onRequest = ({ id, method }) => {
        if (method === "initialize" || children.length > 1) { if (id) process.respond(id, {}); }
        else if (id) process.stdin.emit("error", new Error("EPIPE"));
      };
      children.push(process);
      return process.asChild();
    },
  });
  try {
    await assert.rejects(client.request("account/read"), /EPIPE/);
    assert.equal(children[0]?.exitCode, 0);
    assert.deepEqual(await client.request("account/read"), {});
  } finally {
    await client.close();
  }
});
