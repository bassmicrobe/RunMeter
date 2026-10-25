import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputPath = join(root, "THIRD_PARTY_NOTICES.txt");
const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || arguments_.some(argument => !["--check", "--inventory"].includes(argument))) {
  throw new Error("Usage: node scripts/generate-third-party-notices.mjs [--check|--inventory]");
}
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const licenseName = /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i;
const canonical = text => text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/\n*$/, "\n");
const digest = text => createHash("sha256").update(text).digest("hex");
const slash = path => path.replaceAll("\\", "/");
const upstreamSources = JSON.parse(readFileSync(join(root, "licenses", "upstream", "sources.json"), "utf8"));
// These development dependencies also supply CSS imported directly by globals.css.
// Their JavaScript build tool dependencies are not part of the distributed CSS.
const distributedCssSources = new Set(["node_modules/tailwindcss", "node_modules/shadcn"]);

function pinnedSource(source) {
  const body = canonical(readFileSync(join(root, "licenses", "upstream", source.file), "utf8"));
  if (digest(body) !== source.sha256) throw new Error(`Pinned upstream license checksum differs: ${source.name}`);
  return { name: source.file, body, source: source.source };
}

function installedDirectory(packagePath) {
  let directory = root;
  while (true) {
    const candidate = join(directory, packagePath);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function licenseFiles(directory, recursive = false) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isFile() && licenseName.test(entry.name)) files.push(file);
    else if (recursive && entry.isDirectory() && entry.name !== "node_modules") {
      files.push(...licenseFiles(file, true));
    }
  }
  return files.sort();
}

const records = [];
const skipped = [];
const buildOnly = [];
const missing = [];
for (const [packagePath, metadata] of Object.entries(lock.packages)) {
  if (!packagePath || (metadata.dev === true && !distributedCssSources.has(packagePath)) || metadata.link) continue;
  if (/^node_modules\/@next\/swc-/.test(packagePath)) {
    buildOnly.push(`${packagePath}@${metadata.version}`);
    continue;
  }
  const directory = installedDirectory(packagePath);
  if (!directory) {
    if (!metadata.optional) throw new Error(`Required production dependency is not installed: ${packagePath}`);
    skipped.push(`${packagePath}@${metadata.version}`);
    continue;
  }
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (manifest.version !== metadata.version) throw new Error(`Installed version differs from package-lock: ${manifest.name}`);
  const files = licenseFiles(directory, manifest.name !== "next");
  const documents = files.map(file => ({ name: slash(relative(directory, file)), body: canonical(readFileSync(file, "utf8")) }));
  const supplement = upstreamSources.find(source => source.name === manifest.name && source.version === manifest.version);
  if (supplement) documents.unshift(pinnedSource(supplement));
  if (manifest.name === "@next/env") {
    const next = installedDirectory("node_modules/next");
    const nextManifest = next && JSON.parse(readFileSync(join(next, "package.json"), "utf8"));
    if (!next || nextManifest.version !== manifest.version || manifest.license !== "MIT") {
      throw new Error("The shared Next.js license does not match @next/env");
    }
    documents.push({ name: "Next.js-project-license.md", body: canonical(readFileSync(join(next, "license.md"), "utf8")),
      source: `${lock.packages["node_modules/next"].resolved}#package/license.md` });
  }
  if (manifest.name === "client-only") {
    const react = installedDirectory("node_modules/react");
    if (!react || manifest.license !== "MIT" || manifest.bugs !== "https://github.com/facebook/react/issues") {
      throw new Error("The shared React project license could not be verified for client-only");
    }
    documents.push({ name: "React-project-LICENSE", body: canonical(readFileSync(join(react, "LICENSE"), "utf8")),
      source: `${lock.packages["node_modules/react"].resolved}#package/LICENSE` });
  }
  if (documents.length === 0) {
    missing.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? metadata.license });
    continue;
  }
  records.push({
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === "string" ? manifest.license : metadata.license ?? "See license text",
    source: metadata.resolved ?? manifest.homepage ?? "See package metadata",
    documents,
  });
  if (manifest.name === "next") {
    const compiled = join(directory, "dist", "compiled");
    for (const file of licenseFiles(compiled, true)) {
      records.push({ name: `next/dist/compiled/${slash(relative(compiled, file))}`, version: manifest.version,
        license: "See bundled vendor license text", source: metadata.resolved,
        documents: [{ name: "vendor-license", body: canonical(readFileSync(file, "utf8")) }],
      });
    }
  }
}

if (process.argv.includes("--inventory")) {
  console.log(JSON.stringify({ records: records.length, skippedOptionalPackages: skipped, excludedBuildCompilers: buildOnly.length, missingLicenses: missing }, null, 2));
  process.exit(missing.length > 0 ? 1 : 0);
}
if (missing.length > 0) throw new Error(`Missing production license text for: ${missing.map(value => `${value.name}@${value.version}`).join(", ")}`);

const fonts = JSON.parse(readFileSync(join(root, "licenses", "fonts", "sources.json"), "utf8"));
for (const font of fonts) {
  const body = canonical(readFileSync(join(root, "licenses", "fonts", font.file), "utf8"));
  if (digest(body) !== font.sha256) throw new Error(`Pinned font license checksum differs: ${font.name}`);
  records.push({ name: font.name, version: font.revision, license: "OFL-1.1", source: font.source,
    documents: [{ name: "OFL.txt", body }],
  });
}

const sections = records.sort((a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en")).map(record => {
  const documents = record.documents.map(document => {
    const identity = `${record.name}@${record.version}/${document.name}`;
    return `Document: ${document.name}\nLicense source: ${document.source ?? record.source}\n\n===== BEGIN LICENSE ${identity} sha256:${digest(document.body)} =====\n${document.body}===== END LICENSE =====`;
  });
  return `${record.name}@${record.version}\nLicense: ${record.license}\nSource: ${record.source}\n\n${documents.join("\n\n")}`;
});
const text = [
  "RunMeter third-party notices",
  "",
  "This file is generated by scripts/generate-third-party-notices.mjs.",
  "It preserves upstream license and notice texts, including their copyright holders and public contact details.",
  "RunMeter's own code license and reserved branding terms are separate; see LICENSE and BRANDING_LICENSE.md.",
  "",
  "Scope: installed non-development packages recorded by package-lock.json (Web runtime/server/CSS dependencies),",
  "plus Tailwind CSS and shadcn, whose CSS source files are imported directly into the distributed stylesheet,",
  "Next.js precompiled vendor notices, and the Geist/Geist Mono font licenses used by next/font/google.",
  "This is a conservative package-level inventory, not a claim that every listed module is present in every browser chunk.",
  "Development-only tools, including the JavaScript build-tool dependencies of those CSS sources, are excluded.",
  "It does not cover independently packaged Electron/Chromium/Node runtimes or Desktop's bundled helpers.",
  "Those runtimes and helpers have separate notices shipped with the Windows distribution.",
  "The native @next/swc-* compiler packages are build-only and are excluded from this Web runtime notice inventory.",
  "@next/env and client-only use the MIT licenses of their Next.js and React parent projects; those published marker/environment packages omit standalone license files.",
  "Platform-specific optional packages absent from this installation are not included below. Regenerate on the target platform when distributing its binaries.",
  "",
  "Optional packages absent from this installation:",
  ...skipped.sort().map(name => `- ${name}`),
  "",
  ...sections,
  "",
].join("\n");
if (process.argv.includes("--check")) {
  if (!existsSync(outputPath) || canonical(readFileSync(outputPath, "utf8")) !== text) {
    throw new Error("Third-party notices are stale. Run the notice generator after installing the lockfile's dependencies.");
  }
  console.log(`Third-party notices verified (${records.length} records).`);
} else {
  writeFileSync(outputPath, text, "utf8");
  console.log(`Generated THIRD_PARTY_NOTICES.txt (${records.length} records).`);
}
