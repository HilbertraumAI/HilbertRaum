#!/usr/bin/env bash
# Dev mode: build the linux-x64 bundle (HilbertRaum app component + native launcher + the NixOS
# FHS helper) and run it. ninja rebuilds only what changed, so iterating on the app or launcher
# is fast. Extra args are forwarded to Electron.
#
# Usage: nix develop --command ./scripts/dev.sh [-- <electron args>]
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need nix

log "building linux-x64 bundle"
( cd "$REPO_ROOT" && HILBERTRAUM_PLATFORMS=linux-x64 nix run "$FLAKE_DIR#xtask" -- build bundle-linux-x64 )
LAUNCHER="$DIST_DIR/bundle/hilbertraum.linux-x64.exe"
[ -x "$LAUNCHER" ] || die "no launcher at $LAUNCHER — bundle build failed"
log "launching HilbertRaum (Ctrl-C to quit)"
exec "$LAUNCHER" "$@"
