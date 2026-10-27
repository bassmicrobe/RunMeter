import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";
import { nativeInstallerDocuments } from "./native-installer-licenses.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isMac = process.platform === "darwin";
const packaged = resolve(process.argv[2] ?? join(desktop, "out", isMac ? `RunMeter-darwin-${process.arch}` : "RunMeter-win32-x64"));
// On macOS everything the user receives is inside the zipped RunMeter.app.
const appRoot = isMac ? join(packaged, "RunMeter.app", "Contents", "Resources") : packaged;
const resources = isMac ? appRoot : join(packaged, "resources");
const directory = join(resources, "licenses");
const native = isMac ? null : nativeInstallerDocuments(join(directory, "native-installer"));
const required = [
  "LICENSE", "BRANDING_LICENSE.md", "THIRD_PARTY_NOTICES.txt",
  "DESKTOP-THIRD-PARTY-LICENSES.txt", "NODE-LICENSE.txt", "README.txt",
  "desktop-runtime-packages.json",
];
for (const name of required) {
  const path = join(directory, name);
  assert.ok(existsSync(path), `Packaged license is missing: ${name}`);
  assert.ok(readFileSync(path, "utf8").trim(), `Packaged license is empty: ${name}`);
}
for (const path of [join(appRoot, "LICENSE"), join(appRoot, "LICENSES.chromium.html"), join(resources, "bridge", "NODE-LICENSE.txt")]) {
  const name = path.slice(packaged.length + 1);
  assert.ok(existsSync(path), `Bundled runtime license is missing: ${name}`);
  assert.ok(readFileSync(path, "utf8").trim(), `Bundled runtime license is empty: ${name}`);
}
assert.ok(readFileSync(join(directory, "LICENSE"), "utf8").includes("MIT License"));
const packages = JSON.parse(readFileSync(join(directory, "desktop-runtime-packages.json"), "utf8"));
assert.deepEqual(packages.map(pkg => pkg.name).sort(), ["debug", "electron-squirrel-startup", "ms"]);
for (const pkg of packages) {
  assert.ok(pkg.documents.length, `No original license documents recorded for ${pkg.name}`);
  for (const document of pkg.documents) {
    const source = join(directory, "packages", `${pkg.name.replaceAll("/", "__")}@${pkg.version}`, document.file);
    assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"), document.sha256);
  }
}
assert.equal(
  readFileSync(join(directory, "NODE-LICENSE.txt"), "utf8"),
  readFileSync(join(resources, "bridge", "NODE-LICENSE.txt"), "utf8"),
);
const bridgeNotice = join(resources, "bridge", "THIRD_PARTY_LICENSES.txt");
if (existsSync(bridgeNotice) && readFileSync(bridgeNotice, "utf8").trim()) {
  assert.equal(
    readFileSync(join(directory, "BRIDGE-THIRD-PARTY-LICENSES.txt"), "utf8"),
    readFileSync(bridgeNotice, "utf8"),
    "Bridge notice differs from its accessible copy",
  );
}
const archive = join(resources, "app.asar");
const files = listPackage(archive).map(file => file.replaceAll("\\", "/"));
assert.ok(files.includes("/dist/main/THIRD_PARTY_LICENSES.txt"), "ncc notice is missing from app.asar");
assert.ok(!files.some(file => file.startsWith("/dist/licenses/")), "License resources should be accessible outside app.asar");
assert.ok(!files.some(file => file.startsWith("/licenses/")), "Native license sources should be copied to accessible resources");
assert.equal(JSON.parse(extractFile(archive, "package.json")).license, "MIT");
assert.equal(
  Buffer.compare(
    extractFile(archive, join("dist", "main", "THIRD_PARTY_LICENSES.txt")),
    readFileSync(join(directory, "DESKTOP-THIRD-PARTY-LICENSES.txt")),
  ),
  0,
  "Packaged ncc notice differs from its accessible copy",
);
console.log(JSON.stringify({ passed: true, projectDocuments: required.length, desktopRuntimePackages: packages.length, nativeInstallerDocuments: native?.documentCount ?? 0, electronAndChromiumNotices: true, nodeNotice: true, asarNotice: true }));
