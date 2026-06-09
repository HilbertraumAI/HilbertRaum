#requires -Version 5.1
<#
.SYNOPSIS
  Download + verify model weights onto a prepared drive (Phase 12 -- DIY asset loader).

.DESCRIPTION
  For each model manifest under <Target>/model-manifests (falling back to the repo's
  model-manifests/) that carries a `download:` block, this downloads the weight to its
  local_path under the drive root, RESUMES partial downloads, then SHA-256-verifies it
  against the manifest's top-level sha256 before counting it installed.

  Mirrors apps/desktop/src/main/services/assets.ts (the canonical, unit-tested reference)
  + verify-models.ps1's flat-YAML parse. Self-contained: needs no Node/npm. Uses the
  OS-native downloader (curl.exe, present on Win10 1803+; prefers aria2c if installed).

  Verify-before-trust: a real-hash MISMATCH deletes the partial and exits non-zero. A
  placeholder hash (REPLACE_WITH_REAL_HASH) downloads the file but reports it UNVERIFIED
  (capture the real hash later with verify-models.ps1 -Generate). Idempotent: a present +
  verified weight is skipped.

  License gate (spec section 13): a model whose license_review.status is not 'approved' is
  refused unless -AcceptLicense is passed; the license + license_url are printed first.

.PARAMETER Target
  The prepared drive root (e.g. E:\). Required.

.PARAMETER Only
  Fetch only the model with this id.

.PARAMETER AcceptLicense
  Accept the model license(s) and bypass the not-approved license gate.

.PARAMETER DryRun
  Print the plan and download nothing.

.EXAMPLE
  .\scripts\fetch-models.ps1 -Target E:\ -AcceptLicense
  .\scripts\fetch-models.ps1 -Target E:\ -Only qwen3-4b-instruct-q4 -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [string] $Only,
  [switch] $AcceptLicense,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Normalize -Target to a full path: .NET IO and curl.exe resolve relative paths against
# the PROCESS working directory, which does not follow Set-Location (audit M22).
if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
$Target = [System.IO.Path]::GetFullPath($Target)

$ManifestsDir = Join-Path $Target 'model-manifests'
if (-not (Test-Path $ManifestsDir)) { $ManifestsDir = Join-Path $RepoRoot 'model-manifests' }
if (-not (Test-Path $ManifestsDir)) {
  Write-Error "No model-manifests found under '$Target' or repo root."
  exit 2
}

# Flat-YAML line parse (same approach as verify-models.ps1). Returns the FIRST match, so a
# top-level `sha256:` wins over the one nested in the download block (which is what we
# verify against). `url`/`size_bytes`/`license_url` are unique to the download block.
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

function Get-Sha256([string]$path) {
  return (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
}

# Pick the best available downloader. aria2c is multi-connection + resumable if present;
# otherwise curl.exe (-C - resumes). Never require either beyond curl (ships on Win10+).
$Aria = (Get-Command aria2c -ErrorAction SilentlyContinue)
$Curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)

function Invoke-Download([string]$url, [string]$dest) {
  $dir = Split-Path -Parent $dest
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if ($Aria) {
    & aria2c --continue=true --max-connection-per-server=8 --split=8 `
      --dir "$dir" --out (Split-Path -Leaf $dest) "$url"
    if ($LASTEXITCODE -ne 0) { throw "aria2c failed (exit $LASTEXITCODE)" }
  } elseif ($Curl) {
    # --ssl-revoke-best-effort: see fetch-runtime.ps1 — corporate proxies block CRL/OCSP;
    # integrity is enforced by the SHA-256 verification after download.
    & curl.exe -L --fail --retry 3 --ssl-revoke-best-effort -C - -o "$dest" "$url"
    if ($LASTEXITCODE -ne 0) { throw "curl failed (exit $LASTEXITCODE)" }
  } else {
    # Last resort: Invoke-WebRequest (no resume; restarts the file).
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  }
}

$manifestFiles = Get-ChildItem -Path $ManifestsDir -Recurse -Include *.yaml, *.yml |
  Where-Object { $_.Name -notin @('runtime-sources.yaml', 'runtime-sources.yml') }

$planned = 0
$fetched = 0
$skipped = 0
$hadFailure = $false

Write-Host "Fetch models -> $Target" -ForegroundColor Cyan
if ($DryRun) { Write-Host '(dry run -- nothing will be downloaded)' -ForegroundColor Yellow }
Write-Host ''

foreach ($mf in $manifestFiles) {
  $text = Get-Content -Path $mf.FullName -Raw
  $id = Get-ManifestField $text 'id'
  $localPath = Get-ManifestField $text 'local_path'
  $sha = (Get-ManifestField $text 'sha256'); if ($sha) { $sha = $sha.ToLower() }
  $url = Get-ManifestField $text 'url'
  $license = Get-ManifestField $text 'license'
  $licenseUrl = Get-ManifestField $text 'license_url'
  $reviewStatus = Get-ManifestField $text 'status'

  if (-not $url -or -not $localPath) { continue }      # no download block -> skip
  if ($Only -and $id -ne $Only) { continue }
  $planned++

  $dest = Join-Path $Target ($localPath -replace '/', [IO.Path]::DirectorySeparatorChar)

  # Idempotent skip: present + (real hash matches OR placeholder we can't verify).
  if (Test-Path $dest) {
    if (& $IsRealSha $sha) {
      if ((Get-Sha256 $dest) -eq $sha) {
        Write-Host ("  skip   {0} (present + verified)" -f $id) -ForegroundColor Green
        $skipped++; continue
      }
      Write-Host ("  redo   {0} (present but checksum mismatch -- re-downloading)" -f $id) -ForegroundColor Yellow
    } else {
      Write-Host ("  skip   {0} (present; placeholder hash -- cannot verify)" -f $id) -ForegroundColor DarkYellow
      $skipped++; continue
    }
  }

  # License gate.
  $approved = ($reviewStatus -eq 'approved')
  if (-not $approved -and -not $AcceptLicense) {
    Write-Host ("  BLOCK  {0}: license '{1}' not approved." -f $id, $license) -ForegroundColor Red
    if ($licenseUrl) { Write-Host ("         License: {0}" -f $licenseUrl) }
    Write-Host "         Re-run with -AcceptLicense to accept and continue." -ForegroundColor Red
    $hadFailure = $true
    continue
  }
  if (-not $approved) {
    Write-Host ("  note   {0}: license '{1}' accepted via -AcceptLicense ({2})" -f $id, $license, $licenseUrl)
  }

  if ($DryRun) {
    Write-Host ("  fetch  {0}" -f $id)
    Write-Host ("           {0}" -f $url)
    Write-Host ("           -> {0}" -f $localPath)
    continue
  }

  Write-Host ("  fetch  {0} ..." -f $id)
  try {
    Invoke-Download $url $dest
  } catch {
    Write-Host ("  FAIL   {0}: {1}" -f $id, $_.Exception.Message) -ForegroundColor Red
    $hadFailure = $true
    continue
  }

  if (& $IsRealSha $sha) {
    $actual = Get-Sha256 $dest
    if ($actual -eq $sha) {
      Write-Host ("  ok     {0} (VERIFIED)" -f $id) -ForegroundColor Green
      $fetched++
    } else {
      Write-Host ("  FAIL   {0}: checksum mismatch (expected {1}, got {2}) -- deleting partial" -f $id, $sha, $actual) -ForegroundColor Red
      Remove-Item -Force -Path $dest -ErrorAction SilentlyContinue
      # A stale aria2 control file would corrupt the next resume of the re-download.
      Remove-Item -Force -Path "$dest.aria2" -ErrorAction SilentlyContinue
      $hadFailure = $true
    }
  } else {
    Write-Host ("  ok     {0} (UNVERIFIED -- placeholder hash; run verify-models -Generate)" -f $id) -ForegroundColor Yellow
    $fetched++
  }
}

Write-Host ''
Write-Host ("Planned {0} | fetched {1} | skipped {2}" -f $planned, $fetched, $skipped) -ForegroundColor Cyan
if ($hadFailure) {
  Write-Host 'One or more models failed to download/verify (or were license-blocked).' -ForegroundColor Red
  exit 1
}
exit 0
