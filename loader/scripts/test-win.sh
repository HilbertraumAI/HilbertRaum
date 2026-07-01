#!/usr/bin/env bash
# Run the Windows launcher on a REAL remote Windows box (ssh $WIN_TARGET): stage a drive-root
# (hilbertraum.exe + the unpacked app-win-x64 component + a seeded manifest so it runs from the
# local pool, not the update server), push it, launch the .exe, and assert HilbertRaum boots
# (its main process logs "Workspace resolved"; /api/info reports app_running).
#
# Requires: WIN_TARGET = ssh host of a Windows box (OpenSSH) with a LOGGED-IN desktop session
# (Electron needs a window server). Remote commands run via PowerShell.
#
# Usage: WIN_TARGET=win scripts/test-win.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need ssh; need scp; need unzip

HOST="${WIN_TARGET:?set WIN_TARGET to the ssh host of a windows box (e.g. WIN_TARGET=win)}"
EXE="$DIST_DIR/bundle/hilbertraum.exe"
ZIP="$DIST_DIR/bundle/components/win-x64/app-win-x64.zip"
[ -f "$EXE" ] || die "no hilbertraum.exe — run: make bundle TARGET=win-x64"
[ -f "$ZIP" ] || die "no app-win-x64.zip — run: make bundle TARGET=win-x64"
SSHO=(-o VisualHostKey=no -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=8 -o BatchMode=yes)

# Stage the drive-root: launcher at the root, app component UNPACKED into components/win-x64/
# app-win-x64/ (the burned image unpacks the zip the same way), + a seeded local manifest.
S="$(mktemp -d)"; trap 'rm -rf "$S"' EXIT
mkdir -p "$S/components/win-x64/app-win-x64"
cp "$EXE" "$S/"
cp "$DIST_DIR/bundle/components/win-x64/manifest.json" "$S/components/win-x64/" 2>/dev/null || true
( cd "$S/components/win-x64/app-win-x64" && unzip -q "$ZIP" )
seed_drive_manifest "$S" win-x64

cat > "$S/run-hbr.ps1" <<'PS1'
$ErrorActionPreference = "SilentlyContinue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:HILBERTRAUM_CONTROL_PORT = "45777"
$p = Start-Process -FilePath "$here\hilbertraum.exe" -WorkingDirectory $here `
     -RedirectStandardOutput "$here\out.log" -RedirectStandardError "$here\err.log" -PassThru
Start-Sleep -Seconds 22
try { "API: " + (Invoke-RestMethod -Uri "http://127.0.0.1:45777/api/info" -TimeoutSec 5 | ConvertTo-Json -Compress) }
catch { "API: unreachable: $_" }
Get-Content "$here\out.log","$here\err.log" -EA SilentlyContinue
Stop-Process -Id $p.Id -Force; Get-Process hilbertraum -EA SilentlyContinue | Stop-Process -Force
PS1

log "remote windows test on '$HOST'"
R="$(ssh "${SSHO[@]}" "$HOST" 'powershell -NoProfile -Command "$d=Join-Path $env:TEMP (\"hbr-\"+[guid]::NewGuid().ToString(\"N\")); New-Item -ItemType Directory -Path $d|Out-Null; ($d -replace \"\\\\\",\"/\")"' | tr -d '\r')"
[ -n "$R" ] || die "ssh $HOST failed (no remote temp dir)"
cleanup_remote() { ssh "${SSHO[@]}" "$HOST" "powershell -NoProfile -Command \"Get-Process hilbertraum -EA SilentlyContinue|Stop-Process -Force -EA SilentlyContinue; Remove-Item -Recurse -Force '$R' -EA SilentlyContinue\"" >/dev/null 2>&1 || true; }
trap 'cleanup_remote; rm -rf "$S"' EXIT

log "pushing staged drive ($(du -sh "$S"|cut -f1)) -> $HOST:$R"
scp -q -r "${SSHO[@]}" "$S"/* "$HOST:$R/" || die "scp failed"
LOG="$(mktemp)"
log "launching launcher remotely (~25s)"
ssh "${SSHO[@]}" "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -File $R/run-hbr.ps1" 2>/dev/null | tr -d '\r' | tee "$LOG"
assert_hilbertraum_booted "$LOG" || die "HilbertRaum did not boot on Windows"
log "PASS — Windows launch OK"
