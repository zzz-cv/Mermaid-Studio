[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceExe,
  [string]$OutputIco
)

$ErrorActionPreference = "Stop"
if (-not $OutputIco) { $OutputIco = Join-Path $PSScriptRoot "app.ico" }
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeIconExtractor {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern uint PrivateExtractIcons(string file, int index, int width, int height, IntPtr[] icons, uint[] ids, uint count, uint flags);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr icon);
}
"@

$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$images = New-Object System.Collections.Generic.List[object]
foreach ($size in $sizes) {
  $handles = [IntPtr[]]::new(1)
  $ids = [uint32[]]::new(1)
  $count = [NativeIconExtractor]::PrivateExtractIcons($SourceExe, 0, $size, $size, $handles, $ids, 1, 0)
  if ($count -eq 0 -or $handles[0] -eq [IntPtr]::Zero) { continue }
  try {
    $icon = [System.Drawing.Icon]::FromHandle($handles[0])
    $bitmap = $icon.ToBitmap()
    try {
      $stream = New-Object System.IO.MemoryStream
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $images.Add([PSCustomObject]@{ Size = $size; Bytes = $stream.ToArray() })
      $stream.Dispose()
    } finally {
      $bitmap.Dispose()
      $icon.Dispose()
    }
  } finally {
    [void][NativeIconExtractor]::DestroyIcon($handles[0])
  }
}

if ($images.Count -eq 0) { throw "No icon resources were found in $SourceExe" }
$output = [System.IO.File]::Open($OutputIco, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = New-Object System.IO.BinaryWriter($output)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$images.Count)
  $offset = 6 + 16 * $images.Count
  foreach ($image in $images) {
    $dimension = if ($image.Size -ge 256) { 0 } else { $image.Size }
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$image.Bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $image.Bytes.Length
  }
  foreach ($image in $images) { $writer.Write([byte[]]$image.Bytes) }
} finally {
  $writer.Dispose()
  $output.Dispose()
}

Write-Host "Created $OutputIco with $($images.Count) sizes"
