import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { CredentialVault } from "../credential-vault.ts";

import {
  ClaudeSettingsConflictError,
  ClaudeSettingsManager,
} from "../claude-settings.ts";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

class MemoryVault implements CredentialVault {
  readonly backend = "unavailable" as const;
  readonly values = new Map<string, string>();

  async get(providerId: string, key: string): Promise<string | null> {
    return this.values.get(`${providerId}:${key}`) ?? null;
  }

  async set(providerId: string, key: string, value: string): Promise<void> {
    this.values.set(`${providerId}:${key}`, value);
  }

  async delete(providerId: string, key: string): Promise<void> {
    this.values.delete(`${providerId}:${key}`);
  }
}

test("Claude install chains and later restores the existing statusLine", async (context) => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-claude-settings-")));
  const settingsPath = join(directory, ".claude", "settings.json");
  const dataDirectory = join(directory, "data");
  mkdirSync(join(directory, ".claude"), { recursive: true });
  const previous = {
    type: "command",
    command: "node previous-status.js",
    padding: 2,
    refreshInterval: 20,
  };
  writeFileSync(
    settingsPath,
    JSON.stringify({ theme: "dark", permissions: { allow: ["Read"] }, statusLine: previous }),
  );
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const manager = new ClaudeSettingsManager({
    settingsPath,
    dataDirectory,
    bridgeScriptPath: join(directory, "relay", "claude-statusline.ts"),
    vault: new MemoryVault(),
  });
  const installed = await manager.install();
  assert.equal(installed.changed, true);
  assert.equal(manager.isInstalled(), true);
  const afterInstall = readJson(settingsPath);
  assert.equal(afterInstall.theme, "dark");
  assert.deepEqual(afterInstall.permissions, { allow: ["Read"] });
  assert.notDeepEqual(afterInstall.statusLine, previous);

  const uninstalled = await manager.uninstall();
  assert.equal(uninstalled.changed, true);
  const restored = readJson(settingsPath);
  assert.deepEqual(restored.statusLine, previous);
  assert.equal(restored.theme, "dark");
  assert.deepEqual(restored.permissions, { allow: ["Read"] });
});

test("Claude uninstall refuses to overwrite a user edit", async (context) => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-claude-conflict-")));
  const settingsPath = join(directory, "settings.json");
  const dataDirectory = join(directory, "data");
  writeFileSync(settingsPath, JSON.stringify({ feature: true }));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = new ClaudeSettingsManager({
    settingsPath,
    dataDirectory,
    bridgeScriptPath: join(directory, "claude-statusline.ts"),
    vault: new MemoryVault(),
  });
  await manager.install();
  const edited = readJson(settingsPath);
  edited.statusLine = { type: "command", command: "user-new-command" };
  writeFileSync(settingsPath, JSON.stringify(edited));

  await assert.rejects(() => manager.uninstall(), ClaudeSettingsConflictError);
  assert.deepEqual(readJson(settingsPath).statusLine, edited.statusLine);
  assert.equal(readJson(settingsPath).feature, true);
});

test("Claude install upgrades a RunMeter-owned bridge command", async (context) => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-claude-upgrade-")));
  const settingsPath = join(directory, "settings.json");
  const dataDirectory = join(directory, "data");
  const vault = new MemoryVault();
  writeFileSync(settingsPath, JSON.stringify({ statusLinePadding: 1 }));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const original = new ClaudeSettingsManager({
    settingsPath,
    dataDirectory,
    bridgeExecutablePath: join(directory, "node-old.exe"),
    bridgeScriptPath: join(directory, "bridge-old.js"),
    vault,
  });
  await original.install();

  const upgraded = new ClaudeSettingsManager({
    settingsPath,
    dataDirectory,
    bridgeExecutablePath: join(directory, "node-new.exe"),
    bridgeScriptPath: join(directory, "bridge-new.js"),
    vault,
  });
  const result = await upgraded.install();
  assert.equal(result.changed, true);
  assert.match(
    String((readJson(settingsPath).statusLine as Record<string, unknown>).command),
    /node-new\.exe.*bridge-new\.js/,
  );
  assert.equal(upgraded.isInstalled(), true);

  await upgraded.uninstall();
  assert.deepEqual(readJson(settingsPath), { statusLinePadding: 1 });
});

test("Claude install preserves unrelated edits made while the backup is saved", async (context) => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-claude-edit-")));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "settings.json");
  const previous = { type: "command", command: "previous-command" };
  writeFileSync(settingsPath, JSON.stringify({ statusLine: previous, theme: "dark" }));
  const vault = new MemoryVault();
  const save = vault.set.bind(vault);
  vault.set = async (...args) => {
    await save(...args);
    writeFileSync(settingsPath, JSON.stringify({ statusLine: previous, theme: "light", permissions: { deny: ["Bash"] } }));
  };
  const manager = new ClaudeSettingsManager({
    settingsPath,
    dataDirectory: join(directory, "data"),
    bridgeScriptPath: join(directory, "bridge.js"),
    vault,
  });

  await manager.install();
  assert.equal(readJson(settingsPath).theme, "light");
  assert.deepEqual(readJson(settingsPath).permissions, { deny: ["Bash"] });
  await manager.uninstall();
  assert.deepEqual(readJson(settingsPath).statusLine, previous);
});

test("Claude install and uninstall reject command edits made during vault access", async (context) => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-claude-edit-command-")));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "settings.json");
  const previous = { type: "command", command: "previous-command" };
  const edited = { type: "command", command: "user-command" };
  writeFileSync(settingsPath, JSON.stringify({ statusLine: previous }));
  const vault = new MemoryVault();
  const save = vault.set.bind(vault);
  vault.set = async (...args) => {
    await save(...args);
    writeFileSync(settingsPath, JSON.stringify({ statusLine: edited }));
  };
  const manager = new ClaudeSettingsManager({
    settingsPath,
    dataDirectory: join(directory, "data"),
    bridgeScriptPath: join(directory, "bridge.js"),
    vault,
  });
  await assert.rejects(manager.install(), ClaudeSettingsConflictError);
  assert.deepEqual(readJson(settingsPath).statusLine, edited);

  vault.set = save;
  await manager.install();
  const read = vault.get.bind(vault);
  vault.get = async (...args) => {
    const result = await read(...args);
    writeFileSync(settingsPath, JSON.stringify({ statusLine: previous }));
    return result;
  };
  await assert.rejects(manager.uninstall(), ClaudeSettingsConflictError);
  assert.deepEqual(readJson(settingsPath).statusLine, previous);
});

test("Claude settings mutations are ordered when disconnect follows connect immediately", async (context) => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-claude-order-")));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "settings.json");
  const original = { theme: "light", statusLine: { type: "command", command: "original" } };
  writeFileSync(settingsPath, JSON.stringify(original));
  const manager = new ClaudeSettingsManager({
    settingsPath,
    dataDirectory: join(directory, "data"),
    bridgeScriptPath: join(directory, "bridge.js"),
    vault: new MemoryVault(),
  });
  const results = await Promise.all([manager.install(), manager.uninstall()]);
  assert.ok(results.every((result) => result.changed));
  assert.deepEqual(readJson(settingsPath), original);
  assert.equal(manager.isInstalled(), false);
});

test("Claude settings state cannot restore a different settings file", async (context) => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-claude-path-")));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "first.json");
  const otherPath = join(directory, "other.json");
  const options = {
    dataDirectory: join(directory, "data"),
    bridgeScriptPath: join(directory, "bridge.js"),
    vault: new MemoryVault(),
  };
  const manager = new ClaudeSettingsManager({ ...options, settingsPath });
  await manager.install();
  const installed = readJson(settingsPath);
  writeFileSync(otherPath, JSON.stringify(installed));
  const otherManager = new ClaudeSettingsManager({ ...options, settingsPath: otherPath });
  assert.throws(() => otherManager.isInstalled(), ClaudeSettingsConflictError);
  await assert.rejects(otherManager.uninstall(), ClaudeSettingsConflictError);
  assert.deepEqual(readJson(otherPath), installed);
});
