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
  MISMATCH/UNSUPPORTED all fail) and at least one weight exists.

.PARAMETER Kit
  The Kit ship gate, -Strict over what a preconfigured Kit ships (#766): every bundled
  model (bundled_on_preconfigured_drive: true, at least one of them) and every model with
  any file on the drive. A model with no file on the drive is the in-app download catalog,
  listed as CATALOG and not verified. Implies -Strict. Mirrors
  services/commercial-drive.ts assertCommercialDrive's weightsVerified check.

.EXAMPLE
  .\scripts\verify-models.ps1 -Target E:\
  .\scripts\verify-models.ps1 -Target E:\ -Generate
  .\scripts\verify-models.ps1 -Target E:\ -Strict
  .\scripts\verify-models.ps1 -Target E:\ -Kit
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [switch] $Generate,
  [switch] $Strict,
  [switch] $Kit
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Normalize -Target to a full path: .NET IO ([System.IO.File]::WriteAllText below)
# resolves relative paths against the PROCESS working directory, which does not follow
# Set-Location (audit M22).
if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
$Target = [System.IO.Path]::GetFullPath($Target)

# Every path cmdlet below takes -LiteralPath (#767): a drive root such as `Kit [2026]` is a
# wildcard to -Path, so Test-Path found no manifests there and the run verified the repo's.
# Prefer the drive's own manifests; fall back to the repo's committed ones.
$ManifestsDir = Join-Path $Target 'model-manifests'
if (-not (Test-Path -LiteralPath $ManifestsDir)) { $ManifestsDir = Join-Path $RepoRoot 'model-manifests' }
if (-not (Test-Path -LiteralPath $ManifestsDir)) {
  # Reported with Write-Host, not Write-Error (AUD-05): under $ErrorActionPreference = 'Stop'
  # a Write-Error is a SCRIPT-TERMINATING exception, so the `exit 2` below would never run
  # (the process would exit 1, collapsing the config-error code into the verification-failure
  # code) and the exception would propagate out of the `&` call of a parent script and kill it
  # before it could inspect $LASTEXITCODE and report its own verdict.
  Write-Host "No model-manifests found under '$Target' or repo root." -ForegroundColor Red
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

# Supported (runtime -> format) pairs — mirror models.ts SUPPORTED_RUNTIME_FORMATS (the app's
# §7.4 gate; drift test M-A1). A ggml/whisper_cpp weight (the bundled transcriber) has a real
# sha256 and verifies by SHA-256 like any GGUF; only a genuinely unloadable pair is UNSUPPORTED.
$SupportedRuntimeFormats = [ordered]@{
  'llama_cpp'   = 'gguf'
  'llama.cpp'   = 'gguf'
  'whisper_cpp' = 'ggml'
}

# Extract the indented body of a top-level `<key>:` mapping -- lines from `<key>:` until the
# next column-0 key. Get-ManifestField then reads it. Two blocks are read this way: `mmproj:`
# (the SECOND file of a vision model, DIST-2: verify BOTH files) and `files:` (the ADDITIONAL
# required files of a multi-file weight, #310, e.g. a GGUF shard set's shards 2..N). `files:` is
# emitted AFTER local_path/sha256/download/mmproj in every manifest (model-policy.md key-order
# rule), so it never poisons the flat top-level reads.
function Get-Block([string]$text, [string]$key) {
  $out = New-Object System.Collections.Generic.List[string]
  $inBlk = $false
  # The key line may carry a comment, and a comment line at column 0 does not end a mapping (YAML).
  $head = '^' + [Regex]::Escape($key) + ':\s*(#.*)?$'
  foreach ($line in ($text -split "`n")) {
    if (-not $inBlk) {
      if ($line -match $head) { $inBlk = $true }
    } elseif ($line -match '^#') {
      continue
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

# Classify one weight file against its expected hash (mirrors services/models.ts verifyChecksum).
function Get-WeightStatus([string]$weight, [string]$sha) {
  if (-not (Test-Path -LiteralPath $weight)) { return 'MISSING' }
  $actual = (Get-FileHash -LiteralPath $weight -Algorithm SHA256).Hash.ToLower()
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
# fragility if it ever gains one. -LiteralPath with -Include returns every item in 5.1 (the
# filter is ignored), so the extensions are filtered by hand.
$manifestFiles = @(Get-ChildItem -LiteralPath $ManifestsDir -Recurse -File |
  Where-Object { $_.Extension -in @('.yaml', '.yml') -and $_.Name -notin @('runtime-sources.yaml', 'runtime-sources.yml') })
if ($manifestFiles.Count -eq 0) { Write-Host "No model manifests found under '$ManifestsDir' -- nothing to verify." -ForegroundColor Yellow }
$results = @()
$hadMismatch = $false
$bundledModels = 0

foreach ($mf in $manifestFiles) {
  $text = Get-Content -LiteralPath $mf.FullName -Raw
  $id = Get-ManifestField $text 'id'
  $localPath = Get-ManifestField $text 'local_path'
  $sha = (Get-ManifestField $text 'sha256')
  if ($sha) { $sha = $sha.ToLower() }
  $runtime = Get-ManifestField $text 'runtime'
  $format = Get-ManifestField $text 'format'
  if (-not $localPath) { continue }

  # A vision model is TWO files: the language GGUF + the mmproj projector (DIST-2).
  $mmprojBlock = Get-Block $text 'mmproj'
  $mmprojLocal = Get-ManifestField $mmprojBlock 'local_path'
  $mmprojSha = (Get-ManifestField $mmprojBlock 'sha256'); if ($mmprojSha) { $mmprojSha = $mmprojSha.ToLower() }

  # #310: the ADDITIONAL required files of a multi-file weight (a GGUF shard set's shards
  # 2..N), each verified with an " (file N/M)" label — M is the primary plus every declared
  # file (mmproj is reported separately and does not count towards M).
  $fileMembers = @(Get-FilesMembers (Get-Block $text 'files'))
  $totalFiles = 1 + $fileMembers.Count

  # -Kit (#766): a model ships when it is bundled or has any file on the drive. Every other
  # manifest is the in-app download catalog, where the app's own download gates apply.
  if ($Kit) {
    if ((Get-ManifestField $text 'bundled_on_preconfigured_drive') -eq 'true') {
      $bundledModels++
    } else {
      $paths = @($localPath)
      if ($mmprojLocal) { $paths += $mmprojLocal }
      foreach ($member in $fileMembers) {
        $fLocal = Get-ManifestField $member 'local_path'
        if ($fLocal) { $paths += $fLocal }
      }
      $present = @($paths | Where-Object { Test-Path -LiteralPath (Join-Path $Target ($_ -replace '/', [IO.Path]::DirectorySeparatorChar)) })
      if ($present.Count -eq 0) {
        Write-Host ("  {0,-12} {1}" -f 'CATALOG', $id) -ForegroundColor Gray
        continue
      }
    }
  }

  # A runtime the table does not name, or none at all, is UNSUPPORTED (the app's
  # isSupportedRuntimeFormat). Indexing the table with a null runtime threw and ended the run
  # with no later model reported, and an unknown runtime with no format compared $null with
  # $null and passed (#767).
  if (-not $runtime -or -not $SupportedRuntimeFormats.Contains($runtime) -or $SupportedRuntimeFormats[$runtime] -ne $format) {
    Write-WeightResult $id '' 'UNSUPPORTED'
    continue
  }

  $weight = Join-Path $Target ($localPath -replace '/', [IO.Path]::DirectorySeparatorChar)
  Write-WeightResult $id '' (Get-WeightStatus $weight $sha)
  if ($mmprojLocal) {
    $mmprojWeight = Join-Path $Target ($mmprojLocal -replace '/', [IO.Path]::DirectorySeparatorChar)
    Write-WeightResult $id ' (mmproj)' (Get-WeightStatus $mmprojWeight $mmprojSha)
  }
  $fileIdx = 2
  foreach ($member in $fileMembers) {
    $fLocal = Get-ManifestField $member 'local_path'
    $fSha = Get-ManifestField $member 'sha256'; if ($fSha) { $fSha = $fSha.ToLower() }
    if ($fLocal) {
      $fWeight = Join-Path $Target ($fLocal -replace '/', [IO.Path]::DirectorySeparatorChar)
      $label = " (file {0}/{1})" -f $fileIdx, $totalFiles
      Write-WeightResult $id $label (Get-WeightStatus $fWeight $fSha)
    }
    $fileIdx++
  }
}

if ($Generate) {
  $entries = foreach ($mf in $manifestFiles) {
    $text = Get-Content -LiteralPath $mf.FullName -Raw
    $id = Get-ManifestField $text 'id'
    $localPath = Get-ManifestField $text 'local_path'
    if (-not $localPath) { continue }
    # One entry per FILE: the GGUF, a vision model's mmproj projector (DIST-2), plus every
    # ADDITIONAL declared file (#310) — same order as manifestFiles().
    $paths = @($localPath)
    $mmprojLocal = Get-ManifestField (Get-Block $text 'mmproj') 'local_path'
    if ($mmprojLocal) { $paths += $mmprojLocal }
    $fileMembers = @(Get-FilesMembers (Get-Block $text 'files'))
    foreach ($member in $fileMembers) {
      $fLocal = Get-ManifestField $member 'local_path'
      if ($fLocal) { $paths += $fLocal }
    }
    foreach ($lp in $paths) {
      $weight = Join-Path $Target ($lp -replace '/', [IO.Path]::DirectorySeparatorChar)
      $present = Test-Path -LiteralPath $weight
      [ordered]@{
        id         = $id
        local_path = $lp
        sha256     = if ($present) { (Get-FileHash -LiteralPath $weight -Algorithm SHA256).Hash.ToLower() } else { $null }
        size_bytes = if ($present) { (Get-Item -LiteralPath $weight).Length } else { $null }
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
if ($Strict -or $Kit) {
  if ($Kit -and $bundledModels -eq 0) {
    Write-Host 'KIT: no bundled model (bundled_on_preconfigured_drive: true) - a Kit ships its bundled set preloaded.' -ForegroundColor Red
    exit 1
  }
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
