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

.PARAMETER Strict
  Ship gate: exit 1 unless every manifest weight is VERIFIED (MISSING/UNVERIFIED/
  MISMATCH/UNSUPPORTED all fail) and at least one weight exists. Mirrors
  services/commercial-drive.ts assertCommercialDrive's weightsVerified check.

.EXAMPLE
  .\scripts\verify-models.ps1 -Target E:\
  .\scripts\verify-models.ps1 -Target E:\ -Generate
  .\scripts\verify-models.ps1 -Target E:\ -Strict
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [switch] $Generate,
  [switch] $Strict
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Normalize -Target to a full path: .NET IO ([System.IO.File]::WriteAllText below)
# resolves relative paths against the PROCESS working directory, which does not follow
# Set-Location (audit M22).
if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
$Target = [System.IO.Path]::GetFullPath($Target)

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
      # Strip an inline YAML comment (whitespace + '#' + rest) before unquoting (M17).
      return ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

$IsRealSha = { param($h) $h -match '^[a-f0-9]{64}$' }

# Extract the indented body of a top-level `mmproj:` mapping (the SECOND file of a vision model,
# DIST-2: verify BOTH files). Get-ManifestField then reads its local_path/sha256.
function Get-MmprojBlock([string]$text) {
  $out = New-Object System.Collections.Generic.List[string]
  $inBlk = $false
  foreach ($line in ($text -split "`n")) {
    if (-not $inBlk) {
      if ($line -match '^mmproj:\s*$') { $inBlk = $true }
    } elseif ($line -match '^\S') {
      break
    } else {
      $out.Add($line)
    }
  }
  return ($out -join "`n")
}

# Classify one weight file against its expected hash (mirrors services/models.ts verifyChecksum).
function Get-WeightStatus([string]$weight, [string]$sha) {
  if (-not (Test-Path $weight)) { return 'MISSING' }
  $actual = (Get-FileHash -Path $weight -Algorithm SHA256).Hash.ToLower()
  if (-not (& $IsRealSha $sha)) { return 'UNVERIFIED' }
  if ($actual -eq $sha) { return 'VERIFIED' }
  $script:hadMismatch = $true
  return 'MISMATCH'
}

# Record + print one file's result (the GGUF, or a vision model's mmproj projector).
function Write-WeightResult([string]$id, [string]$label, [string]$status) {
  $script:results += [pscustomobject]@{ id = "$id$label"; status = $status }
  $color = switch ($status) {
    'VERIFIED' { 'Green' }
    'MISMATCH' { 'Red' }
    'MISSING' { 'Yellow' }
    default { 'Gray' }
  }
  Write-Host ("  {0,-12} {1}" -f $status, "$id$label") -ForegroundColor $color
}

# Exclude the runtime-sources manifest (it describes the sidecar, not a model). It has
# no local_path today, but mirroring fetch-models' explicit exclusion removes the
# fragility if it ever gains one.
$manifestFiles = Get-ChildItem -Path $ManifestsDir -Recurse -Include *.yaml, *.yml |
  Where-Object { $_.Name -notin @('runtime-sources.yaml', 'runtime-sources.yml') }
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

  # A vision model is TWO files: the language GGUF + the mmproj projector (DIST-2).
  $mmprojBlock = Get-MmprojBlock $text
  $mmprojLocal = Get-ManifestField $mmprojBlock 'local_path'
  $mmprojSha = (Get-ManifestField $mmprojBlock 'sha256'); if ($mmprojSha) { $mmprojSha = $mmprojSha.ToLower() }

  if ($runtime -notin @('llama_cpp', 'llama.cpp') -or $format -ne 'gguf') {
    Write-WeightResult $id '' 'UNSUPPORTED'
    continue
  }

  $weight = Join-Path $Target ($localPath -replace '/', [IO.Path]::DirectorySeparatorChar)
  Write-WeightResult $id '' (Get-WeightStatus $weight $sha)
  if ($mmprojLocal) {
    $mmprojWeight = Join-Path $Target ($mmprojLocal -replace '/', [IO.Path]::DirectorySeparatorChar)
    Write-WeightResult $id ' (mmproj)' (Get-WeightStatus $mmprojWeight $mmprojSha)
  }
}

if ($Generate) {
  $entries = foreach ($mf in $manifestFiles) {
    $text = Get-Content -Path $mf.FullName -Raw
    $id = Get-ManifestField $text 'id'
    $localPath = Get-ManifestField $text 'local_path'
    if (-not $localPath) { continue }
    # One entry per FILE: the GGUF, plus a vision model's mmproj projector (DIST-2).
    $paths = @($localPath)
    $mmprojLocal = Get-ManifestField (Get-MmprojBlock $text) 'local_path'
    if ($mmprojLocal) { $paths += $mmprojLocal }
    foreach ($lp in $paths) {
      $weight = Join-Path $Target ($lp -replace '/', [IO.Path]::DirectorySeparatorChar)
      $present = Test-Path $weight
      [ordered]@{
        id         = $id
        local_path = $lp
        sha256     = if ($present) { (Get-FileHash -Path $weight -Algorithm SHA256).Hash.ToLower() } else { $null }
        size_bytes = if ($present) { (Get-Item $weight).Length } else { $null }
        present    = [bool]$present
      }
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

# -Strict = the sellable posture (assertCommercialDrive parity): every weight must be
# VERIFIED against a REAL manifest hash, and there must be at least one weight.
if ($Strict) {
  $resultsArr = @($results)
  $notVerified = @($resultsArr | Where-Object { $_.status -ne 'VERIFIED' })
  if ($resultsArr.Count -eq 0) {
    Write-Host 'STRICT: no model manifests with a local_path found - nothing to verify.' -ForegroundColor Red
    exit 1
  }
  if ($notVerified.Count -gt 0) {
    foreach ($r in $notVerified) {
      Write-Host ("STRICT: {0} is {1} (must be VERIFIED)" -f $r.id, $r.status) -ForegroundColor Red
    }
    Write-Host 'STRICT: drive is not sellable - every weight must be VERIFIED against a real manifest sha256.' -ForegroundColor Red
    exit 1
  }
  Write-Host ("STRICT: all {0} weight(s) VERIFIED." -f $resultsArr.Count) -ForegroundColor Green
}
exit 0
