#!/usr/bin/env bash
# ============================================================================
#  Start HilbertRaum (Linux launcher) -- Phase 13, spec section 6.
#
#  This file lives at the DRIVE ROOT, next to the AppImage. It derives the drive
#  root from its OWN location every launch, so the same drive works wherever it
#  mounts (/media/<user>/HILBERTRAUM, /mnt/usb, ...). NO path is hardcoded.
#
#  ./start-hilbertraum.sh --check  names the app it would start and starts
#  nothing (a support tool -- see docs/troubleshooting.md).
#
#  Mirrors apps/desktop/src/main/services/launcher.ts resolveDriveRootFromLauncher.
# ============================================================================
set -euo pipefail

CHECK=0
if [ "${1:-}" = "--check" ]; then CHECK=1; fi

DIR="$(cd "$(dirname "$0")" && pwd)"
export HILBERTRAUM_DRIVE_ROOT="$DIR"
# One source of truth: the app reads the SAME manifests the drive scripts verified.
export HILBERTRAUM_MANIFESTS_DIR="$DIR/model-manifests"

# Find the AppImage on the drive and count the matches.
APP=""
APP_COUNT=0
for candidate in "$DIR"/HilbertRaum-*.AppImage; do
  if [ -f "$candidate" ]; then
    APP_COUNT=$((APP_COUNT + 1))
    if [ -z "$APP" ]; then APP="$candidate"; fi
  fi
done

if [ -z "$APP" ]; then
  echo
  echo "  Could not find the HilbertRaum AppImage on this drive."
  echo "  See docs/troubleshooting.md for help."
  echo
  exit 1
fi

# Two app versions on one drive must never run: an older build beside a newer
# one can destroy the workspace (#235). Refuse, say what to delete, never delete.
if [ "$APP_COUNT" -gt 1 ]; then
  echo
  echo "  More than one HilbertRaum app was found on this drive:"
  for candidate in "$DIR"/HilbertRaum-*.AppImage; do
    if [ -f "$candidate" ]; then echo "    $(basename "$candidate")"; fi
  done
  echo
  echo "  Two versions must never run from one drive. Keep only the newest"
  echo "  .AppImage, delete the older one, then start again."
  echo "  See docs/troubleshooting.md, \"Two app versions on the drive\"."
  echo
  exit 1
fi

if [ "$CHECK" = 1 ]; then
  echo
  echo "  HilbertRaum launcher check"
  echo "  Drive root : $DIR"
  echo "  App        : $APP"
  echo "  Nothing was started."
  echo
  exit 0
fi

chmod +x "$APP" 2>/dev/null || true
exec "$APP"
