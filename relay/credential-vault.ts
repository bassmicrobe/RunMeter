import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface CredentialVault {
  readonly backend: "windows-dpapi" | "macos-keychain" | "linux-secret-service" | "unavailable";
  get(providerId: string, key: string): Promise<string | null>;
  set(providerId: string, key: string, value: string): Promise<void>;
  delete(providerId: string, key: string): Promise<void>;
}

export class CredentialVaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultUnavailableError";
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function assertVaultName(value: string, kind: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) {
    throw new Error(`Invalid credential ${kind}`);
  }
  return value;
}

function runCommand(
  command: string,
  args: string[],
  stdin: string,
  timeoutMs = 10_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error("Credential vault command timed out"));
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // A helper may fail before it consumes stdin. The child close/error handlers
    // report the failure; do not let an EPIPE crash the Relay process.
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_000) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      }
    });
    child.stdin.end(stdin, "utf8");
  });
}

function writePrivateFile(path: string, value: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACLs are inherited from the private user data directory.
  }
}

const DPAPI_PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$encrypted = [Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($encrypted))
`;

const DPAPI_UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd().Trim()
$encrypted = [Convert]::FromBase64String($encoded)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

class WindowsDpapiVault implements CredentialVault {
  readonly backend = "windows-dpapi" as const;
  readonly #directory: string;
  readonly #powershell: string;

  constructor(dataDirectory: string) {
    this.#directory = join(dataDirectory, "vault");
    this.#powershell = process.env.SystemRoot
      ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
  }

  async get(providerId: string, key: string): Promise<string | null> {
    const path = this.#path(providerId, key);
    if (!existsSync(path)) return null;
    const encrypted = readFileSync(path, "utf8");
    const result = await runCommand(
      this.#powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_UNPROTECT_SCRIPT],
      encrypted,
    );
    if (result.exitCode !== 0) {
      throw new CredentialVaultUnavailableError("Windows DPAPI could not decrypt this credential.");
    }
    return result.stdout;
  }

  async set(providerId: string, key: string, value: string): Promise<void> {
    if (!value) throw new Error("Credential value cannot be empty");
    const result = await runCommand(
      this.#powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_PROTECT_SCRIPT],
      value,
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new CredentialVaultUnavailableError("Windows DPAPI could not encrypt this credential.");
    }
    writePrivateFile(this.#path(providerId, key), `${result.stdout.trim()}\n`);
  }

  async delete(providerId: string, key: string): Promise<void> {
    const path = this.#path(providerId, key);
    if (existsSync(path)) rmSync(path, { force: true });
  }

  #path(providerId: string, key: string): string {
    return join(
      this.#directory,
      `${assertVaultName(providerId, "provider")}.${assertVaultName(key, "key")}.dpapi`,
    );
  }
}

class MacOsKeychainVault implements CredentialVault {
  readonly backend = "macos-keychain" as const;

  async get(providerId: string, key: string): Promise<string | null> {
    const { service, account } = this.#identity(providerId, key);
    const result = await runCommand(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      "",
    );
    if (result.exitCode === 44) return null;
    if (result.exitCode !== 0) {
      throw new CredentialVaultUnavailableError("macOS Keychain is unavailable.");
    }
    return result.stdout.replace(/\r?\n$/, "");
  }

  async set(providerId: string, key: string, value: string): Promise<void> {
    if (!value) throw new Error("Credential value cannot be empty");
    const { service, account } = this.#identity(providerId, key);
    // `security` has no stdin option for add-generic-password. spawn() avoids a shell,
    // but the value is briefly present in this child process's argv on macOS.
    const result = await runCommand(
      "/usr/bin/security",
      ["add-generic-password", "-s", service, "-a", account, "-w", value, "-U"],
      "",
    );
    if (result.exitCode !== 0) {
      throw new CredentialVaultUnavailableError("macOS Keychain could not save the credential.");
    }
  }

  async delete(providerId: string, key: string): Promise<void> {
    const { service, account } = this.#identity(providerId, key);
    const result = await runCommand(
      "/usr/bin/security",
      ["delete-generic-password", "-s", service, "-a", account],
      "",
    );
    if (result.exitCode !== 0 && result.exitCode !== 44) {
      throw new CredentialVaultUnavailableError("macOS Keychain could not delete the credential.");
    }
  }

  #identity(providerId: string, key: string): { service: string; account: string } {
    return {
      service: `jp.cybereye-tech.runmeter.${assertVaultName(providerId, "provider")}`,
      account: assertVaultName(key, "key"),
    };
  }
}

class LinuxSecretServiceVault implements CredentialVault {
  readonly backend = "linux-secret-service" as const;

  async get(providerId: string, key: string): Promise<string | null> {
    const identity = this.#identity(providerId, key);
    let result: CommandResult;
    try {
      result = await runCommand("secret-tool", ["lookup", ...identity], "");
    } catch {
      throw new CredentialVaultUnavailableError(
        "Secret Service is unavailable. Install libsecret/secret-tool and unlock a keyring.",
      );
    }
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) {
      throw new CredentialVaultUnavailableError("Secret Service could not read the credential.");
    }
    return result.stdout.replace(/\r?\n$/, "");
  }

  async set(providerId: string, key: string, value: string): Promise<void> {
    if (!value) throw new Error("Credential value cannot be empty");
    const identity = this.#identity(providerId, key);
    let result: CommandResult;
    try {
      result = await runCommand(
        "secret-tool",
        ["store", "--label", `RunMeter ${providerId}`, ...identity],
        value,
      );
    } catch {
      throw new CredentialVaultUnavailableError(
        "Secret Service is unavailable. Install libsecret/secret-tool and unlock a keyring.",
      );
    }
    if (result.exitCode !== 0) {
      throw new CredentialVaultUnavailableError("Secret Service could not save the credential.");
    }
  }

  async delete(providerId: string, key: string): Promise<void> {
    const identity = this.#identity(providerId, key);
    let result: CommandResult;
    try {
      result = await runCommand("secret-tool", ["clear", ...identity], "");
    } catch {
      throw new CredentialVaultUnavailableError(
        "Secret Service is unavailable. Install libsecret/secret-tool and unlock a keyring.",
      );
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new CredentialVaultUnavailableError("Secret Service could not delete the credential.");
    }
  }

  #identity(providerId: string, key: string): string[] {
    return [
      "application",
      "runmeter",
      "provider",
      assertVaultName(providerId, "provider"),
      "key",
      assertVaultName(key, "key"),
    ];
  }
}

class UnavailableVault implements CredentialVault {
  readonly backend = "unavailable" as const;

  async get(): Promise<null> {
    throw new CredentialVaultUnavailableError("No supported OS credential vault is available.");
  }

  async set(): Promise<void> {
    throw new CredentialVaultUnavailableError("No supported OS credential vault is available.");
  }

  async delete(): Promise<void> {
    throw new CredentialVaultUnavailableError("No supported OS credential vault is available.");
  }
}

export function createCredentialVault(dataDirectory: string): CredentialVault {
  if (process.platform === "win32") return new WindowsDpapiVault(dataDirectory);
  if (process.platform === "darwin") return new MacOsKeychainVault();
  if (process.platform === "linux") return new LinuxSecretServiceVault();
  return new UnavailableVault();
}
