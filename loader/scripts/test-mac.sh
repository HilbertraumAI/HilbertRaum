#!/usr/bin/env bash
# Run the macOS launcher on a REAL remote Mac (ssh $MAC_TARGET): push hilbertraum.dmg + the
# mac app component, mount the launcher dmg, run HilbertRaum.app's launcher pointed at the
# pushed pool, and assert HilbertRaum boots ("Workspace resolved").
#
# Requires: MAC_TARGET = ssh host of a mac with a LOGGED-IN GUI session (Electron needs the
# window server). Usage: MAC_TARGET=mac scripts/test-mac.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need ssh; need scp

HOST="${MAC_TARGET:?set MAC_TARGET to the ssh host of a mac (e.g. MAC_TARGET=mac)}"
DMG="$DIST_DIR/bundle/hilbertraum.dmg"
APPDMG="$DIST_DIR/bundle/components/mac-arm64/app-mac-arm64.dmg"
[ -f "$DMG" ] || die "no hilbertraum.dmg — run: make bundle TARGET=mac-arm64"
[ -f "$APPDMG" ] || die "no app-mac-arm64.dmg — run: make bundle TARGET=mac-arm64"
SSHO=(-o VisualHostKey=no -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o BatchMode=yes)

# Stage a drive-root mirroring a real drive: the launcher dmg at the root + the app component
# in its group dir + a seeded local manifest (so it runs from the pushed pool).
S="$(mktemp -d)"; mkdir -p "$S/components/mac-arm64"
cp "$DMG" "$S/hilbertraum.dmg"
cp "$APPDMG" "$S/components/mac-arm64/"
cp "$DIST_DIR/bundle/components/mac-arm64/manifest.json" "$S/components/mac-arm64/" 2>/dev/null || true
seed_drive_manifest "$S" mac-arm64

log "remote mac test on '$HOST'"
R="$(ssh "${SSHO[@]}" "$HOST" 'd=$(mktemp -d /tmp/hbr-XXXXXX); echo "$d"')"
[ -n "$R" ] || die "ssh $HOST failed (no remote temp dir)"
cleanup() { ssh "${SSHO[@]}" "$HOST" "pkill -f hilbertraum 2>/dev/null; hdiutil detach '$R/mnt' 2>/dev/null; rm -rf '$R'" >/dev/null 2>&1 || true; rm -rf "$S"; }
trap cleanup EXIT

log "pushing staged drive ($(du -sh "$S"|cut -f1)) -> $HOST:$R"
scp -q -r "${SSHO[@]}" "$S"/* "$HOST:$R/" || die "scp failed"
LOG="$(mktemp)"
# Mount the launcher dmg, run the .app's launcher (its CWD pool is the pushed drive root via
# HILBERTRAUM_DRIVE_ROOT), wait, capture the launcher log, then detach.
ssh "${SSHO[@]}" "$HOST" bash -s <<REMOTE 2>/dev/null | tee "$LOG"
set -e
export HILBERTRAUM_DRIVE_ROOT="$R" HILBERTRAUM_CONTROL_PORT=45777
hdiutil attach -nobrowse -mountpoint "$R/mnt" "$R/hilbertraum.dmg" >/dev/null
"\$(/usr/bin/find "$R/mnt" -maxdepth 3 -name hilbertraum -type f -path '*MacOS*' | head -1)" >"$R/run.log" 2>&1 &
lp=\$!; sleep 22
curl -s --max-time 5 http://127.0.0.1:45777/api/info || echo "API unreachable"
kill \$lp 2>/dev/null || true
cat "$R/run.log"
REMOTE
assert_hilbertraum_booted "$LOG" || die "HilbertRaum did not boot on macOS"
log "PASS — macOS launch OK"
