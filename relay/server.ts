#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ClaudeAdapter } from "./adapters/claude.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import {
  GeminiAdapter,
  googleOAuthClientConfigFromEnvironment,
} from "./adapters/gemini.ts";
import { createCredentialVault } from "./credential-vault.ts";
import { defaultClaudeSettingsPath, defaultDataDirectory } from "./core/paths.ts";
import { ProviderRegistry } from "./core/registry.ts";
import { RELAY_HOST, RELAY_PORT, RelayHttpServer } from "./http-server.ts";
import { PairingManager } from "./pairing.ts";
import { RelayStore } from "./storage.ts";

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://run-meter.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
] as const;

export function configuredAllowedOrigins(): string[] {
  const configured = process.env.RUNMETER_ALLOWED_ORIGINS;
  return configured
    ? configured.split(",").map((origin) => origin.trim()).filter(Boolean)
    : [...DEFAULT_ALLOWED_ORIGINS];
}

export function createDefaultRelay(options: {
  claudeBridgeExecutablePath?: string;
  claudeBridgeScriptPath?: string;
} = {}): {
  dataDirectory: string;
  store: RelayStore;
  pairing: PairingManager;
  registry: ProviderRegistry;
  credentialVault: ReturnType<typeof createCredentialVault>;
  httpServer: RelayHttpServer;
} {
  const dataDirectory = defaultDataDirectory();
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const store = new RelayStore(join(dataDirectory, "telemetry.sqlite3"));
  const pairing = new PairingManager(store, dataDirectory);
  const credentialVault = createCredentialVault(dataDirectory);
  const registry = new ProviderRegistry();
  registry.register(new CodexAdapter(store));
  registry.register(
    new ClaudeAdapter({
      store,
      pairing,
      dataDirectory,
      settingsPath: defaultClaudeSettingsPath(),
      vault: credentialVault,
      ...(options.claudeBridgeExecutablePath
        ? { bridgeExecutablePath: options.claudeBridgeExecutablePath }
        : {}),
      ...(options.claudeBridgeScriptPath
        ? { bridgeScriptPath: options.claudeBridgeScriptPath }
        : {}),
    }),
  );
  registry.register(
    new GeminiAdapter(
      credentialVault,
      store.getProviderSnapshot("gemini"),
      googleOAuthClientConfigFromEnvironment(),
    ),
  );
  const httpServer = new RelayHttpServer({
    registry,
    store,
    pairing,
    allowedOrigins: configuredAllowedOrigins(),
  });
  return { dataDirectory, store, pairing, registry, credentialVault, httpServer };
}

async function main(): Promise<void> {
  if (process.versions.node.split(".").map(Number)[0] < 24) {
    throw new Error("RunMeter Relay requires Node.js 24 or newer.");
  }
  const relay = createDefaultRelay();
  await relay.httpServer.start();
  process.stdout.write(`RunMeter Relay: http://${RELAY_HOST}:${RELAY_PORT}\n`);
  let lastPairingCode = "";
  const printPairingCode = () => {
    const pairing = relay.pairing.getPairingCode();
    if (!pairing.code || !pairing.expiresAt || pairing.code === lastPairingCode) return;
    lastPairingCode = pairing.code;
    process.stdout.write(
      `ペアリングコード: ${pairing.code}（有効期限 ${pairing.expiresAt}）\n`,
    );
  };
  printPairingCode();
  const pairingCodeTimer = setInterval(printPairingCode, 15_000);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(pairingCodeTimer);
    await relay.httpServer.close();
    await relay.registry.dispose();
    relay.store.close();
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPath === import.meta.url) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Relay startup failed";
    process.stderr.write(`RunMeter Relay could not start: ${message.slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
