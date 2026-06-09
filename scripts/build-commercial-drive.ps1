#requires -Version 5.1
<#
.SYNOPSIS
  Build a finished, verified, sellable commercial drive (Phase 13, spec section 12.2).

.DESCRIPTION
  The master pipeline that ties Phase 11 + Phase 12 + signing together. Runs, in order:

    1. prepare-drive  -Force          # commercial policy (encrypted, network denied)
    2. fetch-models   -AcceptLicense  # verified weights
    3. fetch-runtime                  # verified llama.cpp sidecar
    4. package + sign + notarize      # MANUAL (secrets never in the repo) -- see below
    5. copy launcher + portable app + user docs onto the drive root
    6. verify-models  -Generate       # capture real hashes -> config/checksums.json
    7. final check: commercial posture + all weights VERIFIED + no user data

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
  PrivateAIDriveLite-<version>-portable.exe produced + signed on the build machine).

.PARAMETER SkipPackage
  Skip the packaging/signing step entirely (assemble layout + assets + launchers + verify).

.PARAMETER DryRun
  Print the plan and change nothing.

.EXAMPLE
  .\scripts\build-commercial-drive.ps1 -Target E:\ -AcceptLicense -AppArtifact .\release\PrivateAIDriveLite-0.1.0-portable.exe
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

# --- 3. Download + verify the llama.cpp sidecar ------------------------------------
Step 3 'Download + verify the llama.cpp sidecar'
$runtime = @{ Target = $Target }
if ($DryRun) { $runtime.DryRun = $true }
Run 'fetch-runtime.ps1' $runtime

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
$LauncherFiles = @('Start Private AI Drive.cmd', 'Start Private AI Drive.command', 'start-private-ai-drive.sh', 'READ ME FIRST.txt')
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
foreach ($ud in @('workspace/paid.sqlite', 'workspace/paid.sqlite.enc', 'workspace/paid.sqlite-wal', 'workspace/paid.sqlite-shm', 'config/workspace.json')) {
  if (Test-Path (Join-Path $Target $ud)) { $problems += "user data present: $ud" }
}
$docsDir = Join-Path $Target 'workspace/documents'
if ((Test-Path $docsDir) -and (Get-ChildItem -Force $docsDir -ErrorAction SilentlyContinue | Select-Object -First 1)) {
  $problems += 'user data present: workspace/documents/*'
}
if ($DryRun) {
  Write-Host '  (dry run: posture check skipped)'
} elseif ($problems.Count -gt 0) {
  Write-Host '  NOT SELLABLE:' -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "    - $p" -ForegroundColor Red }
  Write-Host '  (verify-models above also enforces weight hashes; fix all before shipping.)'
  exit 1
} else {
  Write-Host '  Posture OK (encrypted, network denied, no user data).' -ForegroundColor Green
  Write-Host '  Confirm verify-models reported every weight VERIFIED (not UNVERIFIED/MISMATCH).'
}

Write-Host "`nDone. Test the drive on a clean laptop with Wi-Fi OFF (spec section 17 demo)." -ForegroundColor Green
