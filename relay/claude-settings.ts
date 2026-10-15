import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { CredentialVault } from "./credential-vault.ts";

type UnknownRecord = Record<string, unknown>;

interface ClaudeInstallState {
  version: 1;
  settingsPath: string;
  installedStatusLine: UnknownRecord;
  pendingInstalledStatusLine?: UnknownRecord;
  hadPreviousStatusLine: boolean;
}

export interface ClaudeSettingsResult {
  changed: boolean;
  settingsPath: string;
  command: string;
}

export class ClaudeSettingsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeSettingsConflictError";
  }
}

function object(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readJsonObject(path: string): UnknownRecord {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.length > 2_000_000) throw new Error(`Claude settings file is too large: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude settings file is not valid JSON: ${path}`);
  }
  const result = object(parsed);
  if (!result) throw new Error(`Claude settings root must be a JSON object: ${path}`);
  return result;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.runmeter-${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACLs are inherited from the user's Claude settings directory.
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shellArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Unsafe newline in executable path");
  if (process.platform === "win32") {
    if (value.includes('"')) throw new Error("Unsupported quote in executable path");
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class ClaudeSettingsManager {
  readonly #settingsPath: string;
  readonly #statePath: string;
  readonly #dataDirectory: string;
  readonly #bridgeExecutablePath: string;
  readonly #bridgeScriptPath: string;
  readonly #vault: CredentialVault;
  #pendingMutation: Promise<unknown> = Promise.resolve();

  constructor(options: {
    settingsPath: string;
    dataDirectory: string;
    bridgeExecutablePath?: string;
    bridgeScriptPath: string;
    vault: CredentialVault;
  }) {
    this.#settingsPath = options.settingsPath;
    this.#dataDirectory = options.dataDirectory;
    this.#bridgeExecutablePath = options.bridgeExecutablePath ?? process.execPath;
    this.#bridgeScriptPath = options.bridgeScriptPath;
    this.#vault = options.vault;
    this.#statePath = join(options.dataDirectory, "claude-statusline-state.json");
  }

  isInstalled(): boolean {
    if (!existsSync(this.#statePath)) return false;
    const settings = readJsonObject(this.#settingsPath);
    const state = this.#recoverPendingInstall(this.#readState(), settings);
    return equalJson(settings.statusLine, state.installedStatusLine);
  }

  install(): Promise<ClaudeSettingsResult> {
    return this.#serializeMutation(() => this.#install());
  }

  async #install(): Promise<ClaudeSettingsResult> {
    const command = [
      shellArgument(this.#bridgeExecutablePath),
      shellArgument(this.#bridgeScriptPath),
      "--data-dir",
      shellArgument(this.#dataDirectory),
    ].join(" ");
    const settings = readJsonObject(this.#settingsPath);

    if (existsSync(this.#statePath)) {
      const state = this.#recoverPendingInstall(this.#readState(), settings);
      if (state.settingsPath !== this.#settingsPath) {
        throw new ClaudeSettingsConflictError(
          "RunMeter has a Claude status-line installation for a different settings file.",
        );
      }
      if (equalJson(settings.statusLine, state.installedStatusLine)) {
        if (state.installedStatusLine.command === command) {
          return { changed: false, settingsPath: this.#settingsPath, command };
        }
        const updatedStatusLine = {
          ...state.installedStatusLine,
          command,
        };
        writeJsonAtomic(this.#statePath, {
          ...state,
          pendingInstalledStatusLine: updatedStatusLine,
        });
        try {
          this.#replaceStatusLine(settings.statusLine, updatedStatusLine);
        } catch (error) {
          writeJsonAtomic(this.#statePath, state);
          throw error;
        }
        writeJsonAtomic(this.#statePath, {
          ...state,
          installedStatusLine: updatedStatusLine,
        });
        return { changed: true, settingsPath: this.#settingsPath, command };
      }
      const previousStatusLine = await this.#readPreviousStatusLine(state);
      if (equalJson(settings.statusLine ?? null, previousStatusLine)) {
        // Recover a prior interrupted install: state was safely written first.
        this.#replaceStatusLine(settings.statusLine, state.installedStatusLine);
        return { changed: true, settingsPath: this.#settingsPath, command };
      }
      throw new ClaudeSettingsConflictError(
        "Claude statusLine changed after RunMeter prepared it. No settings were overwritten.",
      );
    }

    const previousStatusLine = settings.statusLine;
    const previousObject = object(previousStatusLine);
    const installedStatusLine: UnknownRecord = {
      ...(previousObject ?? {}),
      type: "command",
      command,
      // Keep the meter current while a Claude session is otherwise idle.
      refreshInterval: Math.min(
        30,
        Math.max(
          5,
          typeof previousObject?.refreshInterval === "number"
            ? previousObject.refreshInterval
            : 10,
        ),
      ),
    };
    const state: ClaudeInstallState = {
      version: 1,
      settingsPath: this.#settingsPath,
      installedStatusLine,
      hadPreviousStatusLine: previousStatusLine !== undefined,
    };

    mkdirSync(this.#dataDirectory, { recursive: true, mode: 0o700 });
    if (previousStatusLine === undefined) {
      await this.#vault.delete("claude", "previous-statusline");
    } else {
      await this.#vault.set(
        "claude",
        "previous-statusline",
        JSON.stringify(previousStatusLine),
      );
    }
    writeJsonAtomic(this.#statePath, state);
    try {
      this.#replaceStatusLine(settings.statusLine, installedStatusLine);
    } catch (error) {
      rmSync(this.#statePath, { force: true });
      await this.#vault.delete("claude", "previous-statusline").catch(() => undefined);
      throw error;
    }
    return { changed: true, settingsPath: this.#settingsPath, command };
  }

  uninstall(): Promise<ClaudeSettingsResult> {
    return this.#serializeMutation(() => this.#uninstall());
  }

  async #uninstall(): Promise<ClaudeSettingsResult> {
    if (!existsSync(this.#statePath)) {
      return { changed: false, settingsPath: this.#settingsPath, command: "" };
    }
    const settings = readJsonObject(this.#settingsPath);
    const state = this.#recoverPendingInstall(this.#readState(), settings);
    if (!equalJson(settings.statusLine, state.installedStatusLine)) {
      throw new ClaudeSettingsConflictError(
        "Claude statusLine was edited after RunMeter installed it. No settings were removed.",
      );
    }
    const previousStatusLine = await this.#readPreviousStatusLine(state);
    this.#replaceStatusLine(
      settings.statusLine,
      state.hadPreviousStatusLine ? previousStatusLine : undefined,
    );
    rmSync(this.#statePath, { force: true });
    await this.#vault.delete("claude", "previous-statusline").catch(() => undefined);
    return {
      changed: true,
      settingsPath: this.#settingsPath,
      command: String(state.installedStatusLine.command ?? ""),
    };
  }

  #readState(): ClaudeInstallState {
    const state = readJsonObject(this.#statePath);
    if (
      state.version !== 1 ||
      typeof state.settingsPath !== "string" ||
      typeof state.hadPreviousStatusLine !== "boolean" ||
      !object(state.installedStatusLine) ||
      (state.pendingInstalledStatusLine !== undefined &&
        !object(state.pendingInstalledStatusLine))
    ) {
      throw new ClaudeSettingsConflictError("RunMeter's Claude installation state is invalid.");
    }
    if (state.settingsPath !== this.#settingsPath) {
      throw new ClaudeSettingsConflictError(
        "RunMeter has a Claude status-line installation for a different settings file.",
      );
    }
    return state as unknown as ClaudeInstallState;
  }

  #serializeMutation(operation: () => Promise<ClaudeSettingsResult>): Promise<ClaudeSettingsResult> {
    const result = this.#pendingMutation.then(operation);
    this.#pendingMutation = result.catch(() => undefined);
    return result;
  }

  #replaceStatusLine(expected: unknown, replacement: unknown): void {
    // Vault access yields to other requests and editors. Reload immediately before
    // writing so unrelated settings survive and a changed command is never lost.
    const current = readJsonObject(this.#settingsPath);
    if (!equalJson(current.statusLine, expected)) {
      throw new ClaudeSettingsConflictError(
        "Claude statusLine changed while RunMeter was preparing it. No settings were overwritten.",
      );
    }
    if (replacement === undefined) delete current.statusLine;
    else current.statusLine = replacement;
    writeJsonAtomic(this.#settingsPath, current);
  }

  #recoverPendingInstall(
    state: ClaudeInstallState,
    settings: UnknownRecord,
  ): ClaudeInstallState {
    const pending = state.pendingInstalledStatusLine;
    if (!pending) return state;
    const recovered = { ...state };
    delete recovered.pendingInstalledStatusLine;
    if (equalJson(settings.statusLine, pending)) {
      recovered.installedStatusLine = pending;
      writeJsonAtomic(this.#statePath, recovered);
      return recovered;
    }
    if (equalJson(settings.statusLine, state.installedStatusLine)) {
      writeJsonAtomic(this.#statePath, recovered);
      return recovered;
    }
    throw new ClaudeSettingsConflictError(
      "Claude statusLine changed while RunMeter was upgrading it. No settings were overwritten.",
    );
  }

  async #readPreviousStatusLine(state: ClaudeInstallState): Promise<unknown> {
    if (!state.hadPreviousStatusLine) return null;
    const raw = await this.#vault.get("claude", "previous-statusline");
    if (!raw) {
      throw new ClaudeSettingsConflictError(
        "Claude's previous statusLine is missing from the OS credential vault.",
      );
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new ClaudeSettingsConflictError(
        "Claude's previous statusLine in the OS credential vault is invalid.",
      );
    }
  }
}
