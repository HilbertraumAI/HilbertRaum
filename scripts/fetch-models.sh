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
#   scripts/fetch-models.sh --target /Volumes/HILBERTRAUM [--only <id>] \
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
# Inline YAML comments (whitespace + '#' + rest) are stripped before unquoting (M17).
field() { sed -n "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//p" "$1" | head -n1 | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

# Same flat parse, but over a string (a YAML sub-block) instead of a file — used to read the
# mmproj projector block's local_path/sha256/url (the SECOND file of a vision model, DIST-1).
field_in() { printf '%s\n' "$1" | sed -n "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//p" | head -n1 | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

# Extract the indented body of a top-level `mmproj:` mapping (lines until the next column-0 key).
mmproj_block_of() { awk '/^mmproj:[[:space:]]*$/{f=1;next} /^[^[:space:]]/{f=0} f' "$1"; }

is_real_sha() { [[ "$1" =~ ^[a-f0-9]{64}$ ]]; }

# Classify a destination file against its expected hash: verified|placeholder|mismatch|absent.
file_state() {
  local dest="$1" sha="$2"
  if [[ ! -f "$dest" ]]; then echo absent; return; fi
  if is_real_sha "$sha"; then
    if [[ "$(sha256_of "$dest")" == "$sha" ]]; then echo verified; else echo mismatch; fi
  else echo placeholder; fi
}

# Resilient curl (mirrors fetch-runtime.sh): curl --retry alone does not retry a mid-transfer
# DROP on older curl, so an OUTER loop RESUMES the partial file (-C -) on each attempt — a
# flaky link (beta-tester report) survives several disconnects. $3 = extra flags (may be
# empty). Hash verification afterwards guards integrity, so resume is safe.
curl_resilient() {
  local url="$1" dest="$2" extra="${3:-}"
  local attempts=5 i wait
  for (( i = 1; i <= attempts; i++ )); do
    # shellcheck disable=SC2086 # $extra is an intentional word-split flag list (may be empty)
    if curl -L --fail --retry 3 --retry-delay 2 --retry-connrefused \
         --connect-timeout 30 $extra -C - -o "$dest" "$url"; then
      return 0
    fi
    if (( i < attempts )); then
      wait=$(( i * 3 ))
      echo "    connection interrupted -- retry $i/$attempts in ${wait}s, resuming…" >&2
      sleep "$wait"
    fi
  done
  return 1
}

# Best available downloader: aria2c (multi-connection, resumable) else curl (-C - resumes).
download() {
  local url="$1" dest="$2" dir
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  if command -v aria2c >/dev/null 2>&1; then
    aria2c --continue=true --max-connection-per-server=8 --split=8 \
      --dir "$dir" --out "$(basename "$dest")" "$url"
  elif command -v curl >/dev/null 2>&1; then
    # Schannel curl (Windows/git-bash): best-effort revocation only on that backend;
    # integrity is enforced by the SHA-256 verification after download.
    local curl_extra=""
    curl --version 2>/dev/null | head -n1 | grep -qi schannel && curl_extra="--ssl-revoke-best-effort"
    curl_resilient "$url" "$dest" "$curl_extra"
  elif command -v wget >/dev/null 2>&1; then
    wget -c -O "$dest" "$url"
  else
    echo "No downloader found (need curl, wget, or aria2c)." >&2
    return 3
  fi
}

# Fetch + verify ONE file (the GGUF, or a vision model's mmproj projector), given its already-
# computed state. Mirrors assets.ts `planOneFile` + the atomic verify-before-trust contract.
# Args: id label dest sha url relpath state. Updates the global fetched/skipped/had_failure.
handle_file() {
  local id="$1" label="$2" dest="$3" sha="$4" url="$5" rel="$6" state="$7"
  case "$state" in
    verified)    printf '  skip   %s%s (present + verified)\n' "$id" "$label"; skipped=$((skipped + 1)); return 0 ;;
    placeholder) printf '  skip   %s%s (present; placeholder hash — cannot verify)\n' "$id" "$label"; skipped=$((skipped + 1)); return 0 ;;
    mismatch)    printf '  redo   %s%s (present but checksum mismatch — re-downloading)\n' "$id" "$label" ;;
  esac
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  fetch  %s%s\n           %s\n           -> %s\n' "$id" "$label" "$url" "$rel"; return 0
  fi
  printf '  fetch  %s%s ...\n' "$id" "$label"
  if ! download "$url" "$dest"; then
    printf '  FAIL   %s%s: download error\n' "$id" "$label" >&2; had_failure=1; return 1
  fi
  if is_real_sha "$sha"; then
    local actual; actual="$(sha256_of "$dest")"
    if [[ "$actual" == "$sha" ]]; then
      printf '  ok     %s%s (VERIFIED)\n' "$id" "$label"; fetched=$((fetched + 1))
    else
      printf '  FAIL   %s%s: checksum mismatch (expected %s, got %s) — deleting partial\n' "$id" "$label" "$sha" "$actual" >&2
      rm -f "$dest" "$dest.aria2"; had_failure=1
    fi
  else
    printf '  ok     %s%s (UNVERIFIED — placeholder hash; run verify-models --generate)\n' "$id" "$label"; fetched=$((fetched + 1))
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

# Bash 3.2 + `set -u`: expanding an EMPTY array aborts with "unbound variable" (M23).
if [[ ${#MANIFEST_FILES[@]} -eq 0 ]]; then
  echo "No model manifests found under $MANIFESTS_DIR — nothing to fetch."
  exit 0
fi

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

  # A vision model is TWO files: the language GGUF (above) + the mmproj projector (DIST-1). Parse
  # the projector's own block (its local_path/sha256/download.url) — absent for non-vision models.
  mmproj_block="$(mmproj_block_of "$mf")"
  mmproj_local="$(field_in "$mmproj_block" local_path)"
  mmproj_sha="$(field_in "$mmproj_block" sha256 | tr '[:upper:]' '[:lower:]')"
  mmproj_url="$(field_in "$mmproj_block" url)"
  has_mmproj=0
  [[ -n "$mmproj_url" && -n "$mmproj_local" ]] && has_mmproj=1
  mmproj_dest="$TARGET/$mmproj_local"

  # Classify each file ONCE (a present multi-GB weight is hashed at most once).
  gguf_state="$(file_state "$dest" "$sha")"
  mmproj_state=""
  [[ $has_mmproj -eq 1 ]] && mmproj_state="$(file_state "$mmproj_dest" "$mmproj_sha")"

  # Does anything need the network? (absent / checksum-mismatch). A model already fully present
  # is skipped WITHOUT a license prompt (the license is only relevant to an actual download).
  needs_fetch=0
  [[ "$gguf_state" == absent || "$gguf_state" == mismatch ]] && needs_fetch=1
  [[ $has_mmproj -eq 1 && ( "$mmproj_state" == absent || "$mmproj_state" == mismatch ) ]] && needs_fetch=1

  if [[ $needs_fetch -eq 1 ]]; then
    # License gate (spec §13) — only when something will actually be fetched.
    if [[ "$review_status" != "approved" && $ACCEPT_LICENSE -eq 0 ]]; then
      printf '  BLOCK  %s: license "%s" not approved.\n' "$id" "$license" >&2
      [[ -n "$license_url" ]] && printf '         License: %s\n' "$license_url" >&2
      echo   '         Re-run with --accept-license to accept and continue.' >&2
      had_failure=1; continue
    fi
    if [[ "$review_status" != "approved" ]]; then
      printf '  note   %s: license "%s" accepted via --accept-license (%s)\n' "$id" "$license" "$license_url"
    fi
  fi

  # Call failure-tolerantly (|| true): handle_file's download-error path does `return 1`, and
  # under `set -euo pipefail` a non-zero return in plain-command (or post-`&&`) position trips
  # errexit and kills the whole batch — so one flaky link would silently skip every remaining
  # manifest and the failed model's mmproj sibling, and the summary/gate would never print. The
  # function already records the outcome in had_failure, which sets the exit code at the end, so
  # swallowing the return here keeps the batch going while still exiting 1 — matching
  # fetch-models.ps1's continue-then-summarize-then-exit-1 behavior (F-04, full audit 2026-07-16).
  handle_file "$id" "" "$dest" "$sha" "$url" "$local_path" "$gguf_state" || true
  [[ $has_mmproj -eq 1 ]] && { handle_file "$id" " (mmproj)" "$mmproj_dest" "$mmproj_sha" "$mmproj_url" "$mmproj_local" "$mmproj_state" || true; }
done

echo
printf 'Planned %d | fetched %d | skipped %d\n' "$planned" "$fetched" "$skipped"
if [[ $had_failure -eq 1 ]]; then
  echo "One or more models failed to download/verify (or were license-blocked)." >&2
  exit 1
fi
exit 0
