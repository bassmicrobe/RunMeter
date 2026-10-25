import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { exportPublic } from "../scripts/export-public.mjs";
import { inspectText } from "../scripts/public-files.mjs";

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "runmeter-public-release-test-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "source");
  mkdirSync(root);
  const run = (arguments_) => execFileSync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgsign=false",
    "-c", "user.name=Private test author",
    "-c", "user.email=private-author@example.test",
    ...arguments_,
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
  run(["init", "--initial-branch=main", "--template="]);
  writeFileSync(join(root, ".gitignore"), ".env*\nnode_modules/\n.public-release/\n*.sqlite\n");
  writeFileSync(join(root, "README.md"), "Public product documentation.\n");
  run(["add", "--all"]);
  run(["commit", "-m", "Private historical change"]);
  return { directory, root, run };
}

test("public export copies current source without ignored files or source Git history", () => {
  const { directory, root, run } = fixture();
  writeFileSync(join(root, "README.md"), "Latest public documentation.\n");
  writeFileSync(join(root, ".env.local"), "TEST_PRIVATE_CONFIGURATION=not-for-export\n");
  writeFileSync(join(root, "usage.sqlite"), "private test usage");
  run(["add", "--force", ".env.local", "usage.sqlite"]);
  writeFileSync(join(root, "new-source.mjs"), "export const ready = true;\n");
  const destination = join(directory, "public-source");
  const result = exportPublic({ root, destination });
  assert.equal(result.files, 3);
  assert.equal(readFileSync(join(destination, "README.md"), "utf8"), "Latest public documentation.\n");
  assert.equal(existsSync(join(destination, "new-source.mjs")), true);
  for (const file of [".git", ".env.local", "usage.sqlite"]) {
    assert.equal(existsSync(join(destination, file)), false);
  }
  assert.equal(existsSync(join(root, ".git")), true);
});

test("public export refuses existing targets and repository parents without modification", () => {
  const { root, directory } = fixture();
  const marker = join(directory, "keep.txt");
  writeFileSync(marker, "keep");
  assert.throws(() => exportPublic({ root, destination: directory }), /parents/);
  const existing = join(directory, "existing");
  mkdirSync(existing);
  assert.throws(() => exportPublic({ root, destination: existing }), /already exists/);
  assert.equal(readFileSync(marker, "utf8"), "keep");
  assert.throws(() => exportPublic({ root, destination: root }), /repository/);
  assert.throws(() => exportPublic({ root, destination: "unignored-export" }), /must be ignored/);
  assert.equal(existsSync(join(root, "unignored-export")), false);
});

test("public export rejects a source symlink before creating the target", () => {
  const { directory, root } = fixture();
  const outside = join(directory, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "private.txt"), "not public");
  const link = join(root, "linked-source");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  const destination = join(directory, "public-source");
  assert.throws(() => exportPublic({ root, destination }), /links|junctions/);
  assert.equal(existsSync(destination), false);
});

test("public export rejects a symlink in the destination path", () => {
  const { directory, root } = fixture();
  const outside = join(directory, "outside");
  mkdirSync(outside);
  const link = join(directory, "linked-target");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => exportPublic({ root, destination: join(link, "public") }), /links|junctions/);
  assert.equal(existsSync(join(outside, "public")), false);
});

test("public export initializes one anonymous commit without inherited Git metadata", () => {
  const { root } = fixture();
  const destination = join(root, ".public-release", "RunMeter");
  exportPublic({ root, destination, initialize: true });
  const run = (arguments_) => execFileSync("git", arguments_, { cwd: destination, encoding: "utf8", stdio: "pipe" });
  assert.equal(run(["rev-list", "--count", "HEAD"]).trim(), "1");
  assert.equal(run(["show", "-s", "--format=%an|%ae|%cn|%ce", "HEAD"]).trim(),
    "RunMeter contributors|noreply@example.invalid|RunMeter contributors|noreply@example.invalid");
  assert.equal(run(["remote"]).trim(), "");
  assert.equal(run(["status", "--porcelain"]).trim(), "");
  assert.equal(run(["config", "--local", "user.name"]).trim(), "RunMeter contributors");
  assert.equal(run(["config", "--local", "user.email"]).trim(), "noreply@example.invalid");
  assert.equal(run(["config", "--local", "commit.gpgsign"]).trim(), "false");
});

test("public data findings disclose categories and counts, never matched values", () => {
  const secret = ["sk", "proj", "x".repeat(40)].join("-");
  const findings = inspectText("fixture.mjs", `const value = "${secret}";`, { localUser: "" });
  assert.deepEqual(findings, [{ file: "fixture.mjs", kind: "provider-token", count: 1 }]);
  assert.equal(JSON.stringify(findings).includes(secret), false);
});

test("public export blocks a token before creating the output directory", () => {
  const { root, directory } = fixture();
  const destination = join(directory, "public-source");
  const secret = ["sk", "proj", "x".repeat(40)].join("-");
  writeFileSync(join(root, "private-token.txt"), secret);
  assert.throws(() => exportPublic({ root, destination }), /inspection failed/);
  assert.equal(existsSync(destination), false);
});

test("email checks distinguish URL authority userinfo from actual email text", () => {
  const syntheticEmail = ["private-person", "nonexample.org"].join("@");
  const source = [
    "https://user:password@run-meter.vercel.app/",
    "https://user@run-meter.vercel.app/",
    `contact: ${syntheticEmail}`,
    `https://example.test/?contact=${syntheticEmail}`,
  ].join("\n");
  assert.deepEqual(inspectText("test-fixture.mjs", source, { localUser: "" }), [
    { file: "test-fixture.mjs", kind: "email", count: 2 },
  ]);
});

test("public RunMeter release owners are allowed without exempting other private identity", () => {
  const owner = "fixture-owner";
  const release = `https://github.com/${owner}/RunMeter/releases`;
  for (const url of [release, `${release}/tag/v0.1.0`, `${release}/download/v0.1.0/RunMeterSetup.exe`]) {
    assert.deepEqual(inspectText("README.md", url, { localUser: owner }), []);
  }
  for (const value of [
    owner,
    `${release}?note=${owner}`,
    `${release}/download/v0.1.0/${owner}.zip`,
    `https://github.com/${owner}/PrivateProject/releases`,
    `https://github.com/${owner}/RunMeter/releases-archive`,
    `https://github.com.evil.test/${owner}/RunMeter/releases`,
  ]) {
    assert.ok(inspectText("README.md", value, { localUser: owner }).some(finding => finding.kind === "local-user-name"));
  }
  const token = "sk-" + "x".repeat(40);
  assert.ok(inspectText("README.md", `${release}?token=${token}`, { localUser: owner })
    .some(finding => finding.kind === "provider-token"));
});
