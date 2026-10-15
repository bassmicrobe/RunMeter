import assert from "node:assert/strict";
import test from "node:test";

import { normalizeClaudeStatusLine } from "../adapters/claude.ts";
import {
  normalizeCodexRateLimits,
  normalizeCodexUsage,
} from "../adapters/codex.ts";
import { sanitizeClaudeStatusLine } from "../claude-statusline.ts";
import { buildDashboardSnapshot } from "../core/dashboard.ts";

test("Codex rate-limit and daily token data are normalized", () => {
  const rates = normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: {
          usedPercent: 42,
          windowDurationMins: 10_080,
          resetsAt: 1_800_100_000,
        },
      },
    },
    rateLimitResetCredits: { availableCount: 2 },
  });
  assert.deepEqual(
    rates.windows.map(({ id, label, usedPercent }) => ({ id, label, usedPercent })),
    [
      { id: "codex:primary", label: "Codex 通常枠・5時間", usedPercent: 25 },
      { id: "codex:secondary", label: "Codex 通常枠・1週間", usedPercent: 42 },
    ],
  );
  assert.equal(rates.primaryUsageWindowId, "codex:primary");
  assert.equal(rates.metadata.availableResetCredits, 2);

  const usage = normalizeCodexUsage({
    summary: {
      lifetimeTokens: 123_456,
      peakDailyTokens: 45_678,
      currentStreakDays: 8,
    },
    dailyUsageBuckets: [{ startDate: "2026-08-20", tokens: 12_345 }],
  });
  assert.equal(usage.tokenSummary?.lifetimeTokens, 123_456);
  assert.deepEqual(usage.dailyUsage, [{ date: "2026-08-20", tokens: 12_345 }]);
});

test("Codex canonical rate-limit bucket wins regardless of keyed object order", () => {
  const rates = normalizeCodexRateLimits({
    rateLimits: { limitId: "codex" },
    rateLimitsByLimitId: {
      spark: {
        limitId: "spark",
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 81, windowDurationMins: 300 },
      },
      codex: {
        limitId: "codex",
        primary: { usedPercent: 27, windowDurationMins: 300 },
        secondary: { usedPercent: 39, windowDurationMins: 10_080 },
      },
    },
  });

  assert.equal(rates.primaryUsageWindowId, "codex:primary");
  assert.equal(rates.windows[0]?.id, "codex:primary");
  assert.equal(rates.windows[0]?.label, "Codex 通常枠・5時間");
  assert.equal(rates.windows.some((window) => window.id === "spark:primary"), true);
  assert.equal(rates.metadata.canonicalRateLimitId, "codex");
});

test("Codex normal bucket outranks a canonical Spark bucket", () => {
  const rates = normalizeCodexRateLimits({
    rateLimits: { limitId: "spark" },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 24, windowDurationMins: 300 },
      },
      spark: {
        limitId: "spark",
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 64, windowDurationMins: 300 },
      },
    },
  });

  assert.equal(rates.primaryUsageWindowId, "codex:primary");
  assert.equal(rates.windows[0]?.id, "codex:primary");
  assert.equal(rates.windows[1]?.id, "spark:primary");
});

test("Codex single canonical bucket is added when the keyed map omits it", () => {
  const rates = normalizeCodexRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 18, windowDurationMins: 300 },
    },
    rateLimitsByLimitId: {
      spark: {
        limitId: "spark",
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 76, windowDurationMins: 300 },
      },
    },
  });

  assert.equal(rates.primaryUsageWindowId, "codex:primary");
  assert.deepEqual(
    rates.windows.map((window) => window.id),
    ["codex:primary", "spark:primary"],
  );
});

test("Codex bucket outranks Spark when App Server omits a canonical id", () => {
  const rates = normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      spark: {
        limitId: "spark",
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 75, windowDurationMins: 300 },
      },
      codex: {
        limitId: "codex",
        primary: { usedPercent: 20, windowDurationMins: 300 },
      },
    },
  });

  assert.equal(rates.primaryUsageWindowId, "codex:primary");
  assert.equal(rates.windows[0]?.label, "Codex 通常枠・5時間");
});

test("Codex non-Spark bucket is preferred when no canonical or codex bucket exists", () => {
  const rates = normalizeCodexRateLimits({
    rateLimitsByLimitId: {
      spark: {
        limitId: "spark",
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 72, windowDurationMins: 300 },
      },
      team: {
        limitId: "team",
        limitName: "Codex Team",
        primary: { usedPercent: 31, windowDurationMins: 300 },
      },
    },
  });

  assert.equal(rates.primaryUsageWindowId, "team:primary");
  assert.deepEqual(
    rates.windows.map((window) => window.id),
    ["team:primary", "spark:primary"],
  );
});

test("dashboard builder uses the normalized Codex primary window id", () => {
  const usageWindows = [
    {
      id: "spark:primary",
      label: "GPT-5.3-Codex-Spark・5時間",
      usedPercent: 80,
      resetsAt: null,
      source: "provider" as const,
      estimated: false,
    },
    {
      id: "codex:primary",
      label: "Codex 通常枠・5時間",
      usedPercent: 20,
      resetsAt: null,
      source: "provider" as const,
      estimated: false,
    },
  ];
  const base = {
    providerId: "codex",
    displayName: "Codex",
    status: "connected" as const,
    ingestion: "poll" as const,
    updatedAt: "2026-08-20T12:00:00.000Z",
    windows: usageWindows,
    dailyUsage: [],
  };

  const normalized = buildDashboardSnapshot(
    [{ ...base, metadata: { primaryUsageWindowId: "codex:primary" } }],
    new Date("2026-08-20T12:00:00.000Z"),
  );
  assert.equal(normalized.providers[0]?.primaryUsageWindowId, "codex:primary");

  const legacy = buildDashboardSnapshot(
    [base],
    new Date("2026-08-20T12:00:00.000Z"),
  );
  assert.equal(legacy.providers[0]?.primaryUsageWindowId, "codex:primary");
});

test("Claude bridge removes session and filesystem data before ingest", () => {
  const safe = sanitizeClaudeStatusLine({
    session_id: "private-session",
    transcript_path: "C:/private/transcript.jsonl",
    cwd: "C:/private/repo",
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1_800_000_000 },
      seven_day: { used_percentage: 41.2, resets_at: 1_800_100_000 },
    },
    context_window: {
      total_input_tokens: 15_500,
      total_output_tokens: 1_200,
      context_window_size: 200_000,
      used_percentage: 8,
      current_usage: {
        input_tokens: 8_500,
        output_tokens: 1_200,
        cache_read_input_tokens: 2_000,
      },
    },
  });
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes("private-session"), false);
  assert.equal(serialized.includes("transcript"), false);
  assert.equal(serialized.includes("private/repo"), false);

  const normalized = normalizeClaudeStatusLine(safe);
  assert.deepEqual(
    normalized.windows.map(({ label, usedPercent }) => ({ label, usedPercent })),
    [
      { label: "5時間", usedPercent: 23.5 },
      { label: "7日", usedPercent: 41.2 },
    ],
  );
  assert.equal(normalized.tokenSummary?.currentContextTokens, 16_700);
  assert.equal(normalized.tokenSummary?.cachedTokens, 2_000);
});

test("dashboard builder includes only the providers visible in RunMeter", () => {
  const snapshot = buildDashboardSnapshot([], new Date("2026-08-20T12:00:00.000Z"));
  assert.deepEqual(
    snapshot.providers.map((provider) => provider.id),
    ["codex", "claude"],
  );
  assert.equal(snapshot.providers.every((provider) => provider.status === "disconnected"), true);
});

test("Codex daily totals reject impossible dates and unsafe counters and replace duplicate dates", () => {
  const { dailyUsage } = normalizeCodexUsage({
    dailyUsageBuckets: [
      { startDate: "2026-08-20", tokens: 100 },
      { startDate: "2026-02-30", tokens: 200 },
      { startDate: "2026-08-19", tokens: Number.MAX_SAFE_INTEGER + 1 },
      { startDate: "2026-08-20", tokens: 150 },
      { startDate: "2026-08-18", tokens: 0 },
    ],
  });
  assert.deepEqual(dailyUsage, [
    { date: "2026-08-18", tokens: 0 },
    { date: "2026-08-20", tokens: 150 },
  ]);
});

test("dashboard totals and matrix replace duplicate provider/day snapshots without double-counting", () => {
  const provider = {
    providerId: "codex",
    displayName: "Codex",
    status: "connected" as const,
    ingestion: "poll" as const,
    updatedAt: "2026-08-20T12:00:00.000Z",
    windows: [],
    dailyUsage: [{ date: "2026-08-20", tokens: 100 }],
  };
  const snapshot = buildDashboardSnapshot([
    provider,
    { ...provider, dailyUsage: [{ date: "2026-08-20", tokens: 150 }, { date: "2026-08-20", tokens: 200 }] },
  ], new Date(2026, 7, 20, 12));
  assert.equal(snapshot.dailyHistory[0]?.totalTokens, 200);
  assert.equal(snapshot.providers[0]?.totalTokensToday, 200);
  assert.equal(snapshot.providerHistoryMatrix.length, 1);
  assert.equal(snapshot.providerHistoryMatrix[0]?.tokens, 200);
});
