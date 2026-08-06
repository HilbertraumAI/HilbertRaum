#!/bin/bash
# ============================================================================
#  Start HilbertRaum (macOS launcher) -- Phase 13, spec section 6.
#
#  This file lives at the DRIVE ROOT. Double-clicking it starts the app.
#  It derives the drive root from its OWN location every launch, so the same
#  drive works on any Mac no matter where it mounts (/Volumes/HILBERTRAUM, etc.).
#  NO path is hardcoded.
#
#  exFAT CANNOT STORE SYMLINKS, and a .app bundle contains framework version
#  symlinks (Electron Framework.framework/Versions/Current and friends). So the
#  drive carries the ditto-zip instead, and this launcher extracts it ONCE into a
#  local cache and runs it from there. The workspace, models and runtime all stay
#  on the drive -- only the app binary is unpacked locally.
#  See docs/packaging.md "The release workflow".
#
#  Mirrors apps/desktop/src/main/services/launcher.ts resolveDriveRootFromLauncher.
# ============================================================================
set -e

# The directory this script sits in = the drive root.
DIR="$(cd "$(dirname "$0")" && pwd)"
export HILBERTRAUM_DRIVE_ROOT="$DIR"
# One source of truth: the app reads the SAME manifests the drive scripts verified.
export HILBERTRAUM_MANIFESTS_DIR="$DIR/model-manifests"

# --- 1. An already-extracted bundle on the drive wins (non-exFAT drives can hold one).
APP=""
for candidate in "$DIR"/*.app; do
  if [ -d "$candidate" ]; then APP="$candidate"; break; fi
done

# --- 2. Otherwise extract the ditto-zip into a local cache, keyed by zip name so a
#        new version on the drive re-extracts instead of running the stale one.
if [ -z "$APP" ]; then
  ZIP=""
  for candidate in "$DIR"/HilbertRaum-*-mac-arm64.app.zip; do
    if [ -f "$candidate" ]; then ZIP="$candidate"; break; fi
  done

  if [ -z "$ZIP" ]; then
    echo
    echo "  Could not find the HilbertRaum app on this drive."
    echo "  Expected 'HilbertRaum.app' or 'HilbertRaum-<version>-mac-arm64.app.zip' in this folder."
    echo "  See docs/troubleshooting.md for help."
    echo
    exit 1
  fi

  CACHE="$HOME/Library/Caches/HilbertRaum/$(basename "$ZIP" .zip)"
  if [ ! -d "$CACHE" ]; then
    echo "  First run for this version: unpacking the app (about 400 MB, one time)..."
    rm -rf "$CACHE.partial"
    mkdir -p "$CACHE.partial"
    # ditto, not unzip: it is the macOS-native tool that restores the bundle's
    # symlinks, permissions and extended attributes intact.
    if ! ditto -x -k "$ZIP" "$CACHE.partial"; then
      echo
      echo "  Could not unpack '$ZIP'."
      echo "  Copy it to your Desktop and double-click it, then see docs/troubleshooting.md."
      echo
      rm -rf "$CACHE.partial"
      exit 1
    fi
    # Only publish the cache once extraction fully succeeded, so an interrupted
    # first run cannot leave a half-unpacked bundle that looks complete.
    mv "$CACHE.partial" "$CACHE"
  fi

  for candidate in "$CACHE"/*.app; do
    if [ -d "$candidate" ]; then APP="$candidate"; break; fi
  done

  if [ -z "$APP" ]; then
    echo
    echo "  Unpacked '$ZIP' but found no .app inside it."
    echo "  See docs/troubleshooting.md for help."
    echo
    exit 1
  fi
fi

# Launch the app binary directly so it inherits HILBERTRAUM_DRIVE_ROOT.
# If macOS Gatekeeper blocks it the first time, right-click the .app and choose
# "Open" (see READ ME FIRST.txt / docs/troubleshooting.md).
BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
if [ -x "$BIN" ]; then
  exec "$BIN"
else
  # `open` would NOT propagate HILBERTRAUM_DRIVE_ROOT (launchd strips the env) — the app would
  # silently use a non-drive workspace. Fail with a message instead.
  echo
  echo "  Could not start the app binary inside '$APP'."
  echo "  Try right-clicking the .app and choosing 'Open' once (Gatekeeper), then use"
  echo "  this launcher again. See docs/troubleshooting.md for help."
  echo
  exit 1
fi
