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
#   7. final check: the CANONICAL gate (assertCommercialDrive, run through the built
#      apps/desktop/out/tools/assert-commercial-drive.mjs -- needs `npm run build` and
#      node on PATH) after a native pre-flight -- exits 1 unless the drive is sellable.
#      SELLABLE is printed only from the canonical verdict (#233, #234). The gate also
#      requires the app artifact + launcher for every platform in --platforms and a
#      recorded, matching hash for every sidecar binary.
#
# Mirrors apps/desktop/src/main/services/commercial-drive.ts (planCommercialDrive +
# assertCommercialDrive) -- that TS module is the CANONICAL, unit-tested reference. This
# script ORCHESTRATES the existing scripts; it does not re-implement them.
#
# SIGNING IS MANUAL. The green gate does not sign. Supply the pre-built, signed app(s)
# via --app-artifact (repeatable, one per platform), or use --skip-package (the drive is
# NOT SELLABLE until the apps are on it). The script REFUSES to proceed when a differently
# named HilbertRaum-* artifact (or an extracted .app) already sits at the drive root --
# delete the old build first (#233). See docs/packaging.md.
#
# Usage:
#   scripts/build-commercial-drive.sh --target /Volumes/HILBERTRAUM --accept-license \
#       [--app-artifact ./release/HilbertRaum-0.1.0.AppImage]... [--platforms win-x64,mac-arm64,linux-x64] \
#       [--kiwix-source-dir <archive dir>] [--skip-package] [--verify-only] [--dry-run]
#   --platforms         the platforms this kit is sold for (default all three)
#   --kiwix-source-dir  install the kiwix-tools corresponding-source bundle from this
#                       maintainer-local archive dir before fetching kiwix_tools binaries
#                       (#339 P8-4); omitted = this Kit ships no kiwix-tools at all
#   --verify-only skip steps 1-6, run only the final gate against the drive as it is
#   --dry-run     download and change nothing; the final gate still runs and prints its verdict
set -euo pipefail

TARGET=""
ACCEPT_LICENSE=0
APP_ARTIFACTS=()
PLATFORMS="win-x64,mac-arm64,linux-x64"
KIWIX_SOURCE_DIR=""
SKIP_PACKAGE=0
VERIFY_ONLY=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --accept-license) ACCEPT_LICENSE=1; shift ;;
    --app-artifact) APP_ARTIFACTS+=("${2:-}"); shift 2 ;;
    --app-artifact=*) APP_ARTIFACTS+=("${1#*=}"); shift ;;
    --platforms) PLATFORMS="${2:-}"; shift 2 ;;
    --platforms=*) PLATFORMS="${1#*=}"; shift ;;
    --kiwix-source-dir) KIWIX_SOURCE_DIR="${2:-}"; shift 2 ;;
    --kiwix-source-dir=*) KIWIX_SOURCE_DIR="${1#*=}"; shift ;;
    --skip-package) SKIP_PACKAGE=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
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

# The platforms a kit can be sold for -- keep in sync with KIT_PLATFORMS in
# apps/desktop/src/shared/runtime-sources.ts (script-drift test).
KIT_PLATFORMS=(
  win-x64
  mac-arm64
  linux-x64
)
[[ -n "$PLATFORMS" ]] || { echo "--platforms must name at least one platform" >&2; exit 2; }
IFS=',' read -r -a PLATFORM_LIST <<< "$PLATFORMS"
for p in "${PLATFORM_LIST[@]}"; do
  known=0
  for k in "${KIT_PLATFORMS[@]}"; do [[ "$p" == "$k" ]] && known=1; done
  if [[ $known -eq 0 ]]; then
    echo "Unknown platform '$p' -- known: ${KIT_PLATFORMS[*]}" >&2
    exit 2
  fi
done
# The version the artifacts must carry = the desktop package's (electron-builder and the
# release workflow name HilbertRaum-<version>-... from apps/desktop/package.json).
APP_VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/apps/desktop/package.json" | head -n1)"

# Refuse to proceed when another app artifact already sits at the drive root (#233): the
# copy in step 4 overwrites only the same basename, so an older build would stay beside
# the new one and the launchers would find two. Delete it first, on purpose.
if [[ ${#APP_ARTIFACTS[@]} -gt 0 && $VERIFY_ONLY -eq 0 ]]; then
  PRIOR=()
  shopt -s nullglob
  for existing in "$TARGET"/HilbertRaum-* "$TARGET"/*.app; do
    name="$(basename "$existing")"
    incoming=0
    for a in "${APP_ARTIFACTS[@]}"; do [[ "$(basename "$a")" == "$name" ]] && incoming=1; done
    [[ $incoming -eq 0 ]] && PRIOR+=("$name")
  done
  shopt -u nullglob
  if [[ ${#PRIOR[@]} -gt 0 ]]; then
    echo "Refusing to proceed: another app artifact already sits at the drive root:" >&2
    for p in "${PRIOR[@]}"; do echo "  - $p" >&2; done
    echo "  Delete it first (a drive must carry exactly one app build), then re-run." >&2
    exit 1
  fi
fi

step() { echo; echo "[$1] $2"; }

echo "Build a COMMERCIAL (sellable) drive at: $TARGET"
echo "  platforms: $PLATFORMS | app version: $APP_VERSION"
[[ $DRY_RUN -eq 1 ]] && echo "(dry run -- nothing will be changed; the final gate still runs)"
[[ $VERIFY_ONLY -eq 1 ]] && echo "(verify only -- steps 1-6 skipped)"

if [[ $VERIFY_ONLY -eq 0 ]]; then
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
# --commercial (#234): a placeholder archive hash is refused before any download, a
# hashless (legacy) install marker is re-fetched instead of skipped, and the marker
# records the binary hash only after a verified archive.
for os_name in win mac linux; do
  RUNTIME=(--target "$TARGET" --os "$os_name" --commercial)
  [[ $DRY_RUN -eq 1 ]] && RUNTIME+=(--dry-run)
  bash "$SCRIPT_DIR/fetch-runtime.sh" "${RUNTIME[@]}"
  if [[ "$os_name" != "mac" ]]; then
    CPU_NET=(--target "$TARGET" --os "$os_name" --backend cpu --commercial)
    [[ $DRY_RUN -eq 1 ]] && CPU_NET+=(--dry-run)
    bash "$SCRIPT_DIR/fetch-runtime.sh" "${CPU_NET[@]}"
  fi
done
# Second sidecar family (Phase 36): the whisper.cpp transcriber CLI. Upstream ships a
# prebuilt WINDOWS build only (R-W1); mac/linux whisper builds are a documented manual
# source-build step (docs/packaging.md) — audio import degrades to a friendly per-file
# failure on a drive without one.
WHISPER=(--target "$TARGET" --os win --family whisper_cpp --commercial)
[[ $DRY_RUN -eq 1 ]] && WHISPER+=(--dry-run)
bash "$SCRIPT_DIR/fetch-runtime.sh" "${WHISPER[@]}"
# OCR language files (Phase 38, D32): the ocr/ asset class — plain sha256-verified
# traineddata files, OS-independent (one run covers every shipped OS).
OCR_ASSETS=(--target "$TARGET" --family ocr --commercial)
[[ $DRY_RUN -eq 1 ]] && OCR_ASSETS+=(--dry-run)
bash "$SCRIPT_DIR/fetch-runtime.sh" "${OCR_ASSETS[@]}"

# --- Kiwix-tools corresponding-source bundle (#339 P8-4) ---------------------------
# UN-NUMBERED: sits between the runtime sidecars above and packaging below, but is not
# one of the seven planCommercialDrive step ids (commercial-drive.test.ts pins those).
# SOURCE FIRST: the bundle is installed + re-verified BEFORE the kiwix_tools binaries are
# fetched, so a failed/aborted install can never leave binaries on the drive without their
# complete corresponding source. Omitted --kiwix-source-dir = this Kit ships no kiwix-tools
# at all; the buyer installs the (unbundled) family in-app instead (its own download, its
# own consent) -- checkSourceBundle then finds no kiwix_tools binary present and passes.
if [[ -z "$KIWIX_SOURCE_DIR" ]]; then
  echo
  echo "(no --kiwix-source-dir: this Kit ships no kiwix-tools; the buyer installs the family in-app)"
else
  echo
  echo "Installing the kiwix-tools corresponding-source bundle (#339 P8-4)"
  if ! command -v node >/dev/null 2>&1; then
    echo "  install-kiwix-source-bundle.mjs needs node on PATH" >&2
    exit 1
  fi
  KIWIX_INSTALL_ARGS=("$REPO_ROOT/scripts/install-kiwix-source-bundle.mjs" --target "$TARGET" --source-dir "$KIWIX_SOURCE_DIR")
  [[ $DRY_RUN -eq 1 ]] && KIWIX_INSTALL_ARGS+=(--dry-run)
  if ! node "${KIWIX_INSTALL_ARGS[@]}"; then
    echo "  install-kiwix-source-bundle.mjs failed -- refusing to fetch kiwix-tools binaries without their source" >&2
    exit 1
  fi
  echo "  Fetching the kiwix-tools binaries for every Kit platform (explicit --arch, never inherited from the yaml)"
  for kiwix_entry in "win|x64" "mac|arm64" "linux|x64"; do
    kiwix_os="${kiwix_entry%%|*}"
    kiwix_arch="${kiwix_entry#*|}"
    KIWIX_RUNTIME=(--target "$TARGET" --os "$kiwix_os" --arch "$kiwix_arch" --family kiwix_tools --commercial)
    [[ $DRY_RUN -eq 1 ]] && KIWIX_RUNTIME+=(--dry-run)
    bash "$SCRIPT_DIR/fetch-runtime.sh" "${KIWIX_RUNTIME[@]}"
  done
fi

# --- 4. Package + sign + notarize (MANUAL) -----------------------------------------
step 4 "Package + sign the app (MANUAL -- secrets never in the repo)"
if [[ $SKIP_PACKAGE -eq 1 ]]; then
  echo "  --skip-package set: skipping packaging. Sign + copy the app yourself (NOT SELLABLE until then)."
elif [[ ${#APP_ARTIFACTS[@]} -gt 0 ]]; then
  for artifact in "${APP_ARTIFACTS[@]}"; do
    if [[ ! -e "$artifact" ]]; then echo "AppArtifact not found: $artifact" >&2; exit 1; fi
    DST="$TARGET/$(basename "$artifact")"
    if [[ $DRY_RUN -eq 1 ]]; then echo "  copy $artifact -> $DST"
    else cp -R "$artifact" "$DST"; echo "  copied signed app -> $DST"; fi
  done
else
  echo "  No --app-artifact supplied. Build + sign the app for every platform in --platforms, then"
  echo "  re-run with --app-artifact <path>..., or copy them onto the drive manually. See docs/packaging.md."
fi

# --- 5. Copy the launcher + user docs onto the drive root --------------------------
# NOTE: the root license/attribution artifacts (LICENSE, THIRD-PARTY-NOTICES.md,
# DRIVE-NOTICES.md — LIC-1) are NOT re-copied here: step 1 runs prepare-drive, whose
# base flow already places them at the drive root; the step-7 gate below verifies them.
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
fi # end of steps 1-6 (skipped by --verify-only)

# --- 7. Final check: is this drive sellable? ---------------------------------------
step 7 "Final check: native pre-flight, then the canonical gate (assertCommercialDrive)"
echo "  Native pre-flight of the key invariants (the verdict below comes from the canonical gate):"
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
# License/attribution artifacts gate (assertCommercialDrive parity, LIC-1, full-audit
# 2026-07-12b): a sold drive ships MIT binaries + Apache-2.0 weights/traineddata + the
# GPL app — the three root notice files prepare-drive copies discharge the recorded
# "ship the LICENSE/NOTICE attribution with the drive" requirements. Missing OR EMPTY
# fails. Keep in sync with commercial-drive.ts DRIVE_LICENSE_ARTIFACTS (script-drift test).
LICENSE_ARTIFACTS=(
  LICENSE
  THIRD-PARTY-NOTICES.md
  DRIVE-NOTICES.md
)
for lic in "${LICENSE_ARTIFACTS[@]}"; do
  if [[ ! -s "$TARGET/$lic" ]]; then
    PROBLEMS+=("license/attribution artifact missing or empty at the drive root: $lic (re-run prepare-drive)")
  fi
done
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
[[ $DRY_RUN -eq 1 ]] && echo "  (dry run: weight verification skipped; the canonical gate still runs)"
# Canonical gate (#233, #234): the verdict is assertCommercialDrive()'s, run through the
# built tool — SELLABLE is printed only when it passes AND the pre-flight found nothing.
# Reads only the drive (no network). Needs `npm run build` and node on PATH.
GATE_TOOL="$REPO_ROOT/apps/desktop/out/tools/assert-commercial-drive.mjs"
if [[ ! -f "$GATE_TOOL" ]]; then
  PROBLEMS+=("canonical gate not built: $GATE_TOOL missing (run npm run build)")
elif ! command -v node >/dev/null 2>&1; then
  PROBLEMS+=("canonical gate needs node on PATH")
else
  echo "  Canonical gate:"
  GATE_EXIT=0
  node "$GATE_TOOL" --target "$TARGET" --platforms "$PLATFORMS" --app-version "$APP_VERSION" || GATE_EXIT=$?
  [[ $GATE_EXIT -ne 0 ]] && PROBLEMS+=("canonical gate: not sellable (exit $GATE_EXIT, see above)")
fi
if [[ ${#PROBLEMS[@]} -gt 0 ]]; then
  echo "  NOT SELLABLE:"
  for p in "${PROBLEMS[@]}"; do echo "    - $p"; done
  exit 1
fi
echo "  SELLABLE: canonical gate passed for $PLATFORMS at $APP_VERSION."

echo
echo "Done. Test the drive on a clean laptop with Wi-Fi OFF (spec section 17 demo)."
