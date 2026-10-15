import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildDashboardSnapshot, MAX_DASHBOARD_HISTORY_DAYS } from "../core/dashboard.ts";
import type { ProviderSnapshot } from "../core/types.ts";
import { RelayStore } from "../storage.ts";

function historySnapshot(days = 1): ProviderSnapshot {
  return {
    providerId: "codex",
    displayName: "Codex",
    status: "connected",
    ingestion: "poll",
    updatedAt: "2026-08-20T12:00:00.000Z",
    windows: [],
    dailyUsage: Array.from({ length: days }, (_, index) => ({
      date: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10),
      tokens: index + 1,
    })),
  };
}

test("saved daily history survives reopening the relay database and disconnecting", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "runmeter-history-restart-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "relay.sqlite3");
  const original = new RelayStore(path);
  const snapshot = historySnapshot();
  original.saveProviderSnapshot(snapshot);
  original.close();
  const restarted = new RelayStore(path);
  try {
    restarted.saveProviderSnapshot({ ...snapshot, status: "disconnected", ingestion: "none", updatedAt: null, dailyUsage: [] });
    assert.deepEqual(restarted.listDailyUsage("codex"), snapshot.dailyUsage);
    assert.deepEqual(restarted.listDailyUsage("claude"), []);
  } finally {
    restarted.close();
  }
});

test("stored history reads latest records first and dashboard payload stays bounded", () => {
  const store = new RelayStore(":memory:");
  try {
    const snapshot = historySnapshot(1_000);
    store.saveProviderSnapshot(snapshot);
    const history = store.listDailyUsage("codex");
    assert.equal(history.length, MAX_DASHBOARD_HISTORY_DAYS);
    assert.deepEqual(history, snapshot.dailyUsage.slice(-MAX_DASHBOARD_HISTORY_DAYS));
    assert.equal(store.listDailyUsage("codex", Infinity).length, MAX_DASHBOARD_HISTORY_DAYS);
    assert.equal(store.listDailyUsage("codex", 1_000_000).length, 366);
    const dashboard = buildDashboardSnapshot([
      snapshot,
      { ...snapshot, providerId: "claude", displayName: "Claude" },
    ]);
    assert.equal(dashboard.dailyHistory.length, MAX_DASHBOARD_HISTORY_DAYS);
    assert.equal(dashboard.providerHistoryMatrix.length, MAX_DASHBOARD_HISTORY_DAYS * 2);
    assert.equal(dashboard.dailyHistory.at(-1)?.totalTokens, 2_000);
    assert.equal(store.listDailyUsage("codex", 366).length, 366, "response limits do not delete saved history");
  } finally {
    store.close();
  }
});

test("unchanged polling does not rewrite a measurement and changed usage is still persisted", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "runmeter-history-writes-"));
  const path = join(directory, "relay.sqlite3");
  const store = new RelayStore(path);
  const observer = new DatabaseSync(path);
  context.after(() => {
    observer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  observer.exec("CREATE TABLE test_write_count (count INTEGER NOT NULL); INSERT INTO test_write_count VALUES (0)");
  for (const table of ["provider_snapshots", "usage_observations", "daily_usage"]) {
    for (const action of ["INSERT", "UPDATE"]) {
      observer.exec(`CREATE TRIGGER count_${table}_${action} AFTER ${action} ON ${table}
        BEGIN UPDATE test_write_count SET count = count + 1; END;`);
    }
  }
  const snapshot = {
    ...historySnapshot(),
    windows: [{ id: "codex:primary", label: "5時間", usedPercent: 24, resetsAt: null, source: "provider" as const, estimated: false }],
  };
  store.saveProviderSnapshot(snapshot);
  const originalWrites = observer.prepare("SELECT count FROM test_write_count").get()?.count;
  assert.equal(originalWrites, 3);
  for (let index = 0; index < 10; index += 1) store.saveProviderSnapshot(structuredClone(snapshot));
  assert.equal(observer.prepare("SELECT count FROM test_write_count").get()?.count, originalWrites);
  store.saveProviderSnapshot({ ...snapshot, windows: [{ ...snapshot.windows[0], usedPercent: 25 }] });
  assert.equal(store.getProviderSnapshot("codex")?.windows[0]?.usedPercent, 25);
  assert.equal(store.listUsageHistory("codex", "2026-08-20T00:00:00.000Z")[0]?.usedPercent, 25);
});

test("all-provider history uses its time index instead of scanning old measurements", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "runmeter-history-index-"));
  const path = join(directory, "relay.sqlite3");
  const store = new RelayStore(path);
  const observer = new DatabaseSync(path);
  context.after(() => {
    observer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const plan = observer.prepare(`EXPLAIN QUERY PLAN
    SELECT provider_id, window_id, observed_at, used_percent, resets_at
    FROM usage_observations WHERE observed_at >= ? ORDER BY observed_at ASC LIMIT ?
  `).all("2026-08-20T00:00:00.000Z", 100);
  assert.ok(plan.some((step) => /SEARCH .*usage_observations_by_time/.test(String(step.detail))));
});
