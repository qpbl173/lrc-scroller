param(
    [Parameter(Mandatory = $true)]
    [string]$InputPath,
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$sourcePath = (Resolve-Path -LiteralPath $InputPath).Path
if (-not $OutputPath) {
    $OutputPath = Join-Path ([System.IO.Path]::GetDirectoryName($sourcePath)) ([System.IO.Path]::GetFileNameWithoutExtension($sourcePath) + '-prores4444.mov')
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw 'Please install FFmpeg and add it to PATH first.'
}
& ffmpeg -n -i $sourcePath -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -alpha_bits 16 -an $OutputPath
if ($LASTEXITCODE -ne 0) { throw "FFmpeg conversion failed (exit $LASTEXITCODE)." }
Write-Output "Saved: $OutputPath"
