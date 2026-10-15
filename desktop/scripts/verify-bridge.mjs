import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "dist/bridge/node.exe");
const bridgeScript = resolve(process.argv[3] ?? "dist/bridge/index.js");
const dataDirectory = mkdtempSync(join(tmpdir(), "runmeter-bridge-test-"));
const child = spawn(executable, [bridgeScript, "--data-dir", dataDirectory], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
const stdoutChunks = [];
const timeout = setTimeout(() => child.kill(), 10_000);

child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
  stdoutChunks.push(chunk);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.on("error", (error) => {
  clearTimeout(timeout);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  clearTimeout(timeout);
  rmSync(dataDirectory, { recursive: true, force: true });
  process.stdout.write(
    `${JSON.stringify(
      {
        code,
        signal,
        stdout,
        stdoutHex: Buffer.concat(stdoutChunks).toString("hex"),
        stderr,
      },
      null,
      2,
    )}\n`,
  );
  if (code !== 0 || stdout.trim() !== "RunMeter｜5時間 23%・7日 41%") {
    process.exitCode = 1;
  }
});

child.stdin.end(
  JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 23 },
      seven_day: { used_percentage: 41 },
    },
  }),
);
