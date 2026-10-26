param(
  [string]$SetupPath,
  [string]$PackagePath,
  [string]$SignToolPath = $env:RUNMETER_SIGNTOOL_PATH,
  [string]$Publisher = $env:RUNMETER_SIGNING_PUBLISHER,
  [string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# A PS 7 parent can pass its module search path to powershell.exe (PS 5.1).
# Load this process's own Security module instead of autoloading an incompatible one.
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
  Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force
}

function Assert-RunMeterSignaturePolicy {
  param($Signature, [string]$ExpectedSubject, [bool]$RequirePublisher)

  if (-not $Signature -or [string]$Signature.Status -ne 'Valid' -or -not $Signature.SignerCertificate) {
    throw 'A release binary has no valid Authenticode signature.'
  }
  if (-not $Signature.TimeStamperCertificate) {
    throw 'A release binary has no trusted timestamp.'
  }
  $codeSigning = @($Signature.SignerCertificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { $_.EnhancedKeyUsages } | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })
  $timestamping = @($Signature.TimeStamperCertificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { $_.EnhancedKeyUsages } | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.8' })
  if ($codeSigning.Count -eq 0 -or $timestamping.Count -eq 0) {
    throw 'A release signature has an unexpected certificate purpose.'
  }
  if ($RequirePublisher -and -not [string]::Equals($Signature.SignerCertificate.Subject, $ExpectedSubject, [StringComparison]::Ordinal)) {
    throw 'A RunMeter binary was signed by an unexpected publisher.'
  }
}

function Assert-RunMeterBinarySignature {
  param([string]$Path, [string]$ExpectedSubject, [bool]$RequirePublisher, [string]$Tool)

  $signature = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
  Assert-RunMeterSignaturePolicy $signature $ExpectedSubject $RequirePublisher
  if ($RequirePublisher) {
    Initialize-RunMeterDigestReader
    [RunMeterSignatureVerification.PeSignaturePolicy]::Verify($Path)
  }
  # /all checks every embedded signature; /tw also warns about missing timestamps.
  # Never print native diagnostics, which may include certificate identities/paths.
  & $Tool verify /pa /all /tw $Path 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'SignTool rejected a release binary.' }
}

function Get-RunMeterArchivePath {
  param([string]$Root, [string]$Name)

  $normal = $Name.Replace('\', '/')
  if (-not $normal -or $normal.StartsWith('/') -or $normal.Contains(':') -or $normal.Split('/') -contains '..' -or $normal.Split('/') -contains '.') {
    throw 'The release archive contains an unsafe path.'
  }
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
  $destination = [IO.Path]::GetFullPath((Join-Path $Root $normal))
  if (-not $destination.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A release archive path escapes its verification directory.'
  }
  return $destination
}

function Assert-RunMeterRequiredFiles {
  param([string[]]$Names)

  foreach ($required in @('RunMeter.exe', 'RunMeter_ExecutionStub.exe', 'squirrel.exe', 'resources/bridge/node.exe')) {
    if ($Names -cnotcontains $required) { throw 'A required executable is missing from the release package.' }
  }
}

function Get-RunMeterStreamHash {
  param([IO.Stream]$Stream, [string]$Algorithm = 'SHA256')

  $hash = [Security.Cryptography.HashAlgorithm]::Create($Algorithm)
  try { return [BitConverter]::ToString($hash.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}

function Save-RunMeterArchiveEntry {
  param($Entry, [string]$Destination)

  if ($Entry.Length -le 0 -or $Entry.Length -gt 1GB) { throw 'A release executable is empty or exceeds the verification limit.' }
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination)) | Out-Null
  $inputStream = $Entry.Open()
  $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $inputStream.CopyTo($outputStream) }
  finally { $outputStream.Dispose(); $inputStream.Dispose() }
}

function Initialize-RunMeterSetupResourceReader {
  if ('RunMeterSignatureVerification.SetupResource' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
namespace RunMeterSignatureVerification {
  public static class SetupResource {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr FindResourceExW(IntPtr module, string type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll")]
    private static extern bool FreeLibrary(IntPtr module);
    public static void SaveZip(string setup, string destination) {
      // LOAD_LIBRARY_AS_DATAFILE: inspect resources without executing the installer.
      var module = LoadLibraryExW(setup, IntPtr.Zero, 2);
      if (module == IntPtr.Zero) throw new InvalidOperationException("Cannot inspect Setup resources.");
      try {
        var resource = FindResourceExW(module, "DATA", new IntPtr(131), 0x0409);
        var length = resource == IntPtr.Zero ? 0 : SizeofResource(module, resource);
        if (length == 0 || length > 1073741824) throw new InvalidOperationException("Setup payload is missing or too large.");
        var pointer = LockResource(LoadResource(module, resource));
        if (pointer == IntPtr.Zero) throw new InvalidOperationException("Cannot read Setup payload.");
        var buffer = new byte[1048576];
        using (var stream = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
          for (int offset = 0; offset < length;) {
            int count = (int)Math.Min((long)buffer.Length, (long)length - offset);
            Marshal.Copy(IntPtr.Add(pointer, offset), buffer, 0, count);
            stream.Write(buffer, 0, count);
            offset += count;
          }
        }
      } finally { FreeLibrary(module); }
    }
  }
}
'@
}

function Initialize-RunMeterDigestReader {
  if ('RunMeterSignatureVerification.PeSignaturePolicy' -as [type]) { return }
  Add-Type -AssemblyName System.Security
  $references = @('System.Security')
  if ($PSVersionTable.PSEdition -eq 'Core') {
    Add-Type -AssemblyName System.Security.Cryptography.Pkcs
    $references = @('System.Runtime', 'System.Security.Cryptography', [Security.Cryptography.Pkcs.SignedCms].Assembly.Location)
  }
  Add-Type -ReferencedAssemblies $references -TypeDefinition @'
using System;
using System.IO;
using System.Security.Cryptography.Pkcs;
namespace RunMeterSignatureVerification {
  public static class PeSignaturePolicy {
    private const string Sha256 = "2.16.840.1.101.3.4.2.1";
    private struct Element { public int Tag, Content, End; }
    private static Element Read(byte[] data, ref int position, int end) {
      if (position < 0 || end > data.Length || position + 2 > end) throw new InvalidOperationException("Invalid signature encoding.");
      int tag = data[position++], length = data[position++];
      if ((length & 128) != 0) {
        int count = length & 127;
        if (count == 0 || count > 4 || position + count > end) throw new InvalidOperationException("Invalid signature length.");
        long value = 0;
        for (int i = 0; i < count; i++) value = (value << 8) | data[position++];
        if (value > int.MaxValue) throw new InvalidOperationException("Signature is too large.");
        length = (int)value;
      }
      if (length < 0 || length > end - position) throw new InvalidOperationException("Truncated signature.");
      var result = new Element { Tag = tag, Content = position, End = position + length };
      position += length;
      return result;
    }
    private static Element Sequence(byte[] data, ref int position, int end) {
      var element = Read(data, ref position, end);
      if (element.Tag != 48) throw new InvalidOperationException("Expected signature sequence.");
      return element;
    }
    // Public for fixture tests: enforce the actual file digest / timestamp message
    // imprint algorithm, not the unrelated certificate issuer signature algorithm.
    public static void AssertDigestContent(byte[] data, bool timestamp) {
      int position = 0;
      var root = Sequence(data, ref position, data.Length);
      if (root.End != data.Length) throw new InvalidOperationException("Unexpected signature content.");
      position = root.Content;
      if (timestamp) {
        var version = Read(data, ref position, root.End);
        var policy = Read(data, ref position, root.End);
        if (version.Tag != 2 || policy.Tag != 6) throw new InvalidOperationException("Invalid RFC3161 timestamp.");
      } else {
        Sequence(data, ref position, root.End); // SpcAttributeTypeAndOptionalValue
      }
      var digestInfo = Sequence(data, ref position, root.End);
      position = digestInfo.Content;
      var algorithm = Sequence(data, ref position, digestInfo.End);
      int algorithmPosition = algorithm.Content;
      var oid = Read(data, ref algorithmPosition, algorithm.End);
      byte[] expected = { 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01 };
      if (oid.Tag != 6 || oid.End - oid.Content != expected.Length) throw new InvalidOperationException("Release signature does not use SHA256.");
      for (int i = 0; i < expected.Length; i++) if (data[oid.Content + i] != expected[i]) throw new InvalidOperationException("Release signature does not use SHA256.");
      var digest = Read(data, ref position, digestInfo.End);
      if (digest.Tag != 4 || digest.End - digest.Content != 32 || position != digestInfo.End) throw new InvalidOperationException("Invalid SHA256 digest.");
    }
    private static void VerifyCms(byte[] signature, int depth) {
      if (depth > 8) throw new InvalidOperationException("Too many nested signatures.");
      var cms = new SignedCms();
      cms.Decode(signature);
      if (cms.ContentInfo.ContentType.Value != "1.3.6.1.4.1.311.2.1.4" || cms.SignerInfos.Count == 0) throw new InvalidOperationException("Invalid Authenticode signature.");
      AssertDigestContent(cms.ContentInfo.Content, false);
      foreach (SignerInfo signer in cms.SignerInfos) {
        if (signer.DigestAlgorithm.Value != Sha256) throw new InvalidOperationException("Release signer does not use SHA256.");
        bool timestamp = false;
        foreach (System.Security.Cryptography.CryptographicAttributeObject attribute in signer.UnsignedAttributes) {
          if (attribute.Oid.Value == "1.3.6.1.4.1.311.3.3.1" || attribute.Oid.Value == "1.2.840.113549.1.9.16.2.14") {
            foreach (System.Security.Cryptography.AsnEncodedData value in attribute.Values) {
              var token = new SignedCms();
              token.Decode(value.RawData);
              if (token.ContentInfo.ContentType.Value != "1.2.840.113549.1.9.16.1.4" || token.SignerInfos.Count == 0) throw new InvalidOperationException("Invalid RFC3161 token.");
              AssertDigestContent(token.ContentInfo.Content, true);
              timestamp = true;
            }
          }
          if (attribute.Oid.Value == "1.3.6.1.4.1.311.2.4.1") {
            foreach (System.Security.Cryptography.AsnEncodedData value in attribute.Values) VerifyCms(value.RawData, depth + 1);
          }
        }
        if (!timestamp) throw new InvalidOperationException("A release signature has no SHA256 RFC3161 timestamp.");
      }
    }
    public static void Verify(string path) {
      using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
      using (var reader = new BinaryReader(stream)) {
        if (stream.Length < 64 || reader.ReadUInt16() != 0x5a4d) throw new InvalidOperationException("Invalid PE header.");
        stream.Position = 0x3c;
        long pe = reader.ReadUInt32();
        if (pe > stream.Length - 24) throw new InvalidOperationException("Invalid PE offset.");
        stream.Position = pe;
        if (reader.ReadUInt32() != 0x00004550) throw new InvalidOperationException("Invalid PE signature.");
        stream.Position = pe + 20;
        int optionalLength = reader.ReadUInt16();
        long optional = pe + 24;
        if (optionalLength < 136 || optional + optionalLength > stream.Length) throw new InvalidOperationException("Invalid PE optional header.");
        stream.Position = optional;
        int magic = reader.ReadUInt16();
        int directoryOffset = magic == 0x10b ? 96 : magic == 0x20b ? 112 : 0;
        if (directoryOffset == 0 || optionalLength < directoryOffset + 40) throw new InvalidOperationException("Unsupported PE format.");
        stream.Position = optional + directoryOffset - 4;
        if (reader.ReadUInt32() < 5) throw new InvalidOperationException("PE signature directory is missing.");
        stream.Position = optional + directoryOffset + 32;
        long offset = reader.ReadUInt32(), size = reader.ReadUInt32();
        if (offset == 0 || size < 8 || size > 32 * 1024 * 1024 || offset > stream.Length - size) throw new InvalidOperationException("PE signature table is missing or invalid.");
        long end = offset + size;
        while (offset < end) {
          if (end - offset < 8) throw new InvalidOperationException("Truncated PE signature table.");
          stream.Position = offset;
          long length = reader.ReadUInt32();
          int revision = reader.ReadUInt16(), type = reader.ReadUInt16();
          if (length < 8 || length > end - offset || revision != 0x200 || type != 2) throw new InvalidOperationException("Unsupported PE signature table entry.");
          VerifyCms(reader.ReadBytes((int)length - 8), 0);
          offset += (length + 7) & ~7L;
        }
        if (offset != end) throw new InvalidOperationException("Invalid PE signature table alignment.");
      }
    }
  }
}
'@
}

function Invoke-RunMeterWindowsSignatureVerification {
  param([string]$Setup, [string]$Package, [string]$Tool, [string]$ExpectedSubject, [string]$Report)

  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required to verify Authenticode signatures.' }
  if ([string]::IsNullOrWhiteSpace($ExpectedSubject)) { throw 'RUNMETER_SIGNING_PUBLISHER must contain the complete expected certificate Subject.' }
  if ([string]::IsNullOrWhiteSpace($Tool) -or -not [IO.Path]::IsPathRooted($Tool) -or -not (Test-Path -LiteralPath $Tool -PathType Leaf)) {
    throw 'RUNMETER_SIGNTOOL_PATH must identify the Windows SDK SignTool executable.'
  }
  $setupFile = (Resolve-Path -LiteralPath $Setup -ErrorAction Stop).Path
  $packageFile = (Resolve-Path -LiteralPath $Package -ErrorAction Stop).Path
  Assert-RunMeterBinarySignature $setupFile $ExpectedSubject $true $Tool

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
  $tempName = 'RunMeter-signature-verify-' + [Guid]::NewGuid().ToString('N')
  $scratch = Get-RunMeterArchivePath $tempParent $tempName
  if (Test-Path -LiteralPath $scratch) { throw 'The verification directory already exists.' }
  [IO.Directory]::CreateDirectory($scratch) | Out-Null
  $portableExecutables = 0
  try {
    $zip = [IO.Compression.ZipFile]::OpenRead($packageFile)
    try {
      $names = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      $peNames = @()
      $totalLength = [long]0
      foreach ($entry in $zip.Entries) {
        $normal = $entry.FullName.Replace('\', '/')
        $destination = Get-RunMeterArchivePath (Join-Path $scratch 'package') $normal
        if (-not $names.Add($normal)) { throw 'The release package contains duplicate paths.' }
        if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'The release package contains a symbolic link.' }
        if ($normal -notmatch '(?i)\.(exe|dll|node)$') { continue }
        if (-not $normal.StartsWith('lib/net45/', [StringComparison]::Ordinal)) { throw 'An executable is outside the expected release payload.' }
        $relative = $normal.Substring('lib/net45/'.Length)
        $peNames += $relative
        $totalLength += $entry.Length
        if ($totalLength -gt 2GB) { throw 'The release package exceeds the verification limit.' }
        Save-RunMeterArchiveEntry $entry $destination
        # Preserve trusted third-party signatures (e.g. Node.js); RunMeter-owned
        # executables and the customized Squirrel updater must match our identity.
        $own = @('RunMeter.exe', 'RunMeter_ExecutionStub.exe', 'squirrel.exe') -ccontains $relative
        Assert-RunMeterBinarySignature $destination $ExpectedSubject $own $Tool
        $portableExecutables++
      }
      Assert-RunMeterRequiredFiles $peNames
    } finally { $zip.Dispose() }

    $packageStream = [IO.File]::OpenRead($packageFile)
    try { $packageHash = Get-RunMeterStreamHash $packageStream; $packageStream.Position = 0; $packageSha1 = Get-RunMeterStreamHash $packageStream 'SHA1' }
    finally { $packageStream.Dispose() }
    $packageName = [IO.Path]::GetFileName($packageFile)
    $packageSize = (Get-Item -LiteralPath $packageFile).Length
    $releaseLines = @(Get-Content -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($packageFile)) 'RELEASES') | Where-Object { $_.Trim() })
    $matchingReleases = @($releaseLines | Where-Object { $_ -cmatch ('^[0-9a-fA-F]{40} ' + [Regex]::Escape($packageName) + ' [0-9]+$') })
    if ($matchingReleases.Count -ne 1) { throw 'The release manifest does not identify the final package exactly once.' }
    $fields = $matchingReleases[0].Split(' ')
    if ($fields[0].ToLowerInvariant() -ne $packageSha1 -or [long]$fields[2] -ne $packageSize) { throw 'The release manifest does not match the final package.' }

    Initialize-RunMeterSetupResourceReader
    $setupZip = Join-Path $scratch 'setup.zip'
    [RunMeterSignatureVerification.SetupResource]::SaveZip($setupFile, $setupZip)
    $embeddedZip = [IO.Compression.ZipFile]::OpenRead($setupZip)
    try {
      $embeddedPackage = @($embeddedZip.Entries | Where-Object { $_.FullName -ceq $packageName })
      $embeddedUpdater = @($embeddedZip.Entries | Where-Object { $_.FullName -ceq 'Update.exe' })
      $embeddedReleases = @($embeddedZip.Entries | Where-Object { $_.FullName -ceq 'RELEASES' })
      if ($embeddedPackage.Count -ne 1 -or $embeddedUpdater.Count -ne 1 -or $embeddedReleases.Count -ne 1) { throw 'Setup has no unique package, updater or release manifest.' }
      $allowedEmbeddedNames = @($packageName, 'Update.exe', 'RELEASES', 'background.gif', 'setupIcon.ico')
      $seenEmbeddedNames = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      foreach ($entry in $embeddedZip.Entries) {
        if ($allowedEmbeddedNames -cnotcontains $entry.FullName -or -not $seenEmbeddedNames.Add($entry.FullName)) { throw 'Setup contains an unexpected or duplicate payload.' }
      }
      $embeddedStream = $embeddedPackage[0].Open()
      try { if ((Get-RunMeterStreamHash $embeddedStream) -ne $packageHash) { throw 'Setup embeds a different release package.' } }
      finally { $embeddedStream.Dispose() }
      $reader = New-Object IO.StreamReader ($embeddedReleases[0].Open())
      try { $embeddedManifest = $reader.ReadToEnd().Trim() }
      finally { $reader.Dispose() }
      if ($embeddedManifest -cne $matchingReleases[0].Trim()) { throw 'Setup embeds a different release manifest.' }
      $updaterPath = Join-Path $scratch 'Update.exe'
      Save-RunMeterArchiveEntry $embeddedUpdater[0] $updaterPath
      Assert-RunMeterBinarySignature $updaterPath $ExpectedSubject $true $Tool
    } finally { $embeddedZip.Dispose() }

    $setupStream = [IO.File]::OpenRead($setupFile)
    try { $setupHash = Get-RunMeterStreamHash $setupStream }
    finally { $setupStream.Dispose() }
    $result = @{ passed = $true; verifiedPortableExecutables = $portableExecutables; setupVerified = $true; embeddedUpdaterVerified = $true; embeddedPackageMatches = $true; releaseManifestMatches = $true; setupSha256 = $setupHash; packageSha256 = $packageHash } | ConvertTo-Json -Compress
    if ($Report) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($Report), $result + [Environment]::NewLine, (New-Object Text.UTF8Encoding $false)) }
    Write-Output $result
  } finally {
    # Delete only the newly created, resolved GUID directory directly inside temp.
    $resolvedScratch = [IO.Path]::GetFullPath($scratch)
    if ([IO.Path]::GetDirectoryName($resolvedScratch) -ne $tempParent -or [IO.Path]::GetFileName($resolvedScratch) -cne $tempName) {
      throw 'Refusing to clean an unexpected verification directory.'
    }
    if (Test-Path -LiteralPath $resolvedScratch) {
      if (((Get-Item -LiteralPath $resolvedScratch -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing to clean a replaced verification directory.' }
      Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
    }
  }
}

# Dot-sourcing loads only the policy functions for isolated regression tests.
if ($MyInvocation.InvocationName -eq '.') { return }
try {
  $desktopDirectory = Split-Path $PSScriptRoot -Parent
  $outputDirectory = Join-Path $desktopDirectory 'out\make\squirrel.windows\x64'
  if (-not $ReportPath) { $ReportPath = Join-Path $outputDirectory 'signature-verification.json' }
  if (-not $SetupPath) { $SetupPath = Join-Path $outputDirectory 'RunMeterSetup.exe' }
  if (-not $PackagePath) {
    $packageInfo = Get-Content -LiteralPath (Join-Path $desktopDirectory 'package.json') -Raw | ConvertFrom-Json
    # Match electron-winstaller's NuGet SemVer conversion (preview.1 -> preview1).
    $versionParts = $packageInfo.version.Split('+')[0].Split([char[]]@('-'), 2)
    $packageVersion = $versionParts[0]
    if ($versionParts.Count -gt 1) { $packageVersion += '-' + $versionParts[1].Replace('.', '') }
    $PackagePath = Join-Path $outputDirectory ('RunMeterDesktop-{0}-full.nupkg' -f $packageVersion)
  }
  Invoke-RunMeterWindowsSignatureVerification $SetupPath $PackagePath $SignToolPath $Publisher $ReportPath
} catch {
  # No certificate subjects, account identifiers, native tool output or local paths
  # are written to build logs. The caller receives a failing exit status.
  [Console]::Error.WriteLine('Windows release signature verification failed. Check the configured publisher, timestamped signatures and matching final payloads.')
  exit 1
}
