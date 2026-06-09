#requires -Version 5.1
<#
.SYNOPSIS
  Verify model weights on a prepared drive against their manifest SHA-256 (Phase 11).

.DESCRIPTION
  Walks the manifests under <Target>/model-manifests (falling back to the repo's
  model-manifests/), resolves each weight by its local_path under the drive root,
  SHA-256s the present files, and compares to the manifest sha256.

  Mirrors apps/desktop/src/main/services/models.ts verifyChecksum / isRealSha256 so the
  script and the app agree:
    - placeholder hash (REPLACE_WITH_REAL_HASH) -> UNVERIFIED (not a pass, not a fail)
    - real hash, file matches                   -> VERIFIED
    - real hash, file differs                   -> MISMATCH  (exit 1)
    - file absent                               -> MISSING

  -Generate writes <Target>/config/checksums.json capturing the SHA-256 of every present
  weight (so a drive builder can record real hashes once).

.PARAMETER Target
  The prepared drive root (e.g. E:\). Required.

.PARAMETER Generate
  Write config/checksums.json from the weights present on the drive.

.EXAMPLE
  .\scripts\verify-models.ps1 -Target E:\
  .\scripts\verify-models.ps1 -Target E:\ -Generate
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [switch] $Generate
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Prefer the drive's own manifests; fall back to the repo's committed ones.
$ManifestsDir = Join-Path $Target 'model-manifests'
if (-not (Test-Path $ManifestsDir)) { $ManifestsDir = Join-Path $RepoRoot 'model-manifests' }
if (-not (Test-Path $ManifestsDir)) {
  Write-Error "No model-manifests found under '$Target' or repo root."
  exit 2
}

# Flat-YAML line parse: these manifests are simple key: value files. Pull the fields we
# need (id, local_path, sha256, runtime, format) per file.
function Get-ManifestField([string]$text, [string]$key) {
  foreach ($line in $text -split "`n") {
    if ($line -match "^\s*$([Regex]::Escape($key))\s*:\s*(.+?)\s*$") {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

$IsRealSha = { param($h) $h -match '^[a-f0-9]{64}$' }

$manifestFiles = Get-ChildItem -Path $ManifestsDir -Recurse -Include *.yaml, *.yml
$results = @()
$hadMismatch = $false

foreach ($mf in $manifestFiles) {
  $text = Get-Content -Path $mf.FullName -Raw
  $id = Get-ManifestField $text 'id'
  $localPath = Get-ManifestField $text 'local_path'
  $sha = (Get-ManifestField $text 'sha256')
  if ($sha) { $sha = $sha.ToLower() }
  $runtime = Get-ManifestField $text 'runtime'
  $format = Get-ManifestField $text 'format'
  if (-not $localPath) { continue }

  $weight = Join-Path $Target ($localPath -replace '/', [IO.Path]::DirectorySeparatorChar)
  $status = ''
  $actual = $null

  if ($runtime -notin @('llama_cpp', 'llama.cpp') -or $format -ne 'gguf') {
    $status = 'UNSUPPORTED'
  } elseif (-not (Test-Path $weight)) {
    $status = 'MISSING'
  } else {
    $actual = (Get-FileHash -Path $weight -Algorithm SHA256).Hash.ToLower()
    if (-not (& $IsRealSha $sha)) {
      $status = 'UNVERIFIED'
    } elseif ($actual -eq $sha) {
      $status = 'VERIFIED'
    } else {
      $status = 'MISMATCH'; $hadMismatch = $true
    }
  }

  $results += [pscustomobject]@{ id = $id; local_path = $localPath; status = $status; actual = $actual }
  $color = switch ($status) {
    'VERIFIED' { 'Green' }
    'MISMATCH' { 'Red' }
    'MISSING' { 'Yellow' }
    default { 'Gray' }
  }
  Write-Host ("  {0,-12} {1}" -f $status, $id) -ForegroundColor $color
}

if ($Generate) {
  $entries = foreach ($mf in $manifestFiles) {
    $text = Get-Content -Path $mf.FullName -Raw
    $id = Get-ManifestField $text 'id'
    $localPath = Get-ManifestField $text 'local_path'
    if (-not $localPath) { continue }
    $weight = Join-Path $Target ($localPath -replace '/', [IO.Path]::DirectorySeparatorChar)
    $present = Test-Path $weight
    [ordered]@{
      id         = $id
      local_path = $localPath
      sha256     = if ($present) { (Get-FileHash -Path $weight -Algorithm SHA256).Hash.ToLower() } else { $null }
      size_bytes = if ($present) { (Get-Item $weight).Length } else { $null }
      present    = [bool]$present
    }
  }
  $checksums = [ordered]@{
    drive_format_version = 1
    generated_at         = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    algorithm            = 'sha256'
    entries              = @($entries)
  }
  $configDir = Join-Path $Target 'config'
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  $dst = Join-Path $configDir 'checksums.json'
  # UTF-8 without a BOM (PS 5.1 `-Encoding UTF8` would prepend one, which breaks JSON.parse).
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($dst, ($checksums | ConvertTo-Json -Depth 6), $utf8NoBom)
  Write-Host "Wrote $dst" -ForegroundColor Cyan
}

if ($hadMismatch) {
  Write-Host 'One or more weights FAILED checksum verification.' -ForegroundColor Red
  exit 1
}
exit 0
