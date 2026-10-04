#!/usr/bin/env bash
# ============================================================================
#  Owner-run macOS verification of a packaged HilbertRaum (#560, #562).
#  Procedure, expected results and what to report: docs/packaging.md
#  "Verifying a packaged build on macOS".
#
#    scripts/verify-mac-build.sh                     build `--mac dir` from this checkout, verify it
#    scripts/verify-mac-build.sh <HilbertRaum.app>   verify an existing .app
#    scripts/verify-mac-build.sh <HilbertRaum-*-mac-arm64.app.zip>   verify a release zip
#
#  Optional environment:
#    HILBERTRAUM_OCR_DIR=<dir with deu/eng.traineddata.gz>   include OCR (a drive's ocr/ folder)
#    PROBE_ARGS='--scan <pdf> --scan-words "A,B"'            extra args for the probe
#
#  Needs macOS, Node >= 22.12 and this repo's node_modules (`npm ci`); codesign, PlistBuddy,
#  ditto, sqlite3 and pbpaste ship with macOS. Everything runs against SCRATCH folders under
#  $TMPDIR — never against a real drive. Prints PASS / FAIL / NOTE lines; paste the output into
#  the issue or PR it verifies.
# ============================================================================
set -euo pipefail

[ "$(uname -s)" = "Darwin" ] || { echo "This script runs on macOS only."; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hr-verify-mac.XXXXXX")"
EXPECTED_WIRE="001011001"
FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
note() { echo "NOTE  $*"; }
echo "work dir: $WORK"

# Start "$@" in the background with output to $1-named log; echo the pid.
start_bg() { local log="$1"; shift; "$@" > "$log" 2>&1 & echo $!; }
stop_bg() { kill "$1" 2> /dev/null || true; sleep 2; kill -9 "$1" 2> /dev/null || true; }

# ---- 1. the app ------------------------------------------------------------------------------
if [ $# -ge 1 ] && [[ "$1" == *.zip ]]; then
  ditto -x -k "$1" "$WORK/unzipped"
  for a in "$WORK"/unzipped/*.app; do APP="$a"; break; done
  note "verifying the release zip $1"
elif [ $# -ge 1 ]; then
  APP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  note "verifying the existing app $APP"
else
  note "building --mac dir from $REPO (no Developer ID: the build's own ad-hoc re-sign is what is tested)"
  (cd "$REPO" && npm run build > "$WORK/build.log" 2>&1)
  (cd "$REPO/apps/desktop" && CSC_IDENTITY_AUTO_DISCOVERY=false ../../node_modules/.bin/electron-builder --mac dir \
    -c.directories.output="$WORK/release" >> "$WORK/build.log" 2>&1)
  for a in "$WORK"/release/mac*/HilbertRaum.app; do APP="$a"; break; done
fi
[ -d "${APP:-}" ] || { echo "no HilbertRaum.app found"; exit 2; }
BIN="$APP/Contents/MacOS/HilbertRaum"
echo "app: $APP"
echo "quarantine: $(xattr -p com.apple.quarantine "$APP" 2> /dev/null || echo none)"

# ---- 2. fuses, signature, entitlements, asar integrity -------------------------------------------
WIRE="$(cd "$REPO" && node -e "
  require('@electron/fuses').getCurrentFuseWire(process.argv[1]).then((w) =>
    console.log(Object.keys(w).filter((k) => /^[0-9]+\$/.test(k)).map((k) => String.fromCharCode(w[k])).join('')))" "$APP")"
if [ "$WIRE" = "$EXPECTED_WIRE" ]; then pass "fuse wire $WIRE"; else fail "fuse wire $WIRE (expected $EXPECTED_WIRE)"; fi
codesign -dv --verbose=4 "$APP" > "$WORK/codesign-dv.txt" 2>&1 || true
echo "signature: $(grep -E '^(Signature|Authority|flags|CodeDirectory)' "$WORK/codesign-dv.txt" | head -4 | tr '\n' ' ')"
if codesign --verify --deep --strict --verbose=2 "$APP" > "$WORK/codesign-verify.txt" 2>&1; then
  pass "codesign --verify --deep --strict: $(tail -1 "$WORK/codesign-verify.txt")"
else
  fail "codesign --verify --deep --strict: $(tail -2 "$WORK/codesign-verify.txt" | tr '\n' ' ')"
fi
codesign -d --entitlements :- "$APP" > "$WORK/entitlements.plist" 2> /dev/null || true
if grep -q 'flags=.*runtime' "$WORK/codesign-dv.txt" && ! grep -q 'com.apple.security.device.audio-input' "$WORK/entitlements.plist"; then
  note "hardened runtime is ON and com.apple.security.device.audio-input is NOT entitled: dictation's microphone is expected to be refused (see the mic check below)"
else
  note "hardened runtime flag: $(grep -o 'flags=[^ ]*' "$WORK/codesign-dv.txt" | head -1); audio-input entitled: $(grep -c 'device.audio-input' "$WORK/entitlements.plist" || true)"
fi
PLIST_HASH="$(/usr/libexec/PlistBuddy -c 'Print :ElectronAsarIntegrity:Resources/app.asar:hash' "$APP/Contents/Info.plist" 2> /dev/null || echo missing)"
REAL_HASH="$(cd "$REPO" && node -e "
  require('app-builder-lib/out/asar/asar.js').readAsarHeader(process.argv[1]).then((r) =>
    console.log(require('crypto').createHash('sha256').update(r.header).digest('hex')))" "$APP/Contents/Resources/app.asar")"
if [ "$PLIST_HASH" = "$REAL_HASH" ]; then pass "Info.plist ElectronAsarIntegrity matches app.asar's header ($REAL_HASH)"; else fail "Info.plist integrity $PLIST_HASH vs header $REAL_HASH"; fi

# ---- 3. fuse behaviour -----------------------------------------------------------------------
mkdir -p "$WORK/root-probe"
PID=$(start_bg "$WORK/runasnode.log" env ELECTRON_RUN_AS_NODE=1 HILBERTRAUM_DRIVE_ROOT="$WORK/root-probe" "$BIN" -e 'console.log("RUN_AS_NODE_MARKER", process.versions.node)')
sleep 10; stop_bg "$PID"
if grep -q RUN_AS_NODE_MARKER "$WORK/runasnode.log"; then fail "ELECTRON_RUN_AS_NODE ran Node"; else pass "ELECTRON_RUN_AS_NODE ignored (no Node ran)"; fi
PID=$(start_bg "$WORK/inspect.log" env HILBERTRAUM_DRIVE_ROOT="$WORK/root-probe" "$BIN" --inspect=127.0.0.1:9229 --user-data-dir="$WORK/ud-inspect")
sleep 12
if curl -s -m 3 http://127.0.0.1:9229/json/version | grep -q Browser; then fail "--inspect opened a debugger"; else pass "--inspect opened no debugger"; fi
stop_bg "$PID"
ditto "$APP" "$WORK/tampered.app"
OFF=$(grep -abo '<title>HilbertRaum</title>' "$WORK/tampered.app/Contents/Resources/app.asar" | head -1 | cut -d: -f1)
printf 'X' | dd of="$WORK/tampered.app/Contents/Resources/app.asar" bs=1 seek=$((OFF + 8)) conv=notrunc 2> /dev/null
PID=$(start_bg "$WORK/tamper.log" env HILBERTRAUM_DRIVE_ROOT="$WORK/root-probe" "$WORK/tampered.app/Contents/MacOS/HilbertRaum" \
  --remote-debugging-port=9341 --user-data-dir="$WORK/ud-tamper")
sleep 15
TAMPER_PAGE=$(curl -s -m 3 http://127.0.0.1:9341/json/list | grep -c 'hilbertraum://app/index.html' || true)
stop_bg "$PID"
if grep -q 'ASAR Integrity Violation' "$WORK/tamper.log" && [ "$TAMPER_PAGE" = "0" ]; then
  pass "a changed byte in app.asar ends the app (ASAR Integrity Violation)"
else
  fail "a changed byte in app.asar: page=$TAMPER_PAGE log: $(grep -i -m2 'integrity\|killed\|code signature' "$WORK/tamper.log" | tr '\n' ' ')"
fi
ditto "$APP" "$WORK/planted.app"
rm "$WORK/planted.app/Contents/Resources/app.asar"
mkdir -p "$WORK/planted.app/Contents/Resources/app"
printf '{"name":"planted","main":"main.js"}' > "$WORK/planted.app/Contents/Resources/app/package.json"
printf "require('fs').writeFileSync(process.env.PLANT_MARKER, 'ran'); require('electron').app.whenReady().then(() => require('electron').app.exit(0))\n" \
  > "$WORK/planted.app/Contents/Resources/app/main.js"
PID=$(start_bg "$WORK/plant.log" env PLANT_MARKER="$WORK/planted-ran" "$WORK/planted.app/Contents/MacOS/HilbertRaum" --user-data-dir="$WORK/ud-plant")
sleep 10; stop_bg "$PID"
if [ -f "$WORK/planted-ran" ]; then fail "a planted resources/app/ ran without app.asar"; else pass "a planted resources/app/ does not run (only app.asar loads)"; fi

# ---- 4. the app itself over CDP --------------------------------------------------------------
ROOT="$WORK/root"
mkdir -p "$ROOT/ocr" "$WORK/exports"
if [ -n "${HILBERTRAUM_OCR_DIR:-}" ]; then cp "$HILBERTRAUM_OCR_DIR"/{deu,eng}.traineddata.gz "$ROOT/ocr/"; fi
# The Chromium net log records the browser engine's own requests for the offline check below (#567).
PID=$(start_bg "$WORK/app.log" env HILBERTRAUM_DRIVE_ROOT="$ROOT" "$BIN" --remote-debugging-port=9333 --user-data-dir="$WORK/ud" \
  --log-net-log="$WORK/netlog.json")
# bash 3.2 (the macOS default) + `set -u`: an empty array needs the ${a[@]+...} form below.
EXTRA=()
if [ -n "${PROBE_ARGS:-}" ]; then eval "EXTRA=(${PROBE_ARGS})"; fi
if [ -d "$REPO/apps/desktop/out/renderer/assets" ]; then EXTRA+=(--renderer-dir "$REPO/apps/desktop/out/renderer"); fi
echo "--- probe (allow the microphone prompt; save the evidence pack exactly where it says) ---"
set +e
node "$REPO/scripts/lib/packaged-app-probe.mjs" --port 9333 --drive-root "$ROOT" --mic --clipboard-read pbpaste \
  --export-pdf "$WORK/exports/probe-pack.pdf" ${EXTRA[@]+"${EXTRA[@]}"}
PROBE_FAILS=$?
set -e
stop_bg "$PID"
FAILS=$((FAILS + PROBE_FAILS))
# ---- 5. no request left the machine during that session (#567) ------------------------------
set +e
node "$REPO/scripts/check-netlog.mjs" "$WORK/netlog.json"
NETLOG_FAILS=$?
set -e
FAILS=$((FAILS + NETLOG_FAILS))
echo "--- summary: $FAILS check(s) failed; logs in $WORK ---"
echo "Also report by eye: which app the microphone prompt named (HilbertRaum or Terminal),"
echo "and whether Gatekeeper interfered with the first launch."
exit $((FAILS > 0))
