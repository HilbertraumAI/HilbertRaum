#requires -Version 5.1
<#
.SYNOPSIS
  Build a finished, verified, sellable commercial drive (Phase 13, spec section 12.2).

.DESCRIPTION
  The master pipeline that ties Phase 11 + Phase 12 + signing together. Runs, in order:

    1. prepare-drive  -Force          # commercial policy (encrypted, network denied)
    2. fetch-models   -AcceptLicense  # verified weights
    3. fetch-runtime  -Os win|mac|linux  # verified llama.cpp sidecar for EVERY shipped OS
    4. package + sign + notarize      # MANUAL (secrets never in the repo) -- see below
    5. copy launcher + portable app + user docs onto the drive root
    6. verify-models  -Generate       # capture real hashes -> config/checksums.json
    7. final check: commercial posture + license reviews APPROVED (spec 13; not
       overridable by -AcceptLicense) + verify-models -Strict (all weights VERIFIED)
       + no user data -- exits 1 unless the drive is actually sellable

  Mirrors apps/desktop/src/main/services/commercial-drive.ts (planCommercialDrive +
  assertCommercialDrive) -- that TS module is the CANONICAL, unit-tested reference. This
  script orchestrates the existing scripts; it does NOT re-implement them.

  SIGNING IS MANUAL. The green gate does not sign. Supply a pre-built, signed portable app
  via -AppArtifact, or run with -SkipPackage to assemble everything else and sign/copy the
  app yourself. See docs/packaging.md for how a build machine supplies the certs/creds.

.PARAMETER Target
  The drive root to build onto (e.g. E:\). Required.

.PARAMETER AcceptLicense
  Accept the model licenses non-interactively (required to fetch a gated weight). A SOLD
  drive needs a redistribution-permitting license whose review status is approved (spec 13).

.PARAMETER AppArtifact
  Path to a pre-built, SIGNED portable app to copy onto the drive (e.g. the
  HilbertRaum-<version>-portable.exe produced + signed on the build machine).

.PARAMETER SkipPackage
  Skip the packaging/signing step entirely (assemble layout + assets + launchers + verify).

.PARAMETER DryRun
  Print the plan and change nothing.

.EXAMPLE
  .\scripts\build-commercial-drive.ps1 -Target E:\ -AcceptLicense -AppArtifact .\release\HilbertRaum-0.1.0-portable.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [switch] $AcceptLicense,
  [string] $AppArtifact,
  [switch] $SkipPackage,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Normalize -Target to a full path before passing it to the child scripts (audit M22).
if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
$Target = [System.IO.Path]::GetFullPath($Target)

function Step([int]$n, [string]$msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
# Invoke a sibling script with NAMED parameters. Hashtable splatting (not array splatting)
# is required so -Target is bound by name, not positionally. Reset $LASTEXITCODE first so a
# stale exit code from an earlier command can't be misread as a failure (the child scripts
# that fail use `exit 1`, which sets it).
function Run([string]$script, [hashtable]$params) {
  $path = Join-Path $PSScriptRoot $script
  $global:LASTEXITCODE = 0
  & $path @params
  if ($LASTEXITCODE -ne 0) { Write-Error "$script failed (exit $LASTEXITCODE)."; exit 1 }
}

Write-Host "Build a COMMERCIAL (sellable) drive at: $Target" -ForegroundColor Green
if ($DryRun) { Write-Host '(dry run -- nothing will be changed)' -ForegroundColor Yellow }

# --- 1. Lay out the drive with the COMMERCIAL policy --------------------------------
Step 1 'Lay out the drive (commercial policy: encryption required, network denied)'
$prep = @{ Target = $Target; Force = $true }
if ($DryRun) { $prep.DryRun = $true }
Run 'prepare-drive.ps1' $prep

# --- 2. Download + verify the model weights ----------------------------------------
Step 2 'Download + verify the model weights'
$models = @{ Target = $Target }
if ($AcceptLicense) { $models.AcceptLicense = $true }
if ($DryRun) { $models.DryRun = $true }
Run 'fetch-models.ps1' $models

# --- 3. Download + verify the llama.cpp sidecar builds for EVERY shipped OS ---------
# A sold drive must run on every OS the launchers support (win/mac/linux); fetching only
# the build-host's OS would ship a drive whose mac/linux sidecar dirs are empty. Since
# Phase 14 win/linux ship TWO builds each: the default Vulkan full build (degrades to CPU
# on GPU-less machines) into runtime/llama.cpp/<os>/ plus the pure-CPU safety net into
# runtime/llama.cpp/<os>/cpu/ (the app's fallback ladder rung 3). mac ships Metal only.
Step 3 'Download + verify the llama.cpp sidecar builds (every shipped OS)'
foreach ($osName in @('win', 'mac', 'linux')) {
  $runtime = @{ Target = $Target; Os = $osName }
  if ($DryRun) { $runtime.DryRun = $true }
  Run 'fetch-runtime.ps1' $runtime
  if ($osName -ne 'mac') {
    $cpuNet = @{ Target = $Target; Os = $osName; Backend = 'cpu' }
    if ($DryRun) { $cpuNet.DryRun = $true }
    Run 'fetch-runtime.ps1' $cpuNet
  }
}
# Second sidecar family (Phase 36): the whisper.cpp transcriber CLI. Upstream ships a
# prebuilt WINDOWS build only (R-W1); mac/linux whisper builds are a documented manual
# source-build step (docs/packaging.md) -- audio import degrades to a friendly per-file
# failure on a drive without one.
$whisper = @{ Target = $Target; Os = 'win'; Family = 'whisper_cpp' }
if ($DryRun) { $whisper.DryRun = $true }
Run 'fetch-runtime.ps1' $whisper
# OCR language files (Phase 38, D32): the ocr/ asset class -- plain sha256-verified
# traineddata files, OS-independent (one run covers every shipped OS).
$ocrAssets = @{ Target = $Target; Family = 'ocr' }
if ($DryRun) { $ocrAssets.DryRun = $true }
Run 'fetch-runtime.ps1' $ocrAssets

# --- 4. Package + sign + notarize (MANUAL) -----------------------------------------
Step 4 'Package + sign the portable app (MANUAL -- secrets never in the repo)'
if ($SkipPackage) {
  Write-Host '  -SkipPackage set: skipping packaging. Sign + copy the app yourself.' -ForegroundColor Yellow
} elseif ($AppArtifact) {
  if (-not (Test-Path $AppArtifact)) { Write-Error "AppArtifact not found: $AppArtifact"; exit 1 }
  $dst = Join-Path $Target (Split-Path -Leaf $AppArtifact)
  if ($DryRun) { Write-Host "  copy $AppArtifact -> $dst" }
  else { Copy-Item -Path $AppArtifact -Destination $dst -Force; Write-Host "  copied signed app -> $dst" }
} else {
  Write-Host '  No -AppArtifact supplied. Build + sign the portable .exe, then re-run with' -ForegroundColor Yellow
  Write-Host '  -AppArtifact <path>, or copy it onto the drive manually. See docs/packaging.md.' -ForegroundColor Yellow
}

# --- 5. Copy the launcher + user docs onto the drive root --------------------------
Step 5 'Copy the launcher + user docs onto the drive root'
$LauncherSrc = Join-Path $RepoRoot 'launchers'
$LauncherFiles = @('Start HilbertRaum.cmd', 'Start HilbertRaum.command', 'start-hilbertraum.sh', 'READ ME FIRST.txt')
foreach ($f in $LauncherFiles) {
  $src = Join-Path $LauncherSrc $f
  if (Test-Path $src) {
    if ($DryRun) { Write-Host "  copy $f -> drive root" }
    else { Copy-Item -Path $src -Destination (Join-Path $Target $f) -Force; Write-Host "  copied $f" }
  }
}

# --- 6. Capture real hashes + verify -----------------------------------------------
Step 6 'Capture real hashes + verify all weights'
if ($DryRun) {
  Write-Host '  (dry run: skipping verify-models)'
} else {
  Run 'verify-models.ps1' @{ Target = $Target; Generate = $true }
}

# --- 7. Final check: is this drive sellable? ---------------------------------------
Step 7 'Final check: commercial posture + weights VERIFIED + no user data'
Write-Host '  The CANONICAL gate is assertCommercialDrive() in commercial-drive.ts (unit-tested).'
Write-Host '  Native cross-check of the key invariants:'
$policyPath = Join-Path $Target 'config/policy.json'
$problems = @()
if (Test-Path $policyPath) {
  $policy = Get-Content $policyPath -Raw | ConvertFrom-Json
  if (-not $policy.workspace.encryption_required) { $problems += 'policy: encryption not required' }
  if ($policy.workspace.allow_plaintext_dev_mode) { $problems += 'policy: plaintext allowed' }
  if ($policy.network.allow_model_downloads -or $policy.network.allow_update_checks) { $problems += 'policy: network allowed' }
  if ($policy.network.allow_telemetry) { $problems += 'policy: telemetry allowed' }
  if (-not $policy.models.require_sha256_match) { $problems += 'policy: sha256 match not required' }
} else {
  $problems += 'config/policy.json missing'
}
# No user data on a drive meant to ship empty (spec 12.2). Mirror assertCommercialDrive:
# flat DB/descriptor files + the WAL/SHM sidecars + a non-empty documents dir.
foreach ($ud in @('workspace/hilbertraum.sqlite', 'workspace/hilbertraum.sqlite.enc', 'workspace/hilbertraum.sqlite-wal', 'workspace/hilbertraum.sqlite-shm', 'config/workspace.json')) {
  if (Test-Path (Join-Path $Target $ud)) { $problems += "user data present: $ud" }
}
$docsDir = Join-Path $Target 'workspace/documents'
if ((Test-Path $docsDir) -and (Get-ChildItem -Force $docsDir -ErrorAction SilentlyContinue | Select-Object -First 1)) {
  $problems += 'user data present: workspace/documents/*'
}
# License gate (assertCommercialDrive parity, spec 13): every shipped model's
# license_review.status must be 'approved'. -AcceptLicense is download-time acceptance,
# NEVER a substitute for the redistribution review a sold drive needs.
if (-not $DryRun) {
  $driveManifests = Join-Path $Target 'model-manifests'
  if (Test-Path $driveManifests) {
    $mfFiles = Get-ChildItem -Path $driveManifests -Recurse -Include *.yaml, *.yml
    foreach ($mf in $mfFiles) {
      $text = Get-Content -Path $mf.FullName -Raw
      # Only model manifests (runtime-sources.yaml has no local_path).
      if ($text -notmatch '(?m)^\s*local_path\s*:') { continue }
      $reviewStatus = $null
      if ($text -match '(?m)^\s*status\s*:\s*(.+?)\s*$') {
        $reviewStatus = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
      }
      if ($reviewStatus -ne 'approved') {
        $problems += "license_review not approved: $($mf.BaseName) (status: $(if ($reviewStatus) { $reviewStatus } else { 'missing' }))"
      }
    }
  } else {
    $problems += 'model-manifests missing on the drive'
  }
}
# Runtime-marker gate (assertCommercialDrive parity, Phase 14): every pinned sidecar
# build must be PRESENT (binary) and carry a .hilbertraum-runtime.json whose version AND
# backend match runtime-sources.yaml -- a missing binary or a missing/stale marker
# means the drive ships the wrong build (e.g. a CPU-era binary after the default moved
# to vulkan, or a half-deleted install). The dir/backend list mirrors the committed
# yaml pin; keep them in sync.
if (-not $DryRun) {
  $rtSources = Join-Path $Target 'model-manifests/runtime-sources.yaml'
  if (Test-Path $rtSources) {
    # Per-family pinned versions (Phase 36: the yaml holds llama_cpp AND whisper_cpp).
    $famVersions = @{}
    $topKey = $null
    foreach ($raw in (Get-Content -Path $rtSources)) {
      if ($raw -match '^\s*#') { continue }
      if ($raw -match '^([A-Za-z0-9_]+)\s*:\s*$') { $topKey = $Matches[1]; continue }
      if ($topKey -and -not $famVersions[$topKey] -and $raw -match '^\s*version\s*:\s*(.+?)\s*$') {
        $famVersions[$topKey] = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
      }
    }
    foreach ($rt in @(
      @{ family = 'llama_cpp';   dir = 'runtime/llama.cpp/win';       backend = 'vulkan'; bin = 'llama-server.exe' },
      @{ family = 'llama_cpp';   dir = 'runtime/llama.cpp/win/cpu';   backend = 'cpu';    bin = 'llama-server.exe' },
      @{ family = 'llama_cpp';   dir = 'runtime/llama.cpp/mac';       backend = 'metal';  bin = 'llama-server' },
      @{ family = 'llama_cpp';   dir = 'runtime/llama.cpp/linux';     backend = 'vulkan'; bin = 'llama-server' },
      @{ family = 'llama_cpp';   dir = 'runtime/llama.cpp/linux/cpu'; backend = 'cpu';    bin = 'llama-server' },
      @{ family = 'whisper_cpp'; dir = 'runtime/whisper.cpp/win';     backend = 'cpu';    bin = 'whisper-cli.exe' }
    )) {
      $rtDir = $rt.dir
      $rtVersion = $famVersions[$rt.family]
      $markerFile = Join-Path $Target "$rtDir/.hilbertraum-runtime.json"
      $binFile = Join-Path $Target "$rtDir/$($rt.bin)"
      if (-not (Test-Path $binFile)) {
        $problems += "runtime: $($rt.bin) missing under $rtDir (re-run fetch-runtime)"
      } elseif (-not (Test-Path $markerFile)) {
        $problems += "runtime: no .hilbertraum-runtime.json install marker under $rtDir (re-run fetch-runtime)"
      } else {
        $marker = $null
        try { $marker = Get-Content -Path $markerFile -Raw | ConvertFrom-Json } catch {}
        if (-not $marker -or ($rtVersion -and $marker.version -ne $rtVersion) -or $marker.backend -ne $rt.backend) {
          $problems += "runtime: $rtDir marker does not match the pinned $rtVersion/$($rt.backend) (re-run fetch-runtime)"
        }
      }
    }
  } else {
    $problems += 'model-manifests/runtime-sources.yaml missing on the drive'
  }
}
# OCR asset gate (Phase 38, assertCommercialDrive parity): every pinned ocr file must
# be present with a matching sha256 (plain files -- the hash IS the install state).
if (-not $DryRun) {
  $rtSources = Join-Path $Target 'model-manifests/runtime-sources.yaml'
  if (Test-Path $rtSources) {
    $topKey = $null
    $cur = $null
    $ocrFiles = @()
    foreach ($raw in (Get-Content -Path $rtSources)) {
      if ($raw -match '^\s*#') { continue }
      if ($raw -match '^([A-Za-z0-9_]+)\s*:\s*$') {
        if ($cur) { $ocrFiles += $cur; $cur = $null }
        $topKey = $Matches[1]; continue
      }
      if ($topKey -ne 'ocr') { continue }
      if ($raw -match '^\s*-\s*lang\s*:\s*(.+?)\s*$') {
        if ($cur) { $ocrFiles += $cur }
        $cur = [ordered]@{ lang = ($Matches[1] -replace '\s+#.*$', '').Trim() }
        continue
      }
      if ($cur -and $raw -match '^\s+([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$') {
        $cur[$Matches[1].Trim()] = ($Matches[2] -replace '\s+#.*$', '').Trim()
      }
    }
    if ($cur) { $ocrFiles += $cur }
    foreach ($f in $ocrFiles) {
      $dest = Join-Path $Target ($f.dest -replace '/', [IO.Path]::DirectorySeparatorChar)
      if (-not (Test-Path $dest)) {
        $problems += "ocr: $($f.dest) missing (run fetch-runtime -Family ocr)"
      } elseif ($f.sha256 -match '^[a-f0-9]{64}$') {
        $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $f.sha256.ToLower()) {
          $problems += "ocr: $($f.dest) checksum mismatch (re-run fetch-runtime -Family ocr)"
        }
      }
    }
  }
}
# Weight gate (assertCommercialDrive parity): every weight VERIFIED, automated -- not a
# manual "confirm it yourself" instruction. UNVERIFIED/MISSING/MISMATCH all fail here.
if (-not $DryRun) {
  $global:LASTEXITCODE = 0
  & (Join-Path $PSScriptRoot 'verify-models.ps1') -Target $Target -Strict
  if ($LASTEXITCODE -ne 0) { $problems += 'weights: not every weight is VERIFIED (strict verify failed)' }
}
if ($DryRun) {
  Write-Host '  (dry run: posture + weight checks skipped)'
} elseif ($problems.Count -gt 0) {
  Write-Host '  NOT SELLABLE:' -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "    - $p" -ForegroundColor Red }
  exit 1
} else {
  Write-Host '  SELLABLE: posture OK (encrypted, network denied, no user data) + all weights VERIFIED.' -ForegroundColor Green
}

Write-Host "`nDone. Test the drive on a clean laptop with Wi-Fi OFF (spec section 17 demo)." -ForegroundColor Green
