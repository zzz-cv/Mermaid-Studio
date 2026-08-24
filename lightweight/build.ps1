[CmdletBinding()]
param(
  [switch]$SkipFrontend,
  [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot "release"
$quickStartDirectory = Join-Path $releaseRoot "Mermaid-Studio-Windows-x64"
$zipPath = Join-Path $releaseRoot "Mermaid-Studio-Windows-x64.zip"
$setupPath = Join-Path $releaseRoot "Mermaid-Studio-Setup.exe"
$sizeLimit = 50MB

function Assert-LastExitCode([string]$operation) {
  if ($LASTEXITCODE -ne 0) { throw "$operation failed with exit code $LASTEXITCODE" }
}

function Get-DirectorySize([string]$path) {
  return [int64]((Get-ChildItem -LiteralPath $path -Recurse -File | Measure-Object Length -Sum).Sum)
}

function Assert-UnderSizeLimit([string]$label, [int64]$bytes) {
  if ($bytes -ge $sizeLimit) {
    throw "$label is $([math]::Round($bytes / 1MB, 2)) MB, exceeding the 50 MB target"
  }
}

Push-Location $projectRoot
try {
  if (-not $SkipFrontend) {
    & node "node_modules/typescript/bin/tsc" --noEmit
    Assert-LastExitCode "TypeScript validation"
    & node "node_modules/vite/bin/vite.js" build
    Assert-LastExitCode "Frontend build"
  }

  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "dist/index.html"))) {
    throw "Frontend output is missing. Build it before packaging."
  }

  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  if (Test-Path -LiteralPath $quickStartDirectory) { Remove-Item -LiteralPath $quickStartDirectory -Recurse -Force }
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  if (Test-Path -LiteralPath $setupPath) { Remove-Item -LiteralPath $setupPath -Force }

  $localDotnet = Join-Path $projectRoot ".build-tools/dotnet-sdk/dotnet.exe"
  $dotnetCommand = Get-Command dotnet.exe -ErrorAction SilentlyContinue
  $dotnet = if (Test-Path -LiteralPath $localDotnet) { $localDotnet } elseif ($dotnetCommand) { $dotnetCommand.Source } else { $localDotnet }
  if (-not (Test-Path -LiteralPath $dotnet)) { throw ".NET SDK was not found" }

  & $dotnet publish "lightweight/MermaidStudio.Lightweight.csproj" -c Release -r win-x64 --no-self-contained -o $quickStartDirectory -p:DebugSymbols=false -p:DebugType=None
  Assert-LastExitCode "Lightweight shell build"

  Copy-Item -LiteralPath (Join-Path $projectRoot "dist") -Destination (Join-Path $quickStartDirectory "dist") -Recurse
  Get-ChildItem -LiteralPath $quickStartDirectory -Recurse -File -Filter *.pdb | Remove-Item -Force
  $wpfAssembly = Join-Path $quickStartDirectory "Microsoft.Web.WebView2.Wpf.dll"
  if (Test-Path -LiteralPath $wpfAssembly) { Remove-Item -LiteralPath $wpfAssembly -Force }
  Compress-Archive -LiteralPath $quickStartDirectory -DestinationPath $zipPath -CompressionLevel Optimal

  if (-not $SkipInstaller) {
    $makeNsisCommand = Get-Command makensis.exe -ErrorAction SilentlyContinue
    $makeNsis = if ($makeNsisCommand) { $makeNsisCommand.Source } else { $null }
    if (-not $makeNsis) {
      $makeNsis = Get-ChildItem "$env:LOCALAPPDATA/electron-builder/Cache" -Recurse -File -Filter makensis.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -eq "Bin" } |
        Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $makeNsis) { throw "NSIS compiler was not found; use -SkipInstaller to build only the quick-start ZIP" }
    Push-Location $PSScriptRoot
    try {
      & $makeNsis /V2 "installer.nsi"
      Assert-LastExitCode "Installer build"
    } finally {
      Pop-Location
    }
  }

  $quickStartBytes = Get-DirectorySize $quickStartDirectory
  $zipBytes = (Get-Item -LiteralPath $zipPath).Length
  Assert-UnderSizeLimit "Quick-start directory" $quickStartBytes
  Assert-UnderSizeLimit "Quick-start ZIP" $zipBytes
  if (Test-Path -LiteralPath $setupPath) { Assert-UnderSizeLimit "Installer" (Get-Item -LiteralPath $setupPath).Length }

  $artifacts = @($zipPath)
  if (Test-Path -LiteralPath $setupPath) { $artifacts += $setupPath }
  $artifacts | ForEach-Object {
    $item = Get-Item -LiteralPath $_
    [PSCustomObject]@{ Name = $item.Name; MB = [math]::Round($item.Length / 1MB, 2); SHA256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
  } | Format-Table -AutoSize
  Write-Host "Quick-start directory: $([math]::Round($quickStartBytes / 1MB, 2)) MB"
} finally {
  Pop-Location
}
