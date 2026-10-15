import { expect, test, type Page, type Route } from "@playwright/test";
import { createDisconnectedDashboardSnapshot } from "../../src/lib/disconnected-dashboard";

const relay = "http://127.0.0.1:47831";
const token = "release-test-" + "x".repeat(40);
const now = new Date("2026-09-26T10:00:00.000Z");

function snapshot() {
  const value = createDisconnectedDashboardSnapshot(now);
  Object.assign(value.providers[0], {
    status: "connected",
    lastSyncAt: now.toISOString(),
    ingestion: "poll",
    primaryUsageWindowId: "codex:5h",
    usageWindows: [{
      id: "codex:5h", label: "5時間", usedPercent: 42,
      resetsAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      source: "provider", estimated: false,
    }],
  });
  return value;
}

function providerSnapshot(connected = true) {
  return {
    providerId: "codex", displayName: "Codex",
    status: connected ? "connected" : "disconnected", ingestion: "poll",
    updatedAt: now.toISOString(), windows: connected ? snapshot().providers[0].usageWindows : [],
    dailyUsage: [],
  };
}

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

async function seedSession(page: Page, sessionToken = token) {
  await page.evaluate(async ({ token, relay, expiresAt }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("runmeter-browser", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("relay-session");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("relay-session", "readwrite");
        transaction.objectStore("relay-session").put({
          storageVersion: 1, token, tokenVersion: "1", expiresAt,
          origin: relay, pairedAt: new Date().toISOString(),
        }, "local-relay");
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onabort = () => reject(transaction.error);
      };
    });
  }, { token: sessionToken, relay, expiresAt: new Date(now.getTime() + 86400_000).toISOString() });
}

test.beforeEach(async ({ page }) => {
  // Tests never contact a running relay or any real provider/account.
  await page.route(`${relay}/**`, route => route.abort());
  await page.clock.install({ time: now });
});

test("initial view contains no demo data and fits the viewport", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const leakedRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.url().startsWith("http") && !request.url().startsWith("http://127.0.0.1:3210")) {
      leakedRequests.push(request.url());
    }
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "利用率とリセット" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "利用データはまだありません" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gemini", exact: true })).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(leakedRequests).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("initial.png"), fullPage: true });
});

test("pairing requires six digits and accepts a relay with only visible providers", async ({ page }) => {
  let attempts = 0;
  await page.route(`${relay}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/health") return json(route, { ok: true, service: "RunMeter Relay", version: 1, providers: ["codex", "claude"] });
    if (path === "/v1/pair") {
      attempts++;
      expect(route.request().postDataJSON()).toEqual({ code: "123456" });
      return json(route, { token, tokenVersion: "1", expiresAt: new Date(now.getTime() + 86400_000).toISOString() });
    }
    if (path === "/v1/providers/codex") return json(route, providerSnapshot(false));
    return json(route, snapshot());
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Codexの接続設定を開く" });
  await trigger.click();
  const input = page.getByLabel("ペアリングコード", { exact: true });
  await input.fill("1234");
  await expect(page.getByRole("button", { name: "この端末とペアリング" })).toBeDisabled();
  await input.press("Enter");
  expect(attempts).toBe(0);
  await input.fill("123456");
  await page.getByRole("button", { name: "この端末とペアリング" }).click();
  await expect(page.getByText("Relay接続済み", { exact: true })).toBeVisible();
  expect(attempts).toBe(1);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("pause stops polling and visibility refresh, resume fetches immediately", async ({ page }) => {
  let snapshots = 0;
  await page.route(`${relay}/**`, async route => {
    snapshots++;
    return json(route, snapshot());
  });
  await page.goto("/");
  await seedSession(page);
  await page.reload();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  await page.getByRole("button", { name: "自動更新を停止" }).click();
  const count = snapshots;
  await page.clock.fastForward(45_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(snapshots).toBe(count);
  await page.getByRole("button", { name: "自動更新を再開" }).click();
  await expect.poll(() => snapshots).toBeGreaterThan(count);
});

test("elapsed resets and unavailable values are not presented as upcoming or disconnected", async ({ page }) => {
  const value = snapshot();
  value.providers[0].usageWindows[0].resetsAt = new Date(now.getTime() - 60_000).toISOString();
  value.providers[1].status = "connected";
  await page.route(`${relay}/**`, route => json(route, value));
  await page.goto("/");
  await seedSession(page);
  await page.reload();
  await expect(page.getByText("リセット時刻を過ぎました・更新待ち", { exact: true })).toBeVisible();
  await expect(page.getByText("利用率は取得できません", { exact: true })).toBeVisible();
  await expect(page.getByText("接続後に表示", { exact: true })).toHaveCount(0);
});

test("unpairing cannot be undone by an older in-flight snapshot", async ({ page }) => {
  let release: (() => void) | undefined;
  let delay = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let waiting = false;
  await page.route(`${relay}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/health") return json(route, { ok: true, service: "RunMeter Relay", version: 1, providers: ["codex", "claude"] });
    if (path === "/v1/providers/codex") return json(route, providerSnapshot());
    if (path === "/v1/pair") return json(route, { ok: true });
    if (delay) { waiting = true; await gate; }
    return json(route, snapshot());
  });
  await page.goto("/");
  await seedSession(page);
  await page.reload();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  await page.getByRole("button", { name: "Codexの接続設定を開く" }).click();
  await expect(page.getByText("Relay接続済み", { exact: true })).toBeVisible();
  delay = true;
  await page.evaluate(() => window.dispatchEvent(new Event("runmeter:relay-refresh")));
  await expect.poll(() => waiting).toBe(true);
  await page.getByRole("button", { name: "Relayとの連携を解除" }).click();
  await expect(page.getByLabel("ペアリングコード", { exact: true })).toBeVisible();
  release!();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "利用データはまだありません" })).toBeVisible();
});

test("a failed refresh keeps the previous reading explicitly marked stale", async ({ page }) => {
  let offline = false;
  await page.route(`${relay}/**`, route => offline ? route.abort() : json(route, snapshot()));
  await page.goto("/");
  await seedSession(page);
  await page.reload();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  offline = true;
  await page.evaluate(() => window.dispatchEvent(new Event("runmeter:relay-refresh")));
  await expect(page.getByText("RunMeterとの接続が切れています", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  await expect(page.getByText("前回取得", { exact: true })).toBeVisible();
});

test("a late 401 from a closed connection dialog preserves the newly paired session", async ({ page }) => {
  const newToken = "new-release-test-" + "y".repeat(40);
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let connecting = false;
  await page.route(`${relay}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/health") return json(route, { ok: true, service: "RunMeter Relay", version: 1, providers: ["codex", "claude"] });
    if (path === "/v1/providers/codex/connect") {
      connecting = true;
      await gate;
      return json(route, { error: { code: "invalid_bearer", message: "古いペアリング" } }, 401);
    }
    if (path === "/v1/providers/codex") return json(route, providerSnapshot(false));
    return json(route, createDisconnectedDashboardSnapshot(now));
  });
  await page.goto("/");
  await seedSession(page);
  await page.reload();
  await page.getByRole("button", { name: "Codexの接続設定を開く" }).click();
  await page.getByRole("button", { name: "Codexへログイン" }).click();
  await expect.poll(() => connecting).toBe(true);
  await page.keyboard.press("Escape");
  await seedSession(page, newToken);
  const response = page.waitForResponse(`${relay}/v1/providers/codex/connect`);
  release!();
  await (await response).finished();
  await page.getByRole("button", { name: "Codexの接続設定を開く" }).click();
  await expect(page.getByText("Relay接続済み", { exact: true })).toBeVisible();
  const savedToken = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const request = indexedDB.open("runmeter-browser", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("relay-session", "readonly");
      const record = transaction.objectStore("relay-session").get("local-relay");
      record.onsuccess = () => resolve(record.result?.token);
      transaction.oncomplete = () => database.close();
    };
  }));
  expect(savedToken).toBe(newToken);
});

test("Claude instruction-based connection updates the open dialog after ingest", async ({ page }) => {
  let connected = false;
  await page.route(`${relay}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/health") return json(route, { ok: true, service: "RunMeter Relay", version: 1, providers: ["codex", "claude"] });
    if (path === "/v1/providers/claude/connect") return json(route, {
      kind: "action-required", action: { type: "instructions", steps: ["Claude Codeでメッセージを送信してください。"] },
    });
    if (path === "/v1/providers/claude") return json(route, {
      ...providerSnapshot(connected), providerId: "claude", displayName: "Claude",
    });
    const value = createDisconnectedDashboardSnapshot(now);
    if (connected) value.providers[1].status = "connected";
    return json(route, value);
  });
  await page.goto("/");
  await seedSession(page);
  await page.reload();
  await page.getByRole("button", { name: "Claudeの接続設定を開く" }).click();
  await page.getByRole("button", { name: "Claude Codeを検出" }).click();
  await expect(page.getByText("Claude Codeでメッセージを送信してください。", { exact: true })).toBeVisible();
  connected = true;
  await page.clock.fastForward(3_000);
  await expect(page.getByRole("dialog").getByText("Claude接続済み", { exact: true })).toBeVisible();
});

test("stored history renders accurately after service disconnection", async ({ page }, testInfo) => {
  const value = createDisconnectedDashboardSnapshot(now);
  value.dailyHistory = ["2026-09-24", "2026-09-25"].map((date, index) => ({
    date, label: `9/${24 + index}`, totalTokens: 1000 * (index + 1), costUsd: 0,
    runs: 0, successRate: 0, p95LatencyMs: 0,
  }));
  value.providerHistoryMatrix = value.dailyHistory.map(day => ({
    providerId: "codex", date: day.date, label: day.label, tokens: day.totalTokens,
    costUsd: 0, intensity: day.totalTokens / 2000,
  }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`${relay}/**`, route => json(route, value));
  await page.goto("/");
  await seedSession(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "利用履歴" })).toBeVisible();
  await expect(page.getByText("この端末に記録した2日分・直近90記録日まで", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("stored-history.png"), fullPage: true });
});

test("production responses protect framing and serve favicon and Japanese sharing metadata", async ({ request }) => {
  const page = await request.get("/");
  expect(page.status()).toBe(200);
  expect(page.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(page.headers()["content-security-policy"]).not.toContain("unsafe-eval");
  expect(page.headers()["referrer-policy"]).toBe("no-referrer");
  expect(await page.text()).toContain('lang="ja"');
  for (const path of ["/favicon.ico", "/icon.png", "/opengraph-image.png", "/twitter-image.png"]) {
    const asset = await request.get(path);
    expect(asset.status(), path).toBe(200);
    expect(asset.headers()["content-type"], path).toContain("image/");
  }
});
