#!/usr/bin/env bash
# Build a finished, verified, sellable commercial drive (Phase 13, spec section 12.2).
#
# The master pipeline that ties Phase 11 + Phase 12 + signing together. Runs, in order:
#   1. prepare-drive  --force            # commercial policy (encrypted, network denied)
#   2. fetch-models   --accept-license   # verified weights
#   3. fetch-runtime  --os win|mac|linux # verified llama.cpp sidecar for EVERY shipped OS
#   4. package + sign + notarize         # MANUAL (secrets never in the repo)
#   5. copy launcher + portable app + user docs onto the drive root
#   6. verify-models  --generate         # capture real hashes -> config/checksums.json
#   7. final check: commercial posture + license reviews APPROVED (spec 13; not
#      overridable by --accept-license) + verify-models --strict (all weights VERIFIED)
#      + no user data -- exits 1 unless the drive is actually sellable
#
# Mirrors apps/desktop/src/main/services/commercial-drive.ts (planCommercialDrive +
# assertCommercialDrive) -- that TS module is the CANONICAL, unit-tested reference. This
# script ORCHESTRATES the existing scripts; it does not re-implement them.
#
# SIGNING IS MANUAL. The green gate does not sign. Supply a pre-built, signed app via
# --app-artifact, or use --skip-package. See docs/packaging.md.
#
# Usage:
#   scripts/build-commercial-drive.sh --target /Volumes/HILBERTRAUM --accept-license \
#       [--app-artifact ./release/HilbertRaum-0.1.0.AppImage] [--skip-package] [--dry-run]
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
step 1 "Lay out the drive (commercial policy: encryption required, no phone-home)"
PREP=(--target "$TARGET" --force)
[[ $DRY_RUN -eq 1 ]] && PREP+=(--dry-run)
bash "$SCRIPT_DIR/prepare-drive.sh" "${PREP[@]}"

# --- 2. Download + verify the model weights ----------------------------------------
step 2 "Download + verify the model weights"
MODELS=(--target "$TARGET")
[[ $ACCEPT_LICENSE -eq 1 ]] && MODELS+=(--accept-license)
[[ $DRY_RUN -eq 1 ]] && MODELS+=(--dry-run)
bash "$SCRIPT_DIR/fetch-models.sh" "${MODELS[@]}"

# --- 3. Download + verify the llama.cpp sidecar builds for EVERY shipped OS ---------
# A sold drive must run on every OS the launchers support (win/mac/linux); fetching only
# the build-host's OS would ship a drive whose other sidecar dirs are empty. Since
# Phase 14 win/linux ship TWO builds each: the default Vulkan full build (degrades to CPU
# on GPU-less machines) into runtime/llama.cpp/<os>/ plus the pure-CPU safety net into
# runtime/llama.cpp/<os>/cpu/ (the app's fallback ladder rung 3). mac ships Metal only.
step 3 "Download + verify the llama.cpp sidecar builds (every shipped OS)"
for os_name in win mac linux; do
  RUNTIME=(--target "$TARGET" --os "$os_name")
  [[ $DRY_RUN -eq 1 ]] && RUNTIME+=(--dry-run)
  bash "$SCRIPT_DIR/fetch-runtime.sh" "${RUNTIME[@]}"
  if [[ "$os_name" != "mac" ]]; then
    CPU_NET=(--target "$TARGET" --os "$os_name" --backend cpu)
    [[ $DRY_RUN -eq 1 ]] && CPU_NET+=(--dry-run)
    bash "$SCRIPT_DIR/fetch-runtime.sh" "${CPU_NET[@]}"
  fi
done
# Second sidecar family (Phase 36): the whisper.cpp transcriber CLI. Upstream ships a
# prebuilt WINDOWS build only (R-W1); mac/linux whisper builds are a documented manual
# source-build step (docs/packaging.md) — audio import degrades to a friendly per-file
# failure on a drive without one.
WHISPER=(--target "$TARGET" --os win --family whisper_cpp)
[[ $DRY_RUN -eq 1 ]] && WHISPER+=(--dry-run)
bash "$SCRIPT_DIR/fetch-runtime.sh" "${WHISPER[@]}"
# OCR language files (Phase 38, D32): the ocr/ asset class — plain sha256-verified
# traineddata files, OS-independent (one run covers every shipped OS).
OCR_ASSETS=(--target "$TARGET" --family ocr)
[[ $DRY_RUN -eq 1 ]] && OCR_ASSETS+=(--dry-run)
bash "$SCRIPT_DIR/fetch-runtime.sh" "${OCR_ASSETS[@]}"

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
for f in "Start HilbertRaum.cmd" "Start HilbertRaum.command" "start-hilbertraum.sh" "READ ME FIRST.txt"; do
  src="$REPO_ROOT/launchers/$f"
  if [[ -f "$src" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then echo "  copy $f -> drive root"
    else cp "$src" "$TARGET/$f"; echo "  copied $f"; fi
  fi
done
# Make the POSIX launchers executable.
[[ $DRY_RUN -eq 0 ]] && chmod +x "$TARGET/Start HilbertRaum.command" "$TARGET/start-hilbertraum.sh" 2>/dev/null || true

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
# NOTE: policy.json is MACHINE-GENERATED by prepare-drive (the greps below tolerate
# arbitrary whitespace after the colon, but not minified/hand-edited JSON — M24).
PROBLEMS=()
POLICY="$TARGET/config/policy.json"
if [[ -f "$POLICY" ]]; then
  grep -q '"encryption_required":[[:space:]]*true'  "$POLICY" || PROBLEMS+=("policy: encryption not required")
  grep -q '"allow_plaintext_dev_mode":[[:space:]]*true' "$POLICY" && PROBLEMS+=("policy: plaintext allowed")
  # Model downloads are a permitted, user-initiated action on a sold drive; only phone-home
  # channels (update checks, telemetry) must be denied. Mirrors commercial-drive.ts networkDenied.
  grep -q '"allow_update_checks":[[:space:]]*true'  "$POLICY" && PROBLEMS+=("policy: update checks allowed")
  grep -q '"allow_telemetry":[[:space:]]*true'      "$POLICY" && PROBLEMS+=("policy: telemetry allowed")
  grep -q '"require_sha256_match":[[:space:]]*true' "$POLICY" || PROBLEMS+=("policy: sha256 match not required")
else
  PROBLEMS+=("config/policy.json missing")
fi
# Mirror assertCommercialDrive: flat DB/descriptor files + WAL/SHM sidecars + documents dir.
for ud in workspace/hilbertraum.sqlite workspace/hilbertraum.sqlite.enc workspace/hilbertraum.sqlite-wal workspace/hilbertraum.sqlite-shm config/workspace.json; do
  [[ -e "$TARGET/$ud" ]] && PROBLEMS+=("user data present: $ud")
done
if [[ -d "$TARGET/workspace/documents" ]] && [[ -n "$(ls -A "$TARGET/workspace/documents" 2>/dev/null)" ]]; then
  PROBLEMS+=("user data present: workspace/documents/*")
fi
# App skills present + user-skills empty (assertCommercialDrive parity, skills plan S9 / §14):
# a sold drive ships trusted PRODUCT skills under app-skills/ (a folder with a SKILL.md) and an
# EMPTY user-skills/ (the buyer fills it). Mirrors commercial-drive.ts listSkillFolders.
app_skill_count=0
if [[ -d "$TARGET/app-skills" ]]; then
  for sd in "$TARGET/app-skills"/*/; do
    [[ -f "${sd}SKILL.md" ]] && app_skill_count=$((app_skill_count + 1))
  done
fi
[[ $app_skill_count -eq 0 ]] && PROBLEMS+=("no app skills provisioned (a sold drive ships trusted product skills under app-skills/)")
if [[ -d "$TARGET/user-skills" ]]; then
  while IFS= read -r us; do
    [[ -n "$us" ]] && PROBLEMS+=("user skill present on a drive meant to ship empty: user-skills/$us")
  done < <(ls -A "$TARGET/user-skills" 2>/dev/null)
fi
# License gate (assertCommercialDrive parity, spec 13): every shipped model's
# license_review.status must be 'approved'. --accept-license is download-time acceptance,
# NEVER a substitute for the redistribution review a sold drive needs.
if [[ $DRY_RUN -eq 0 ]]; then
  DRIVE_MANIFESTS="$TARGET/model-manifests"
  if [[ -d "$DRIVE_MANIFESTS" ]]; then
    while IFS= read -r mf; do
      [[ -n "$mf" ]] || continue
      # Only model manifests (runtime-sources.yaml has no local_path).
      grep -q '^[[:space:]]*local_path[[:space:]]*:' "$mf" || continue
      review_status="$(sed -n 's/^[[:space:]]*status[[:space:]]*:[[:space:]]*//p' "$mf" | head -n1 | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//')"
      if [[ "$review_status" != "approved" ]]; then
        PROBLEMS+=("license_review not approved: $(basename "$mf") (status: ${review_status:-missing})")
      fi
    done < <(find "$DRIVE_MANIFESTS" \( -name '*.yaml' -o -name '*.yml' \) -type f | sort)
  else
    PROBLEMS+=("model-manifests missing on the drive")
  fi
fi
# Runtime-marker gate (assertCommercialDrive parity, Phase 14): every pinned sidecar
# build must be PRESENT (binary) and carry a .hilbertraum-runtime.json whose version AND
# backend match runtime-sources.yaml — a missing binary or a missing/stale marker means
# the drive ships the wrong build (e.g. a CPU-era binary after the default moved to
# vulkan, or a half-deleted install). The dir|backend list mirrors the committed yaml
# pin; keep them in sync.
if [[ $DRY_RUN -eq 0 ]]; then
  RT_SOURCES="$TARGET/model-manifests/runtime-sources.yaml"
  if [[ -f "$RT_SOURCES" ]]; then
    # Per-family pinned versions (Phase 36: the yaml holds llama_cpp AND whisper_cpp) —
    # take the first version: line INSIDE each top-level family block.
    LLAMA_VERSION=""; WHISPER_VERSION=""; rt_top=""
    while IFS= read -r rt_raw; do
      rt_line="${rt_raw%$'\r'}"
      [[ "$rt_line" =~ ^[[:space:]]*# ]] && continue
      if [[ "$rt_line" =~ ^([A-Za-z0-9_]+)[[:space:]]*:[[:space:]]*$ ]]; then
        rt_top="${BASH_REMATCH[1]}"; continue
      fi
      if [[ "$rt_line" =~ ^[[:space:]]*version[[:space:]]*:[[:space:]]*(.+)$ ]]; then
        rt_v="$(echo "${BASH_REMATCH[1]}" | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//')"
        [[ "$rt_top" == "llama_cpp" && -z "$LLAMA_VERSION" ]] && LLAMA_VERSION="$rt_v"
        [[ "$rt_top" == "whisper_cpp" && -z "$WHISPER_VERSION" ]] && WHISPER_VERSION="$rt_v"
      fi
    done < "$RT_SOURCES"
    for rt_entry in \
      "llama|runtime/llama.cpp/win|vulkan|llama-server.exe" \
      "llama|runtime/llama.cpp/win/cpu|cpu|llama-server.exe" \
      "llama|runtime/llama.cpp/mac|metal|llama-server" \
      "llama|runtime/llama.cpp/linux|vulkan|llama-server" \
      "llama|runtime/llama.cpp/linux/cpu|cpu|llama-server" \
      "whisper|runtime/whisper.cpp/win|cpu|whisper-cli.exe"; do
      rt_family="${rt_entry%%|*}"
      rt_rest="${rt_entry#*|}"
      rt_dir="${rt_rest%%|*}"
      rt_rest="${rt_rest#*|}"
      rt_backend="${rt_rest%%|*}"
      rt_bin="${rt_rest#*|}"
      RT_VERSION="$LLAMA_VERSION"; [[ "$rt_family" == "whisper" ]] && RT_VERSION="$WHISPER_VERSION"
      marker_file="$TARGET/$rt_dir/.hilbertraum-runtime.json"
      bin_file="$TARGET/$rt_dir/$rt_bin"
      if [[ ! -f "$bin_file" ]]; then
        PROBLEMS+=("runtime: $rt_bin missing under $rt_dir (re-run fetch-runtime)")
      elif [[ ! -f "$marker_file" ]]; then
        PROBLEMS+=("runtime: no .hilbertraum-runtime.json install marker under $rt_dir (re-run fetch-runtime)")
      else
        m_version="$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$marker_file")"
        m_backend="$(sed -n 's/.*"backend":"\([^"]*\)".*/\1/p' "$marker_file")"
        if [[ (-n "$RT_VERSION" && "$m_version" != "$RT_VERSION") || "$m_backend" != "$rt_backend" ]]; then
          PROBLEMS+=("runtime: $rt_dir marker does not match the pinned $RT_VERSION/$rt_backend (re-run fetch-runtime)")
        fi
      fi
    done
  else
    PROBLEMS+=("model-manifests/runtime-sources.yaml missing on the drive")
  fi
fi
# OCR asset gate (Phase 38, assertCommercialDrive parity): every pinned ocr file must
# be present with a matching sha256 (plain files — the hash IS the install state).
if [[ $DRY_RUN -eq 0 && -f "$TARGET/model-manifests/runtime-sources.yaml" ]]; then
  ocr_top=""; ocr_lang=""; ocr_sha=""; ocr_dest=""
  check_ocr_file() {
    [[ -z "$ocr_lang" ]] && return 0
    if [[ ! -f "$TARGET/$ocr_dest" ]]; then
      PROBLEMS+=("ocr: $ocr_dest missing (run fetch-runtime --family ocr)")
    elif [[ "$ocr_sha" =~ ^[a-f0-9]{64}$ ]]; then
      if command -v sha256sum >/dev/null 2>&1; then ocr_actual="$(sha256sum "$TARGET/$ocr_dest" | awk '{print $1}')"
      else ocr_actual="$(shasum -a 256 "$TARGET/$ocr_dest" | awk '{print $1}')"; fi
      if [[ "$ocr_actual" != "$ocr_sha" ]]; then
        PROBLEMS+=("ocr: $ocr_dest checksum mismatch (re-run fetch-runtime --family ocr)")
      fi
    fi
  }
  while IFS= read -r ocr_raw; do
    ocr_line="${ocr_raw%$'\r'}"
    [[ "$ocr_line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$ocr_line" =~ ^([A-Za-z0-9_]+)[[:space:]]*:[[:space:]]*$ ]]; then
      check_ocr_file; ocr_lang=""; ocr_top="${BASH_REMATCH[1]}"; continue
    fi
    [[ "$ocr_top" == "ocr" ]] || continue
    if [[ "$ocr_line" =~ ^[[:space:]]*-[[:space:]]*lang[[:space:]]*:[[:space:]]*(.+)$ ]]; then
      check_ocr_file
      ocr_lang="$(echo "${BASH_REMATCH[1]}" | sed 's/[[:space:]][[:space:]]*#.*$//;s/[[:space:]]*$//')"
      ocr_sha=""; ocr_dest=""
      continue
    fi
    if [[ -n "$ocr_lang" && "$ocr_line" =~ ^[[:space:]]+sha256[[:space:]]*:[[:space:]]*(.+)$ ]]; then
      ocr_sha="$(echo "${BASH_REMATCH[1]}" | sed 's/[[:space:]][[:space:]]*#.*$//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
    fi
    if [[ -n "$ocr_lang" && "$ocr_line" =~ ^[[:space:]]+dest[[:space:]]*:[[:space:]]*(.+)$ ]]; then
      ocr_dest="$(echo "${BASH_REMATCH[1]}" | sed 's/[[:space:]][[:space:]]*#.*$//;s/[[:space:]]*$//')"
    fi
  done < "$TARGET/model-manifests/runtime-sources.yaml"
  check_ocr_file
fi
# Weight gate (assertCommercialDrive parity): every weight VERIFIED, automated — not a
# manual "confirm it yourself" instruction. UNVERIFIED/MISSING/MISMATCH all fail here.
if [[ $DRY_RUN -eq 0 ]]; then
  if ! bash "$SCRIPT_DIR/verify-models.sh" --target "$TARGET" --strict; then
    PROBLEMS+=("weights: not every weight is VERIFIED (strict verify failed)")
  fi
fi
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  (dry run: posture + weight checks skipped)"
elif [[ ${#PROBLEMS[@]} -gt 0 ]]; then
  echo "  NOT SELLABLE:"
  for p in "${PROBLEMS[@]}"; do echo "    - $p"; done
  exit 1
else
  echo "  SELLABLE: posture OK (encrypted, no phone-home, no user data) + all weights VERIFIED."
fi

echo
echo "Done. Test the drive on a clean laptop with Wi-Fi OFF (spec section 17 demo)."
