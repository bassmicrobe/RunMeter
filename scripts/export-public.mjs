import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoSymlink,
  collectPublicFiles,
  git,
  inspectPublicFiles,
  isWithin,
  printFindings,
} from "./public-files.mjs";

export function exportPublic({ root, destination, initialize = false }) {
  if (!destination) throw new Error("An explicit, previously nonexistent destination is required.");
  const sourceRoot = realpathSync(root);
  const targetRoot = resolve(sourceRoot, destination);
  if (targetRoot === sourceRoot || isWithin(targetRoot, sourceRoot)) {
    throw new Error("The destination cannot be the repository or one of its parents.");
  }
  if (targetRoot.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) {
    throw new Error("A destination inside a Git metadata directory is not allowed.");
  }
  assertNoSymlink(targetRoot);
  if (existsSync(targetRoot)) throw new Error("The destination already exists; no files were changed.");
  if (isWithin(sourceRoot, targetRoot)) {
    const localTarget = relative(sourceRoot, targetRoot).split(sep).join("/");
    try {
      execFileSync("git", ["check-ignore", "--no-index", "-q", "--", localTarget], {
        cwd: sourceRoot,
        stdio: "pipe",
      });
    } catch {
      throw new Error("A destination inside the repository must be ignored, for example .public-release/RunMeter.");
    }
  }
  const files = collectPublicFiles(sourceRoot);
  const findings = inspectPublicFiles(files);
  if (findings.length > 0) {
    printFindings(findings);
    throw new Error("Public data inspection failed; the destination was not created.");
  }
  mkdirSync(dirname(targetRoot), { recursive: true });
  assertNoSymlink(dirname(targetRoot));
  mkdirSync(targetRoot);
  for (const { file, source } of files) {
    const target = resolve(targetRoot, file);
    if (!isWithin(targetRoot, target)) throw new Error("A target file escapes the export directory.");
    assertNoSymlink(source);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
  if (initialize) {
    const identity = "RunMeter contributors";
    const email = "noreply@example.invalid";
    const config = [
      "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgsign=false",
      "-c", "tag.gpgsign=false",
      "-c", `user.name=${identity}`,
      "-c", `user.email=${email}`,
    ];
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
    }
    Object.assign(environment, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: identity,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: identity,
      GIT_COMMITTER_EMAIL: email,
    });
    const run = (arguments_) => git(targetRoot, [...config, ...arguments_], { env: environment });
    // An explicit empty template prevents inherited hooks and local paths.
    run(["init", "--initial-branch=main", "--template="]);
    run(["config", "--local", "user.name", identity]);
    run(["config", "--local", "user.email", email]);
    run(["config", "--local", "commit.gpgsign", "false"]);
    run(["add", "--all"]);
    run(["commit", "--no-verify", "-m", "Initial public source snapshot"]);
  }
  return { files: files.length, initialized: initialize };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const arguments_ = process.argv.slice(2);
    const destinationIndex = arguments_.indexOf("--destination");
    const destination = destinationIndex >= 0 ? arguments_[destinationIndex + 1] : null;
    const expected = destination ? ["--destination", destination, ...(arguments_.includes("--init") ? ["--init"] : [])] : [];
    if (!destination || destination.startsWith("--") || arguments_.length !== expected.length ||
      arguments_.some((argument) => !expected.includes(argument))) {
      throw new Error("Usage: node scripts/export-public.mjs --destination <new-directory> [--init]");
    }
    const result = exportPublic({
      root: fileURLToPath(new URL("../", import.meta.url)),
      destination,
      initialize: arguments_.includes("--init"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Avoid disclosing native filesystem errors containing local paths.
    const message = error.code ? "Export failed because of a filesystem operation. No existing destination was overwritten." : error.message;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
