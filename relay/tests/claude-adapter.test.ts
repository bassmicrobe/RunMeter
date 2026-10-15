import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeAdapter } from "../adapters/claude.ts";
import type { CredentialVault } from "../credential-vault.ts";
import { PairingManager } from "../pairing.ts";
import { RelayStore } from "../storage.ts";

class MemoryVault implements CredentialVault {
  readonly backend = "unavailable" as const;
  readonly values = new Map<string, string>();
  async get(provider: string, key: string) { return this.values.get(`${provider}:${key}`) ?? null; }
  async set(provider: string, key: string, value: string) { this.values.set(`${provider}:${key}`, value); }
  async delete(provider: string, key: string) { this.values.delete(`${provider}:${key}`); }
}

test("Claude reconnect failure preserves an existing valid helper credential", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runmeter-claude-adapter-"));
  const dataDirectory = join(directory, "data");
  mkdirSync(dataDirectory);
  const store = new RelayStore(":memory:");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const pairing = new PairingManager(store, dataDirectory);
  const settingsPath = join(directory, "settings.json");
  const adapter = new ClaudeAdapter({ store, pairing, dataDirectory, settingsPath, vault: new MemoryVault() });
  await adapter.connect();
  const credentialPath = join(dataDirectory, "service-claude-statusline.token");
  const before = readFileSync(credentialPath, "utf8");
  writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "user-changed-command" } }));
  await assert.rejects(adapter.connect());
  assert.equal(readFileSync(credentialPath, "utf8"), before);
  assert.equal(pairing.authenticate(`Bearer ${before.trim()}`, ["ingest:claude"]).scope, "ingest:claude");
});

test("Claude status read renews an expired helper credential without a reconnect", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runmeter-claude-expired-"));
  const dataDirectory = join(directory, "data");
  mkdirSync(dataDirectory);
  const store = new RelayStore(":memory:");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const pairing = new PairingManager(store, dataDirectory);
  const adapter = new ClaudeAdapter({
    store, pairing, dataDirectory, settingsPath: join(directory, "settings.json"), vault: new MemoryVault(),
  });
  await adapter.connect();
  pairing.revokeServiceCredential("claude-statusline");
  const credentialPath = pairing.ensureServiceCredential("claude-statusline", "ingest:claude", Date.now() - 366 * 24 * 60 * 60 * 1_000);
  const expired = readFileSync(credentialPath, "utf8").trim();
  assert.throws(() => pairing.authenticate(`Bearer ${expired}`, ["ingest:claude"]));
  await adapter.getStatus();
  const renewed = readFileSync(credentialPath, "utf8").trim();
  assert.notEqual(renewed, expired);
  assert.equal(pairing.authenticate(`Bearer ${renewed}`, ["ingest:claude"]).scope, "ingest:claude");
});
