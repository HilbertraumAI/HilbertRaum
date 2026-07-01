#!/usr/bin/env bash
# Launch the built linux-x64 bundle on this NixOS host under xvfb and assert HilbertRaum boots,
# capturing a screenshot of the live window. There is no separate NixOS bundle: the linux-x64
# artifact ships the FHS helper as a squashfs, and the static-musl launcher detects NixOS,
# mounts it, and (in an outer bwrap) provides it as /nix/store before FHS-reexecing so the
# generic-glibc Electron runs. Exercises: launcher -> bwrap FHS -> Electron (HilbertRaum).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need xvfb-run

OUT="$DIST_DIR/bundle"
LAUNCHER="$OUT/hilbertraum.linux-x64.exe"
[ -x "$LAUNCHER" ] || die "linux bundle missing — run: make bundle TARGET=linux-x64"
[ -f "$OUT/components/linux-x64/manifest.json" ] || die "components/linux-x64 group missing — run: make bundle TARGET=linux-x64"
SHOT="${1:-/tmp/hilbertraum-nixos.png}"; rm -f "$SHOT"
LOG="$(mktemp)"

log "launching under xvfb; screenshot after ~22s -> $SHOT"
( cd "$OUT" && PLANAI_FORCE_EXTRACT=1 xvfb-run -a bash -c '
    "'"$LAUNCHER"'" >"'"$LOG"'" 2>&1 &
    lp=$!
    sleep 22
    command -v import >/dev/null 2>&1 && import -window root "'"$SHOT"'" 2>/dev/null || true
    kill $lp 2>/dev/null || true; wait $lp 2>/dev/null || true
' ) || true

[ -f "$SHOT" ] && log "screenshot -> $SHOT ($(stat -c%s "$SHOT" 2>/dev/null || echo 0) bytes)" || warn "no screenshot captured"
assert_hilbertraum_booted "$LOG" || die "HilbertRaum did not boot on NixOS"
log "PASS — NixOS FHS launch OK"
