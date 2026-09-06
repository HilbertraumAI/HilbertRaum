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
    7. final check: the CANONICAL gate (assertCommercialDrive, run through the built
       apps/desktop/out/tools/assert-commercial-drive.mjs -- needs `npm run build` and
       node on PATH) after a native pre-flight -- exits 1 unless the drive is sellable.
       SELLABLE is printed only from the canonical verdict (#233, #234). The gate also
       requires the app artifact + launcher for every platform in -Platforms and a
       recorded, matching hash for every sidecar binary.

  Mirrors apps/desktop/src/main/services/commercial-drive.ts (planCommercialDrive +
  assertCommercialDrive) -- that TS module is the CANONICAL, unit-tested reference. This
  script orchestrates the existing scripts; it does NOT re-implement them.

  SIGNING IS MANUAL. The green gate does not sign. Supply the pre-built, signed app(s)
  via -AppArtifact, or run with -SkipPackage to assemble everything else and sign/copy the
  app yourself. See docs/packaging.md for how a build machine supplies the certs/creds.

.PARAMETER Target
  The drive root to build onto (e.g. E:\). Required.

.PARAMETER AcceptLicense
  Accept the model licenses non-interactively (required to fetch a gated weight). A SOLD
  drive needs a redistribution-permitting license whose review status is approved (spec 13).

.PARAMETER AppArtifact
  Path(s) to the pre-built, SIGNED app artifact(s) to copy onto the drive -- one per
  platform in -Platforms (e.g. HilbertRaum-<version>-portable.exe, the
  HilbertRaum-<version>-mac-arm64.app.zip, HilbertRaum-<version>.AppImage). Comma-separated.
  The script REFUSES to proceed when a differently named HilbertRaum-* artifact (or an
  extracted .app) already sits at the drive root -- delete the old build first (#233).

.PARAMETER Platforms
  The platforms this kit is sold for (win-x64, mac-arm64, linux-x64; default all three).
  The gate requires an app artifact + launcher for each -- and none for any other.

.PARAMETER KiwixSourceDir
  The maintainer-local archive directory holding the five pinned kiwix-tools copyleft source
  tarballs (#339 P8-4). When supplied, the script installs the corresponding-source bundle at
  runtime/kiwix-tools/source/ (scripts/install-kiwix-source-bundle.mjs) BEFORE fetching the
  kiwix_tools binaries for every Kit platform -- so an aborted install never leaves binaries
  without their source. Omitted (default): this Kit ships no kiwix-tools at all; the buyer
  installs the family in-app instead. See docs/packaging.md.

.PARAMETER SkipPackage
  Skip the packaging/signing step entirely (assemble layout + assets + launchers + verify).
  The drive is NOT SELLABLE until the app artifacts are on it.

.PARAMETER VerifyOnly
  Skip steps 1-6 and run only the final gate against the drive as it is.

.PARAMETER DryRun
  Print the plan, download and change nothing -- the final gate still runs and prints
  its verdict for the target as it is.

.EXAMPLE
  .\scripts\build-commercial-drive.ps1 -Target E:\ -AcceptLicense -AppArtifact .\release\HilbertRaum-0.1.0-portable.exe -Platforms win-x64
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [switch] $AcceptLicense,
  [string[]] $AppArtifact,
  [string[]] $Platforms = @('win-x64', 'mac-arm64', 'linux-x64'),
  [string] $KiwixSourceDir,
  [switch] $SkipPackage,
  [switch] $VerifyOnly,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Normalize -Target to a full path before passing it to the child scripts (audit M22).
if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
$Target = [System.IO.Path]::GetFullPath($Target)

# The platforms a kit can be sold for -- keep in sync with KIT_PLATFORMS in
# apps/desktop/src/shared/runtime-sources.ts (script-drift test).
$KitPlatforms = @(
  'win-x64',
  'mac-arm64',
  'linux-x64'
)
# Accept both `-Platforms win-x64,mac-arm64` (array binding) and a quoted comma list.
$Platforms = @($Platforms | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($Platforms.Count -eq 0) { Write-Host '-Platforms must name at least one platform' -ForegroundColor Red; exit 2 }
foreach ($p in $Platforms) {
  if ($KitPlatforms -notcontains $p) {
    Write-Host "Unknown platform '$p' -- known: $($KitPlatforms -join ', ')" -ForegroundColor Red
    exit 2
  }
}
# The version the artifacts must carry = the desktop package's (electron-builder and the
# release workflow name HilbertRaum-<version>-... from apps/desktop/package.json).
$AppVersion = (Get-Content (Join-Path $RepoRoot 'apps/desktop/package.json') -Raw | ConvertFrom-Json).version

# Refuse to proceed when another app artifact already sits at the drive root (#233): the
# copy in step 4 overwrites only the same basename, so an older build would stay beside
# the new one and the launchers would find two. Delete it first, on purpose.
if ($AppArtifact -and -not $VerifyOnly) {
  $incoming = @($AppArtifact | ForEach-Object { Split-Path -Leaf $_ })
  $prior = @(Get-ChildItem -LiteralPath $Target -Force -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -like 'HilbertRaum-*' -or ($_.PSIsContainer -and $_.Name -like '*.app')) -and ($incoming -notcontains $_.Name) })
  if ($prior.Count -gt 0) {
    Write-Host 'Refusing to proceed: another app artifact already sits at the drive root:' -ForegroundColor Red
    foreach ($p in $prior) { Write-Host "  - $($p.Name)" -ForegroundColor Red }
    Write-Host '  Delete it first (a drive must carry exactly one app build), then re-run.' -ForegroundColor Red
    exit 1
  }
}

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
Write-Host "  platforms: $($Platforms -join ', ') | app version: $AppVersion"
if ($DryRun) { Write-Host '(dry run -- nothing will be changed; the final gate still runs)' -ForegroundColor Yellow }
if ($VerifyOnly) { Write-Host '(verify only -- steps 1-6 skipped)' -ForegroundColor Yellow }

if (-not $VerifyOnly) {
# --- 1. Lay out the drive with the COMMERCIAL policy --------------------------------
Step 1 'Lay out the drive (commercial policy: encryption required, no phone-home)'
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
# -Commercial (#234): a placeholder archive hash is refused before any download, a
# hashless (legacy) install marker is re-fetched instead of skipped, and the marker
# records the binary hash only after a verified archive.
foreach ($osName in @('win', 'mac', 'linux')) {
  $runtime = @{ Target = $Target; Os = $osName; Commercial = $true }
  if ($DryRun) { $runtime.DryRun = $true }
  Run 'fetch-runtime.ps1' $runtime
  if ($osName -ne 'mac') {
    $cpuNet = @{ Target = $Target; Os = $osName; Backend = 'cpu'; Commercial = $true }
    if ($DryRun) { $cpuNet.DryRun = $true }
    Run 'fetch-runtime.ps1' $cpuNet
  }
}
# Second sidecar family (Phase 36): the whisper.cpp transcriber CLI. Upstream ships a
# prebuilt WINDOWS build only (R-W1); mac/linux whisper builds are a documented manual
# source-build step (docs/packaging.md) -- audio import degrades to a friendly per-file
# failure on a drive without one.
$whisper = @{ Target = $Target; Os = 'win'; Family = 'whisper_cpp'; Commercial = $true }
if ($DryRun) { $whisper.DryRun = $true }
Run 'fetch-runtime.ps1' $whisper
# OCR language files (Phase 38, D32): the ocr/ asset class -- plain sha256-verified
# traineddata files, OS-independent (one run covers every shipped OS).
$ocrAssets = @{ Target = $Target; Family = 'ocr'; Commercial = $true }
if ($DryRun) { $ocrAssets.DryRun = $true }
Run 'fetch-runtime.ps1' $ocrAssets

# --- Kiwix-tools corresponding-source bundle (#339 P8-4) ---------------------------
# UN-NUMBERED: sits between the runtime sidecars above and packaging below, but is not
# one of the seven planCommercialDrive step ids (commercial-drive.test.ts pins those).
# SOURCE FIRST: the bundle is installed + re-verified BEFORE the kiwix_tools binaries are
# fetched, so a failed/aborted install can never leave binaries on the drive without their
# complete corresponding source. Omitted -KiwixSourceDir = this Kit ships no kiwix-tools at
# all; the buyer installs the (unbundled) family in-app instead (its own download, its own
# consent) -- checkSourceBundle then finds no kiwix_tools binary present and passes.
if (-not $KiwixSourceDir) {
  Write-Host "`n(no -KiwixSourceDir: this Kit ships no kiwix-tools; the buyer installs the family in-app)" -ForegroundColor Yellow
} else {
  Write-Host "`nInstalling the kiwix-tools corresponding-source bundle (#339 P8-4)" -ForegroundColor Cyan
  $kiwixNodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $kiwixNodeCmd) {
    Write-Host '  install-kiwix-source-bundle.mjs needs node on PATH' -ForegroundColor Red
    exit 1
  }
  $kiwixInstallScript = Join-Path $RepoRoot 'scripts/install-kiwix-source-bundle.mjs'
  $kiwixInstallArgs = @($kiwixInstallScript, '--target', $Target, '--source-dir', $KiwixSourceDir)
  if ($DryRun) { $kiwixInstallArgs += '--dry-run' }
  $global:LASTEXITCODE = 0
  & $kiwixNodeCmd.Source @kiwixInstallArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  install-kiwix-source-bundle.mjs failed (exit $LASTEXITCODE) -- refusing to fetch kiwix-tools binaries without their source" -ForegroundColor Red
    exit 1
  }
  Write-Host '  Fetching the kiwix-tools binaries for every Kit platform (explicit -Arch, never inherited from the yaml)'
  foreach ($kiwixPlat in @(
    @{ Os = 'win'; Arch = 'x64' },
    @{ Os = 'mac'; Arch = 'arm64' },
    @{ Os = 'linux'; Arch = 'x64' }
  )) {
    $kiwixRuntime = @{ Target = $Target; Os = $kiwixPlat.Os; Arch = $kiwixPlat.Arch; Family = 'kiwix_tools'; Commercial = $true }
    if ($DryRun) { $kiwixRuntime.DryRun = $true }
    Run 'fetch-runtime.ps1' $kiwixRuntime
  }
}

# --- 4. Package + sign + notarize (MANUAL) -----------------------------------------
Step 4 'Package + sign the portable app (MANUAL -- secrets never in the repo)'
if ($SkipPackage) {
  Write-Host '  -SkipPackage set: skipping packaging. Sign + copy the app yourself (NOT SELLABLE until then).' -ForegroundColor Yellow
} elseif ($AppArtifact) {
  foreach ($artifact in $AppArtifact) {
    if (-not (Test-Path $artifact)) { Write-Host "AppArtifact not found: $artifact" -ForegroundColor Red; exit 1 }
    $dst = Join-Path $Target (Split-Path -Leaf $artifact)
    if ($DryRun) { Write-Host "  copy $artifact -> $dst" }
    else { Copy-Item -Path $artifact -Destination $dst -Recurse -Force; Write-Host "  copied signed app -> $dst" }
  }
} else {
  Write-Host '  No -AppArtifact supplied. Build + sign the app for every platform in -Platforms, then' -ForegroundColor Yellow
  Write-Host '  re-run with -AppArtifact <paths>, or copy them onto the drive manually. See docs/packaging.md.' -ForegroundColor Yellow
}

# --- 5. Copy the launcher + user docs onto the drive root --------------------------
# NOTE: the root license/attribution artifacts (LICENSE, THIRD-PARTY-NOTICES.md,
# DRIVE-NOTICES.md — LIC-1) are NOT re-copied here: step 1 runs prepare-drive, whose
# base flow already places them at the drive root; the step-7 gate below verifies them.
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
} # end of steps 1-6 (skipped by -VerifyOnly)

# --- 7. Final check: is this drive sellable? ---------------------------------------
Step 7 'Final check: native pre-flight, then the canonical gate (assertCommercialDrive)'
Write-Host '  Native pre-flight of the key invariants (the verdict below comes from the canonical gate):'
$policyPath = Join-Path $Target 'config/policy.json'
$problems = @()
if (Test-Path $policyPath) {
  $policy = Get-Content $policyPath -Raw | ConvertFrom-Json
  if (-not $policy.workspace.encryption_required) { $problems += 'policy: encryption not required' }
  if ($policy.workspace.allow_plaintext_dev_mode) { $problems += 'policy: plaintext allowed' }
  # Model downloads are a permitted, user-initiated action on a sold drive; only phone-home
  # channels (update checks, telemetry) must be denied. Mirrors commercial-drive.ts networkDenied.
  if ($policy.network.allow_update_checks) { $problems += 'policy: update checks allowed' }
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
# App skills present + user-skills empty (assertCommercialDrive parity, skills plan S9 / §14):
# a sold drive ships trusted PRODUCT skills under app-skills/ (a folder with a SKILL.md) and an
# EMPTY user-skills/ (the buyer fills it). Mirrors commercial-drive.ts listSkillFolders.
$appSkillsDir = Join-Path $Target 'app-skills'
$appSkillCount = 0
if (Test-Path $appSkillsDir) {
  $appSkillCount = @(Get-ChildItem -Directory $appSkillsDir -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') }).Count
}
if ($appSkillCount -eq 0) { $problems += 'no app skills provisioned (a sold drive ships trusted product skills under app-skills/)' }
$userSkillsDir = Join-Path $Target 'user-skills'
if (Test-Path $userSkillsDir) {
  foreach ($us in @(Get-ChildItem -Force $userSkillsDir -ErrorAction SilentlyContinue)) {
    $problems += "user skill present on a drive meant to ship empty: user-skills/$($us.Name)"
  }
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
# License/attribution artifacts gate (assertCommercialDrive parity, LIC-1, full-audit
# 2026-07-12b): a sold drive ships MIT binaries + Apache-2.0 weights/traineddata + the
# GPL app — the three root notice files prepare-drive copies discharge the recorded
# "ship the LICENSE/NOTICE attribution with the drive" requirements. Missing OR EMPTY
# fails. Keep in sync with commercial-drive.ts DRIVE_LICENSE_ARTIFACTS (script-drift test).
$LicenseArtifacts = @(
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'DRIVE-NOTICES.md'
)
foreach ($lic in $LicenseArtifacts) {
  $licPath = Join-Path $Target $lic
  # -Force: a HIDDEN root artifact would otherwise make Get-Item throw under
  # $ErrorActionPreference = 'Stop' instead of reaching the SELLABLE verdict below.
  if (-not (Test-Path $licPath) -or ((Get-Item -Force $licPath).Length -eq 0)) {
    $problems += "license/attribution artifact missing or empty at the drive root: $lic (re-run prepare-drive)"
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
if ($DryRun) { Write-Host '  (dry run: weight verification skipped; the canonical gate still runs)' }
# Canonical gate (#233, #234): the verdict is assertCommercialDrive()'s, run through the
# built tool -- SELLABLE is printed only when it passes AND the pre-flight found nothing.
# Reads only the drive (no network). Needs `npm run build` and node on PATH.
$gateTool = Join-Path $RepoRoot 'apps/desktop/out/tools/assert-commercial-drive.mjs'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not (Test-Path $gateTool)) {
  $problems += "canonical gate not built: $gateTool missing (run npm run build)"
} elseif (-not $nodeCmd) {
  $problems += 'canonical gate needs node on PATH'
} else {
  Write-Host '  Canonical gate:'
  $global:LASTEXITCODE = 0
  # Native-arg quoting (PS 5.1): a trailing backslash before the closing quote of a
  # space-containing path escapes the quote -- hand node the path without it (a bare
  # drive root like E:\ keeps its backslash).
  $gateTarget = $Target.TrimEnd('\')
  if ($gateTarget -match '^[A-Za-z]:$') { $gateTarget += '\' }
  & $nodeCmd.Source $gateTool --target $gateTarget --platforms ($Platforms -join ',') --app-version $AppVersion
  if ($LASTEXITCODE -ne 0) { $problems += "canonical gate: not sellable (exit $LASTEXITCODE, see above)" }
}
if ($problems.Count -gt 0) {
  Write-Host '  NOT SELLABLE:' -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "    - $p" -ForegroundColor Red }
  exit 1
}
Write-Host "  SELLABLE: canonical gate passed for $($Platforms -join ', ') at $AppVersion." -ForegroundColor Green

Write-Host "`nDone. Test the drive on a clean laptop with Wi-Fi OFF (spec section 17 demo)." -ForegroundColor Green
