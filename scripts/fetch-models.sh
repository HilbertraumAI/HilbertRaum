#!/usr/bin/env bash
# Download + verify model weights onto a prepared drive (Phase 12 — DIY asset loader).
#
# For each model manifest with a `download:` block, downloads the weight to its local_path
# under the drive root, RESUMES partial downloads (curl -C - / aria2c), then SHA-256-
# verifies it against the manifest's top-level sha256 before counting it installed.
#
# Mirrors apps/desktop/src/main/services/assets.ts + verify-models.sh's flat-YAML parse.
# Self-contained: needs no Node/npm. Uses the OS-native downloader (curl; prefers aria2c).
#
# Verify-before-trust: a real-hash MISMATCH deletes the partial and exits non-zero. A
# placeholder hash downloads the file but reports it UNVERIFIED. Idempotent: a present +
# verified weight is skipped.
#
# License gate (spec §13): a model whose license_review.status != 'approved' is refused
# unless --accept-license is passed; the license + license_url are printed first.
#
# Usage:
#   scripts/fetch-models.sh --target /Volumes/PRIVATE_AI_DRIVE [--only <id>] \
#       [--accept-license] [--dry-run]
set -euo pipefail

TARGET=""
ONLY=""
ACCEPT_LICENSE=0
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --only=*) ONLY="${1#*=}"; shift ;;
    --accept-license) ACCEPT_LICENSE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$TARGET" ]] && { echo "Error: --target <drive-root> is required" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MANIFESTS_DIR="$TARGET/model-manifests"
[[ -d "$MANIFESTS_DIR" ]] || MANIFESTS_DIR="$REPO_ROOT/model-manifests"
[[ -d "$MANIFESTS_DIR" ]] || { echo "No model-manifests found under '$TARGET' or repo root." >&2; exit 2; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Flat-YAML line parse — first match wins (top-level sha256 over the nested download one).
field() { sed -n "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//p" "$1" | head -n1 | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

is_real_sha() { [[ "$1" =~ ^[a-f0-9]{64}$ ]]; }

# Best available downloader: aria2c (multi-connection, resumable) else curl (-C - resumes).
download() {
  local url="$1" dest="$2" dir
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  if command -v aria2c >/dev/null 2>&1; then
    aria2c --continue=true --max-connection-per-server=8 --split=8 \
      --dir "$dir" --out "$(basename "$dest")" "$url"
  elif command -v curl >/dev/null 2>&1; then
    curl -L --fail --retry 3 -C - -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -c -O "$dest" "$url"
  else
    echo "No downloader found (need curl, wget, or aria2c)." >&2
    return 3
  fi
}

MANIFEST_FILES=()
while IFS= read -r mf; do
  [ -n "$mf" ] && MANIFEST_FILES+=("$mf")
done < <(find "$MANIFESTS_DIR" \( -name '*.yaml' -o -name '*.yml' \) -type f \
         ! -name 'runtime-sources.yaml' ! -name 'runtime-sources.yml' | sort)

planned=0; fetched=0; skipped=0; had_failure=0

echo "Fetch models -> $TARGET"
[[ $DRY_RUN -eq 1 ]] && echo "(dry run — nothing will be downloaded)"
echo

for mf in "${MANIFEST_FILES[@]}"; do
  id="$(field "$mf" id)"
  local_path="$(field "$mf" local_path)"
  sha="$(field "$mf" sha256 | tr '[:upper:]' '[:lower:]')"
  url="$(field "$mf" url)"
  license="$(field "$mf" license)"
  license_url="$(field "$mf" license_url)"
  review_status="$(field "$mf" status)"

  [[ -z "$url" || -z "$local_path" ]] && continue       # no download block → skip
  [[ -n "$ONLY" && "$id" != "$ONLY" ]] && continue
  planned=$((planned + 1))

  dest="$TARGET/$local_path"

  # Idempotent skip.
  if [[ -f "$dest" ]]; then
    if is_real_sha "$sha"; then
      if [[ "$(sha256_of "$dest")" == "$sha" ]]; then
        printf '  skip   %s (present + verified)\n' "$id"; skipped=$((skipped + 1)); continue
      fi
      printf '  redo   %s (present but checksum mismatch — re-downloading)\n' "$id"
    else
      printf '  skip   %s (present; placeholder hash — cannot verify)\n' "$id"; skipped=$((skipped + 1)); continue
    fi
  fi

  # License gate.
  if [[ "$review_status" != "approved" && $ACCEPT_LICENSE -eq 0 ]]; then
    printf '  BLOCK  %s: license "%s" not approved.\n' "$id" "$license" >&2
    [[ -n "$license_url" ]] && printf '         License: %s\n' "$license_url" >&2
    echo   '         Re-run with --accept-license to accept and continue.' >&2
    had_failure=1; continue
  fi
  if [[ "$review_status" != "approved" ]]; then
    printf '  note   %s: license "%s" accepted via --accept-license (%s)\n' "$id" "$license" "$license_url"
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  fetch  %s\n           %s\n           -> %s\n' "$id" "$url" "$local_path"; continue
  fi

  printf '  fetch  %s ...\n' "$id"
  if ! download "$url" "$dest"; then
    printf '  FAIL   %s: download error\n' "$id" >&2; had_failure=1; continue
  fi

  if is_real_sha "$sha"; then
    actual="$(sha256_of "$dest")"
    if [[ "$actual" == "$sha" ]]; then
      printf '  ok     %s (VERIFIED)\n' "$id"; fetched=$((fetched + 1))
    else
      printf '  FAIL   %s: checksum mismatch (expected %s, got %s) — deleting partial\n' "$id" "$sha" "$actual" >&2
      rm -f "$dest"; had_failure=1
    fi
  else
    printf '  ok     %s (UNVERIFIED — placeholder hash; run verify-models --generate)\n' "$id"
    fetched=$((fetched + 1))
  fi
done

echo
printf 'Planned %d | fetched %d | skipped %d\n' "$planned" "$fetched" "$skipped"
if [[ $had_failure -eq 1 ]]; then
  echo "One or more models failed to download/verify (or were license-blocked)." >&2
  exit 1
fi
exit 0
