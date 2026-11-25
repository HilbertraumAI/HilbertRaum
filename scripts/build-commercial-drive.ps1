#requires -Version 5.1
<#
.SYNOPSIS
  Build a finished, verified, sellable commercial drive (Phase 13, spec section 12.2).

.DESCRIPTION
  The master pipeline that ties Phase 11 + Phase 12 + signing together. Runs, in order:

    1. prepare-drive  -Force -Kit     # commercial policy (encrypted, network denied) + the Kit's updates key
    2. fetch-models   -Bundled        # the bundled set's verified weights (#766)
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

  Between steps 6 and 7 an un-numbered block writes the build's last two files: the Kit's
  support end, config/kit-support.txt (from -SupportEnd, written once per Kit), then the
  drive's release record, config/drive-release.json (the apps, start files and engines now
  on the drive; docs/app-updates.md sections 8.4 and 8.5). Both are written by node helpers
  under scripts/lib, so node 22.18 or later must be on PATH; the month, node and an existing
  support end are checked before step 1.

  The verdict is assertCommercialDrive's (apps/desktop/src/main/services/commercial-drive.ts,
  the CANONICAL, unit-tested gate). This script orchestrates the existing scripts; it does NOT
  re-implement them. The order of the steps lives here and in the .sh twin alone
  (tests/integration/script-orchestration.test.ts runs it).

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

.PARAMETER SupportEnd
  The month this Kit's support period ends, as YYYY-MM (for example 2031-12): written once
  into config/kit-support.txt (W-17). Required on every run but -VerifyOnly, a -DryRun
  included; not before this computer's current month. The month is echoed in words before
  step 1. A drive that already holds another month is refused before step 1: to re-stamp
  unsold stock, delete config/kit-support.txt on purpose and run again.

.PARAMETER SkipPackage
  Skip the packaging/signing step entirely (assemble layout + assets + launchers + verify).
  The drive is NOT SELLABLE until the app artifacts are on it. The support end and a release
  record without an app version are still written; after copying the apps by hand, write the
  record again (docs/packaging.md) before the -VerifyOnly check.

.PARAMETER VerifyOnly
  Skip steps 1-6 and the record block and run only the final gate against the drive as it
  is: nothing is written, and -SupportEnd is not needed (given, it is ignored).

.PARAMETER DryRun
  Print the plan, download and change nothing -- the final gate still runs and prints
  its verdict for the target as it is.

.EXAMPLE
  .\scripts\build-commercial-drive.ps1 -Target E:\ -AcceptLicense -SupportEnd 2031-12 -AppArtifact .\release\HilbertRaum-0.1.0-portable.exe -Platforms win-x64
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [switch] $AcceptLicense,
  [string[]] $AppArtifact,
  [string[]] $Platforms = @('win-x64', 'mac-arm64', 'linux-x64'),
  [string] $KiwixSourceDir,
  [string] $SupportEnd,
  [switch] $SkipPackage,
  [switch] $VerifyOnly,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
# Every path cmdlet below takes -LiteralPath: in a target such as 'Kit [1]' the brackets are part of
# the name, and a plain -Path reads them as a wildcard that matches nothing (#767).

# Normalize -Target to a full path before passing it to the child scripts (audit M22).
if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
$Target = [System.IO.Path]::GetFullPath($Target)
# The target as the node helpers are handed it. Native-arg quoting (PS 5.1): a trailing backslash before the closing
# quote of a space-containing path escapes the quote, so it goes; a bare drive root like E:\ keeps its backslash.
$NodeTarget = $Target.TrimEnd('\')
if ($NodeTarget -match '^[A-Za-z]:$') { $NodeTarget += '\' }

# The platforms a kit can be sold for -- keep in sync with KIT_PLATFORMS in
# apps/desktop/src/shared/runtime-sources.ts (script-drift test).
$KitPlatforms = @(
  'win-x64',
  'mac-arm64',
  'linux-x64'
)
# Accept both `-Platforms win-x64,mac-arm64` (array binding) and a quoted comma list.
$Platforms = @($Platforms | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
# -AppArtifact is documented comma-separated the same way: under -File a list arrives as ONE string. An
# element that names an existing file stays whole, so a path that itself holds a comma still works.
$AppArtifact = @($AppArtifact | Where-Object { $_ } |
  ForEach-Object { if (Test-Path -LiteralPath $_ -PathType Leaf) { $_ } else { $_ -split ',' } } |
  ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($Platforms.Count -eq 0) { Write-Host '-Platforms must name at least one platform' -ForegroundColor Red; exit 2 }
foreach ($p in $Platforms) {
  if ($KitPlatforms -notcontains $p) {
    Write-Host "Unknown platform '$p' -- known: $($KitPlatforms -join ', ')" -ForegroundColor Red
    exit 2
  }
}
# A Kit's support end (W-17): required on every run that writes, a dry run included, so a rehearsal fails where the run
# would. Checked as a plain string here; the helper below checks the month itself (no binder attribute: a binding error
# prints PowerShell's own text, exits 1 and would be demanded under -VerifyOnly too).
if (-not $VerifyOnly -and -not $SupportEnd) {
  Write-Host "-SupportEnd <YYYY-MM> is required: the month this Kit's support ends (config/kit-support.txt)" -ForegroundColor Red
  exit 2
}
# The version the artifacts must carry = the desktop package's (electron-builder and the
# release workflow name HilbertRaum-<version>-... from apps/desktop/package.json).
$AppVersion = (Get-Content -LiteralPath (Join-Path $RepoRoot 'apps/desktop/package.json') -Raw | ConvertFrom-Json).version

# Refuse to proceed when another app artifact already sits at the drive root (#233): the
# copy in step 4 overwrites only the same basename, so an older build would stay beside
# the new one and the launchers would find two. Delete it first, on purpose.
# Every artifact must exist, too: step 4 copies them only after steps 1-3 have downloaded
# every weight and runtime, which is where a typo used to surface (#769).
if ($AppArtifact -and -not $VerifyOnly) {
  foreach ($artifact in $AppArtifact) {
    if (-not (Test-Path -LiteralPath $artifact)) { Write-Host "AppArtifact not found: $artifact" -ForegroundColor Red; exit 1 }
  }
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
# that fail use `exit 1`, which sets it). Write-Host, not Write-Error: under 'Stop' the
# latter throws, and the `exit 1` after it never ran (AUD-05).
function Run([string]$script, [hashtable]$params) {
  $path = Join-Path $PSScriptRoot $script
  $global:LASTEXITCODE = 0
  & $path @params
  if ($LASTEXITCODE -ne 0) { Write-Host "$script failed (exit $LASTEXITCODE)." -ForegroundColor Red; exit 1 }
}
# Runs a node helper of scripts/lib (node --no-warnings: Node's own warnings name local paths) and shows only the lines
# of its own, each starting with $prefix; returns its exit code. stderr is merged so those lines can be picked out; in
# PowerShell 5.1 a merged stderr line is an error record, which 'Stop' turns into a terminating error, so the call runs
# under 'Continue', in this function's scope only. prepare-drive.ps1 holds the same function (script-drift.test.ts).
function Invoke-NodeHelper([string]$node, [string]$prefix, [string[]]$helperArgs) {
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0
  $lines = @(& $node --no-warnings @helperArgs 2>&1)
  $code = $LASTEXITCODE
  foreach ($line in $lines) {
    $text = "$line"
    if ($text.StartsWith($prefix)) { Write-Host "  $text" }
  }
  return $code
}

Write-Host "Build a COMMERCIAL (sellable) drive at: $Target" -ForegroundColor Green
Write-Host "  platforms: $($Platforms -join ', ') | app version: $AppVersion"
if ($DryRun) { Write-Host '(dry run -- nothing will be changed; the final gate still runs)' -ForegroundColor Yellow }
if ($VerifyOnly) { Write-Host '(verify only -- steps 1-6 skipped)' -ForegroundColor Yellow }

# The Kit's support end and the drive's release record (W-17, W-20; docs/app-updates.md sections 8.4, 8.5) are the
# build's last writes, by two node helpers. Both are checked here, before any download: node itself, the month (in a
# dry run too) and whatever config/kit-support.txt holds already (it is written once per Kit), so a build that could
# not finish stops before step 1, as a missing artifact does (#769). The month is echoed in words for the owner to read.
$KitSupportHelper = Join-Path $RepoRoot 'scripts/lib/write-kit-support.mjs'
$ReleaseHelper = Join-Path $RepoRoot 'scripts/lib/write-drive-release.mjs'
if ($VerifyOnly) {
  if ($SupportEnd) { Write-Host '(verify only -- -SupportEnd ignored: nothing is written)' -ForegroundColor Yellow }
} else {
  $helperNode = Get-Command node -ErrorAction SilentlyContinue
  if (-not $helperNode) {
    Write-Host 'build-commercial-drive needs node 22.18 or later on PATH: it writes config/kit-support.txt and config/drive-release.json' -ForegroundColor Red
    exit 1
  }
  $checkExit = Invoke-NodeHelper $helperNode.Source 'kit-support.txt' @($KitSupportHelper, '--target', $NodeTarget, '--support-end', $SupportEnd, '--check')
  if ($checkExit -eq 2) { exit 2 }
  if ($checkExit -ne 0) { exit 1 }
}

if (-not $VerifyOnly) {
# --- 1. Lay out the drive with the COMMERCIAL policy --------------------------------
Step 1 'Lay out the drive (commercial policy: encryption required, no phone-home)'
$prep = @{ Target = $Target; Force = $true; Kit = $true }
if ($DryRun) { $prep.DryRun = $true }
Run 'prepare-drive.ps1' $prep

# --- 2. Download + verify the bundled model weights --------------------------------
# A Kit preloads only its bundled set (bundled_on_preconfigured_drive: true, #766). Every
# other manifest stays on the drive as the in-app download catalog.
Step 2 'Download + verify the bundled model weights'
$models = @{ Target = $Target; Bundled = $true }
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
# UN-NUMBERED: sits between the runtime sidecars above and packaging below, outside the
# seven numbered steps.
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
    $dst = Join-Path $Target (Split-Path -Leaf $artifact)
    if ($DryRun) { Write-Host "  copy $artifact -> $dst" }
    else { Copy-Item -LiteralPath $artifact -Destination $dst -Recurse -Force; Write-Host "  copied signed app -> $dst" }
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
  if (Test-Path -LiteralPath $src) {
    if ($DryRun) { Write-Host "  copy $f -> drive root" }
    else { Copy-Item -LiteralPath $src -Destination (Join-Path $Target $f) -Force; Write-Host "  copied $f" }
  }
}

# --- 6. Capture real hashes + verify -----------------------------------------------
Step 6 'Capture real hashes + verify all weights'
if ($DryRun) {
  Write-Host '  (dry run: skipping verify-models)'
} else {
  Run 'verify-models.ps1' @{ Target = $Target; Generate = $true }
}

# --- Record what this drive was built with (W-17, W-20) ------------------------------
# UN-NUMBERED, like the kiwix bundle: the build's last writes, after step 6 and before the final check, inside the
# verify-only guard (-VerifyOnly writes neither file). First the Kit's support end, config/kit-support.txt (written once
# per Kit: the same month is kept, another one refused; docs/app-updates.md section 8.4), then the drive's release
# record, config/drive-release.json (the apps, start files and engines now on the drive, section 8.5), which must come
# last: a change after it leaves a record that no longer says what the drive holds. The stamp is in config/, which the
# record never lists. A failure of either stops the build here, with the helper's own line.
Write-Host "`nRecord what this drive was built with" -ForegroundColor Cyan
if ($DryRun) {
  Write-Host "  would write config/kit-support.txt: $SupportEnd"
  Write-Host '  would write config/drive-release.json'
} else {
  $stampExit = Invoke-NodeHelper $helperNode.Source 'kit-support.txt' @($KitSupportHelper, '--target', $NodeTarget, '--support-end', $SupportEnd)
  if ($stampExit -ne 0) { Write-Host "  write-kit-support.mjs failed (exit $stampExit): the build stops here" -ForegroundColor Red; exit 1 }
  $recordExit = Invoke-NodeHelper $helperNode.Source 'drive-release.json' @($ReleaseHelper, '--target', $NodeTarget)
  if ($recordExit -ne 0) { Write-Host "  write-drive-release.mjs failed (exit $recordExit): the build stops here" -ForegroundColor Red; exit 1 }
}
} # end of steps 1-6 (skipped by -VerifyOnly)

# --- 7. Final check: is this drive sellable? ---------------------------------------
Step 7 'Final check: native pre-flight, then the canonical gate (assertCommercialDrive)'
Write-Host '  Native pre-flight of the key invariants (the verdict below comes from the canonical gate):'
$policyPath = Join-Path $Target 'config/policy.json'
$problems = @()
if (Test-Path -LiteralPath $policyPath) {
  $policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
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
# No user data on a drive meant to ship empty (spec 12.2, #893). Mirrors assertCommercialDrive's
# rule (commercial-drive.ts USER_DATA_DIRS / USER_DATA_CONFIG_FILES): every entry directly in these
# folders is user data -- a file or a link by its own name (a link is never followed), a non-empty
# folder as <dir>/<name>/* (an empty one is fine) -- and so is a vault descriptor or a
# working-copy-lost marker in config/, exact or with a suffix, in any case. Fail closed: a folder
# that cannot be listed is "user data unreadable: <dir>/", a file where workspace/, logs/ or config/
# belongs is "user data unreadable: <dir> (not a folder)"; only a missing one passes. A link is a
# symbolic link or a junction, as Node's Dirent reads it: other reparse points (a OneDrive or other
# cloud placeholder folder) are folders.
$UserDataDirs = @(
  'workspace',
  'logs'
)
$UserDataConfigFiles = @(
  'workspace.json',
  'working-copy-lost.json'
)
# The entries of one folder; none, after naming why, when the gate cannot look into it.
function Get-UserDataEntries([string]$Rel) {
  $path = Join-Path $Target $Rel
  if (-not (Test-Path -LiteralPath $path)) { return }
  if (-not (Test-Path -LiteralPath $path -PathType Container)) {
    $script:problems += "user data unreadable: $Rel (not a folder)"
    return
  }
  try {
    Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop
  } catch [System.Management.Automation.ItemNotFoundException], [System.IO.DirectoryNotFoundException] {
    return
  } catch {
    $script:problems += "user data unreadable: $Rel/"
  }
}
foreach ($udDir in $UserDataDirs) {
  foreach ($ud in @(Get-UserDataEntries $udDir)) {
    $udIsLink = $ud.LinkType -eq 'SymbolicLink' -or $ud.LinkType -eq 'Junction'
    if (-not $ud.PSIsContainer -or $udIsLink) {
      $problems += "user data present: $udDir/$($ud.Name)"
      continue
    }
    try {
      $udFirst = Get-ChildItem -LiteralPath $ud.FullName -Force -ErrorAction Stop | Select-Object -First 1
    } catch [System.Management.Automation.ItemNotFoundException], [System.IO.DirectoryNotFoundException] {
      continue
    } catch {
      $problems += "user data unreadable: $udDir/$($ud.Name)/"
      continue
    }
    if ($udFirst) { $problems += "user data present: $udDir/$($ud.Name)/*" }
  }
}
foreach ($cf in @(Get-UserDataEntries 'config')) {
  foreach ($udc in $UserDataConfigFiles) {
    if ($cf.Name -eq $udc -or $cf.Name.StartsWith("$udc.", [System.StringComparison]::OrdinalIgnoreCase)) {
      $problems += "user data present: config/$($cf.Name)"
    }
  }
}
# App skills present + user-skills empty (assertCommercialDrive parity, skills plan S9 / §14):
# a sold drive ships trusted PRODUCT skills under app-skills/ (a folder with a SKILL.md) and an
# EMPTY user-skills/ (the buyer fills it). Mirrors commercial-drive.ts listSkillFolders.
$appSkillsDir = Join-Path $Target 'app-skills'
$appSkillCount = 0
if (Test-Path -LiteralPath $appSkillsDir) {
  $appSkillCount = @(Get-ChildItem -LiteralPath $appSkillsDir -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') }).Count
}
if ($appSkillCount -eq 0) { $problems += 'no app skills provisioned (a sold drive ships trusted product skills under app-skills/)' }
$userSkillsDir = Join-Path $Target 'user-skills'
if (Test-Path -LiteralPath $userSkillsDir) {
  foreach ($us in @(Get-ChildItem -LiteralPath $userSkillsDir -Force -ErrorAction SilentlyContinue)) {
    $problems += "user skill present on a drive meant to ship empty: user-skills/$($us.Name)"
  }
}
# License gate (assertCommercialDrive parity, spec 13): every shipped model's
# license_review.status must be 'approved'. -AcceptLicense is download-time acceptance,
# NEVER a substitute for the redistribution review a sold drive needs. A model ships when
# it is bundled or its weight is on the drive (#766); every other manifest is the in-app
# download catalog, where the model's own license gate applies. A model with only its
# projector or an extra file on the drive fails the weight gate below and the canonical one.
if (-not $DryRun) {
  $driveManifests = Join-Path $Target 'model-manifests'
  if (Test-Path -LiteralPath $driveManifests) {
    # -Include is ignored beside -LiteralPath (PS 5.1 returns every file and dir): filter by extension.
    $mfFiles = @(Get-ChildItem -LiteralPath $driveManifests -Recurse -File | Where-Object { $_.Extension -in '.yaml', '.yml' })
    foreach ($mf in $mfFiles) {
      $text = Get-Content -LiteralPath $mf.FullName -Raw
      # Only model manifests (runtime-sources.yaml has no local_path).
      if (-not ($text -match '(?m)^\s*local_path\s*:\s*(.+?)\s*$')) { continue }
      $mfLocal = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
      $mfBundled = ($text -match '(?m)^\s*bundled_on_preconfigured_drive\s*:\s*true\b')
      if (-not $mfBundled -and -not (Test-Path -LiteralPath (Join-Path $Target ($mfLocal -replace '/', [IO.Path]::DirectorySeparatorChar)))) { continue }
      $reviewStatus = $null
      if ($text -match '(?m)^\s*status\s*:\s*(.+?)\s*$') {
        $reviewStatus = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
      }
      if ($reviewStatus -ne 'approved') {
        # A drive built before #766 carries such a weight; the fix is deleting it, not the review.
        $mfHint = if ($mfBundled) { '' } else { " -- not bundled, its weight is on the drive: delete $mfLocal to list it for in-app download" }
        $problems += "license_review not approved: $($mf.BaseName) (status: $(if ($reviewStatus) { $reviewStatus } else { 'missing' }))$mfHint"
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
  if (-not (Test-Path -LiteralPath $licPath) -or ((Get-Item -LiteralPath $licPath -Force).Length -eq 0)) {
    $problems += "license/attribution artifact missing or empty at the drive root: $lic (re-run prepare-drive)"
  }
}
# Runtime-marker pre-flight (Phase 14): every pinned sidecar
# build must be PRESENT (binary) and carry a .hilbertraum-runtime.json whose version AND
# backend match runtime-sources.yaml -- a missing binary or a missing/stale marker
# means the drive ships the wrong build (e.g. a CPU-era binary after the default moved
# to vulkan, or a half-deleted install). The dir/backend list mirrors the committed
# yaml pin; keep them in sync. NOT assertCommercialDrive's reading of the marker (#1028):
# ConvertFrom-Json takes single quotes and names in any case, so this can pass a marker
# that is damaged. The canonical gate run in step 7 reads it as the app does and is the
# authority; this check only fails early.
if (-not $DryRun) {
  $rtSources = Join-Path $Target 'model-manifests/runtime-sources.yaml'
  if (Test-Path -LiteralPath $rtSources) {
    # Per-family pinned versions (Phase 36: the yaml holds llama_cpp AND whisper_cpp).
    $famVersions = @{}
    $topKey = $null
    foreach ($raw in (Get-Content -LiteralPath $rtSources)) {
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
      # #986: an engine install interrupted on this drive leaves <dir>.new or <dir>.old beside
      # the install until the app's next start there finishes or rolls back the swap. A Kit must
      # not ship either: it is a second engine copy (assertCommercialDrive parity). Exact names.
      foreach ($swapLeft in @("$rtDir.new", "$rtDir.old")) {
        # Get-Item -Force sees the entry itself, a dangling link or junction too (Test-Path follows a
        # symbolic link to its missing target); the .sh twin tests -e || -L, the canonical gate lstat.
        if (Get-Item -LiteralPath (Join-Path $Target $swapLeft) -Force -ErrorAction SilentlyContinue) {
          $problems += "runtime: $swapLeft is left from an interrupted engine install (start the app on this drive once, or delete it)"
        }
      }
      $markerFile = Join-Path $Target "$rtDir/.hilbertraum-runtime.json"
      $binFile = Join-Path $Target "$rtDir/$($rt.bin)"
      if (-not (Test-Path -LiteralPath $binFile)) {
        $problems += "runtime: $($rt.bin) missing under $rtDir (re-run fetch-runtime)"
      } elseif (-not (Test-Path -LiteralPath $markerFile)) {
        $problems += "runtime: no .hilbertraum-runtime.json install marker under $rtDir (re-run fetch-runtime)"
      } else {
        $marker = $null
        try { $marker = Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json } catch {}
        if (-not $marker -or ($rtVersion -and $marker.version -ne $rtVersion) -or $marker.backend -ne $rt.backend) {
          $problems += "runtime: $rtDir marker does not match the pinned $rtVersion/$($rt.backend) (re-run fetch-runtime)"
        }
      }
    }
  } else {
    $problems += 'model-manifests/runtime-sources.yaml missing on the drive'
  }
}
# #986: the knowledge-pack tools are optional, so the matrix above has no row for them, but an engine
# install interrupted on this drive leaves their swap folders just the same (assertCommercialDrive
# parity; script-drift.test.ts holds this list to runtime-sources.yaml). Exact names only.
$KiwixToolsDirs = @(
  'runtime/kiwix-tools/win',
  'runtime/kiwix-tools/mac',
  'runtime/kiwix-tools/linux'
)
if (-not $DryRun) {
  foreach ($ktDir in $KiwixToolsDirs) {
    foreach ($swapLeft in @("$ktDir.new", "$ktDir.old")) {
      if (Get-Item -LiteralPath (Join-Path $Target $swapLeft) -Force -ErrorAction SilentlyContinue) {
        $problems += "runtime: $swapLeft is left from an interrupted engine install (start the app on this drive once, or delete it)"
      }
    }
  }
}
# OCR asset gate (Phase 38, assertCommercialDrive parity): every pinned ocr file must
# be present with a matching sha256 (plain files -- the hash IS the install state).
if (-not $DryRun) {
  $rtSources = Join-Path $Target 'model-manifests/runtime-sources.yaml'
  if (Test-Path -LiteralPath $rtSources) {
    $topKey = $null
    $cur = $null
    $ocrFiles = @()
    foreach ($raw in (Get-Content -LiteralPath $rtSources)) {
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
      if (-not (Test-Path -LiteralPath $dest)) {
        $problems += "ocr: $($f.dest) missing (run fetch-runtime -Family ocr)"
      } elseif ($f.sha256 -match '^[a-f0-9]{64}$') {
        $actual = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $f.sha256.ToLower()) {
          $problems += "ocr: $($f.dest) checksum mismatch (re-run fetch-runtime -Family ocr)"
        }
      }
    }
  }
}
# Weight gate (assertCommercialDrive parity): every weight the Kit ships VERIFIED, at least
# one model bundled (#766), automated -- not a manual "confirm it yourself" instruction.
# UNVERIFIED/MISSING/MISMATCH all fail here.
if (-not $DryRun) {
  $global:LASTEXITCODE = 0
  & (Join-Path $PSScriptRoot 'verify-models.ps1') -Target $Target -Kit
  if ($LASTEXITCODE -ne 0) { $problems += 'weights: verify-models -Kit failed (a shipped weight is not VERIFIED, or no model is bundled)' }
}
if ($DryRun) { Write-Host '  (dry run: weight verification skipped; the canonical gate still runs)' }
# Canonical gate (#233, #234): the verdict is assertCommercialDrive()'s, run through the
# built tool -- SELLABLE is printed only when it passes AND the pre-flight found nothing.
# Reads only the drive (no network). Needs `npm run build` and node on PATH.
$gateTool = Join-Path $RepoRoot 'apps/desktop/out/tools/assert-commercial-drive.mjs'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $gateTool)) {
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
