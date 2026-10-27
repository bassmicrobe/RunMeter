import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "24.22.1";
const NODE_LICENSE_SHA256 =
  "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace";
// Official nodejs.org archives from SHASUMS256.txt. npm has no maintained
// darwin-arm64 Node package, so macOS builds download the release directly.
const DARWIN_ARCHIVE_SHA256 = {
  arm64: "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
  x64: "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
};
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const bridgeDirectory = resolve(desktopDirectory, "dist", "bridge");

async function download(url, timeout) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    throw new Error(`Could not download ${url} (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function prepareWindowsRuntime() {
  const nodeExecutable = resolve(
    desktopDirectory,
    "node_modules",
    "node-win-x64",
    "bin",
    "node.exe",
  );
  if (!existsSync(nodeExecutable)) {
    throw new Error(
      `Pinned Node.js runtime is missing. Run npm install in ${desktopDirectory}.`,
    );
  }
  copyFileSync(nodeExecutable, resolve(bridgeDirectory, "node.exe"));
}

async function prepareDarwinRuntime(arch) {
  const expected = DARWIN_ARCHIVE_SHA256[arch];
  if (!expected) throw new Error(`Unsupported macOS architecture: ${arch}`);
  const name = `node-v${NODE_VERSION}-darwin-${arch}`;
  const cacheDirectory = resolve(desktopDirectory, "node_modules", ".cache", "runmeter-node");
  const archivePath = resolve(cacheDirectory, `${name}.tar.gz`);
  mkdirSync(cacheDirectory, { recursive: true });
  if (!existsSync(archivePath) || sha256(readFileSync(archivePath)) !== expected) {
    const archive = await download(
      `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`,
      120_000,
    );
    // Verify before anything from the archive is extracted or cached.
    if (sha256(archive) !== expected) {
      throw new Error("The downloaded Node.js archive did not match the pinned checksum.");
    }
    writeFileSync(archivePath, archive);
  }
  const extractDirectory = resolve(desktopDirectory, "dist", "bridge-node-extract");
  rmSync(extractDirectory, { recursive: true, force: true });
  mkdirSync(extractDirectory, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", extractDirectory, `${name}/bin/node`]);
  const target = resolve(bridgeDirectory, "node");
  copyFileSync(resolve(extractDirectory, name, "bin", "node"), target);
  chmodSync(target, 0o755);
  rmSync(extractDirectory, { recursive: true, force: true });
}

// The Bridge runtime must match the machine that runs the packaged app, and
// Electron Forge packages for the build host, so the host selects the runtime.
mkdirSync(bridgeDirectory, { recursive: true });
if (process.platform === "win32") {
  prepareWindowsRuntime();
} else if (process.platform === "darwin") {
  await prepareDarwinRuntime(process.arch);
} else {
  throw new Error(`Desktop builds support Windows and macOS, not ${process.platform}.`);
}

const license = await download(
  `https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`,
  15_000,
);
if (sha256(license) !== NODE_LICENSE_SHA256) {
  throw new Error("The downloaded Node.js license did not match the pinned checksum.");
}
writeFileSync(resolve(bridgeDirectory, "NODE-LICENSE.txt"), license);
writeFileSync(
  resolve(bridgeDirectory, "runtime.json"),
  `${JSON.stringify({ nodeVersion: NODE_VERSION }, null, 2)}\n`,
  "utf8",
);
