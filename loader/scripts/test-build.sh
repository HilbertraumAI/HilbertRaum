#!/usr/bin/env bash
# Build the linux-x64 bundle and verify HilbertRaum actually boots through the native launcher
# (headless, under xvfb): the launcher mounts/extracts the app component, enters the NixOS FHS
# sandbox, sets HILBERTRAUM_DRIVE_ROOT, and Electron's main process comes up. Captures a
# screenshot. Run inside `nix develop`.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need nix; need xvfb-run

log "building linux-x64 bundle"
( cd "$REPO_ROOT" && HILBERTRAUM_PLATFORMS=linux-x64 nix run .#xtask -- build bundle-linux-x64 )
LAUNCHER="$DIST_DIR/bundle/hilbertraum.linux-x64.exe"
[ -x "$LAUNCHER" ] || die "no launcher at $LAUNCHER"

LOG="$(mktemp)"
log "launching headless (~30s) under xvfb"
( cd "$DIST_DIR/bundle" && PLANAI_FORCE_EXTRACT=1 timeout 30 \
    xvfb-run -a "$LAUNCHER" >"$LOG" 2>&1 ) || true
assert_hilbertraum_booted "$LOG" || die "HilbertRaum did not boot"
log "PASS — build + boot OK (screenshot: scripts/test-nixos.sh)"
