#!/usr/bin/env bash
# Build a finished, verified, sellable commercial drive (Phase 13, spec section 12.2).
#
# The master pipeline that ties Phase 11 + Phase 12 + signing together. Runs, in order:
#   1. prepare-drive  --force            # commercial policy (encrypted, network denied)
#   2. fetch-models   --accept-license   # verified weights
#   3. fetch-runtime                     # verified llama.cpp sidecar
#   4. package + sign + notarize         # MANUAL (secrets never in the repo)
#   5. copy launcher + portable app + user docs onto the drive root
#   6. verify-models  --generate         # capture real hashes -> config/checksums.json
#   7. final check: commercial posture + all weights VERIFIED + no user data
#
# Mirrors apps/desktop/src/main/services/commercial-drive.ts (planCommercialDrive +
# assertCommercialDrive) -- that TS module is the CANONICAL, unit-tested reference. This
# script ORCHESTRATES the existing scripts; it does not re-implement them.
#
# SIGNING IS MANUAL. The green gate does not sign. Supply a pre-built, signed app via
# --app-artifact, or use --skip-package. See docs/packaging.md.
#
# Usage:
#   scripts/build-commercial-drive.sh --target /Volumes/PAID --accept-license \
#       [--app-artifact ./release/PrivateAIDriveLite-0.1.0.AppImage] [--skip-package] [--dry-run]
set -euo pipefail

TARGET=""
ACCEPT_LICENSE=0
APP_ARTIFACT=""
SKIP_PACKAGE=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --accept-license) ACCEPT_LICENSE=1; shift ;;
    --app-artifact) APP_ARTIFACT="${2:-}"; shift 2 ;;
    --app-artifact=*) APP_ARTIFACT="${1#*=}"; shift ;;
    --skip-package) SKIP_PACKAGE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "Error: --target <drive-root> is required" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

step() { echo; echo "[$1] $2"; }

echo "Build a COMMERCIAL (sellable) drive at: $TARGET"
[[ $DRY_RUN -eq 1 ]] && echo "(dry run -- nothing will be changed)"

# --- 1. Lay out the drive with the COMMERCIAL policy --------------------------------
step 1 "Lay out the drive (commercial policy: encryption required, network denied)"
PREP=(--target "$TARGET" --force)
[[ $DRY_RUN -eq 1 ]] && PREP+=(--dry-run)
bash "$SCRIPT_DIR/prepare-drive.sh" "${PREP[@]}"

# --- 2. Download + verify the model weights ----------------------------------------
step 2 "Download + verify the model weights"
MODELS=(--target "$TARGET")
[[ $ACCEPT_LICENSE -eq 1 ]] && MODELS+=(--accept-license)
[[ $DRY_RUN -eq 1 ]] && MODELS+=(--dry-run)
bash "$SCRIPT_DIR/fetch-models.sh" "${MODELS[@]}"

# --- 3. Download + verify the llama.cpp sidecar ------------------------------------
step 3 "Download + verify the llama.cpp sidecar"
RUNTIME=(--target "$TARGET")
[[ $DRY_RUN -eq 1 ]] && RUNTIME+=(--dry-run)
bash "$SCRIPT_DIR/fetch-runtime.sh" "${RUNTIME[@]}"

# --- 4. Package + sign + notarize (MANUAL) -----------------------------------------
step 4 "Package + sign the app (MANUAL -- secrets never in the repo)"
if [[ $SKIP_PACKAGE -eq 1 ]]; then
  echo "  --skip-package set: skipping packaging. Sign + copy the app yourself."
elif [[ -n "$APP_ARTIFACT" ]]; then
  if [[ ! -e "$APP_ARTIFACT" ]]; then echo "AppArtifact not found: $APP_ARTIFACT" >&2; exit 1; fi
  DST="$TARGET/$(basename "$APP_ARTIFACT")"
  if [[ $DRY_RUN -eq 1 ]]; then echo "  copy $APP_ARTIFACT -> $DST"
  else cp -R "$APP_ARTIFACT" "$DST"; echo "  copied signed app -> $DST"; fi
else
  echo "  No --app-artifact supplied. Build + sign the app, then re-run with"
  echo "  --app-artifact <path>, or copy it onto the drive manually. See docs/packaging.md."
fi

# --- 5. Copy the launcher + user docs onto the drive root --------------------------
step 5 "Copy the launcher + user docs onto the drive root"
for f in "Start Private AI Drive.cmd" "Start Private AI Drive.command" "start-private-ai-drive.sh" "READ ME FIRST.txt"; do
  src="$REPO_ROOT/launchers/$f"
  if [[ -f "$src" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then echo "  copy $f -> drive root"
    else cp "$src" "$TARGET/$f"; echo "  copied $f"; fi
  fi
done
# Make the POSIX launchers executable.
[[ $DRY_RUN -eq 0 ]] && chmod +x "$TARGET/Start Private AI Drive.command" "$TARGET/start-private-ai-drive.sh" 2>/dev/null || true

# --- 6. Capture real hashes + verify -----------------------------------------------
step 6 "Capture real hashes + verify all weights"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  (dry run: skipping verify-models)"
else
  bash "$SCRIPT_DIR/verify-models.sh" --target "$TARGET" --generate
fi

# --- 7. Final check: is this drive sellable? ---------------------------------------
step 7 "Final check: commercial posture + weights VERIFIED + no user data"
echo "  The CANONICAL gate is assertCommercialDrive() in commercial-drive.ts (unit-tested)."
echo "  Native cross-check of the key invariants:"
PROBLEMS=()
POLICY="$TARGET/config/policy.json"
if [[ -f "$POLICY" ]]; then
  grep -q '"encryption_required": *true'  "$POLICY" || PROBLEMS+=("policy: encryption not required")
  grep -q '"allow_plaintext_dev_mode": *true' "$POLICY" && PROBLEMS+=("policy: plaintext allowed")
  grep -q '"allow_model_downloads": *true' "$POLICY" && PROBLEMS+=("policy: model downloads allowed")
  grep -q '"allow_update_checks": *true'  "$POLICY" && PROBLEMS+=("policy: update checks allowed")
  grep -q '"require_sha256_match": *true' "$POLICY" || PROBLEMS+=("policy: sha256 match not required")
else
  PROBLEMS+=("config/policy.json missing")
fi
for ud in workspace/paid.sqlite workspace/paid.sqlite.enc config/workspace.json; do
  [[ -e "$TARGET/$ud" ]] && PROBLEMS+=("user data present: $ud")
done
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  (dry run: posture check skipped)"
elif [[ ${#PROBLEMS[@]} -gt 0 ]]; then
  echo "  NOT SELLABLE:"
  for p in "${PROBLEMS[@]}"; do echo "    - $p"; done
  echo "  (verify-models above also enforces weight hashes; fix all before shipping.)"
  exit 1
else
  echo "  Posture OK (encrypted, network denied, no user data)."
  echo "  Confirm verify-models reported every weight VERIFIED (not UNVERIFIED/MISMATCH)."
fi

echo
echo "Done. Test the drive on a clean laptop with Wi-Fi OFF (spec section 17 demo)."
