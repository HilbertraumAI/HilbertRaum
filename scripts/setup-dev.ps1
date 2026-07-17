#requires -Version 5.1
<#
.SYNOPSIS
  One-shot developer bootstrap for HilbertRaum (Phase 11).

.DESCRIPTION
  Installs dependencies, then runs the build + tests as a smoke check. Uses
  NODE_OPTIONS=--use-system-ca so npm install works behind a TLS-intercepting corporate
  proxy (BUILD_STATE R6 — Node reads the Windows certificate store).

  Note: the install downloads the Electron binary (~100 MB) the first time (R2). This is
  the ONLY network the project needs and it is dev-time only — the app itself stays 100%
  offline at runtime.

  Uses `npm ci` (issue #49): it installs exactly what package-lock.json pins and NEVER
  rewrites it — `npm install` under a different npm version rewrites the lockfile's `peer`
  flags, leaving every contributor with a permanently dirty lockfile. Use `npm install`
  only when you deliberately change dependencies (with the pinned npm — see
  `packageManager` in package.json).

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
#
# Probe via `node -p` on the flag-introspection set, NOT `& node --use-system-ca -e 0 2>$null`:
# under $ErrorActionPreference='Stop' (line 30) Windows PowerShell 5.1 wraps a native command's
# REDIRECTED stderr in ErrorRecords and TERMINATES the script — so a Node that rejects the flag
# (any 22.5–22.14, all within our >=22.5 engines floor) would print 'bad option' to stderr and
# crash the bootstrap with a NativeCommandError instead of falling back. `node -p` needs no
# stderr redirect: it prints True/False on stdout and exits 0 on every supported Node
# (`process.allowedNodeEnvironmentFlags` exists since Node 10), so the EAP hazard never arises
# (F-18, full audit 2026-07-16 — mirrors the redirect-free intent of setup-dev.sh).
$hasSystemCa = & node -p "process.allowedNodeEnvironmentFlags.has('--use-system-ca')"
if ($hasSystemCa -eq 'true') {
  $env:NODE_OPTIONS = ("$($env:NODE_OPTIONS) --use-system-ca").Trim()
} else {
  Write-Host 'Note: this Node does not support --use-system-ca (needs >= 22.15); continuing without it.' -ForegroundColor Yellow
}

Write-Host '==> npm ci (lockfile-exact install; downloads the Electron binary on first run, R2)' -ForegroundColor Cyan
npm ci
if ($LASTEXITCODE -ne 0) {
  Write-Host 'npm ci failed. If this is a TLS/cert error, see BUILD_STATE R6:' -ForegroundColor Yellow
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
