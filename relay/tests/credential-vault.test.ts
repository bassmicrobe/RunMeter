import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createCredentialVault } from "../credential-vault.ts";

test(
  "Windows credential vault encrypts values with DPAPI instead of plaintext",
  { skip: process.platform !== "win32" },
  async (context) => {
    const directory = resolve(mkdtempSync(join(tmpdir(), "runmeter-vault-")));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const vault = createCredentialVault(directory);
    const secret = "test-secret-that-must-not-appear-on-disk";
    await vault.set("gemini", "test-secret", secret);
    assert.equal(await vault.get("gemini", "test-secret"), secret);

    const vaultDirectory = join(directory, "vault");
    const files = readdirSync(vaultDirectory);
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(vaultDirectory, files[0]), "utf8").includes(secret), false);

    await vault.delete("gemini", "test-secret");
    assert.equal(await vault.get("gemini", "test-secret"), null);
  },
);
