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
#  "Start HilbertRaum.command" --check  names the app it would start and starts
#  nothing (a support tool -- see docs/troubleshooting.md).
#
#  Mirrors apps/desktop/src/main/services/launcher.ts resolveDriveRootFromLauncher.
# ============================================================================
set -euo pipefail

CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; fi

# The directory this script sits in = the drive root.
DIR="$(cd "$(dirname "$0")" && pwd)"
export HILBERTRAUM_DRIVE_ROOT="$DIR"
# One source of truth: the app reads the SAME manifests the drive scripts verified.
export HILBERTRAUM_MANIFESTS_DIR="$DIR/model-manifests"

# --- 1. Take stock: extracted bundles (non-exFAT drives can hold one) and ditto-zips.
APP=""
APP_COUNT=0
for candidate in "$DIR"/*.app; do
  if [ -d "$candidate" ]; then
    APP_COUNT=$((APP_COUNT + 1))
    if [ -z "$APP" ]; then APP="$candidate"; fi
  fi
done
ZIP=""
ZIP_COUNT=0
for candidate in "$DIR"/HilbertRaum-*-mac-arm64.app.zip; do
  if [ -f "$candidate" ]; then
    ZIP_COUNT=$((ZIP_COUNT + 1))
    if [ -z "$ZIP" ]; then ZIP="$candidate"; fi
  fi
done

if [ "$APP_COUNT" -eq 0 ] && [ "$ZIP_COUNT" -eq 0 ]; then
  echo
  echo "  Could not find the HilbertRaum app on this drive."
  echo "  Expected 'HilbertRaum.app' or 'HilbertRaum-<version>-mac-arm64.app.zip' in this folder."
  echo "  See docs/troubleshooting.md for help."
  echo
  exit 1
fi

# Two app versions on one drive must never run: an older build beside a newer
# one can destroy the workspace (#235). An extracted bundle carries no version in
# its name, so ANY .app beside ANY zip counts as two. Refuse before the cache
# below is touched, say what to delete, never delete.
if [ $((APP_COUNT + ZIP_COUNT)) -gt 1 ]; then
  echo
  echo "  More than one HilbertRaum app was found on this drive:"
  for candidate in "$DIR"/*.app "$DIR"/HilbertRaum-*-mac-arm64.app.zip; do
    if [ -e "$candidate" ]; then echo "    $(basename "$candidate")"; fi
  done
  echo
  echo "  Two versions must never run from one drive. Keep only the newest"
  echo "  HilbertRaum-<version>-mac-arm64.app.zip, delete the older ones and any"
  echo "  extracted HilbertRaum.app next to it, then start again."
  echo "  See docs/troubleshooting.md, \"Two app versions on the drive\"."
  echo
  exit 1
fi

if [ "$CHECK" = 1 ]; then
  echo
  echo "  HilbertRaum launcher check"
  echo "  Drive root : $DIR"
  if [ -n "$APP" ]; then
    echo "  App        : $APP"
  else
    echo "  App        : $ZIP (unpacked into a local cache on start)"
  fi
  echo "  Nothing was started."
  echo
  exit 0
fi

# --- 2. No extracted bundle: extract the ditto-zip into a local cache, keyed by
#        zip name so a new version on the drive re-extracts instead of running the
#        stale one.
if [ -z "$APP" ]; then
  if [ -z "${HOME:-}" ]; then
    echo
    echo "  HOME is not set, so there is nowhere to unpack the app."
    echo "  See docs/troubleshooting.md for help."
    echo
    exit 1
  fi

  CACHE="$HOME/Library/Caches/HilbertRaum/$(basename "$ZIP" .zip)"
  if [ ! -d "$CACHE" ]; then
    echo "  First run for this version: unpacking the app (about 400 MB, one time)..."
    # The partial dir is PID-unique: extraction takes long enough that an impatient
    # second double-click is likely, and two runs sharing one partial path would
    # rm -rf each other's in-progress extraction (and could publish a half tree).
    # Stale partials from killed runs are swept here instead (-f: no-match is fine).
    rm -rf "$CACHE".partial.*
    PARTIAL="$CACHE.partial.$$"
    mkdir -p "$PARTIAL"
    # ditto, not unzip: it is the macOS-native tool that restores the bundle's
    # symlinks, permissions and extended attributes intact.
    if ! ditto -x -k "$ZIP" "$PARTIAL"; then
      echo
      echo "  Could not unpack '$ZIP'."
      echo "  Copy it to your Desktop and double-click it, then see docs/troubleshooting.md."
      echo
      rm -rf "$PARTIAL"
      exit 1
    fi
    # Only publish the cache once extraction fully succeeded, so an interrupted
    # first run cannot leave a half-unpacked bundle that looks complete. If a
    # parallel launch published first, use its copy (mv onto an existing dir would
    # nest ours INSIDE it, not replace it).
    if [ -d "$CACHE" ]; then
      rm -rf "$PARTIAL"
    else
      mv "$PARTIAL" "$CACHE"
    fi
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
