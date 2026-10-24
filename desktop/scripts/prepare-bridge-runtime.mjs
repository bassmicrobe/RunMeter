import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "24.22.1";
const NODE_LICENSE_SHA256 =
  "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const bridgeDirectory = resolve(desktopDirectory, "dist", "bridge");
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

mkdirSync(bridgeDirectory, { recursive: true });
copyFileSync(nodeExecutable, resolve(bridgeDirectory, "node.exe"));

const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`;
const response = await fetch(licenseUrl, { signal: AbortSignal.timeout(15_000) });
if (!response.ok) {
  throw new Error(`Could not download the Node.js license (${response.status}).`);
}
const license = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(license).digest("hex");
if (digest !== NODE_LICENSE_SHA256) {
  throw new Error("The downloaded Node.js license did not match the pinned checksum.");
}
writeFileSync(resolve(bridgeDirectory, "NODE-LICENSE.txt"), license);
writeFileSync(
  resolve(bridgeDirectory, "runtime.json"),
  `${JSON.stringify({ nodeVersion: NODE_VERSION }, null, 2)}\n`,
  "utf8",
);
