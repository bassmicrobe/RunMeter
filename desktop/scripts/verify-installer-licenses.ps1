param([string]$PackagePath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopDirectory = Split-Path $PSScriptRoot -Parent
$appDirectory = Join-Path $desktopDirectory 'out\RunMeter-win32-x64'
if (-not $PackagePath) {
  $packageInfo = Get-Content -LiteralPath (Join-Path $desktopDirectory 'package.json') -Raw | ConvertFrom-Json
  $PackagePath = Join-Path $desktopDirectory ("out\make\squirrel.windows\x64\RunMeterDesktop-{0}-full.nupkg" -f $packageInfo.version)
}

# Read the actual Squirrel payload without installing it or extracting binaries.
# Its default nuspec omits top-level HTML, so Chromium's notice must be explicit.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $PackagePath).Path)
try {
  $required = @('LICENSE', 'LICENSES.chromium.html', 'resources/bridge/NODE-LICENSE.txt')
  $noticesDirectory = Join-Path $appDirectory 'resources\licenses'
  if (-not (Test-Path -LiteralPath $noticesDirectory -PathType Container)) {
    throw 'Packaged license directory is missing. Run package verification first.'
  }
  foreach ($file in Get-ChildItem -LiteralPath $noticesDirectory -File -Recurse) {
    $relative = $file.FullName.Substring($appDirectory.Length + 1).Replace('\', '/')
    $required += $relative
  }
  foreach ($relative in $required) {
    $entry = $zip.GetEntry('lib/net45/' + $relative)
    if (-not $entry -or $entry.Length -eq 0) {
      throw "Installer license is missing or empty: $relative"
    }
    $stream = $entry.Open()
    $original = [System.IO.File]::OpenRead((Join-Path $appDirectory $relative))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $actual = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
      $expected = [System.BitConverter]::ToString($sha.ComputeHash($original)).Replace('-', '')
      if ($actual -ne $expected) { throw "Installer license differs from its packaged original: $relative" }
    } finally {
      $sha.Dispose()
      $original.Dispose()
      $stream.Dispose()
    }
  }
  @{ passed = $true; installerLicenseDocuments = $required.Count; originalHashesMatch = $true } | ConvertTo-Json -Compress
} finally {
  $zip.Dispose()
}
