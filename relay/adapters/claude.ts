import { fileURLToPath } from "node:url";

import type {
  JsonObject,
  ProviderAdapter,
  ProviderConnectResult,
  ProviderSnapshot,
  TokenSummary,
  UsageWindow,
} from "../core/types.ts";
import type { PairingManager } from "../pairing.ts";
import type { RelayStore } from "../storage.ts";
import type { CredentialVault } from "../credential-vault.ts";
import { ClaudeSettingsManager } from "../claude-settings.ts";

type UnknownRecord = Record<string, unknown>;

function object(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finite(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

function isoFromEpoch(value: unknown): string | null {
  const seconds = finite(value);
  if (seconds === undefined || seconds <= 0) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeWindow(
  id: string,
  label: string,
  input: unknown,
): UsageWindow | null {
  const value = object(input);
  if (!value) return null;
  const used = finite(value.used_percentage, 100);
  if (used === undefined && value.resets_at === undefined) return null;
  return {
    id,
    label,
    usedPercent: used ?? null,
    resetsAt: isoFromEpoch(value.resets_at),
    source: "provider",
    estimated: false,
  };
}

export function normalizeClaudeStatusLine(payload: unknown): {
  windows: UsageWindow[];
  tokenSummary?: TokenSummary;
  metadata: JsonObject;
} {
  const input = object(payload) ?? {};
  const rateLimits = object(input.rate_limits);
  const context = object(input.context_window);
  const current = object(context?.current_usage);
  const windows = [
    normalizeWindow("claude:five-hour", "5時間", rateLimits?.five_hour),
    normalizeWindow("claude:seven-day", "7日", rateLimits?.seven_day),
  ].filter((window): window is UsageWindow => window !== null);

  const totalInput = finite(context?.total_input_tokens);
  const totalOutput = finite(context?.total_output_tokens);
  const currentContextTokens =
    totalInput !== undefined || totalOutput !== undefined
      ? (totalInput ?? 0) + (totalOutput ?? 0)
      : undefined;
  const tokenSummary: TokenSummary = {
    currentContextTokens,
    contextWindowSize: finite(context?.context_window_size),
    inputTokens: finite(current?.input_tokens),
    outputTokens: finite(current?.output_tokens),
    cachedTokens:
      current
        ? (finite(current.cache_creation_input_tokens) ?? 0) +
          (finite(current.cache_read_input_tokens) ?? 0)
        : undefined,
  };
  const hasSummary = Object.values(tokenSummary).some((entry) => entry !== undefined);
  const metadata: JsonObject = {};
  const contextUsedPercent = finite(context?.used_percentage, 100);
  const contextRemainingPercent = finite(context?.remaining_percentage, 100);
  if (contextUsedPercent !== undefined) metadata.contextUsedPercent = contextUsedPercent;
  if (contextRemainingPercent !== undefined) {
    metadata.contextRemainingPercent = contextRemainingPercent;
  }
  return { windows, ...(hasSummary ? { tokenSummary } : {}), metadata };
}

function disconnectedSnapshot(): ProviderSnapshot {
  return {
    providerId: "claude",
    displayName: "Claude",
    status: "disconnected",
    ingestion: "none",
    updatedAt: null,
    windows: [],
    dailyUsage: [],
    metadata: { installed: false },
  };
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude";
  readonly displayName = "Claude";
  readonly capabilities = {
    connect: true,
    disconnect: true,
    refresh: true,
    ingest: true,
  } as const;

  readonly #store: RelayStore;
  readonly #pairing: PairingManager;
  readonly #settings: ClaudeSettingsManager;

  constructor(options: {
    store: RelayStore;
    pairing: PairingManager;
    dataDirectory: string;
    settingsPath: string;
    vault: CredentialVault;
    bridgeExecutablePath?: string;
    bridgeScriptPath?: string;
  }) {
    this.#store = options.store;
    this.#pairing = options.pairing;
    this.#settings = new ClaudeSettingsManager({
      settingsPath: options.settingsPath,
      dataDirectory: options.dataDirectory,
      ...(options.bridgeExecutablePath
        ? { bridgeExecutablePath: options.bridgeExecutablePath }
        : {}),
      bridgeScriptPath:
        options.bridgeScriptPath ??
        fileURLToPath(new URL("../claude-statusline.ts", import.meta.url)),
      vault: options.vault,
    });
  }

  async getStatus(): Promise<ProviderSnapshot> {
    const stored = this.#store.getProviderSnapshot(this.id);
    if (!this.#settings.isInstalled()) return disconnectedSnapshot();
    // Refresh a RunMeter-owned command when the desktop runtime changes.
    await this.#settings.install();
    this.#pairing.ensureServiceCredential("claude-statusline", "ingest:claude");
    return (
      stored ?? {
        ...disconnectedSnapshot(),
        status: "connecting",
        updatedAt: new Date().toISOString(),
        ingestion: "event",
        metadata: { installed: true },
      }
    );
  }

  async connect(): Promise<ProviderConnectResult> {
    const result = await this.#settings.install();
    this.#pairing.ensureServiceCredential("claude-statusline", "ingest:claude");
    const snapshot: ProviderSnapshot = {
      ...(this.#store.getProviderSnapshot(this.id) ?? disconnectedSnapshot()),
      status: "connecting",
      ingestion: "event",
      updatedAt: new Date().toISOString(),
      metadata: { installed: true },
    };
    this.#store.saveProviderSnapshot(snapshot);
    return {
      kind: "action-required",
      action: {
        type: "instructions",
        title: "Claude Code連携を有効にしました",
        steps: [
          result.changed
            ? "起動中のClaude Codeを再起動してください。"
            : "Claude Codeでメッセージを1回送信してください。",
          "最初の応答後、5時間・7日の利用率がRunMeterへ反映されます。",
        ],
      },
      snapshot,
    };
  }

  async disconnect(): Promise<void> {
    await this.#settings.uninstall();
    this.#pairing.revokeServiceCredential("claude-statusline");
    this.#store.saveProviderSnapshot(disconnectedSnapshot());
  }

  async refresh(): Promise<ProviderSnapshot> {
    return this.getStatus();
  }

  async ingest(payload: unknown): Promise<ProviderSnapshot> {
    if (!this.#settings.isInstalled()) {
      throw new Error("Claude statusLine is not installed for RunMeter.");
    }
    const normalized = normalizeClaudeStatusLine(payload);
    const snapshot: ProviderSnapshot = {
      providerId: this.id,
      displayName: this.displayName,
      status: "connected",
      ingestion: "event",
      updatedAt: new Date().toISOString(),
      windows: normalized.windows,
      dailyUsage: [],
      ...(normalized.tokenSummary ? { tokenSummary: normalized.tokenSummary } : {}),
      metadata: { installed: true, ...normalized.metadata },
    };
    this.#store.saveProviderSnapshot(snapshot);
    return snapshot;
  }
}
