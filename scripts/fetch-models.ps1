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

  Half a download pair (#767): a model whose top-level download has no partner on its mmproj
  projector or on a files: member (or the other way round) is refused with the validator's
  message (BLOCK, exit 1), whatever is on disk and whatever -AcceptLicense says: the app
  refuses such a manifest, so any file of it fetched would never start.

.PARAMETER Target
  The prepared drive root (e.g. E:\). Required.

.PARAMETER Only
  Fetch only the model with this id. An id no manifest carries, or one whose manifest
  declares no download block, exits 2: an explicit request that names nothing fetchable.

.PARAMETER Bundled
  Fetch only the models a preconfigured Kit ships preloaded
  (bundled_on_preconfigured_drive: true, #766). build-commercial-drive passes it.

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
  [switch] $Bundled,
  [switch] $AcceptLicense,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# FAILURE REPORTING (AUD-05): failures are announced with `Write-Host -ForegroundColor Red`
# plus an explicit `exit`, never with `Write-Error`. Under $ErrorActionPreference = 'Stop' a
# Write-Error becomes a SCRIPT-TERMINATING exception, so a following `exit 2` never executes
# (the process exits 1 and the documented config-error code collapses into the
# download-failure code) and the exception propagates OUT through the `&` call of a parent
# script (prepare-drive) and kills it before it can inspect $LASTEXITCODE.

# Normalize -Target to a full path: .NET IO and curl.exe resolve relative paths against
# the PROCESS working directory, which does not follow Set-Location (audit M22).
if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
$Target = [System.IO.Path]::GetFullPath($Target)

# Every path cmdlet below takes -LiteralPath (#767): a drive root such as `Kit [2026]` is a
# wildcard to -Path, so Test-Path found no manifests there and the run fell back to the repo's.
$ManifestsDir = Join-Path $Target 'model-manifests'
if (-not (Test-Path -LiteralPath $ManifestsDir)) { $ManifestsDir = Join-Path $RepoRoot 'model-manifests' }
if (-not (Test-Path -LiteralPath $ManifestsDir)) {
  Write-Host "No model-manifests found under '$Target' or repo root." -ForegroundColor Red
  exit 2
}

# Flat-YAML line parse (same approach as verify-models.ps1). Returns the FIRST match, so a
# top-level `sha256:` wins over the one nested in the download block (which is what we
# verify against). `url`/`size_bytes`/`license_url` are read from the body of one block
# (Get-Block), never from the whole manifest.
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
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
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
    # No in-script downloader: a WebClient / Invoke-WebRequest download line is what antivirus
    # heuristics flag (Norton quarantined a copy carrying one, #767), and every Windows from 10
    # 1803 on ships curl.exe. Same outcome as the .sh twin with no downloader: this file fails.
    throw 'No downloader found (need curl.exe, built into Windows 10 1803 and later, or aria2c).'
  }
}

# Extract the indented body of a top-level `<key>:` mapping -- lines from `<key>:` until the
# next column-0 key. Get-ManifestField then parses it. Three blocks are read this way: the
# top-level `download:` (the primary file's source), `mmproj:` (the SECOND file of a vision
# model, DIST-1) and `files:` (the ADDITIONAL required files of a multi-file weight, #310, e.g.
# a GGUF shard set's shards 2..N). A key nested in one block never answers for another: read
# flat, a projector's size_bytes reached the primary file when the top-level download carried
# none, and the size guard below then deleted a resumable partial (#767).
function Get-Block([string]$text, [string]$key) {
  $out = New-Object System.Collections.Generic.List[string]
  $inBlk = $false
  $head = '^' + [Regex]::Escape($key) + ':\s*$'
  foreach ($line in ($text -split "`n")) {
    if (-not $inBlk) {
      if ($line -match $head) { $inBlk = $true }
    } elseif ($line -match '^\S') {
      break
    } else {
      $out.Add($line)
    }
  }
  return ($out -join "`n")
}

# Split a `files:` block (as text, from Get-Block) into one member's raw text per
# list entry (#310). A member starts at its own `- local_path:` line (the leading `- ` is
# stripped so Get-ManifestField sees `local_path:` at the front) and runs to the next one.
function Get-FilesMembers([string]$block) {
  $members = New-Object System.Collections.Generic.List[string]
  $current = New-Object System.Collections.Generic.List[string]
  foreach ($line in ($block -split "`n")) {
    if ($line -match '^\s*-\s*local_path:') {
      if ($current.Count -gt 0) { $members.Add(($current -join "`n")) }
      $current = New-Object System.Collections.Generic.List[string]
      $current.Add(($line -replace '^\s*-\s*', ''))
    } elseif ($current.Count -gt 0) {
      $current.Add($line)
    }
  }
  if ($current.Count -gt 0) { $members.Add(($current -join "`n")) }
  return $members
}

# Extract a member's own `download:` sub-block — everything after its `download:` line to the
# end of the member's text (the contract's fixed shape: url/sha256/size_bytes are the download
# block's only children and nothing else follows it in a files[] member).
function Get-FileDownloadBlock([string]$memberText) {
  $lines = $memberText -split "`n"
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*download:\s*$') { $idx = $i; break }
  }
  if ($idx -lt 0 -or $idx -ge ($lines.Count - 1)) { return '' }
  return ($lines[($idx + 1)..($lines.Count - 1)] -join "`n")
}

# Classify a destination file against its expected hash: verified|placeholder|mismatch|absent.
function Get-FileState([string]$dest, [string]$sha) {
  if (-not (Test-Path -LiteralPath $dest)) { return 'absent' }
  if (& $IsRealSha $sha) {
    if ((Get-Sha256 $dest) -eq $sha) { return 'verified' } else { return 'mismatch' }
  }
  return 'placeholder'
}

# Fetch + verify ONE file (the GGUF, or a vision model's mmproj projector), given its already-
# computed state. Mirrors assets.ts `planOneFile` + the atomic verify-before-trust contract.
function Invoke-HandleFile([string]$id, [string]$label, [string]$dest, [string]$sha, [string]$url, [string]$rel, [string]$state, [string]$expectedSize) {
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
  # A "redo" writes onto the file that is already there, and every downloader below resumes:
  # curl (-C -) resumes AT THE FILE'S END; aria2c (--continue) resumes from its own `.aria2`
  # CONTROL FILE, never from the file length. That is deliberate: resuming a part-downloaded
  # weight across runs is a documented feature of this script, and a multi-GB weight on a flaky
  # link must not restart from zero. But the SAME state also covers a file that is complete and
  # WRONG, and an at-EOF resume of that one asks the server for a byte range starting at or
  # past the resource's length -- an unsatisfiable range (HTTP 416), so the repair transfers
  # nothing and the run is wasted (AUD-24).
  # Rule: delete first ONLY when resume provably cannot help, i.e. when the bytes on disk
  # already reach the manifest's expected size AND the file is not an aria2 partial the next
  # run will resume. A SHORTER file is a resumable partial and is left alone, exactly as
  # before. A full-length file WITH an `.aria2` control file beside it is aria2's
  # PREALLOCATION (aria2's default file-allocation sizes the destination at download start),
  # i.e. a resumable partial too: aria2 removes the control file itself on completion, so its
  # presence proves the transfer never finished, and aria2's control-file resume cannot hit
  # the 416 trap. Keep it ONLY while aria2c is the downloader that will actually run -- to
  # curl the control file is useless and the preallocated file is the 416 case again
  # (full-audit 2026-07-23 review fix F1). When the manifest carries no size_bytes we cannot
  # tell the two apart, so we do NOT delete and keep the previous behaviour (resume; a wrong
  # file is still deleted by the post-download verification below, which self-heals on the
  # next run).
  # NOTE the value comes from this file's own download block (Get-Block), never from another
  # file's: a projector's size once deleted the primary file's resumable partial (#767).
  if ($state -eq 'mismatch' -and $expectedSize -match '^\d+$') {
    $onDisk = (Get-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue)
    if ($onDisk -and $onDisk.Length -ge [long]$expectedSize) {
      if ($Aria -and (Test-Path -LiteralPath "$dest.aria2")) {
        Write-Host ("         {0} bytes on disk >= the manifest's {1}, but an .aria2 control file is present -- keeping the resumable aria2 partial" -f $onDisk.Length, $expectedSize) -ForegroundColor DarkYellow
      } else {
        Write-Host ("         {0} bytes on disk >= the manifest's {1} -- deleting before re-download (resume cannot repair it)" -f $onDisk.Length, $expectedSize) -ForegroundColor DarkYellow
        Remove-Item -Force -LiteralPath $dest -ErrorAction SilentlyContinue
        Remove-Item -Force -LiteralPath "$dest.aria2" -ErrorAction SilentlyContinue
      }
    }
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
      Remove-Item -Force -LiteralPath $dest -ErrorAction SilentlyContinue
      Remove-Item -Force -LiteralPath "$dest.aria2" -ErrorAction SilentlyContinue
      $script:hadFailure = $true
    }
  } else {
    Write-Host ("  ok     {0}{1} (UNVERIFIED -- placeholder hash; run verify-models -Generate)" -f $id, $label) -ForegroundColor Yellow
    $script:fetched++
  }
}

# -LiteralPath with -Include returns every item in 5.1 (the filter is ignored), so the
# extensions are filtered by hand.
$manifestFiles = @(Get-ChildItem -LiteralPath $ManifestsDir -Recurse -File |
  Where-Object { $_.Extension -in @('.yaml', '.yml') -and $_.Name -notin @('runtime-sources.yaml', 'runtime-sources.yml') })

$planned = 0
$fetched = 0
$skipped = 0
$hadFailure = $false
# -Only names one model: an id no manifest carries, or one with nothing to fetch, exits 2 below.
$onlySeen = $false
$onlyFetchable = $false

Write-Host "Fetch models -> $Target" -ForegroundColor Cyan
if ($DryRun) { Write-Host '(dry run -- nothing will be downloaded)' -ForegroundColor Yellow }
Write-Host ''
if ($manifestFiles.Count -eq 0) { Write-Host "No model manifests found under '$ManifestsDir' -- nothing to fetch." }

foreach ($mf in $manifestFiles) {
  $text = Get-Content -LiteralPath $mf.FullName -Raw
  $id = Get-ManifestField $text 'id'
  if ($Only -and $id -ne $Only) { continue }
  if ($Only) { $onlySeen = $true }
  if ($Bundled -and (Get-ManifestField $text 'bundled_on_preconfigured_drive') -ne 'true') { continue }
  $localPath = Get-ManifestField $text 'local_path'
  $sha = (Get-ManifestField $text 'sha256'); if ($sha) { $sha = $sha.ToLower() }
  # The primary file's source: the top-level `download:` block only, never another file's (#767).
  $dlBlock = Get-Block $text 'download'
  $url = Get-ManifestField $dlBlock 'url'
  # Optional (30 of the committed manifests carry it) -- used only to tell a complete-but-wrong
  # file apart from a resumable partial in Invoke-HandleFile.
  $sizeBytes = Get-ManifestField $dlBlock 'size_bytes'
  $licenseUrl = Get-ManifestField $dlBlock 'license_url'
  $license = Get-ManifestField $text 'license'
  $reviewStatus = Get-ManifestField $text 'status'
  # Optional download.withdrawn (issue 196): the publisher deleted the exact file this manifest
  # pins, so the URL above is known-dead. Mirrors planModelDownloads' 'source-withdrawn' task
  # status (assets.ts is the source of truth; script-execution.test.ts runs both twins). Note values
  # must not contain ' #' -- Get-ManifestField strips inline YAML comments.
  # Read FLAT on purpose, unlike url/size_bytes: a note in ANY file's download block skips the
  # whole model when something needs fetching. The app plans each file on its own, but a model
  # with one file gone can never be completed, so fetching its other files would only spend GBs
  # on a model that stays missing.
  $withdrawn = Get-ManifestField $text 'withdrawn'

  # A vision model is TWO files: the language GGUF (above) + the mmproj projector (DIST-1). Parse
  # the projector's own block (its local_path/sha256/download.url) -- absent for non-vision models.
  $mmprojBlock = Get-Block $text 'mmproj'
  $mmprojLocal = Get-ManifestField $mmprojBlock 'local_path'
  $mmprojSha = (Get-ManifestField $mmprojBlock 'sha256'); if ($mmprojSha) { $mmprojSha = $mmprojSha.ToLower() }
  $mmprojUrl = Get-ManifestField $mmprojBlock 'url'
  $mmprojSize = Get-ManifestField $mmprojBlock 'size_bytes'

  # #310: the ADDITIONAL required files of a multi-file weight (a GGUF shard set's shards 2..N),
  # read here and hashed only once the model passes the checks below.
  $fileSpecs = @()
  foreach ($member in @(Get-FilesMembers (Get-Block $text 'files'))) {
    $fLocal = Get-ManifestField $member 'local_path'
    $fSha = Get-ManifestField $member 'sha256'; if ($fSha) { $fSha = $fSha.ToLower() }
    $fDlBlock = Get-FileDownloadBlock $member
    $fUrl = Get-ManifestField $fDlBlock 'url'
    $fSize = Get-ManifestField $fDlBlock 'size_bytes'
    $fileSpecs += [pscustomobject]@{ Local = $fLocal; Sha = $fSha; Url = $fUrl; Size = $fSize }
  }

  # A url stands for its download block: the validator requires one in every block.
  $declaresDownload = [bool]$url -or [bool]$mmprojUrl -or (@($fileSpecs | Where-Object { $_.Url }).Count -gt 0)
  if (-not $declaresDownload -or -not $localPath) { continue }      # no download block -> skip
  if ($Only) { $onlyFetchable = $true }
  $planned++

  # Half a download pair (#767): the validator's all-or-nothing rule (shared/manifest.ts, #752),
  # with its messages. The app refuses such a manifest, so any file of it fetched would belong to
  # a model that never starts; without a top-level download the primary file has no source at
  # all. Checked before any file is hashed, whatever is on disk and whatever -AcceptLicense says.
  $halfPair = @()
  if ($mmprojLocal) {
    if ($url -and -not $mmprojUrl) {
      $halfPair += '"mmproj.download" is required when the model declares a top-level "download" (a partial download plan would install a model that cannot start)'
    }
    if ($mmprojUrl -and -not $url) {
      $halfPair += '"download" is required when "mmproj" declares one (a partial download plan would install a model that cannot start)'
    }
  }
  for ($i = 0; $i -lt $fileSpecs.Count; $i++) {
    if ($url -and -not $fileSpecs[$i].Url) {
      $halfPair += ('"files[{0}].download" is required when the model declares a top-level "download" (a partial download plan would install a model that cannot start)' -f $i)
    }
    if ($fileSpecs[$i].Url -and -not $url) {
      $halfPair += ('"download" is required when "files[{0}]" declares one (a partial download plan would install a model that cannot start)' -f $i)
    }
  }
  if ($halfPair.Count -gt 0) {
    foreach ($message in $halfPair) { Write-Host ("  BLOCK  {0}: {1}" -f $id, $message) -ForegroundColor Red }
    Write-Host '         Nothing fetched: the app refuses this manifest, so the model could never start.' -ForegroundColor Red
    $hadFailure = $true
    continue
  }

  $dest = Join-Path $Target ($localPath -replace '/', [IO.Path]::DirectorySeparatorChar)
  $hasMmproj = [bool]($mmprojUrl -and $mmprojLocal)
  $mmprojDest = if ($hasMmproj) { Join-Path $Target ($mmprojLocal -replace '/', [IO.Path]::DirectorySeparatorChar) } else { $null }

  # Classify each file ONCE (a present multi-GB weight is hashed at most once).
  $ggufState = Get-FileState $dest $sha
  $mmprojState = if ($hasMmproj) { Get-FileState $mmprojDest $mmprojSha } else { $null }

  # The files: members, classified once into $filePlans so the later fetch pass never re-hashes.
  $totalFiles = 1 + $fileSpecs.Count
  $filePlans = @()
  foreach ($spec in $fileSpecs) {
    if (-not $spec.Local) { continue }
    $fDest = Join-Path $Target ($spec.Local -replace '/', [IO.Path]::DirectorySeparatorChar)
    $fState = Get-FileState $fDest $spec.Sha
    $filePlans += [pscustomobject]@{ Local = $spec.Local; Sha = $spec.Sha; Url = $spec.Url; Size = $spec.Size; Dest = $fDest; State = $fState }
  }

  # Does anything need the network? (absent / checksum-mismatch). A model already fully present is
  # skipped WITHOUT a license prompt (the license is only relevant to an actual download). @(...):
  # one PSCustomObject has no .Count in 5.1, so a lone member that needed fetching read as none and
  # skipped the license gate and the withdrawn skip (#767).
  $needsFetch = ($ggufState -eq 'absent' -or $ggufState -eq 'mismatch') -or
    ($hasMmproj -and ($mmprojState -eq 'absent' -or $mmprojState -eq 'mismatch')) -or
    (@($filePlans | Where-Object { $_.State -eq 'absent' -or $_.State -eq 'mismatch' }).Count -gt 0)

  # Withdrawn upstream source (issue 196) -- only relevant when something WOULD be fetched: a
  # drive that already carries the weight is unaffected and verifies as usual. Skipped, not
  # failed: one publisher retiring a file must not break a whole drive build.
  if ($needsFetch -and $withdrawn) {
    Write-Host ("  SKIP   {0}: upstream source withdrawn -- {1}" -f $id, $withdrawn) -ForegroundColor Yellow
    Write-Host '         Nothing to fetch; copies already on a drive keep verifying.'
    $skipped++
    continue
  }

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

  Invoke-HandleFile $id '' $dest $sha $url $localPath $ggufState $sizeBytes
  if ($hasMmproj) {
    Invoke-HandleFile $id ' (mmproj)' $mmprojDest $mmprojSha $mmprojUrl $mmprojLocal $mmprojState $mmprojSize
  }
  $fileIdx = 2
  foreach ($fp in $filePlans) {
    $label = " (file {0}/{1})" -f $fileIdx, $totalFiles
    $fileDest = $fp.Dest; $fileSha = $fp.Sha; $fileUrl = $fp.Url; $fileLocal = $fp.Local; $fileState = $fp.State
    $fileSize = $fp.Size
    Invoke-HandleFile $id $label $fileDest $fileSha $fileUrl $fileLocal $fileState $fileSize
    $fileIdx++
  }
}

# An explicit -Only that names nothing fetchable is a usage error, not an empty success: a stale
# default id in prepare-drive -WithAssets would otherwise pass silently (#767).
if ($Only -and -not $onlySeen) {
  Write-Host ("No model manifest with id '{0}' under '{1}'." -f $Only, $ManifestsDir) -ForegroundColor Red
  exit 2
}
if ($Only -and -not $onlyFetchable) {
  Write-Host ("Model '{0}' declares no download block: nothing to fetch." -f $Only) -ForegroundColor Red
  exit 2
}

Write-Host ''
Write-Host ("Planned {0} | fetched {1} | skipped {2}" -f $planned, $fetched, $skipped) -ForegroundColor Cyan
# A Kit with nothing to preload fails at step 2, not after the builder's runtime downloads (#766).
if ($Bundled -and $planned -eq 0) {
  Write-Host 'No bundled model (bundled_on_preconfigured_drive: true) with a download block: a Kit has nothing to preload.' -ForegroundColor Red
  exit 1
}
if ($hadFailure) {
  Write-Host 'One or more models failed to download/verify (or were blocked).' -ForegroundColor Red
  exit 1
}
exit 0
