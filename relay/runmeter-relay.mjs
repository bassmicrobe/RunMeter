#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));
const child = spawn(
  process.execPath,
  ["--experimental-transform-types", serverPath, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

child.on("error", (error) => {
  process.stderr.write(`RunMeter Relayを起動できませんでした: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
