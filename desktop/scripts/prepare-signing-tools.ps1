# Build-time tools only. Never copy this directory into the application or release.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV) {
  throw 'This bootstrap is for a disposable GitHub Actions Windows runner only. For local signing, install the official Microsoft client tools.'
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Windows is required for Artifact Signing tools.'
}

$runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
if (-not (Test-Path -LiteralPath $runnerTemp -PathType Container)) { throw 'Runner temporary directory is missing.' }
$toolRoot = [IO.Path]::GetFullPath((Join-Path $runnerTemp ('runmeter-signing-tools-' + [Guid]::NewGuid().ToString('N'))))
if (-not $toolRoot.StartsWith($runnerTemp + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Signing tools must stay inside the runner temporary directory.'
}
if (Test-Path -LiteralPath $toolRoot) { throw 'Signing tools target must be new.' }
New-Item -ItemType Directory -Path $toolRoot | Out-Null

# Hashes from the official NuGet catalog; a package change requires code review.
# https://www.nuget.org/packages/Microsoft.Windows.SDK.BuildTools/10.0.26100.9169
# https://www.nuget.org/packages/Microsoft.ArtifactSigning.Client/1.0.146
$packages = @(
  @{
    Id = 'microsoft.windows.sdk.buildtools'
    Version = '10.0.26100.9169'
    Sha512 = 'hOpNh7bCzJOOm2hvKuodr1NUKHeqoUhxdAzTmhO/q+u/E+5FOyhK+THhNhUUfKLbWnSslZ/m35dwghmS2BzaWg=='
    Tool = 'bin\10.0.26100.0\x64\signtool.exe'
    Variable = 'RUNMETER_SIGNTOOL_PATH'
  },
  @{
    Id = 'microsoft.artifactsigning.client'
    Version = '1.0.146'
    Sha512 = '/G0hG/VDIS6psW23b5t1V/ORIgn0PVAOtGj9w+hkPmAuI4pempfwlW50E2GtHscnz9+5Qz3hbC4mcb7ej2Yn1A=='
    Tool = 'bin\x64\Azure.CodeSigning.Dlib.dll'
    Variable = 'RUNMETER_SIGNING_DLIB_PATH'
  }
)

Add-Type -AssemblyName System.IO.Compression.FileSystem
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
foreach ($package in $packages) {
  $filename = $package.Id + '.' + $package.Version + '.nupkg'
  $uri = 'https://api.nuget.org/v3-flatcontainer/' + $package.Id + '/' + $package.Version + '/' + $filename
  $archive = Join-Path $toolRoot $filename
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $archive
  } catch {
    throw ('Could not download pinned Microsoft signing tools: ' + $package.Id)
  }
  $hash = [Security.Cryptography.SHA512]::Create()
  $stream = [IO.File]::OpenRead($archive)
  try { $actual = [Convert]::ToBase64String($hash.ComputeHash($stream)) }
  finally { $stream.Dispose(); $hash.Dispose() }
  if ($actual -cne $package.Sha512) { throw ('Signing tools integrity check failed: ' + $package.Id) }
  $destination = Join-Path $toolRoot $package.Id
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination)
  $tool = Join-Path $destination $package.Tool
  if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw 'Pinned signing tools have an unexpected layout.' }
  if ($tool.IndexOfAny([char[]]"`r`n") -ge 0) { throw 'Invalid signing tools path.' }
  # The signed-build preflight also verifies the native tools' Authenticode signatures.
  [IO.File]::AppendAllText($env:GITHUB_ENV, ($package.Variable + '=' + $tool + "`n"), [Text.UTF8Encoding]::new($false))
  Write-Output ('Prepared pinned ' + $package.Id + ' ' + $package.Version)
}
