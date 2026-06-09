#requires -Version 5.1
<#
.SYNOPSIS
  Lay out a Private AI Drive Lite portable drive (spec §6 / Phase 11).

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
  Network is OFF either way (deny-by-default offline guarantee).

.EXAMPLE
  .\scripts\prepare-drive.ps1 -Target E:\ -DryRun
  .\scripts\prepare-drive.ps1 -Target E:\
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [switch] $DryRun,
  [switch] $Force,
  [switch] $Dev
)

$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's directory.
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Directory tree (must match drive.ts DRIVE_LAYOUT_DIRS / sidecar.ts llamaOsDir).
$Dirs = @(
  'workspace',
  'models/chat',
  'models/embeddings',
  'model-manifests',
  'runtime/llama.cpp/win',
  'runtime/llama.cpp/mac',
  'runtime/llama.cpp/linux',
  'logs',
  'config',
  'docs'
)

function Join-DrivePath([string]$rel) {
  return (Join-Path $Target ($rel -replace '/', [IO.Path]::DirectorySeparatorChar))
}

# --- Build config payloads (snake_case shapes parsePolicy/resolvePaths accept) ------
$DriveJson = [ordered]@{
  product                  = 'Private AI Drive Lite'
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
    allow_model_downloads = $false
    allow_update_checks   = $false
    allow_telemetry       = $false
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

# --- What you must add manually (R5) ------------------------------------------------
Write-Host 'Next steps (artifacts NOT provisioned by this script):' -ForegroundColor Cyan
Write-Host '  1. Drop GGUF weights into models/chat/ and models/embeddings/ (see manifest local_path).'
Write-Host '  2. Drop llama-server binaries into runtime/llama.cpp/{win,mac,linux}/.'
Write-Host "  3. Run scripts\verify-models.ps1 -Target '$Target' to verify checksums."
Write-Host ''
Write-Host 'Launch from the drive with PAID_DRIVE_ROOT set to the drive root:' -ForegroundColor Cyan
Write-Host "  `$env:PAID_DRIVE_ROOT = '$Target'"
