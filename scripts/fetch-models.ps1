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

# Resilient curl (mirrors fetch-runtime.ps1): curl --retry alone does not retry a mid-transfer
# DROP on older curl, so an OUTER loop resumes the partial file (-C -) on each attempt — a
# flaky link (beta-tester report) survives several disconnects. Hash verification afterwards
# guards integrity, so resume is safe.
function Invoke-CurlResilient([string]$url, [string]$dest) {
  $attempts = 5
  for ($i = 1; $i -le $attempts; $i++) {
    & curl.exe -L --fail --retry 3 --retry-delay 2 --retry-connrefused `
      --connect-timeout 30 --ssl-revoke-best-effort -C - -o "$dest" "$url"
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($i -lt $attempts) {
      $wait = $i * 3
      Write-Host ("    connection interrupted (curl exit {0}) -- retry {1}/{2} in {3}s, resuming…" -f $LASTEXITCODE, $i, $attempts, $wait) -ForegroundColor Yellow
      Start-Sleep -Seconds $wait
    }
  }
  return $false
}

function Invoke-Download([string]$url, [string]$dest) {
  $dir = Split-Path -Parent $dest
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if ($Aria) {
    & aria2c --continue=true --max-connection-per-server=8 --split=8 `
      --dir "$dir" --out (Split-Path -Leaf $dest) "$url"
    if ($LASTEXITCODE -ne 0) { throw "aria2c failed (exit $LASTEXITCODE)" }
  } elseif ($Curl) {
    # Resilient curl: an OUTER retry loop that RESUMES the partial file (-C -) so a flaky
    # connection (beta-tester report) doesn't lose a multi-GB weight. --ssl-revoke-best-effort:
    # corporate proxies block CRL/OCSP. Integrity is enforced by the SHA-256 verification
    # after download, so resume can never weaken verification.
    if (-not (Invoke-CurlResilient $url $dest)) { throw 'curl failed after retries' }
  } else {
    # Last resort: Invoke-WebRequest (no resume; restarts the file).
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  }
}

# Extract the indented body of a top-level `mmproj:` mapping (the SECOND file of a vision model,
# DIST-1) — lines from `mmproj:` until the next column-0 key. Get-ManifestField then parses it.
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

# Classify a destination file against its expected hash: verified|placeholder|mismatch|absent.
function Get-FileState([string]$dest, [string]$sha) {
  if (-not (Test-Path $dest)) { return 'absent' }
  if (& $IsRealSha $sha) {
    if ((Get-Sha256 $dest) -eq $sha) { return 'verified' } else { return 'mismatch' }
  }
  return 'placeholder'
}

# Fetch + verify ONE file (the GGUF, or a vision model's mmproj projector), given its already-
# computed state. Mirrors assets.ts `planOneFile` + the atomic verify-before-trust contract.
function Invoke-HandleFile([string]$id, [string]$label, [string]$dest, [string]$sha, [string]$url, [string]$rel, [string]$state) {
  switch ($state) {
    'verified'    { Write-Host ("  skip   {0}{1} (present + verified)" -f $id, $label) -ForegroundColor Green; $script:skipped++; return }
    'placeholder' { Write-Host ("  skip   {0}{1} (present; placeholder hash -- cannot verify)" -f $id, $label) -ForegroundColor DarkYellow; $script:skipped++; return }
    'mismatch'    { Write-Host ("  redo   {0}{1} (present but checksum mismatch -- re-downloading)" -f $id, $label) -ForegroundColor Yellow }
  }
  if ($DryRun) {
    Write-Host ("  fetch  {0}{1}" -f $id, $label)
    Write-Host ("           {0}" -f $url)
    Write-Host ("           -> {0}" -f $rel)
    return
  }
  Write-Host ("  fetch  {0}{1} ..." -f $id, $label)
  try {
    Invoke-Download $url $dest
  } catch {
    Write-Host ("  FAIL   {0}{1}: {2}" -f $id, $label, $_.Exception.Message) -ForegroundColor Red
    $script:hadFailure = $true
    return
  }
  if (& $IsRealSha $sha) {
    $actual = Get-Sha256 $dest
    if ($actual -eq $sha) {
      Write-Host ("  ok     {0}{1} (VERIFIED)" -f $id, $label) -ForegroundColor Green
      $script:fetched++
    } else {
      Write-Host ("  FAIL   {0}{1}: checksum mismatch (expected {2}, got {3}) -- deleting partial" -f $id, $label, $sha, $actual) -ForegroundColor Red
      Remove-Item -Force -Path $dest -ErrorAction SilentlyContinue
      Remove-Item -Force -Path "$dest.aria2" -ErrorAction SilentlyContinue
      $script:hadFailure = $true
    }
  } else {
    Write-Host ("  ok     {0}{1} (UNVERIFIED -- placeholder hash; run verify-models -Generate)" -f $id, $label) -ForegroundColor Yellow
    $script:fetched++
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

  # A vision model is TWO files: the language GGUF (above) + the mmproj projector (DIST-1). Parse
  # the projector's own block (its local_path/sha256/download.url) -- absent for non-vision models.
  $mmprojBlock = Get-MmprojBlock $text
  $mmprojLocal = Get-ManifestField $mmprojBlock 'local_path'
  $mmprojSha = (Get-ManifestField $mmprojBlock 'sha256'); if ($mmprojSha) { $mmprojSha = $mmprojSha.ToLower() }
  $mmprojUrl = Get-ManifestField $mmprojBlock 'url'
  $hasMmproj = [bool]($mmprojUrl -and $mmprojLocal)
  $mmprojDest = if ($hasMmproj) { Join-Path $Target ($mmprojLocal -replace '/', [IO.Path]::DirectorySeparatorChar) } else { $null }

  # Classify each file ONCE (a present multi-GB weight is hashed at most once).
  $ggufState = Get-FileState $dest $sha
  $mmprojState = if ($hasMmproj) { Get-FileState $mmprojDest $mmprojSha } else { $null }

  # Does anything need the network? (absent / checksum-mismatch). A model already fully present is
  # skipped WITHOUT a license prompt (the license is only relevant to an actual download).
  $needsFetch = ($ggufState -eq 'absent' -or $ggufState -eq 'mismatch') -or
    ($hasMmproj -and ($mmprojState -eq 'absent' -or $mmprojState -eq 'mismatch'))

  if ($needsFetch) {
    # License gate (spec section 13) -- only when something will actually be fetched.
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
  }

  Invoke-HandleFile $id '' $dest $sha $url $localPath $ggufState
  if ($hasMmproj) {
    Invoke-HandleFile $id ' (mmproj)' $mmprojDest $mmprojSha $mmprojUrl $mmprojLocal $mmprojState
  }
}

Write-Host ''
Write-Host ("Planned {0} | fetched {1} | skipped {2}" -f $planned, $fetched, $skipped) -ForegroundColor Cyan
if ($hadFailure) {
  Write-Host 'One or more models failed to download/verify (or were license-blocked).' -ForegroundColor Red
  exit 1
}
exit 0
