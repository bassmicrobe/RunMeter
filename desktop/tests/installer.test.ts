import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeSettingsManager } from "../../relay/claude-settings.ts";
import type { CredentialVault } from "../../relay/credential-vault.ts";
import { restoreClaudeSettings, runInstallerStartup } from "../installer.ts";

class MemoryVault implements CredentialVault {
  readonly backend = "unavailable" as const;
  readonly values = new Map<string, string>();
  async get(provider: string, key: string) {
    return this.values.get(`${provider}/${key}`) ?? null;
  }
  async set(provider: string, key: string, value: string) {
    this.values.set(`${provider}/${key}`, value);
  }
  async delete(provider: string, key: string) {
    this.values.delete(`${provider}/${key}`);
  }
}

test("uninstall restores the prior status line and preserves unrelated settings and history", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runmeter-uninstall-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "claude-settings.json");
  const original = {
    statusLine: { type: "command", command: "my-statusline" },
    theme: "dark",
  };
  writeFileSync(settingsPath, JSON.stringify(original));
  const history = join(directory, "telemetry.sqlite3");
  writeFileSync(history, "retained test history");
  const vault = new MemoryVault();
  await new ClaudeSettingsManager({
    settingsPath,
    dataDirectory: directory,
    bridgeScriptPath: "test-bridge.js",
    vault,
  }).install();
  await restoreClaudeSettings({
    settingsPath,
    dataDirectory: directory,
    vault,
  });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), original);
  assert.equal(readFileSync(history, "utf8"), "retained test history");
  assert.equal(
    existsSync(join(directory, "claude-statusline-state.json")),
    false,
  );
});

test("uninstall preserves a status line edited by the user after installation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runmeter-uninstall-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "claude-settings.json");
  const vault = new MemoryVault();
  await new ClaudeSettingsManager({
    settingsPath,
    dataDirectory: directory,
    bridgeScriptPath: "test-bridge.js",
    vault,
  }).install();
  const edited = {
    statusLine: { type: "command", command: "my-new-statusline" },
    theme: "light",
  };
  writeFileSync(settingsPath, JSON.stringify(edited));
  await assert.rejects(
    restoreClaudeSettings({ settingsPath, dataDirectory: directory, vault }),
    /edited/,
  );
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), edited);
  assert.equal(
    existsSync(join(directory, "claude-statusline-state.json")),
    true,
  );
});

test("Squirrel cannot quit before asynchronous uninstall cleanup completes", async () => {
  const events: string[] = [];
  let finishRestore: (() => void) | undefined;
  const pending = runInstallerStartup({
    arguments: ["--squirrel-uninstall"],
    disableAutostart: () => {
      events.push("disable-autostart");
    },
    restoreSettings: () =>
      new Promise<void>((resolve) => {
        finishRestore = resolve;
        events.push("restore-start");
      }),
    onCleanupError: () => assert.fail("Unexpected cleanup error"),
    startSquirrel: async () => {
      events.push("start-squirrel");
      return true;
    },
  });
  assert.deepEqual(events, ["disable-autostart", "restore-start"]);
  finishRestore?.();
  assert.equal(await pending, true);
  assert.deepEqual(events, [
    "disable-autostart",
    "restore-start",
    "start-squirrel",
  ]);
});

test("a settings conflict is reported but does not prevent uninstall or alter edited data", async () => {
  const events: string[] = [];
  assert.equal(
    await runInstallerStartup({
      arguments: ["--squirrel-uninstall"],
      disableAutostart: () => undefined,
      restoreSettings: async () => {
        throw new Error("User-edited settings");
      },
      onCleanupError: () => {
        events.push("reported");
      },
      startSquirrel: async () => {
        events.push("start-squirrel");
        return true;
      },
    }),
    true,
  );
  assert.deepEqual(events, ["reported", "start-squirrel"]);
});
