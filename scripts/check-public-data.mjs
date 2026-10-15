import { fileURLToPath } from "node:url";
import {
  collectPublicFiles,
  git,
  inspectPublicFiles,
  inspectText,
  printFindings,
} from "./public-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

try {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--history")) {
    throw new Error("Usage: node scripts/check-public-data.mjs [--history]");
  }
  const files = collectPublicFiles(root);
  const findings = inspectPublicFiles(files);
  let commitCount = 0;
  if (arguments_.includes("--history")) {
    const commits = git(root, ["rev-list", "--all"]).trim().split("\n").filter(Boolean);
    const seen = new Set();
    commitCount = commits.length;
    for (const commit of commits) {
      const metadata = git(root, ["show", "-s", "--format=%an%n%ae%n%cn%n%ce%n%B", commit]);
      findings.push(...inspectText(`commit:${commit.slice(0, 7)}:metadata`, metadata));
      for (const entry of git(root, ["ls-tree", "-r", "-z", commit]).split("\0").filter(Boolean)) {
        const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/.exec(entry);
        if (!match || seen.has(match[1])) continue;
        seen.add(match[1]);
        const contents = git(root, ["cat-file", "blob", match[1]]);
        findings.push(...inspectText(`commit:${commit.slice(0, 7)}:${match[2]}`, contents));
      }
    }
  }
  printFindings(findings);
  process.stdout.write(`${JSON.stringify({ files: files.length, commits: commitCount, findings: findings.length })}\n`);
  if (findings.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.code ? "Public data inspection failed because of a filesystem operation." : error.message}\n`);
  process.exitCode = 1;
}
