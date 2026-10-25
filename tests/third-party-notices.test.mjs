import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const generator = fileURLToPath(new URL("../scripts/generate-third-party-notices.mjs", import.meta.url));
const temporaryDirectories = [];
const prefix = "runmeter-notices-test-";
const runtimeLicense = "Fixture runtime license text for regression testing.\n";
const runtimeArchive = "https://registry.example.test/fixture-runtime/-/fixture-runtime-1.0.0.tgz";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith(prefix));
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function installFixturePackage(directory, name, body) {
  const target = join(directory, "node_modules", name);
  mkdirSync(target, { recursive: true });
  writeJson(join(target, "package.json"), { name, version: "1.0.0", license: "MIT" });
  writeFileSync(join(target, "LICENSE"), body, "utf8");
}

function fixture({ optionalInstalled = false, requiredInstalled = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const root = join(directory, "checkout");
  for (const path of ["scripts", "licenses/upstream", "licenses/fonts"]) mkdirSync(join(root, path), { recursive: true });
  copyFileSync(generator, join(root, "scripts/generate-third-party-notices.mjs"));
  const integrity = "sha512-" + createHash("sha512").update("fixture runtime archive").digest("base64");
  const lock = { lockfileVersion: 3, packages: {
    "": { name: "fixture-app", version: "1.0.0" },
    "node_modules/fixture-required": { version: "1.0.0", license: "MIT", resolved: "https://registry.example.test/fixture-required-1.0.0.tgz" },
    "node_modules/fixture-runtime": { version: "1.0.0", license: "MIT", resolved: runtimeArchive, integrity, optional: true },
  } };
  writeJson(join(root, "package-lock.json"), lock);
  writeJson(join(root, "licenses/fonts/sources.json"), []);
  writeJson(join(root, "licenses/upstream/sources.json"), [{
    name: "fixture-runtime", version: "1.0.0", optional: true, file: "fixture-runtime-LICENSE.txt", document: "LICENSE",
    source: runtimeArchive + "#package/LICENSE", packageIntegrity: integrity,
    sha256: createHash("sha256").update(runtimeLicense).digest("hex"),
  }]);
  writeFileSync(join(root, "licenses/upstream/fixture-runtime-LICENSE.txt"), runtimeLicense, "utf8");
  if (requiredInstalled) installFixturePackage(root, "fixture-required", "Fixture required package license.\n");
  if (optionalInstalled) installFixturePackage(root, "fixture-runtime", runtimeLicense);
  const run = (...arguments_) => spawnSync(process.execPath, ["scripts/generate-third-party-notices.mjs", ...arguments_], {
    cwd: root, encoding: "utf8", stdio: "pipe",
  });
  return { directory, root, lock, run };
}

test("optional runtime installation choices do not change generated notices", () => {
  const installed = fixture({ optionalInstalled: true });
  const absent = fixture();
  for (const source of [installed, absent]) {
    const generated = source.run();
    assert.equal(generated.status, 0, generated.stderr);
    const checked = source.run("--check");
    assert.equal(checked.status, 0, checked.stderr);
  }
  assert.equal(readFileSync(join(installed.root, "THIRD_PARTY_NOTICES.txt"), "utf8"),
    readFileSync(join(absent.root, "THIRD_PARTY_NOTICES.txt"), "utf8"));
});

test("required dependencies cannot be resolved from an ancestor installation", () => {
  const source = fixture({ requiredInstalled: false });
  installFixturePackage(source.directory, "fixture-required", "Ancestor package must not be used.\n");
  const result = source.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not installed in this checkout: node_modules\/fixture-required/);
});

test("a modified pinned optional license is rejected", () => {
  const source = fixture();
  writeFileSync(join(source.root, "licenses/upstream/fixture-runtime-LICENSE.txt"), runtimeLicense + "Changed.\n", "utf8");
  const result = source.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pinned upstream license checksum differs: fixture-runtime/);
});

test("a changed lockfile archive integrity requires an updated verified license pin", () => {
  const source = fixture();
  source.lock.packages["node_modules/fixture-runtime"].integrity = "sha512-" + createHash("sha512").update("changed fixture archive").digest("base64");
  writeJson(join(source.root, "package-lock.json"), source.lock);
  const result = source.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Optional production dependency needs a checksum-verified pinned license: node_modules\/fixture-runtime/);
});
