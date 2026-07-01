#!/usr/bin/env bash
# Run the linux-x64 launcher (the real shipped static-musl artifact) inside a stock Ubuntu
# instance (incus) under xvfb, to prove the bundle runs on a generic glibc distro — not just
# NixOS. Asserts HilbertRaum boots. Uses a privileged container with /dev/fuse so the real
# squashfuse mount path is exercised (no NixOS FHS re-exec needed on Ubuntu).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need incus

UBUNTU="${UBUNTU_VERSION:-26.04}"
VM="${HILBERTRAUM_VM_NAME:-hbr-test-$$-${RANDOM}}"
OUT="$DIST_DIR/bundle"
LAUNCHER="$OUT/hilbertraum.linux-x64.exe"
[ -x "$LAUNCHER" ] || die "linux bundle missing — run: make bundle TARGET=linux-x64"
[ -d "$OUT/components/linux-x64" ] || die "components/linux-x64 missing — run: make bundle TARGET=linux-x64"
SHOT="${1:-/tmp/hilbertraum-ubuntu.png}"; rm -f "$SHOT"

cleanup() { incus delete -f "$VM" >/dev/null 2>&1 || true; }
trap cleanup EXIT
log "launching ubuntu:$UBUNTU container '$VM' (privileged + /dev/fuse)"
incus launch "images:ubuntu/$UBUNTU" "$VM" -c security.privileged=true -c security.nesting=true >/dev/null
incus config device add "$VM" fuse unix-char source=/dev/fuse path=/dev/fuse >/dev/null 2>&1 || true
incus exec "$VM" -- bash -c 'for i in $(seq 1 30); do command -v apt-get >/dev/null && break; sleep 1; done; apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb fuse3 imagemagick >/dev/null 2>&1 || true'

log "pushing drive-root into the container"
incus exec "$VM" -- mkdir -p /opt/hbr/components/linux-x64
incus file push "$LAUNCHER" "$VM/opt/hbr/hilbertraum.linux-x64.exe" >/dev/null
incus file push -r "$OUT/components/linux-x64/." "$VM/opt/hbr/components/linux-x64/" >/dev/null
incus exec "$VM" -- chmod +x /opt/hbr/hilbertraum.linux-x64.exe

log "launching from /opt/hbr under xvfb (~25s)"
incus exec "$VM" -- bash -c '
  cd /opt/hbr
  xvfb-run -a bash -c "./hilbertraum.linux-x64.exe >/opt/hbr/run.log 2>&1 & lp=\$!; sleep 22; import -window root /opt/hbr/shot.png 2>/dev/null || true; kill \$lp 2>/dev/null || true" || true
'
LOG="$(mktemp)"; incus file pull "$VM/opt/hbr/run.log" "$LOG" >/dev/null 2>&1 || true
incus file pull "$VM/opt/hbr/shot.png" "$SHOT" >/dev/null 2>&1 && log "screenshot -> $SHOT" || warn "no screenshot"
assert_hilbertraum_booted "$LOG" || die "HilbertRaum did not boot on Ubuntu $UBUNTU"
log "PASS — Ubuntu $UBUNTU launch OK"
