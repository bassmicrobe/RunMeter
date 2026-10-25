import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function inside(base, name) {
  assert.ok(typeof name === "string" && name && !isAbsolute(name), "Invalid native license path");
  const path = resolve(base, name);
  const suffix = relative(base, path);
  assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix), "Native license path escapes its directory");
  return path;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function nativeInstallerDocuments(base) {
  const manifest = JSON.parse(readFileSync(join(base, "sources.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.groups, ["native-bootstrap/sources.json", "squirrel-source/sources.json", "managed/sources.json"]);
  const files = new Set(["sources.json", "README.txt"]);
  const documents = [];
  for (const group of manifest.groups) {
    const path = inside(base, group);
    const entries = JSON.parse(readFileSync(path, "utf8")).documents;
    assert.ok(Array.isArray(entries) && entries.length, `Empty native license group: ${group}`);
    files.add(group);
    for (const document of entries) {
      assert.ok(document.component && document.version && document.license && document.sourceUrl, `Incomplete native license metadata: ${group}`);
      const original = inside(dirname(path), document.file);
      assert.ok(readFileSync(original, "utf8").trim(), `Empty native license: ${document.file}`);
      assert.equal(sha256(original), document.sha256, `Native license original changed: ${document.file}`);
      files.add(relative(base, original));
      documents.push(document);
    }
  }
  for (const name of files) assert.ok(readFileSync(inside(base, name), "utf8").trim(), `Empty native license file: ${name}`);
  return { manifest, files: [...files], documentCount: documents.length };
}

export function verifyNativeInstallerVendor(manifest, vendorPackageDirectory) {
  const pkg = JSON.parse(readFileSync(join(vendorPackageDirectory, "package.json"), "utf8"));
  assert.equal(pkg.name, manifest.vendorPackage.name);
  assert.equal(pkg.version, manifest.vendorPackage.version, "Installer release changed; audit its native licenses before building");
  assert.deepEqual(manifest.binaries.map(binary => binary.file), ["Squirrel.exe", "Setup.exe", "StubExecutable.exe"]);
  for (const binary of manifest.binaries) {
    assert.equal(sha256(inside(join(vendorPackageDirectory, "vendor"), binary.file)), binary.sha256, `Installer vendor binary changed: ${binary.file}`);
  }
}
