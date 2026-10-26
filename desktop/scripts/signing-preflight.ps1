Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# npm may inherit PowerShell 7's PSModulePath when launching Windows PowerShell.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force

foreach ($name in @('RUNMETER_SIGNTOOL_PATH', 'RUNMETER_SIGNING_DLIB_PATH')) {
  $file = [Environment]::GetEnvironmentVariable($name)
  if (-not $file -or -not [System.IO.File]::Exists($file)) { throw "Missing $name." }
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
      $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne 'Microsoft Corporation') {
    throw "The tool configured in $name must have a valid Microsoft signature."
  }
}
$tool = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:RUNMETER_SIGNTOOL_PATH)
$version = [Version]::new($tool.FileMajorPart, $tool.FileMinorPart, $tool.FileBuildPart, $tool.FilePrivatePart)
if ($version -lt [Version]'10.0.22621.755') { throw 'Install a current Windows SDK x64 SignTool (10.0.22621.755 or newer).' }

$dotnet = Get-Command dotnet -CommandType Application -ErrorAction Stop
$runtimes = & $dotnet.Source --list-runtimes
if ($LASTEXITCODE -ne 0 -or -not ($runtimes -match '^Microsoft.NETCore.App 8\.')) {
  throw 'Install the x64 .NET 8 runtime required by the Artifact Signing dlib.'
}
$az = Get-Command az -CommandType Application -ErrorAction Stop
& $az.Source account show --output none --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Sign in with az login (local) or Azure/login OIDC (CI) first.' }
Write-Output 'Signing tool signatures, SDK version, .NET 8, and Azure CLI session checked.'
