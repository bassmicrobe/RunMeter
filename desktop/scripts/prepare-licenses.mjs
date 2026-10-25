import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = resolve(desktop, "..");
const output = resolve(desktop, "dist", "licenses");
const require = createRequire(import.meta.url);

// This generated directory is replaced on every run so removed dependencies or
// an empty bridge bundle cannot leave stale notices in a later release.
if (output !== join(desktop, "dist", "licenses")) throw new Error("Unexpected license output directory");
rmSync(output, { recursive: true, force: true });

function copyNotice(source, destination) {
  if (!existsSync(source) || !readFileSync(source, "utf8").trim()) {
    throw new Error(`Required license document is missing or empty: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

for (const name of ["LICENSE", "BRANDING_LICENSE.md", "THIRD_PARTY_NOTICES.txt"]) {
  copyNotice(join(project, name), join(output, name));
}

const mainNotice = join(desktop, "dist", "main", "THIRD_PARTY_LICENSES.txt");
copyNotice(mainNotice, join(output, "DESKTOP-THIRD-PARTY-LICENSES.txt"));
const mainText = readFileSync(mainNotice, "utf8");
for (const name of ["electron-squirrel-startup", "debug", "ms"]) {
  if (!new RegExp(`^${name}\\r?$`, "m").test(mainText)) {
    throw new Error(`ncc did not emit the required ${name} license`);
  }
}

// The bridge currently contains only RunMeter code and Node built-ins. If a
// future bridge bundles a third-party package, ncc's notice is retained too.
const bridgeNotice = join(desktop, "dist", "bridge", "THIRD_PARTY_LICENSES.txt");
const bridgeHasNotice = existsSync(bridgeNotice) && Boolean(readFileSync(bridgeNotice, "utf8").trim());
if (bridgeHasNotice) {
  copyNotice(bridgeNotice, join(output, "BRIDGE-THIRD-PARTY-LICENSES.txt"));
}
copyNotice(join(desktop, "dist", "bridge", "NODE-LICENSE.txt"), join(output, "NODE-LICENSE.txt"));

const manifest = [];
const visited = new Set();
function preservePackage(name, resolver) {
  const packagePath = resolver.resolve(`${name}/package.json`);
  if (visited.has(packagePath)) return;
  visited.add(packagePath);
  const directory = dirname(packagePath);
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const documents = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:\..*)?$/i.test(entry.name))
    .map(entry => entry.name)
    .sort();
  if (!documents.some(file => /^(?:licen[cs]e|copying)(?:\..*)?$/i.test(file))) {
    throw new Error(`No original license document found for ${pkg.name}@${pkg.version}`);
  }
  const folder = `${pkg.name.replaceAll("/", "__")}@${pkg.version}`;
  const notices = documents.map(file => {
    const destination = join(output, "packages", folder, file);
    copyNotice(join(directory, file), destination);
    return { file, sha256: createHash("sha256").update(readFileSync(destination)).digest("hex") };
  });
  manifest.push({ name: pkg.name, version: pkg.version, license: pkg.license, documents: notices });
  const childResolver = createRequire(packagePath);
  for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) preservePackage(dependency, childResolver);
}
preservePackage("electron-squirrel-startup", require);
manifest.sort((left, right) => left.name.localeCompare(right.name));
writeFileSync(join(output, "desktop-runtime-packages.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(output, "README.txt"), [
  "RunMeter Desktop license documents",
  "",
  "LICENSE: RunMeter code (MIT).",
  "BRANDING_LICENSE.md: RunMeter logos and brand assets are not licensed under MIT.",
  "THIRD_PARTY_NOTICES.txt: Notices for the hosted Web application's dependencies and fonts.",
  "DESKTOP-THIRD-PARTY-LICENSES.txt: ncc's notices for the bundled desktop main process.",
  ...(bridgeHasNotice ? ["BRIDGE-THIRD-PARTY-LICENSES.txt: ncc's license metadata for bundled Bridge modules, including RunMeter's local Relay."] : []),
  "The Bridge currently bundles only RunMeter code and Node.js built-ins; it has no bundled third-party package dependencies.",
  "packages/: Original LICENSE/COPYING/NOTICE documents for the desktop runtime dependency tree.",
  "NODE-LICENSE.txt: Original license and third-party notices for the bundled Bridge Node.js runtime.",
  "",
  "Electron's LICENSE and LICENSES.chromium.html are at the application directory's top level,",
  "alongside RunMeter.exe. The Bridge also retains its own NODE-LICENSE.txt in resources/bridge/.",
  "All third-party works retain their respective licenses and copyright notices.",
  "",
].join("\n"));
console.log(JSON.stringify({ prepared: true, desktopRuntimePackages: manifest.map(pkg => `${pkg.name}@${pkg.version}`) }));
