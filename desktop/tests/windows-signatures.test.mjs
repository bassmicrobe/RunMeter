import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(desktop, "scripts/verify-windows-signatures.ps1");
const windows = process.platform === "win32";

function powershell(source, executable = "powershell.exe") {
  return spawnSync(executable, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `$ErrorActionPreference = 'Stop'\n${source}`,
  ], {
    encoding: "utf8",
    env: { ...process.env, RUNMETER_SIGNATURE_POLICY_TEST_SCRIPT: script },
    timeout: 30_000,
  });
}

test("signature policy accepts timestamped code signatures and preserves vendor identities", { skip: !windows }, () => {
  const result = powershell(`
    . $env:RUNMETER_SIGNATURE_POLICY_TEST_SCRIPT
    function New-TestSignature {
      [pscustomobject]@{
        Status = 'Valid'
        SignerCertificate = [pscustomobject]@{ Subject = 'CN=RunMeter Test, O=Example, C=JP'; Extensions = @([pscustomobject]@{ Oid = [pscustomobject]@{Value='2.5.29.37'}; EnhancedKeyUsages = @([pscustomobject]@{Value='1.3.6.1.5.5.7.3.3'}) }) }
        TimeStamperCertificate = [pscustomobject]@{ Extensions = @([pscustomobject]@{ Oid = [pscustomobject]@{Value='2.5.29.37'}; EnhancedKeyUsages = @([pscustomobject]@{Value='1.3.6.1.5.5.7.3.8'}) }) }
      }
    }
    $signature = New-TestSignature
    Assert-RunMeterSignaturePolicy $signature 'CN=RunMeter Test, O=Example, C=JP' $true
    Assert-RunMeterSignaturePolicy $signature 'CN=Different Vendor' $false
    Write-Output 'policy-passed'
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "policy-passed");
});

test("signature policy rejects unsigned, invalid, unstamped, wrong-purpose and wrong-publisher releases", { skip: !windows }, () => {
  const result = powershell(`
    . $env:RUNMETER_SIGNATURE_POLICY_TEST_SCRIPT
    function New-TestSignature {
      [pscustomobject]@{
        Status = 'Valid'
        SignerCertificate = [pscustomobject]@{ Subject = 'CN=RunMeter Test, O=Example, C=JP'; Extensions = @([pscustomobject]@{ Oid = [pscustomobject]@{Value='2.5.29.37'}; EnhancedKeyUsages = @([pscustomobject]@{Value='1.3.6.1.5.5.7.3.3'}) }) }
        TimeStamperCertificate = [pscustomobject]@{ Extensions = @([pscustomobject]@{ Oid = [pscustomobject]@{Value='2.5.29.37'}; EnhancedKeyUsages = @([pscustomobject]@{Value='1.3.6.1.5.5.7.3.8'}) }) }
      }
    }
    $rejected = 0
    foreach ($scenario in @('unsigned', 'invalid', 'no-signer', 'no-timestamp', 'wrong-code-purpose', 'wrong-timestamp-purpose', 'wrong-publisher', 'case-mismatch')) {
      $signature = New-TestSignature
      switch ($scenario) {
        'unsigned' { $signature.Status = 'NotSigned' }
        'invalid' { $signature.Status = 'HashMismatch' }
        'no-signer' { $signature.SignerCertificate = $null }
        'no-timestamp' { $signature.TimeStamperCertificate = $null }
        'wrong-code-purpose' { $signature.SignerCertificate.Extensions[0].EnhancedKeyUsages[0].Value = '1.3.6.1.5.5.7.3.1' }
        'wrong-timestamp-purpose' { $signature.TimeStamperCertificate.Extensions[0].EnhancedKeyUsages[0].Value = '1.3.6.1.5.5.7.3.3' }
        'wrong-publisher' { $signature.SignerCertificate.Subject = 'CN=Other Vendor' }
        'case-mismatch' { $signature.SignerCertificate.Subject = 'CN=runmeter test, O=Example, C=JP' }
      }
      try { Assert-RunMeterSignaturePolicy $signature 'CN=RunMeter Test, O=Example, C=JP' $true }
      catch { $rejected++ }
    }
    if ($rejected -ne 8) { throw 'A bad signature was accepted.' }
    Write-Output 'eight-rejected'
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "eight-rejected");
});

test("archive policy rejects escaped paths and missing updater, stub or bridge runtime", { skip: !windows }, () => {
  const result = powershell(`
    . $env:RUNMETER_SIGNATURE_POLICY_TEST_SCRIPT
    $root = Join-Path ([IO.Path]::GetTempPath()) 'RunMeter-test-only'
    $null = Get-RunMeterArchivePath $root 'lib/net45/RunMeter.exe'
    $rejected = 0
    foreach ($path in @('../escape.exe', '/absolute.exe', 'C:/absolute.exe', 'lib/net45/../../../../escape.exe', 'lib/./file.exe')) {
      try { $null = Get-RunMeterArchivePath $root $path } catch { $rejected++ }
    }
    $required = @('RunMeter.exe', 'RunMeter_ExecutionStub.exe', 'squirrel.exe', 'resources/bridge/node.exe')
    Assert-RunMeterRequiredFiles $required
    foreach ($omitted in $required) {
      try { Assert-RunMeterRequiredFiles @($required | Where-Object { $_ -ne $omitted }) } catch { $rejected++ }
    }
    if ($rejected -ne 9) { throw 'An unsafe or incomplete archive was accepted.' }
    Write-Output 'archive-policy-passed'
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "archive-policy-passed");
});

test("verification fails closed when signing configuration is missing", { skip: !windows }, () => {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
  ], {
    encoding: "utf8",
    env: { ...process.env, RUNMETER_SIGNING_PUBLISHER: "", RUNMETER_SIGNTOOL_PATH: "" },
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /signature verification failed/);
});

// A pristine checkout has no installer; when present, the current unsigned
// preview must be rejected by actual Windows trust validation without signing.
const setup = resolve(desktop, "out/make/squirrel.windows/x64/RunMeterSetup.exe");
test("actual unsigned preview installer cannot pass release verification", { skip: !windows || !existsSync(setup) }, (t) => {
  const inspection = powershell(`
    . $env:RUNMETER_SIGNATURE_POLICY_TEST_SCRIPT
    $signature = Get-AuthenticodeSignature -LiteralPath '${setup.replaceAll("'", "''")}'
    Write-Output ([string]$signature.Status)
  `);
  assert.equal(inspection.status, 0);
  assert.equal(inspection.stderr, "");
  if (inspection.stdout.trim() !== "NotSigned") {
    t.skip("The locally built installer already has a signature.");
    return;
  }
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-SignToolPath", resolve(desktop, "node_modules/@electron/windows-sign/vendor/signtool.exe"),
    "-Publisher", "CN=RunMeter Test, O=Example, C=JP",
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /signature verification failed/);
  assert.doesNotMatch(result.stderr, /CN=RunMeter Test/);
});

const der = (tag, ...content) => {
  const body = Buffer.concat(content);
  assert.ok(body.length < 128, "Small fixtures use DER short lengths.");
  return Buffer.concat([Buffer.from([tag, body.length]), body]);
};
const sequence = (...content) => der(0x30, ...content);
const sha256Oid = der(6, Buffer.from("608648016503040201", "hex"));
const digestInfo = (oid = sha256Oid, bytes = 32) => sequence(sequence(oid, der(5)), der(4, Buffer.alloc(bytes)));
const fileDigest = (oid, bytes) => sequence(sequence(), digestInfo(oid, bytes));
const timestampImprint = (oid, bytes) => sequence(der(2, Buffer.from([1])), der(6, Buffer.from([0x2a, 3])), digestInfo(oid, bytes));

test("file digest and RFC3161 imprint parsing reject SHA1, malformed and truncated content", { skip: !windows }, () => {
  const valid = [fileDigest(), timestampImprint()];
  const sha1 = der(6, Buffer.from("2b0e03021a", "hex"));
  const invalid = [
    fileDigest(sha1), fileDigest(sha256Oid, 31), timestampImprint(sha1), timestampImprint(sha256Oid, 31),
    fileDigest().subarray(0, -1), Buffer.from([0x30, 0x80, 0, 0]),
  ];
  const decode = (value) => `[Convert]::FromBase64String('${value.toString("base64")}')`;
  const result = powershell(`
    . $env:RUNMETER_SIGNATURE_POLICY_TEST_SCRIPT
    Initialize-RunMeterDigestReader
    [RunMeterSignatureVerification.PeSignaturePolicy]::AssertDigestContent((${decode(valid[0])}), $false)
    [RunMeterSignatureVerification.PeSignaturePolicy]::AssertDigestContent((${decode(valid[1])}), $true)
    $rejected = 0
    ${invalid.map((value, index) => `try { [RunMeterSignatureVerification.PeSignaturePolicy]::AssertDigestContent((${decode(value)}), $${index === 2 || index === 3 ? "true" : "false"}) } catch { $rejected++ }`).join("\n")}
    if ($rejected -ne 6) { throw 'An invalid digest was accepted.' }
    Write-Output 'digest-policy-passed'
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "digest-policy-passed");
});

const vendorNode = resolve(desktop, "node_modules/node-win-x64/bin/node.exe");
for (const executable of ["powershell.exe", "pwsh.exe"]) {
  test(`actual Node.js SHA256 Authenticode and RFC3161 parsing works in ${executable}`, { skip: !windows || !existsSync(vendorNode) }, (t) => {
    const result = powershell(`
      . $env:RUNMETER_SIGNATURE_POLICY_TEST_SCRIPT
      Initialize-RunMeterDigestReader
      [RunMeterSignatureVerification.PeSignaturePolicy]::Verify('${vendorNode.replaceAll("'", "''")}')
      Write-Output 'vendor-format-passed'
    `, executable);
    if (result.error?.code === "ENOENT" && executable === "pwsh.exe") {
      t.skip("PowerShell 7 is not installed.");
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), "vendor-format-passed");
  });
}

const version = JSON.parse(readFileSync(resolve(desktop, "package.json"), "utf8")).version.split("+")[0];
const [coreVersion, prerelease] = version.split("-", 2);
const nugetVersion = coreVersion + (prerelease ? `-${prerelease.replaceAll(".", "")}` : "");
const releasePackage = resolve(desktop, `out/make/squirrel.windows/x64/RunMeterDesktop-${nugetVersion}-full.nupkg`);
test("actual Setup resources contain the exact final package and updater (archive-only fixture)", { skip: !windows || !existsSync(setup) || !existsSync(releasePackage) }, () => {
  // Stub only the binary-trust function in this isolated PowerShell test process.
  // Production has no skip-signature switch. The tests above cover real trust
  // rejection and signature policy; this fixture exercises PE-resource reading,
  // ZIP layout, required executables, both manifests and full-package SHA hashes.
  const result = powershell(`
    . $env:RUNMETER_SIGNATURE_POLICY_TEST_SCRIPT
    $script:checks = @()
    function Assert-RunMeterBinarySignature {
      param([string]$Path, [string]$ExpectedSubject, [bool]$RequirePublisher, [string]$Tool)
      $script:checks += [pscustomobject]@{ Name = [IO.Path]::GetFileName($Path); Own = $RequirePublisher }
    }
    $result = Invoke-RunMeterWindowsSignatureVerification '${setup.replaceAll("'", "''")}' '${releasePackage.replaceAll("'", "''")}' '${resolve(desktop, "node_modules/@electron/windows-sign/vendor/signtool.exe").replaceAll("'", "''")}' 'CN=Test' ''
    $report = $result | ConvertFrom-Json
    if (-not $report.embeddedPackageMatches -or -not $report.embeddedUpdaterVerified -or -not $report.releaseManifestMatches) { throw 'Release archive fixture failed.' }
    foreach ($name in @('RunMeterSetup.exe', 'RunMeter.exe', 'RunMeter_ExecutionStub.exe', 'squirrel.exe', 'Update.exe')) {
      if (@($script:checks | Where-Object { $_.Name -ceq $name -and $_.Own }).Count -ne 1) { throw 'A company executable did not enforce the publisher.' }
    }
    if (@($script:checks | Where-Object { $_.Name -ceq 'node.exe' -and -not $_.Own }).Count -ne 1) { throw 'The vendor signature was not preserved.' }
    Write-Output 'archive-fixture-passed'
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "archive-fixture-passed");
});
