import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createDisconnectedDashboardSnapshot } from "../../src/lib/disconnected-dashboard";

const relay = "http://127.0.0.1:47831";
const testToken = "audit-fixture-" + "x".repeat(40);

async function seedSession(page: Page) {
  await page.evaluate(async ({ token, origin }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("runmeter-browser", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("relay-session");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("relay-session", "readwrite");
        transaction.objectStore("relay-session").put({
          storageVersion: 1, token, tokenVersion: "1", origin,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          pairedAt: new Date().toISOString(),
        }, "local-relay");
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onabort = () => reject(transaction.error);
      };
    });
  }, { token: testToken, origin: relay });
}

test.beforeEach(async ({ page }) => {
  // Every test uses an isolated browser; no real relay, credentials or accounts.
  await page.route(`${relay}/**`, route => route.abort());
});

test("unpaired screen and guide pass automated accessibility checks", async ({ page }, testInfo) => {
  for (const path of ["/", "/guide"]) {
    await page.goto(path);
    await page.getByRole("heading", { level: 1 }).waitFor();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
  }
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "利用データはまだありません" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("audited-dashboard.png"), fullPage: true });
});

test("320px menu closes accessibly and pairing remains usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route(`${relay}/v1/health`, route => route.fulfill({
    json: { ok: true, service: "RunMeter Relay", version: 1, providers: ["codex", "claude"] },
  }));
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "メニューを開閉", exact: true });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "メニュー" })).toBeVisible();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Codexの接続設定を開く" }).click();
  await expect(page.getByLabel("ペアリングコード", { exact: true })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations.map(item => item.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("90-day history provides exact values by keyboard without viewport overflow", async ({ page }) => {
  const now = new Date();
  const snapshot = createDisconnectedDashboardSnapshot(now);
  Object.assign(snapshot.providers[0], {
    status: "connected", lastSyncAt: now.toISOString(), ingestion: "poll", primaryUsageWindowId: "codex:5h",
    usageWindows: [{ id: "codex:5h", label: "5時間", usedPercent: 42,
      resetsAt: new Date(now.getTime() + 3_600_000).toISOString(), source: "provider", estimated: false }],
  });
  snapshot.dailyHistory = Array.from({ length: 90 }, (_, index) => {
    const date = new Date(now.getTime() - (89 - index) * 86_400_000).toISOString().slice(0, 10);
    return { date, label: `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`,
      totalTokens: 1234 + index, costUsd: 0, runs: 0, successRate: 0, p95LatencyMs: 0 };
  });
  snapshot.providerHistoryMatrix = snapshot.dailyHistory.map(day => ({
    providerId: "codex", date: day.date, label: day.label, tokens: day.totalTokens, costUsd: 0, intensity: 1,
  }));
  await page.route(`${relay}/**`, route => route.fulfill({ json: snapshot }));
  await page.goto("/");
  await seedSession(page);
  await page.reload();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  const summary = page.locator("summary").filter({ hasText: "日別の数値を見る" });
  await summary.focus();
  await page.keyboard.press("Enter");
  const table = page.getByRole("table", { name: "この端末に記録した日別の使用量。新しい日付から表示します。" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(91);
  await expect(table.getByRole("row").nth(1)).toContainText("1,323");
  const region = page.getByRole("region", { name: "日別の使用量（スクロールできます）" });
  await region.focus();
  await page.keyboard.press("End");
  await expect.poll(() => region.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator("*").count()).toBeLessThan(4500);
});

test("copy denial gives recovery guidance without an uncaught exception", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
    value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
  }));
  await page.route(`${relay}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/health") return route.fulfill({ json: {
      ok: true, service: "RunMeter Relay", version: 1, providers: ["codex", "claude"],
    } });
    if (path.endsWith("/connect")) return route.fulfill({ json: {
      kind: "action-required", action: { type: "instructions", steps: ["公式CLIで認証してください"], command: "codex login" },
    } });
    if (path === "/v1/providers/codex") return route.fulfill({ json: {
      providerId: "codex", displayName: "Codex", status: "disconnected", ingestion: "poll",
      updatedAt: null, windows: [], dailyUsage: [],
    } });
    return route.fulfill({ json: createDisconnectedDashboardSnapshot() });
  });
  await page.goto("/");
  await seedSession(page);
  await page.reload();
  await page.getByRole("button", { name: "Codexの接続設定を開く" }).click();
  await page.getByRole("button", { name: "Codexへログイン" }).click();
  await page.getByRole("button", { name: "コマンドをコピー", exact: true }).click();
  await expect(page.getByText("コピーできませんでした。表示された文字を選択してコピーしてください。", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("search remains operable in a short landscape viewport", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 375 });
  const snapshot = createDisconnectedDashboardSnapshot();
  snapshot.agents = Array.from({ length: 12 }, (_, index) => ({
    id: `fixture-${index}`, name: `検証エージェント${index + 1}`, slug: `fixture-${index}`,
    description: "自動テスト内だけのデータ", status: "idle", provider: "codex", model: "test-model",
    currentRunId: null, currentTask: null, tokensToday: 0, costTodayUsd: 0, requestsToday: 0,
    successRate: 0, p95LatencyMs: 0, lastSeenAt: new Date().toISOString(),
  }));
  await page.route(`${relay}/**`, route => route.fulfill({ json: snapshot }));
  await page.goto("/");
  await seedSession(page);
  await page.reload();
  await page.getByRole("button", { name: /実行を検索/ }).click();
  const dialog = page.getByRole("dialog", { name: "実行またはエージェントを検索" });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(375);
  await page.getByRole("combobox").fill("検証エージェント12");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("initial dashboard stays within its script budget and records rendering metrics", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const metrics = { lcpMs: 0, cls: 0, blockingMs: 0 };
    Object.assign(window, { runmeterAuditMetrics: metrics });
    new PerformanceObserver(list => list.getEntries().forEach(entry => { metrics.lcpMs = entry.startTime; }))
      .observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver(list => list.getEntries().forEach(entry => {
      const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
      if (!shift.hadRecentInput) metrics.cls += shift.value;
    })).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver(list => list.getEntries().forEach(entry => {
      metrics.blockingMs += Math.max(0, entry.duration - 50);
    })).observe({ type: "longtask", buffered: true });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "利用率とリセット" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const metrics = await page.evaluate(() => {
    const scripts = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    return {
      ...(window as unknown as { runmeterAuditMetrics: object }).runmeterAuditMetrics,
      scriptBytes: scripts.filter(entry => entry.initiatorType === "script").reduce((sum, entry) => sum + entry.encodedBodySize, 0),
      domElements: document.querySelectorAll("*").length,
    };
  });
  const metricsPath = testInfo.outputPath("rendering-metrics.json");
  await writeFile(metricsPath, JSON.stringify(metrics, null, 2));
  await testInfo.attach("rendering-metrics.json", { path: metricsPath, contentType: "application/json" });
  expect(metrics.scriptBytes).toBeLessThan(300 * 1024);
  expect(metrics.domElements).toBeLessThan(400);
});
