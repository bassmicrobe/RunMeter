import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import type { RelayStore, StoredSession } from "./storage.ts";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const BROWSER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SERVICE_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_PAIRING_FAILURES = 5;
const PAIRING_COOLDOWN_MS = 60 * 1000;

export interface PairingCodeStatus {
  available: boolean;
  code?: string;
  expiresAt?: string;
  retryAt?: string;
}

export interface ClaimedSession {
  token: string;
  expiresAt: string;
}

export interface AuthenticatedSession {
  tokenHash: string;
  scope: string;
  expiresAt: string;
}

export class PairingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = "PairingError";
    this.code = code;
    this.status = status;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function normalizeLabel(label: unknown): string {
  if (typeof label !== "string") return "RunMeter browser";
  const normalized = label.trim().slice(0, 64);
  return normalized || "RunMeter browser";
}

function writePrivateFile(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACLs are inherited from the user's private profile directory.
  }
}

export class PairingManager {
  readonly #store: RelayStore;
  readonly #dataDirectory: string;
  #code = "";
  #codeExpiresAt = 0;
  #failedAttempts = 0;
  #cooldownUntil = 0;

  constructor(store: RelayStore, dataDirectory: string) {
    this.#store = store;
    this.#dataDirectory = dataDirectory;
    this.#rotateCode(Date.now());
    this.#store.purgeExpired(new Date().toISOString());
  }

  getPairingCode(now = Date.now()): PairingCodeStatus {
    if (this.#cooldownUntil > now) {
      return {
        available: false,
        retryAt: new Date(this.#cooldownUntil).toISOString(),
      };
    }
    if (now >= this.#codeExpiresAt) this.#rotateCode(now);
    return {
      available: true,
      code: this.#code,
      expiresAt: new Date(this.#codeExpiresAt).toISOString(),
    };
  }

  claim(code: unknown, label: unknown, now = Date.now()): ClaimedSession {
    if (this.#cooldownUntil > now) {
      throw new PairingError(
        "pairing_rate_limited",
        "Too many failed pairing attempts. Try again shortly.",
        429,
      );
    }
    if (now >= this.#codeExpiresAt) {
      this.#rotateCode(now);
      throw new PairingError("pairing_code_expired", "The pairing code expired.");
    }
    if (typeof code !== "string" || !safeEqual(code, this.#code)) {
      this.#failedAttempts += 1;
      if (this.#failedAttempts >= MAX_PAIRING_FAILURES) {
        this.#code = "";
        this.#codeExpiresAt = 0;
        this.#cooldownUntil = now + PAIRING_COOLDOWN_MS;
      }
      throw new PairingError("invalid_pairing_code", "The pairing code is invalid.");
    }

    const session = this.#mintSession(
      "browser",
      normalizeLabel(label),
      BROWSER_SESSION_TTL_MS,
      now,
    );
    // A code can succeed exactly once. A fresh code is created for a later device.
    this.#rotateCode(now);
    return session;
  }

  authenticate(
    authorizationHeader: string | undefined,
    acceptedScopes: readonly string[] = ["browser"],
    now = Date.now(),
  ): AuthenticatedSession {
    if (!authorizationHeader?.startsWith("Bearer ")) {
      throw new PairingError("missing_bearer", "A bearer token is required.");
    }
    const token = authorizationHeader.slice("Bearer ".length);
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
      throw new PairingError("invalid_bearer", "The bearer token is invalid.");
    }
    const tokenHash = hashToken(token);
    const nowIso = new Date(now).toISOString();
    const session = this.#store.findSession(tokenHash, nowIso);
    if (!session || !acceptedScopes.includes(session.scope)) {
      throw new PairingError("invalid_bearer", "The bearer token is invalid.");
    }
    this.#store.touchSession(tokenHash, nowIso);
    return {
      tokenHash,
      scope: session.scope,
      expiresAt: session.expiresAt,
    };
  }

  revoke(tokenHash: string): void {
    this.#store.revokeSession(tokenHash);
  }

  ensureServiceCredential(
    label: string,
    scope: string,
    now = Date.now(),
  ): string {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(label)) {
      throw new Error("Invalid service credential label");
    }
    const path = join(this.#dataDirectory, `service-${label}.token`);
    if (existsSync(path)) {
      const token = readFileSync(path, "utf8").trim();
      if (/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
        const stored = this.#store.findSession(
          hashToken(token),
          new Date(now).toISOString(),
        );
        if (stored?.scope === scope && stored.label === label) return path;
      }
    }

    this.#store.revokeSessionsByLabel(label);
    const session = this.#mintSession(scope, label, SERVICE_SESSION_TTL_MS, now);
    writePrivateFile(path, `${session.token}\n`);
    return path;
  }

  revokeServiceCredential(label: string): void {
    this.#store.revokeSessionsByLabel(label);
    const path = join(this.#dataDirectory, `service-${label}.token`);
    if (existsSync(path)) rmSync(path, { force: true });
  }

  #mintSession(
    scope: string,
    label: string,
    ttlMs: number,
    now: number,
  ): ClaimedSession {
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();
    const record: StoredSession = {
      tokenHash: hashToken(token),
      scope,
      label,
      createdAt,
      expiresAt,
      lastUsedAt: null,
    };
    this.#store.saveSession(record);
    return { token, expiresAt };
  }

  #rotateCode(now: number): void {
    this.#code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.#codeExpiresAt = now + PAIRING_TTL_MS;
    this.#failedAttempts = 0;
    this.#cooldownUntil = 0;
  }
}
