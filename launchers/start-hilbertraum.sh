#!/usr/bin/env bash
# ============================================================================
#  Start HilbertRaum (Linux launcher) -- Phase 13, spec section 6.
#
#  This file lives at the DRIVE ROOT, next to the AppImage. It derives the drive
#  root from its OWN location every launch, so the same drive works wherever it
#  mounts (/media/<user>/HILBERTRAUM, /mnt/usb, ...). NO path is hardcoded.
#
#  Mirrors apps/desktop/src/main/services/launcher.ts resolveDriveRootFromLauncher.
# ============================================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
export HILBERTRAUM_DRIVE_ROOT="$DIR"
# One source of truth: the app reads the SAME manifests the drive scripts verified.
export HILBERTRAUM_MANIFESTS_DIR="$DIR/model-manifests"

# Find the AppImage on the drive.
APP=""
for candidate in "$DIR"/*.AppImage; do
  if [ -f "$candidate" ]; then APP="$candidate"; break; fi
done

if [ -z "$APP" ]; then
  echo
  echo "  Could not find the HilbertRaum AppImage on this drive."
  echo "  See docs/troubleshooting.md for help."
  echo
  exit 1
fi

chmod +x "$APP" 2>/dev/null || true
exec "$APP"
