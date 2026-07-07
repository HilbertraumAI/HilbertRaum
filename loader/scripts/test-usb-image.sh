#!/usr/bin/env bash
# Loop-mount the built FAT32 USB image and launch HilbertRaum from it under xvfb — the real USB
# scenario (the launcher + app component + manifests live on a FAT32 volume). Asserts boot and
# captures a screenshot. Needs sudo for the loop mount. Run inside `nix develop`.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need xvfb-run

IMG="$DIST_DIR/hilbertraum-usb.img"
[ -f "$IMG" ] || die "no image — run: make image PLATFORMS=linux-x64"
MNT="$(mktemp -d)"; SHOT="${1:-/tmp/hilbertraum-usb.png}"; rm -f "$SHOT"; LOG="$(mktemp)"
cleanup() { sudo umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true; }
trap cleanup EXIT

log "loop-mounting $IMG (FAT32) at $MNT"
sudo mount -o loop,uid="$(id -u)",gid="$(id -g)" "$IMG" "$MNT" || die "loop mount failed (sudo?)"
LAUNCHER="$MNT/hilbertraum.linux-x64.exe"
[ -x "$LAUNCHER" ] || [ -f "$LAUNCHER" ] || die "launcher not found on the image"

log "launching from the FAT32 mount under xvfb (~22s)"
( cd "$MNT" && PLANAI_FORCE_EXTRACT=1 xvfb-run -a bash -c '
    "'"$LAUNCHER"'" >"'"$LOG"'" 2>&1 &
    lp=$!; sleep 22
    command -v import >/dev/null 2>&1 && import -window root "'"$SHOT"'" 2>/dev/null || true
    kill $lp 2>/dev/null || true; wait $lp 2>/dev/null || true
' ) || true

[ -f "$SHOT" ] && log "screenshot -> $SHOT" || warn "no screenshot captured"
assert_hilbertraum_booted "$LOG" || die "HilbertRaum did not boot from the FAT32 image"
log "PASS — FAT32 USB image launch OK"
