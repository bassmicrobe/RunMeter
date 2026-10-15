import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const maximumFileSize = 32 * 1024 * 1024;

export function git(root, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
  } catch {
    // Git diagnostics can include a local path, URL, or account identity.
    throw new Error("Git operation failed; no command output was disclosed.");
  }
}

export function isWithin(parent, child) {
  const local = relative(parent, child);
  return local !== "" && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

export function assertNoSymlink(path) {
  let current = resolve(path);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("Symbolic links and directory junctions are not allowed.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
}

export function collectPublicFiles(root) {
  const canonicalRoot = realpathSync(root);
  const candidates = [...new Set(git(canonicalRoot, [
    "ls-files", "--cached", "--others", "--exclude-standard", "-z",
  ]).split("\0").filter(Boolean))];
  let ignored = new Set();
  if (candidates.length > 0) {
    // --no-index also excludes accidentally tracked files now covered by ignore rules.
    let result;
    try {
      result = execFileSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
        cwd: canonicalRoot,
        input: `${candidates.join("\0")}\0`,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      if (error.status !== 1) throw new Error("Could not check ignored files.");
      result = error.stdout ?? "";
    }
    ignored = new Set(result.split("\0").filter(Boolean));
  }
  const files = [];
  for (const file of candidates) {
    const segments = file.split(/[\\/]/);
    if (isAbsolute(file) || segments.some((part) => part === ".." || part.toLowerCase() === ".git")) {
      throw new Error("A source file escapes the repository or uses a reserved Git path.");
    }
    const source = resolve(canonicalRoot, file);
    if (!isWithin(canonicalRoot, source)) throw new Error("A source file escapes the repository.");
    if (ignored.has(file)) continue;
    let stats;
    try {
      stats = lstatSync(source);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    assertNoSymlink(source);
    if (!stats.isFile()) throw new Error("Only regular source files can be exported.");
    if (stats.size > maximumFileSize) throw new Error("An oversized file needs manual review before export.");
    files.push({ file, source });
  }
  return files.sort((a, b) => a.file.localeCompare(b.file, "en"));
}

const patterns = [
  ["private-key", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g],
  ["provider-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{32,}|npm_[A-Za-z0-9]{36,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|GOCSPX-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g],
  ["personal-path", /(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+|\/Users\/[^/\s"'<>]+|\/home\/[^/\s"'<>]+)/gi],
  ["email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
];

function isExamplePath(value) {
  const user = value.split(/[\\/]+/).at(-1);
  return /^(?:Public|Default|user|test[-_]?user|private|private-user|test-account|example|runmeter-test)$/i.test(user);
}

function isExampleEmail(value) {
  return /@(?:users\.noreply\.github\.com|github\.com|example\.(?:com|org|net|invalid)|[^@]+\.(?:test|invalid|example))$/i.test(value);
}

function withoutUrlUserInfo(text) {
  // URL userinfo such as user:password@host is not an email address.
  // Only remove userinfo from URL authorities; query strings and other text remain scanned.
  return text.replace(/\b(?:https?|git\+(?:https?|ssh)):\/\/[^\s"'`<>]+/gi, (value) => {
    const match = /^([^:]+:\/\/)([^/?#]*)([\s\S]*)$/.exec(value);
    if (!match) return value;
    const separator = match[2].lastIndexOf("@");
    return separator < 0 ? value : `${match[1]}${match[2].slice(separator + 1)}${match[3]}`;
  });
}

function isKnownSyntheticCredential(file, value) {
  const localFile = file.replace(/^commit:[a-f0-9]+:/, "").replaceAll("\\", "/");
  // This single fixed alphabet-sequence fixture verifies that credential-like values
  // are rejected from Gemini snapshots. The full value stays out of audit output.
  return localFile === "relay/tests/gemini-api.test.ts" &&
    createHash("sha256").update(value).digest("hex") ===
      "87353204333d35db7a69cf8eaae460a2460dca03670f9d2866e6fa395a6adf5a";
}

export function inspectText(file, text, { localUser = basename(homedir()) } = {}) {
  const findings = [];
  for (const [kind, expression] of patterns) {
    let matches = [...(kind === "email" ? withoutUrlUserInfo(text) : text).matchAll(expression)];
    if (kind === "provider-token") matches = matches.filter((match) => !isKnownSyntheticCredential(file, match[0]));
    if (kind === "personal-path") matches = matches.filter((match) => !isExamplePath(match[0]));
    if (kind === "email") {
      // npm lockfile metadata includes third-party maintainer contacts and git@github.com.
      if (basename(file) === "package-lock.json") continue;
      matches = matches.filter((match) => !isExampleEmail(match[0]));
    }
    if (matches.length > 0) findings.push({ file, kind, count: matches.length });
  }
  if (localUser.length >= 4 && !isExamplePath(localUser)) {
    const count = text.toLowerCase().split(localUser.toLowerCase()).length - 1;
    if (count > 0) findings.push({ file, kind: "local-user-name", count });
  }
  return findings;
}

export function inspectPublicFiles(files) {
  return files.flatMap(({ file, source }) => inspectText(file, readFileSync(source).toString("utf8")));
}

export function printFindings(findings) {
  for (const finding of findings) process.stdout.write(`${JSON.stringify(finding)}\n`);
}
