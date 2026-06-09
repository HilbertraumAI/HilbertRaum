#!/bin/bash
# ============================================================================
#  Start Private AI Drive (macOS launcher) -- Phase 13, spec section 6.
#
#  This file lives at the DRIVE ROOT. Double-clicking it starts the app.
#  It derives the drive root from its OWN location every launch, so the same
#  drive works on any Mac no matter where it mounts (/Volumes/PAID, etc.).
#  NO path is hardcoded.
#
#  Mirrors apps/desktop/src/main/services/launcher.ts resolveDriveRootFromLauncher.
# ============================================================================
set -e

# The directory this script sits in = the drive root.
DIR="$(cd "$(dirname "$0")" && pwd)"
export PAID_DRIVE_ROOT="$DIR"

# Find the packaged app bundle.
APP=""
for candidate in "$DIR"/*.app; do
  if [ -d "$candidate" ]; then APP="$candidate"; break; fi
done

if [ -z "$APP" ]; then
  echo
  echo "  Could not find the Private AI Drive app on this drive."
  echo "  Make sure 'Private AI Drive Lite.app' is in this folder."
  echo "  See docs/troubleshooting.md for help."
  echo
  exit 1
fi

# Launch the app binary directly so it inherits PAID_DRIVE_ROOT.
# If macOS Gatekeeper blocks it the first time, right-click the .app and choose
# "Open" (see READ ME FIRST.txt / docs/troubleshooting.md).
BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
if [ -x "$BIN" ]; then
  exec "$BIN"
else
  # Fallback: open the bundle (env may not propagate on very old macOS).
  open "$APP"
fi
