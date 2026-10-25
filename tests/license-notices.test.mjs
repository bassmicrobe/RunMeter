import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inspectText } from "../scripts/public-files.mjs";

const contact = ["license-author", "upstream.dev"].join("@");
const body = `Copyright 2026 Upstream Authors <${contact}>\nPermission is granted under the upstream license.\n`;

function licenseBlock(contents = body) {
  const digest = createHash("sha256").update(contents).digest("hex");
  return `===== BEGIN LICENSE example-package@1.0.0 sha256:${digest} =====\n${contents}===== END LICENSE =====\n`;
}

test("verified upstream license contacts remain publishable in exact notice files", () => {
  for (const file of ["THIRD_PARTY_NOTICES.txt", "public/licenses/THIRD_PARTY_NOTICES.txt", "commit:abcdef:THIRD_PARTY_NOTICES.txt"]) {
    assert.deepEqual(inspectText(file, licenseBlock(), { localUser: "test-user" }), []);
    assert.deepEqual(inspectText(file, licenseBlock().replaceAll("\n", "\r\n"), { localUser: "test-user" }), []);
  }
});

test("unverified contacts, changed bodies and other files are still rejected", () => {
  for (const [file, contents] of [
    ["README.md", licenseBlock()],
    ["THIRD_PARTY_NOTICES.txt", licenseBlock().replace("Copyright 2026", "Copyright 2025")],
    ["THIRD_PARTY_NOTICES.txt", licenseBlock() + contact],
    ["public/licenses/BRANDING_LICENSE.txt", licenseBlock()],
  ]) {
    assert.ok(inspectText(file, contents, { localUser: "test-user" }).some(finding => finding.kind === "email"));
  }
});

test("license attribution never exempts credentials or local identity", () => {
  const credential = "sk-" + "x".repeat(40);
  assert.ok(inspectText("THIRD_PARTY_NOTICES.txt", licenseBlock(`${body}${credential}\n`), { localUser: "test-user" })
    .some(finding => finding.kind === "provider-token"));
  assert.ok(inspectText("THIRD_PARTY_NOTICES.txt", licenseBlock(`${body}runmeter-private-owner\n`), { localUser: "runmeter-private-owner" })
    .some(finding => finding.kind === "local-user-name"));
});
