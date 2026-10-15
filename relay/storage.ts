import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DailyUsage, JsonValue, ProviderSnapshot } from "./core/types.ts";

export interface StoredSession {
  tokenHash: string;
  scope: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export interface UsageObservation {
  providerId: string;
  windowId: string;
  observedAt: string;
  usedPercent: number | null;
  resetsAt: string | null;
}

const ALLOWED_METADATA_KEYS = new Set([
  "attached",
  "authMode",
  "availableResetCredits",
  "canonicalRateLimitId",
  "connectionStage",
  "contextRemainingPercent",
  "contextUsedPercent",
  "credentialState",
  "currentStreakDays",
  "installed",
  "longestRunningTurnSec",
  "longestStreakDays",
  "metricDelaySeconds",
  "planType",
  "primaryUsageWindowId",
  "projectId",
  "rateLimitReachedTypes",
  "scope",
]);
const SENSITIVE_NORMALIZED_KEYS = [
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "clientsecret",
  "secret",
  "password",
  "authorization",
  "cookie",
  "credential",
] as const;
const SENSITIVE_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.|GOCSPX-[A-Za-z0-9_-]{8,}|ya29\.[A-Za-z0-9._~-]{8,}|(?:^|[^A-Za-z0-9])1\/\/[A-Za-z0-9._~-]{8,})/;

function normalizedMetadataKey(key: string): string {
  return key
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function sensitiveMetadataKey(key: string): boolean {
  const normalized = normalizedMetadataKey(key);
  return SENSITIVE_NORMALIZED_KEYS.some((term) => normalized.includes(term));
}

function assertCredentialFree(value: JsonValue, path = "metadata"): void {
  if (typeof value === "string") {
    if (SENSITIVE_VALUE.test(value)) {
      throw new Error(`Credential-like value rejected at ${path}`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCredentialFree(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const approvedMetadataKey =
      path === "snapshot.metadata" && ALLOWED_METADATA_KEYS.has(key);
    if (!approvedMetadataKey && sensitiveMetadataKey(key)) {
      throw new Error(`Sensitive metadata key rejected at ${path}.${key}`);
    }
    if (path === "snapshot.metadata" && !approvedMetadataKey) {
      throw new Error(`Unapproved metadata key rejected at ${path}.${key}`);
    }
    assertCredentialFree(entry, `${path}.${key}`);
  }
}

function parseSnapshot(raw: unknown): ProviderSnapshot | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as ProviderSnapshot;
    if (!parsed || typeof parsed !== "object" || typeof parsed.providerId !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export class RelayStore {
  readonly #db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(databasePath);
    try {
      chmodSync(databasePath, 0o600);
    } catch {
      // Windows ACLs are inherited from the user's private profile directory.
    }
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 3000;

      CREATE TABLE IF NOT EXISTS provider_snapshots (
        provider_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS usage_observations (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        used_percent REAL,
        resets_at TEXT,
        UNIQUE(provider_id, window_id, observed_at)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS usage_observations_lookup
        ON usage_observations(provider_id, observed_at);

      CREATE INDEX IF NOT EXISTS usage_observations_by_time
        ON usage_observations(observed_at);

      CREATE TABLE IF NOT EXISTS daily_usage (
        provider_id TEXT NOT NULL,
        usage_date TEXT NOT NULL,
        tokens INTEGER,
        requests INTEGER,
        cost_usd REAL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider_id, usage_date)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT
      ) STRICT;
    `);
  }

  saveProviderSnapshot(snapshot: ProviderSnapshot): void {
    const serializedSnapshot = JSON.stringify(snapshot);
    assertCredentialFree(JSON.parse(serializedSnapshot) as JsonValue, "snapshot");
    // A status poll and its adapter may persist the same measurement. Avoid a
    // write transaction and history upserts when no snapshot data has changed.
    const previous = this.#db
      .prepare("SELECT snapshot_json FROM provider_snapshots WHERE provider_id = ?")
      .get(snapshot.providerId);
    if (previous?.snapshot_json === serializedSnapshot) return;
    const observedAt = snapshot.updatedAt ?? new Date().toISOString();
    const observedTime = Date.parse(observedAt);
    const observationBucket = Number.isNaN(observedTime)
      ? observedAt
      : new Date(Math.floor(observedTime / 60_000) * 60_000).toISOString();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(`
          INSERT INTO provider_snapshots(provider_id, snapshot_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(provider_id) DO UPDATE SET
            snapshot_json = excluded.snapshot_json,
            updated_at = excluded.updated_at
        `)
        .run(snapshot.providerId, serializedSnapshot, observedAt);

      // Repeated polling while disconnected, connecting or recovering from an
      // error is not a new usage measurement, even when cached windows exist.
      if (
        snapshot.error ||
        !["connected", "degraded"].includes(snapshot.status) ||
        !snapshot.updatedAt ||
        Number.isNaN(observedTime)
      ) {
        this.#db.exec("COMMIT");
        return;
      }

      const observationStatement = this.#db.prepare(`
        INSERT INTO usage_observations(
          provider_id, window_id, observed_at, used_percent, resets_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider_id, window_id, observed_at) DO UPDATE SET
          used_percent = excluded.used_percent,
          resets_at = excluded.resets_at
      `);
      for (const window of snapshot.windows) {
        observationStatement.run(
          snapshot.providerId,
          window.id,
          observationBucket,
          window.usedPercent,
          window.resetsAt,
        );
      }

      const dailyStatement = this.#db.prepare(`
        INSERT INTO daily_usage(
          provider_id, usage_date, tokens, requests, cost_usd, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider_id, usage_date) DO UPDATE SET
          tokens = excluded.tokens,
          requests = excluded.requests,
          cost_usd = excluded.cost_usd,
          updated_at = excluded.updated_at
      `);
      for (const day of snapshot.dailyUsage) {
        dailyStatement.run(
          snapshot.providerId,
          day.date,
          day.tokens ?? null,
          day.requests ?? null,
          day.costUsd ?? null,
          observedAt,
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getProviderSnapshot(providerId: string): ProviderSnapshot | null {
    const row = this.#db
      .prepare("SELECT snapshot_json FROM provider_snapshots WHERE provider_id = ?")
      .get(providerId);
    return parseSnapshot(row?.snapshot_json);
  }

  listProviderSnapshots(): ProviderSnapshot[] {
    return this.#db
      .prepare("SELECT snapshot_json FROM provider_snapshots ORDER BY provider_id")
      .all()
      .map((row) => parseSnapshot(row.snapshot_json))
      .filter((snapshot): snapshot is ProviderSnapshot => snapshot !== null);
  }

  listDailyUsage(providerId: string, limit = 90): DailyUsage[] {
    const safeLimit = Number.isFinite(limit)
      ? Math.min(366, Math.max(1, Math.floor(limit)))
      : 90;
    // Read newest records before limiting so long-lived installations retain
    // recent history without loading every stored day into each response.
    return this.#db
      .prepare(`
        SELECT usage_date, tokens, requests, cost_usd
        FROM daily_usage
        WHERE provider_id = ?
        ORDER BY usage_date DESC
        LIMIT ?
      `)
      .all(providerId, safeLimit)
      .reverse()
      .map((row) => ({
        date: String(row.usage_date),
        ...(typeof row.tokens === "number" ? { tokens: row.tokens } : {}),
        ...(typeof row.requests === "number" ? { requests: row.requests } : {}),
        ...(typeof row.cost_usd === "number" ? { costUsd: row.cost_usd } : {}),
      }));
  }

  listUsageHistory(
    providerId: string | null,
    since: string,
    limit = 100_000,
  ): UsageObservation[] {
    const safeLimit = Number.isFinite(limit)
      ? Math.min(200_001, Math.max(1, Math.floor(limit)))
      : 100_000;
    const rows = providerId
      ? this.#db
          .prepare(`
            SELECT provider_id, window_id, observed_at, used_percent, resets_at
            FROM usage_observations
            WHERE provider_id = ? AND observed_at >= ?
            ORDER BY observed_at ASC
            LIMIT ?
          `)
          .all(providerId, since, safeLimit)
      : this.#db
          .prepare(`
            SELECT provider_id, window_id, observed_at, used_percent, resets_at
            FROM usage_observations
            WHERE observed_at >= ?
            ORDER BY observed_at ASC
            LIMIT ?
          `)
          .all(since, safeLimit);

    return rows.map((row) => ({
      providerId: String(row.provider_id),
      windowId: String(row.window_id),
      observedAt: String(row.observed_at),
      usedPercent:
        typeof row.used_percent === "number" ? row.used_percent : null,
      resetsAt: typeof row.resets_at === "string" ? row.resets_at : null,
    }));
  }

  saveSession(session: StoredSession): void {
    this.#db
      .prepare(`
        INSERT INTO auth_sessions(
          token_hash, scope, label, created_at, expires_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET
          scope = excluded.scope,
          label = excluded.label,
          expires_at = excluded.expires_at,
          last_used_at = excluded.last_used_at
      `)
      .run(
        session.tokenHash,
        session.scope,
        session.label,
        session.createdAt,
        session.expiresAt,
        session.lastUsedAt,
      );
  }

  findSession(tokenHash: string, now: string): StoredSession | null {
    const row = this.#db
      .prepare(`
        SELECT token_hash, scope, label, created_at, expires_at, last_used_at
        FROM auth_sessions
        WHERE token_hash = ? AND expires_at > ?
      `)
      .get(tokenHash, now);
    if (!row) return null;
    return {
      tokenHash: String(row.token_hash),
      scope: String(row.scope),
      label: String(row.label),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      lastUsedAt:
        typeof row.last_used_at === "string" ? row.last_used_at : null,
    };
  }

  touchSession(tokenHash: string, now: string): void {
    this.#db
      .prepare("UPDATE auth_sessions SET last_used_at = ? WHERE token_hash = ?")
      .run(now, tokenHash);
  }

  revokeSession(tokenHash: string): void {
    this.#db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }

  revokeSessionsByLabel(label: string): void {
    this.#db.prepare("DELETE FROM auth_sessions WHERE label = ?").run(label);
  }

  purgeExpired(now: string): void {
    this.#db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
  }

  close(): void {
    this.#db.close();
  }
}
