const { readFileSync, statSync } = require("node:fs");
const { basename, isAbsolute } = require("node:path");

const settingNames = [
  "RUNMETER_SIGNING_ENDPOINT",
  "RUNMETER_SIGNING_ACCOUNT",
  "RUNMETER_SIGNING_PROFILE",
  "RUNMETER_SIGNING_PUBLISHER",
  "RUNMETER_SIGNTOOL_PATH",
  "RUNMETER_SIGNING_DLIB_PATH",
];
const conflictingNames = [
  "RUNMETER_WINDOWS_CERTIFICATE_FILE",
  "RUNMETER_WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_CERTIFICATE_FILE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "WINDOWS_SIGN_WITH_PARAMS",
  "WINDOWS_SIGN_HOOK_MODULE_PATH",
  "WINDOWS_SIGN_JAVASCRIPT",
];
const regions = new Set([
  "brs", "cus", "eus", "jpe", "krc", "ncus", "neu", "plc", "scus",
  "swn", "wcus", "weu", "wus", "wus2", "wus3",
]);

function assertNoConflictingSettings(env) {
  for (const name of conflictingNames) {
    if (env[name]) throw new Error(`Remove ${name}; RunMeter uses Azure Artifact Signing only.`);
  }
}

function assertX64Tool(file, expectedName, settingName) {
  if (!isAbsolute(file) || basename(file).toLowerCase() !== expectedName) {
    throw new Error(`${settingName} must be an absolute path to ${expectedName}.`);
  }
  try {
    if (!statSync(file).isFile()) throw new Error();
    const bytes = readFileSync(file);
    if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error();
    const pe = bytes.readUInt32LE(0x3c);
    if (pe > bytes.length - 6 || bytes.readUInt32LE(pe) !== 0x00004550 ||
        bytes.readUInt16LE(pe + 4) !== 0x8664) throw new Error();
  } catch {
    throw new Error(`${settingName} must point to an existing x64 Windows binary.`);
  }
}

function readSigningConfig(env = process.env) {
  assertNoConflictingSettings(env);
  for (const name of settingNames) {
    if (!env[name]?.trim()) throw new Error(`Set ${name}; see docs/WINDOWS_SIGNING.md.`);
  }
  let endpoint;
  try {
    endpoint = new URL(env.RUNMETER_SIGNING_ENDPOINT);
  } catch {
    throw new Error("RUNMETER_SIGNING_ENDPOINT must be an official HTTPS signing endpoint.");
  }
  const region = endpoint.hostname.replace(/\.codesigning\.azure\.net$/, "");
  if (endpoint.protocol !== "https:" || !regions.has(region) ||
      endpoint.hostname !== `${region}.codesigning.azure.net` || endpoint.port ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== "/") {
    throw new Error("RUNMETER_SIGNING_ENDPOINT must be an official HTTPS signing endpoint.");
  }
  for (const name of ["RUNMETER_SIGNING_ACCOUNT", "RUNMETER_SIGNING_PROFILE"]) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(env[name])) throw new Error(`${name} is not a valid resource name.`);
  }
  const publisher = env.RUNMETER_SIGNING_PUBLISHER;
  if (publisher.length > 1024 || /[\r\n\0]/.test(publisher) || !/(?:^|,\s*)CN=.+/.test(publisher)) {
    throw new Error("RUNMETER_SIGNING_PUBLISHER must be the approved certificate's full Subject.");
  }
  assertX64Tool(env.RUNMETER_SIGNTOOL_PATH, "signtool.exe", "RUNMETER_SIGNTOOL_PATH");
  assertX64Tool(env.RUNMETER_SIGNING_DLIB_PATH, "azure.codesigning.dlib.dll", "RUNMETER_SIGNING_DLIB_PATH");
  return {
    endpoint: endpoint.origin,
    account: env.RUNMETER_SIGNING_ACCOUNT,
    profile: env.RUNMETER_SIGNING_PROFILE,
    publisher,
    signToolPath: env.RUNMETER_SIGNTOOL_PATH,
    dlibPath: env.RUNMETER_SIGNING_DLIB_PATH,
  };
}

function createSigningMetadata(config) {
  return {
    Endpoint: config.endpoint,
    CodeSigningAccountName: config.account,
    CertificateProfileName: config.profile,
    // Local az login and CI azure/login (OIDC) both expose AzureCliCredential.
    // Do not fall back to a developer's other tenants or embedded credentials.
    ExcludeCredentials: [
      "EnvironmentCredential", "WorkloadIdentityCredential", "ManagedIdentityCredential",
      "SharedTokenCacheCredential", "VisualStudioCredential", "VisualStudioCodeCredential",
      "AzurePowerShellCredential", "AzureDeveloperCliCredential", "InteractiveBrowserCredential",
    ],
  };
}

function toSquirrelVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error("Unexpected desktop version.");
  }
  const [main, ...prerelease] = version.split("+")[0].split("-");
  return prerelease.length ? `${main}-${prerelease.join("-").replaceAll(".", "")}` : main;
}

function getWindowsSignOptions(env = process.env) {
  assertNoConflictingSettings(env);
  const enabled = env.RUNMETER_SIGNING_REQUIRED === "1";
  if (!env.RUNMETER_SIGNING_REQUIRED && !settingNames.some((name) => env[name]) && !env.RUNMETER_SIGNING_METADATA_FILE) {
    return undefined;
  }
  if (!enabled || !env.RUNMETER_SIGNING_METADATA_FILE) {
    throw new Error("Use npm run desktop:make:signed; signing settings cannot silently produce an unsigned build.");
  }
  const config = readSigningConfig(env);
  const metadataFile = env.RUNMETER_SIGNING_METADATA_FILE;
  try {
    if (!isAbsolute(metadataFile) ||
        JSON.stringify(JSON.parse(readFileSync(metadataFile, "utf8"))) !==
        JSON.stringify(createSigningMetadata(config))) throw new Error();
  } catch {
    throw new Error("Signing metadata is missing or differs from the validated configuration.");
  }
  return {
    signToolPath: config.signToolPath,
    hashes: ["sha256"],
    automaticallySelectCertificate: false,
    timestampServer: "http://timestamp.acs.microsoft.com",
    description: "RunMeter",
    website: "https://cybereye-tech.jp/",
    // Pass an array so paths containing spaces remain single arguments.
    // The installed windows-sign hook API swallows failures; use SignTool directly.
    signWithParams: ["/dlib", config.dlibPath, "/dmdf", metadataFile],
  };
}

module.exports = { readSigningConfig, createSigningMetadata, getWindowsSignOptions, toSquirrelVersion };
