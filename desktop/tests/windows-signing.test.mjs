import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import signing from "../scripts/windows-signing.cjs";
import { runSignedBuild, withSigningMetadata } from "../scripts/make-signed.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "RunMeter-signing-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const header = Buffer.alloc(128);
  header.writeUInt16LE(0x5a4d, 0);
  header.writeUInt32LE(64, 0x3c);
  header.writeUInt32LE(0x00004550, 64);
  header.writeUInt16LE(0x8664, 68);
  for (const name of ["signtool.exe", "Azure.CodeSigning.Dlib.dll"]) {
    await writeFile(join(directory, name), header);
  }
  return {
    RUNMETER_SIGNING_ENDPOINT: "https://jpe.codesigning.azure.net/",
    RUNMETER_SIGNING_ACCOUNT: "example-signing-account",
    RUNMETER_SIGNING_PROFILE: "example-public-trust",
    RUNMETER_SIGNING_PUBLISHER: "CN=EXAMPLE ORGANIZATION, O=EXAMPLE ORGANIZATION, C=JP",
    RUNMETER_SIGNTOOL_PATH: join(directory, "signtool.exe"),
    RUNMETER_SIGNING_DLIB_PATH: join(directory, "Azure.CodeSigning.Dlib.dll"),
    npm_execpath: join(directory, "npm-cli.js"),
  };
}

test("unsigned development builds need no Azure access; partial signing settings fail closed", async (t) => {
  assert.equal(signing.getWindowsSignOptions({}), undefined);
  const env = await fixture(t);
  assert.throws(() => signing.getWindowsSignOptions(env), /make:signed/);
  assert.throws(() => signing.getWindowsSignOptions({ RUNMETER_SIGNING_REQUIRED: "invalid" }), /make:signed/);
  for (const name of ["RUNMETER_WINDOWS_CERTIFICATE_FILE", "RUNMETER_WINDOWS_CERTIFICATE_PASSWORD",
    "WINDOWS_CERTIFICATE_FILE", "WINDOWS_CERTIFICATE_PASSWORD", "WINDOWS_SIGN_WITH_PARAMS",
    "WINDOWS_SIGN_HOOK_MODULE_PATH", "WINDOWS_SIGN_JAVASCRIPT"]) {
    assert.throws(() => signing.getWindowsSignOptions({ ...env, [name]: "conflicting-setting" }), /Remove/);
  }
  await assert.rejects(runSignedBuild({ env: {}, platform: "win32", run: () => assert.fail("must not start any process") }), /Set RUNMETER/);
});

test("Azure endpoint validation rejects credentials, foreign hosts, paths and query parameters", async (t) => {
  const env = await fixture(t);
  assert.equal(signing.readSigningConfig(env).endpoint, "https://jpe.codesigning.azure.net");
  for (const endpoint of [
    "http://jpe.codesigning.azure.net", "https://jpe.codesigning.azure.net.attacker.test",
    "https://jpe.codesigning.azure.net@attacker.test", "https://user:password@jpe.codesigning.azure.net",
    "https://jpe.codesigning.azure.net:444/", "https://jpe.codesigning.azure.net/path",
    "https://jpe.codesigning.azure.net/?key=example", "https://jpe.codesigning.azure.net/#example",
    "https://unregistered.codesigning.azure.net", "invalid",
  ]) {
    assert.throws(() => signing.readSigningConfig({ ...env, RUNMETER_SIGNING_ENDPOINT: endpoint }), /official HTTPS/);
  }
});

test("both native tools must be real x64 PE files; mismatched architecture and malformed files are rejected", async (t) => {
  const env = await fixture(t);
  const tool = await readFile(env.RUNMETER_SIGNTOOL_PATH);
  tool.writeUInt16LE(0x014c, 68);
  await writeFile(env.RUNMETER_SIGNTOOL_PATH, tool);
  assert.throws(() => signing.readSigningConfig(env), /existing x64/);
  await writeFile(env.RUNMETER_SIGNTOOL_PATH, "invalid executable");
  assert.throws(() => signing.readSigningConfig(env), /existing x64/);
  assert.throws(() => signing.readSigningConfig({ ...env, RUNMETER_SIGNTOOL_PATH: "signtool.exe" }), /absolute path/);
});

test("metadata uses Azure CLI only, exact options survive Squirrel JSON transport, and no hook or PFX is configured", async (t) => {
  const env = await fixture(t);
  const config = signing.readSigningConfig(env);
  let metadataFile;
  await withSigningMetadata(config, env, async (signedEnv) => {
    metadataFile = signedEnv.RUNMETER_SIGNING_METADATA_FILE;
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    assert.equal(metadata.CodeSigningAccountName, env.RUNMETER_SIGNING_ACCOUNT);
    assert.ok(metadata.ExcludeCredentials.includes("EnvironmentCredential"));
    assert.ok(!metadata.ExcludeCredentials.includes("AzureCliCredential"));
    const options = JSON.parse(JSON.stringify(signing.getWindowsSignOptions(signedEnv)));
    assert.deepEqual(options.hashes, ["sha256"]);
    assert.equal(options.timestampServer, "http://timestamp.acs.microsoft.com");
    assert.equal(options.automaticallySelectCertificate, false);
    assert.deepEqual(options.signWithParams, ["/dlib", env.RUNMETER_SIGNING_DLIB_PATH, "/dmdf", metadataFile]);
    for (const name of ["hookFunction", "hookModulePath", "certificateFile", "certificatePassword"]) assert.ok(!(name in options));
    await writeFile(metadataFile, JSON.stringify({ ...metadata, ExcludeCredentials: [] }));
    assert.throws(() => signing.getWindowsSignOptions(signedEnv), /differs from/);
  });
  await assert.rejects(access(dirname(metadataFile)), /ENOENT/);
});

test("a failed make halts verification and removes its temporary signing metadata", async (t) => {
  const env = await fixture(t);
  const calls = [];
  let metadataFile;
  await assert.rejects(runSignedBuild({ env, platform: "win32", run: async (file, args, childEnv) => {
    calls.push({ file, args });
    if (calls.length === 1) return;
    metadataFile = childEnv.RUNMETER_SIGNING_METADATA_FILE;
    assert.ok(signing.getWindowsSignOptions(childEnv));
    throw new Error("simulated signer rejection");
  } }), /simulated signer rejection/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].file, process.execPath);
  assert.deepEqual(calls[1].args, [env.npm_execpath, "run", "make"]);
  await assert.rejects(access(dirname(metadataFile)), /ENOENT/);
  assert.equal(env.RUNMETER_SIGNING_METADATA_FILE, undefined);
});

test("check-only performs preflight without signing or making a package", async (t) => {
  const env = await fixture(t);
  const calls = [];
  await runSignedBuild({ env, platform: "win32", checkOnly: true, run: async (file, args) => calls.push({ file, args }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.ok(calls[0].args.at(-1).endsWith("signing-preflight.ps1"));
});

test("the installed Electron SignTool implementation propagates a nonzero tool exit", async () => {
  const require = createRequire(import.meta.url);
  const { sign } = require("@electron/windows-sign");
  // Node receives 'sign' as a nonexistent script and exits; no signing service is called.
  await assert.rejects(sign({
    files: ["not-a-release.exe"], signToolPath: process.execPath,
    hashes: ["sha256"], timestampServer: "http://timestamp.acs.microsoft.com",
  }), /Signtool exited with code/);
});

test("prerelease and build metadata produce the actual Squirrel package filename", () => {
  const require = createRequire(import.meta.url);
  const { convertVersion } = require("electron-winstaller");
  for (const version of ["0.1.0", "0.1.1-preview.1", "0.1.1-alpha-test.2+build.4", "1.0.0+build.4"]) {
    assert.equal(signing.toSquirrelVersion(version), convertVersion(version));
  }
  assert.throws(() => signing.toSquirrelVersion("../untrusted"), /Unexpected desktop version/);
});
