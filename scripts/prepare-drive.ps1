#requires -Version 5.1
<#
.SYNOPSIS
  Lay out a HilbertRaum portable drive (spec §6 / Phase 11).

.DESCRIPTION
  Creates the directory tree the app actually reads (workspace/, models/{chat,embeddings}/,
  model-manifests/, runtime/llama.cpp/{win,mac,linux}/, logs/, config/, docs/), copies the
  committed model manifests + user docs onto the drive, and generates the
  config/{drive,policy}.json files. It does NOT download model weights or sidecar binaries
  (those are git-ignored and not in the repo, R5) — it tells you where to drop them.

  Idempotent: re-running is safe. config/*.json are only (re)written with -Force.

  The canonical, unit-tested reference for this layout + the config shapes is
  apps/desktop/src/main/services/drive.ts. Keep the two in sync.

.PARAMETER Target
  The drive root to prepare, e.g. E:\ (Windows), or any folder. Required.

.PARAMETER DryRun
  Print the plan and create nothing.

.PARAMETER Force
  Overwrite existing config/drive.json + config/policy.json.

.PARAMETER Dev
  Generate a developer-friendly policy.json (plaintext workspace + unverified models
  allowed). Default is the commercial posture (encryption required, models must verify).
  Model downloads are PERMITTED either way (still gated by the in-app allowNetwork setting +
  a per-download confirmation); update-checks + telemetry stay off (the app never phones home).

.PARAMETER WithAssets
  After laying out the tree, download + verify a launch-ready default asset set (invokes
  fetch-models.ps1 + fetch-runtime.ps1) so one command yields a usable drive. Build-time
  network only — the app itself stays offline. To keep setup fast the default set is small
  but complete for the core features: the default chat model (Ministral 3 8B), the embeddings
  model, the reranker, the Whisper transcriber model, and the Qwen2.5-VL image-description
  model (GGUF + mmproj), PLUS both sidecar runtimes (llama.cpp + whisper.cpp) and the OCR
  language files (deu/eng traineddata for scanned-PDF and photo text recognition, Phase 38 --
  OS-independent, ~4 MB). The user downloads any other models (larger chat models) from inside
  the app. Without this flag the behaviour is unchanged (layout + config; you drop artifacts
  in by hand).

.PARAMETER AllModels
  With -WithAssets, fetch ALL models with a download block (every chat model + embeddings +
  reranker + transcriber) instead of the small default set. Slower; for building a fully
  provisioned drive. The sidecar runtimes are fetched either way.

.PARAMETER AcceptLicense
  Forwarded to fetch-models.ps1 (accept the model licenses) when -WithAssets is used.

.EXAMPLE
  .\scripts\prepare-drive.ps1 -Target E:\ -DryRun
  .\scripts\prepare-drive.ps1 -Target E:\
  .\scripts\prepare-drive.ps1 -Target E:\ -WithAssets -AcceptLicense
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [switch] $DryRun,
  [switch] $Force,
  [switch] $Dev,
  [switch] $WithAssets,
  [switch] $AllModels,
  [switch] $AcceptLicense
)

$ErrorActionPreference = 'Stop'

# The models -WithAssets provisions by default (fast setup): the default chat model plus the
# embeddings model, reranker, Whisper transcriber, and the Qwen2.5-VL image-description model,
# so chat, document Q&A, retrieval quality, audio/dictation, and image understanding all work
# out of the box. Every OTHER model (larger chat models) is downloaded by the user from inside
# the app. Pass -AllModels to fetch everything. The whisper.cpp runtime and the OCR language
# files are fetched alongside these (see the -WithAssets block). Keep these ids in sync with
# the manifests under model-manifests/.
$DefaultModelIds = @(
  'ministral3-8b-instruct-2512-q4',   # chat (benchmark-winning 8B)
  'multilingual-e5-small-q8',         # embeddings (document Q&A)
  'bge-reranker-v2-m3-f16',           # reranker (retrieval quality)
  'whisper-small-multilingual',       # transcriber (audio / dictation)
  'qwen2.5-vl-3b-instruct-q4'         # vision (image description; GGUF + mmproj, two files)
)

# Normalize -Target to a full path: the config files below are written via .NET
# ([System.IO.File]::WriteAllText), which resolves relative paths against the PROCESS
# working directory — that does not follow Set-Location, so a relative -Target used to
# split dirs and config across two locations (audit M22).
if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
$Target = [System.IO.Path]::GetFullPath($Target)

# Repo root = parent of this script's directory.
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Directory tree (must match drive.ts DRIVE_LAYOUT_DIRS / sidecar.ts llamaOsDir).
$Dirs = @(
  'workspace',
  'app-skills',
  'user-skills',
  'models/chat',
  'models/embeddings',
  'models/reranker',
  'models/transcriber',
  'models/vision',
  'models/translation',
  'model-manifests',
  'model-manifests/vision',
  'model-manifests/translation',
  'runtime/llama.cpp/win',
  'runtime/llama.cpp/mac',
  'runtime/llama.cpp/linux',
  'runtime/whisper.cpp/win',
  'runtime/whisper.cpp/mac',
  'runtime/whisper.cpp/linux',
  'ocr',
  'logs',
  'config',
  'docs'
)

function Join-DrivePath([string]$rel) {
  return (Join-Path $Target ($rel -replace '/', [IO.Path]::DirectorySeparatorChar))
}

# --- Build config payloads (snake_case shapes parsePolicy/resolvePaths accept) ------
$DriveJson = [ordered]@{
  product                  = 'HilbertRaum'
  drive_format_version     = 1
  created_at               = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  edition                  = 'lite'
  offline_by_default       = $true
  models_dir               = 'models'
  workspace_dir            = 'workspace'
  allow_network_by_default = $false
}

$PolicyJson = [ordered]@{
  network   = [ordered]@{
    allow_model_downloads = $true
    allow_update_checks   = $false
  }
  workspace = [ordered]@{
    encryption_required     = (-not $Dev)
    allow_plaintext_dev_mode = [bool]$Dev
  }
  models    = [ordered]@{
    allow_unverified_models = [bool]$Dev
    require_manifest        = $true
    require_sha256_match    = (-not $Dev)
  }
}

Write-Host "Prepare drive at: $Target" -ForegroundColor Cyan
if ($DryRun) { Write-Host '(dry run -- nothing will be created)' -ForegroundColor Yellow }
Write-Host ''

# --- Directories --------------------------------------------------------------------
Write-Host 'Directories:'
foreach ($d in $Dirs) {
  $full = Join-DrivePath $d
  if ($DryRun) {
    Write-Host "  + $full"
  } else {
    New-Item -ItemType Directory -Force -Path $full | Out-Null
    Write-Host "  ok $d"
  }
}
Write-Host ''

# --- Manifests ----------------------------------------------------------------------
$ManifestSrc = Join-Path $RepoRoot 'model-manifests'
$ManifestDst = Join-DrivePath 'model-manifests'
Write-Host 'Model manifests:'
if (Test-Path $ManifestSrc) {
  if ($DryRun) {
    Write-Host "  copy $ManifestSrc -> $ManifestDst (*.yaml/*.yml)"
  } else {
    Copy-Item -Path (Join-Path $ManifestSrc '*') -Destination $ManifestDst -Recurse -Force
    Write-Host "  copied manifests to model-manifests/"
  }
} else {
  Write-Host "  WARNING: $ManifestSrc not found (run from a repo clone)" -ForegroundColor Yellow
}
Write-Host ''

# --- App skills ---------------------------------------------------------------------
# Copy the committed product skills (text-only: SKILL.md + JSON schemas + examples) from the
# repo app-skills/ tree onto the drive, the same wholesale copy as model-manifests/ (skills
# plan S9 / DS17). user-skills/ is left EMPTY (the buyer fills it). Canonical reference:
# drive.ts listSkillFolders / planPrepareDrive.appSkillsToCopy.
$AppSkillSrc = Join-Path $RepoRoot 'app-skills'
$AppSkillDst = Join-DrivePath 'app-skills'
Write-Host 'App skills:'
if (Test-Path $AppSkillSrc) {
  if ($DryRun) {
    Write-Host "  copy $AppSkillSrc -> $AppSkillDst (product skills)"
  } else {
    Copy-Item -Path (Join-Path $AppSkillSrc '*') -Destination $AppSkillDst -Recurse -Force
    Write-Host "  copied app skills to app-skills/"
  }
} else {
  Write-Host "  WARNING: $AppSkillSrc not found (run from a repo clone)" -ForegroundColor Yellow
}
Write-Host ''

# --- User docs ----------------------------------------------------------------------
$DocsDst = Join-DrivePath 'docs'
$DocFiles = @('docs/user-guide.md', 'docs/troubleshooting.md', 'PRIVACY.md')
Write-Host 'User docs:'
foreach ($rel in $DocFiles) {
  $src = Join-Path $RepoRoot $rel
  if (Test-Path $src) {
    if ($DryRun) { Write-Host "  copy $rel -> docs/" }
    else { Copy-Item -Path $src -Destination $DocsDst -Force; Write-Host "  copied $rel" }
  }
}
Write-Host ''

# --- License / attribution notices (LIC-1, full-audit 2026-07-12b) -------------------
# Distribution-level notices go to the DRIVE ROOT (not docs/): the app's own GPLv3 text,
# the bundled-npm-package notices, and the GENERATED drive-wide notices for runtime
# binaries + model weights (regenerate with `node scripts/generate-drive-notices.mjs`;
# the committed file is copied here so no Node is needed at drive-build time). Copied
# unconditionally — dev drives get them too (harmless). The commercial SELLABLE gate
# (build-commercial-drive step 7 / assertCommercialDrive) requires all three. Keep this
# list in sync with commercial-drive.ts DRIVE_LICENSE_ARTIFACTS (script-drift test).
$LicenseArtifacts = @(
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'DRIVE-NOTICES.md'
)
Write-Host 'License notices:'
foreach ($lic in $LicenseArtifacts) {
  $src = Join-Path $RepoRoot $lic
  if (Test-Path $src) {
    if ($DryRun) { Write-Host "  copy $lic -> drive root" }
    else { Copy-Item -Path $src -Destination (Join-Path $Target $lic) -Force; Write-Host "  copied $lic" }
  } else {
    Write-Host "  WARNING: $lic not found at the repo root (run from a repo clone)" -ForegroundColor Yellow
  }
}
Write-Host ''

# --- Config files -------------------------------------------------------------------
function Write-JsonFile([string]$relPath, $obj) {
  $full = Join-DrivePath $relPath
  $json = ($obj | ConvertTo-Json -Depth 6)
  if ($DryRun) { Write-Host "  + $relPath"; return }
  if ((Test-Path $full) -and -not $Force) {
    Write-Host "  skip $relPath (exists; use -Force to overwrite)" -ForegroundColor Yellow
    return
  }
  # Write UTF-8 WITHOUT a BOM: Windows PowerShell 5.1 `Set-Content -Encoding UTF8` prepends
  # a BOM, which makes Node's `JSON.parse` (in the app's policy/drive loaders) throw. The
  # .NET writer with UTF8Encoding($false) emits clean UTF-8 the app parses identically to
  # the bash-prepared files.
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($full, $json, $utf8NoBom)
  Write-Host "  wrote $relPath"
}

Write-Host 'Config files:'
Write-JsonFile 'config/drive.json' $DriveJson
Write-JsonFile 'config/policy.json' $PolicyJson
Write-Host ''

# --- Optional: download + verify the assets (Phase 12) ------------------------------
if ($WithAssets) {
  Write-Host ''
  Write-Host 'Fetching assets (build-time network; the app itself stays offline):' -ForegroundColor Cyan
  $fetchModels = Join-Path $PSScriptRoot 'fetch-models.ps1'
  $fetchRuntime = Join-Path $PSScriptRoot 'fetch-runtime.ps1'
  # Use HASHTABLE splatting (named params), not array splatting: array elements are bound
  # positionally and '-AcceptLicense'/'-DryRun' strings are NOT recognised as switch names,
  # which fails param binding (PositionalParameterNotFound), especially with a rooted
  # -Target like 'D:\'.
  # fetch-models takes a single -Only id, so the default set is fetched one id at a time;
  # -AllModels fetches every manifest in one pass (a single call with no -Only).
  if ($AllModels) {
    $modelTargets = @($null)
  } else {
    $modelTargets = $DefaultModelIds
    Write-Host ("  (default set: {0}; pass -AllModels for every model)" -f ($DefaultModelIds -join ', ')) -ForegroundColor DarkGray
  }
  foreach ($only in $modelTargets) {
    $modelArgs = @{ Target = $Target }
    if ($only) { $modelArgs.Only = $only }
    if ($AcceptLicense) { $modelArgs.AcceptLicense = $true }
    if ($DryRun) { $modelArgs.DryRun = $true }
    & $fetchModels @modelArgs
    if ($LASTEXITCODE -ne 0) { Write-Error 'fetch-models failed.'; exit 1 }
  }

  # llama.cpp sidecar (the chat + embeddings engine) -- always.
  $runtimeArgs = @{ Target = $Target }
  if ($DryRun) { $runtimeArgs.DryRun = $true }
  & $fetchRuntime @runtimeArgs
  if ($LASTEXITCODE -ne 0) { Write-Error 'fetch-runtime (llama.cpp) failed.'; exit 1 }

  # whisper.cpp sidecar (the transcriber engine) -- always, to match the bundled Whisper
  # model. Best-effort: prebuilt whisper.cpp binaries exist for Windows only, so on a
  # mac/linux build host there is no build to fetch -- a miss is a warning, not a failure
  # (those drives build whisper.cpp from source; see docs/packaging.md).
  $whisperArgs = @{ Target = $Target; Family = 'whisper_cpp' }
  if ($DryRun) { $whisperArgs.DryRun = $true }
  & $fetchRuntime @whisperArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  note: whisper.cpp runtime not provisioned (no prebuilt build for this host -- build from source on mac/linux).' -ForegroundColor Yellow
  }

  # OCR language files (Phase 38, D32): the ocr/ asset class -- plain sha256-verified
  # traineddata files, OS-independent (one run covers every shipped OS). Unlike the whisper
  # build there is nothing host-specific to miss, so this is fetched unconditionally like
  # llama.cpp (a failure aborts). Without it the DIY drive's ocr/ dir stays empty and
  # scanned-PDF/photo OCR (Phase 38) is silently unavailable -- the provisioning root cause
  # of issue #59 (F-05, full audit 2026-07-16). build-commercial-drive already fetches it.
  $ocrArgs = @{ Target = $Target; Family = 'ocr' }
  if ($DryRun) { $ocrArgs.DryRun = $true }
  & $fetchRuntime @ocrArgs
  if ($LASTEXITCODE -ne 0) { Write-Error 'fetch-runtime (ocr) failed.'; exit 1 }

  Write-Host ''
  Write-Host "Now capture real hashes: scripts\verify-models.ps1 -Target '$Target' -Generate" -ForegroundColor Cyan
} else {
  # --- What you must add manually (R5) ----------------------------------------------
  Write-Host 'Next steps (artifacts NOT provisioned without -WithAssets):' -ForegroundColor Cyan
  Write-Host '  1. Drop GGUF weights into models/chat/ and models/embeddings/ (see manifest local_path),'
  Write-Host "     or re-run with -WithAssets to download + verify them (scripts\fetch-models.ps1)."
  Write-Host '  2. Drop llama-server binaries into runtime/llama.cpp/{win,mac,linux}/ (or -WithAssets).'
  Write-Host "  3. Run scripts\verify-models.ps1 -Target '$Target' to verify checksums."
}
Write-Host ''
Write-Host 'Launch from the drive with HILBERTRAUM_DRIVE_ROOT set to the drive root:' -ForegroundColor Cyan
Write-Host "  `$env:HILBERTRAUM_DRIVE_ROOT = '$Target'"
