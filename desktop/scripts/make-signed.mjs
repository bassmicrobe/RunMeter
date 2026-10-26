import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import signing from "./windows-signing.cjs";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function runCommand(file, args, env) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(file, args, {
      cwd: desktopDirectory, env, stdio: "inherit", windowsHide: true,
    });
    child.on("error", () => reject(new Error("Required signing/build tool could not be started.")));
    child.on("exit", (code) => code === 0 ? resolveCommand() :
      reject(new Error("Signing/build verification failed; no release was produced.")));
  });
}

export async function withSigningMetadata(config, env, action) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "RunMeter-signing-"));
  const metadataFile = join(temporaryDirectory, "metadata.json");
  try {
    await writeFile(metadataFile, JSON.stringify(signing.createSigningMetadata(config)), { mode: 0o600, flag: "wx" });
    return await action({ ...env, RUNMETER_SIGNING_REQUIRED: "1", RUNMETER_SIGNING_METADATA_FILE: metadataFile });
  } finally {
    // This exact directory was created by mkdtemp above, never taken from env/input.
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runSignedBuild({ env = process.env, platform = process.platform, run = runCommand, checkOnly = false } = {}) {
  if (platform !== "win32") throw new Error("Windows x64 is required for Artifact Signing builds.");
  const config = signing.readSigningConfig(env);
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(desktopDirectory, "scripts", "signing-preflight.ps1")], env);
  if (checkOnly) {
    process.stdout.write("Artifact Signing prerequisites passed. No files were signed.\n");
    return;
  }
  const npmCli = env.npm_execpath;
  if (!npmCli || !isNpmCli(npmCli)) throw new Error("Run via npm run desktop:make:signed.");
  await withSigningMetadata(config, env, async (signedEnv) => {
    const startedAt = Date.now();
    await run(process.execPath, [npmCli, "run", "make"], signedEnv);
    const { version } = JSON.parse(await readFile(join(desktopDirectory, "package.json"), "utf8"));
    const output = join(desktopDirectory, "out", "make", "squirrel.windows", "x64");
    for (const file of ["RunMeterSetup.exe", `RunMeterDesktop-${signing.toSquirrelVersion(version)}-full.nupkg`, "RELEASES"]) {
      if ((await stat(join(output, file))).mtimeMs < startedAt) {
        throw new Error("Installer output is stale; refusing to validate an earlier build.");
      }
    }
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(desktopDirectory, "scripts", "verify-windows-signatures.ps1")], signedEnv);
  });
}

function isNpmCli(file) {
  return /(?:^|[/\\])npm-cli\.js$/i.test(file);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    process.stderr.write("Usage: make-signed.mjs [--check]\n");
    process.exitCode = 1;
  } else {
    try {
      await runSignedBuild({ checkOnly: args.includes("--check") });
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
