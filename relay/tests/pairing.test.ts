import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { PairingError, PairingManager } from "../pairing.ts";
import { RelayStore } from "../storage.ts";

test("pairing codes are one-time and browser bearer sessions can be revoked", (context) => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-pairing-")));
  const store = new RelayStore(join(directory, "test.sqlite3"));
  context.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const pairing = new PairingManager(store, directory);
  const initial = pairing.getPairingCode(1_000);
  assert.equal(initial.available, true);
  assert.match(initial.code ?? "", /^\d{6}$/);

  const claimed = pairing.claim(initial.code, "test browser", 1_001);
  assert.match(claimed.token, /^[A-Za-z0-9_-]{40,128}$/);
  const authenticated = pairing.authenticate(
    `Bearer ${claimed.token}`,
    ["browser"],
    1_002,
  );
  assert.equal(authenticated.scope, "browser");

  assert.throws(
    () => pairing.claim(initial.code, "replay", 1_003),
    (error: unknown) => error instanceof PairingError && error.code === "invalid_pairing_code",
  );
  pairing.revoke(authenticated.tokenHash);
  assert.throws(
    () => pairing.authenticate(`Bearer ${claimed.token}`, ["browser"], 1_004),
    PairingError,
  );
});

test("pairing attempts are rate limited after five failures", (context) => {
  const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-rate-limit-")));
  const store = new RelayStore(join(directory, "test.sqlite3"));
  context.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const pairing = new PairingManager(store, directory);
  for (let index = 0; index < 5; index += 1) {
    assert.throws(() => pairing.claim("999999", "attacker", 2_000 + index));
  }
  const status = pairing.getPairingCode(2_010);
  assert.equal(status.available, false);
  assert.ok(status.retryAt);
});
