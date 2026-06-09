#requires -Version 5.1
<#
.SYNOPSIS
  One-shot developer bootstrap for Private AI Drive Lite (Phase 11).

.DESCRIPTION
  Installs dependencies, then runs the build + tests as a smoke check. Uses
  NODE_OPTIONS=--use-system-ca so npm install works behind a TLS-intercepting corporate
  proxy (BUILD_STATE R6 — Node reads the Windows certificate store).

  Note: `npm install` downloads the Electron binary (~100 MB) the first time (R2). This is
  the ONLY network the project needs and it is dev-time only — the app itself stays 100%
  offline at runtime.

.PARAMETER SkipTests
  Install + build only (skip the test run).

.EXAMPLE
  .\scripts\setup-dev.ps1
#>
[CmdletBinding()]
param([switch] $SkipTests)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# R6: read the Windows cert store so a corporate TLS proxy doesn't break the install.
# --use-system-ca only exists from Node 22.15 / 23.8 — probe first (an unknown flag in
# NODE_OPTIONS aborts EVERY node/npm invocation), and APPEND so a pre-existing
# NODE_OPTIONS is preserved (audit M19).
$global:LASTEXITCODE = 0
& node --use-system-ca -e 0 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  $env:NODE_OPTIONS = ("$($env:NODE_OPTIONS) --use-system-ca").Trim()
} else {
  Write-Host 'Note: this Node does not support --use-system-ca (needs >= 22.15); continuing without it.' -ForegroundColor Yellow
}

Write-Host '==> npm install (downloads the Electron binary on first run, R2)' -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host 'npm install failed. If this is a TLS/cert error, see BUILD_STATE R6:' -ForegroundColor Yellow
  Write-Host '  - ensure NODE_OPTIONS=--use-system-ca (set automatically by this script)' -ForegroundColor Yellow
  Write-Host '  - or (dev-only, less secure): npm config set strict-ssl false' -ForegroundColor Yellow
  exit 1
}

Write-Host '==> npm run build' -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { exit 1 }

if (-not $SkipTests) {
  Write-Host '==> npm test' -ForegroundColor Cyan
  npm test
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

Write-Host ''
Write-Host 'Setup complete. Next:' -ForegroundColor Green
Write-Host '  npm run dev        # launch the app'
Write-Host '  scripts\prepare-drive.ps1 -Target E:\   # lay out a portable drive'
