import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Never replace, authenticate with or stop a Relay already used by this machine.
const portProbe = createServer();
await new Promise((accept, reject) => {
  portProbe.once("error", () =>
    reject(
      new Error(
        "Port 47831 is in use. Close your Relay before running this isolated desktop check.",
      ),
    ),
  );
  portProbe.listen(47831, "127.0.0.1", () => portProbe.close(accept));
});

const directory = mkdtempSync(join(tmpdir(), "runmeter-desktop-test-"));
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const environment = {
  ...process.env,
  RUNMETER_DATA_DIR: join(directory, "relay"),
  RUNMETER_SMOKE_USER_DATA: join(directory, "browser"),
  RUNMETER_SMOKE_RESULT: join(directory, "result.json"),
};
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require("electron"),
  [
    resolve(scriptsDirectory, "desktop-smoke-app.mjs"),
    "--hidden",
    "--no-auto-start",
  ],
  {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  },
);
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const timeout = setTimeout(() => child.kill(), 60_000);

try {
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  const result = existsSync(environment.RUNMETER_SMOKE_RESULT)
    ? readFileSync(environment.RUNMETER_SMOKE_RESULT, "utf8")
    : stdout;
  process.stdout.write(`${result}\n`);
  if (code !== 0 || !result.includes('"passed":true')) {
    process.stderr.write(stderr);
    throw new Error(`Desktop smoke check failed (${code}).`);
  }
} finally {
  clearTimeout(timeout);
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
