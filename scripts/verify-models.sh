#!/usr/bin/env bash
# Verify model weights on a prepared drive against their manifest SHA-256 (Phase 11).
#
# Mirrors apps/desktop/src/main/services/models.ts verifyChecksum / isRealSha256:
#   placeholder hash (REPLACE_WITH_REAL_HASH) -> UNVERIFIED (not pass, not fail)
#   real hash, file matches                   -> VERIFIED
#   real hash, file differs                   -> MISMATCH  (exit 1)
#   file absent                               -> MISSING
#
# --generate writes <target>/config/checksums.json from the present weights.
# --strict   ship gate: exit 1 unless every manifest weight is VERIFIED (and >= 1
#            exists) — mirrors commercial-drive.ts assertCommercialDrive.
#
# Usage:
#   scripts/verify-models.sh --target /Volumes/PRIVATE_AI_DRIVE [--generate] [--strict]
set -euo pipefail

TARGET=""
GENERATE=0
STRICT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --generate) GENERATE=1; shift ;;
    --strict) STRICT=1; shift ;;
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

# Cross-platform SHA-256 (Linux: sha256sum; macOS: shasum -a 256).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Flat-YAML line parse for a single key. Inline YAML comments (whitespace + '#' + rest)
# are stripped before unquoting (M17).
field() { sed -n "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//p" "$1" | head -n1 | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

# Same flat parse over a string (a YAML sub-block) — reads the mmproj projector's local_path/sha256
# (the SECOND file of a vision model, DIST-2: verify BOTH files, mirroring services/models.ts).
field_in() { printf '%s\n' "$1" | sed -n "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//p" | head -n1 | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

# Extract the indented body of a top-level `mmproj:` mapping (lines until the next column-0 key).
mmproj_block_of() { awk '/^mmproj:[[:space:]]*$/{f=1;next} /^[^[:space:]]/{f=0} f' "$1"; }

is_real_sha() { [[ "$1" =~ ^[a-f0-9]{64}$ ]]; }

# Supported (runtime -> format) pairs — mirror models.ts SUPPORTED_RUNTIME_FORMATS (the app's
# §7.4 gate; drift test M-A1). A ggml/whisper_cpp weight (the bundled transcriber) has a real
# sha256 and verifies by SHA-256 like any GGUF; only a genuinely unloadable pair is UNSUPPORTED.
supported_format_for() {
  case "$1" in
    llama_cpp|llama.cpp) printf 'gguf' ;;
    whisper_cpp)         printf 'ggml' ;;
  esac
}

had_mismatch=0
total_weights=0
verified_weights=0

# Verify ONE file (the GGUF, or a vision model's mmproj projector) against its expected hash,
# updating the counters. Mirrors services/models.ts verifyChecksum + drive.ts verifyDriveModels.
verify_file() {
  local id="$1" label="$2" weight="$3" sha="$4" status actual
  if [[ ! -f "$weight" ]]; then
    status="MISSING"
  else
    actual="$(sha256_of "$weight")"
    if ! is_real_sha "$sha"; then status="UNVERIFIED"
    elif [[ "$actual" == "$sha" ]]; then status="VERIFIED"
    else status="MISMATCH"; had_mismatch=1; fi
  fi
  total_weights=$((total_weights + 1))
  [[ "$status" == "VERIFIED" ]] && verified_weights=$((verified_weights + 1))
  [[ $STRICT -eq 1 && "$status" != "VERIFIED" ]] && echo "STRICT: $id$label is $status (must be VERIFIED)" >&2
  printf '  %-12s %s\n' "$status" "$id$label"
}
# Collect manifest paths WITHOUT `mapfile` (a Bash 4+ builtin absent from macOS's stock
# Bash 3.2) and WITHOUT `sort -z` (not on BSD/macOS sort). Newline-delimited read is
# portable; manifest filenames are controlled and contain no newlines.
MANIFEST_FILES=()
while IFS= read -r mf; do
  [ -n "$mf" ] && MANIFEST_FILES+=("$mf")
done < <(find "$MANIFESTS_DIR" \( -name '*.yaml' -o -name '*.yml' \) -type f \
         ! -name 'runtime-sources.yaml' ! -name 'runtime-sources.yml' | sort)

# Bash 3.2 + `set -u`: expanding an EMPTY array aborts with "unbound variable" (M23).
if [[ ${#MANIFEST_FILES[@]} -eq 0 ]]; then
  echo "No model manifests found under $MANIFESTS_DIR — nothing to verify." >&2
  if [[ $STRICT -eq 1 ]]; then exit 1; fi
  exit 0
fi

for mf in "${MANIFEST_FILES[@]}"; do
  id="$(field "$mf" id)"
  local_path="$(field "$mf" local_path)"
  sha="$(field "$mf" sha256 | tr '[:upper:]' '[:lower:]')"
  runtime="$(field "$mf" runtime)"
  format="$(field "$mf" format)"
  [[ -z "$local_path" ]] && continue

  # A vision model is TWO files: the language GGUF + the mmproj projector (DIST-2).
  mmproj_block="$(mmproj_block_of "$mf")"
  mmproj_local="$(field_in "$mmproj_block" local_path)"
  mmproj_sha="$(field_in "$mmproj_block" sha256 | tr '[:upper:]' '[:lower:]')"

  if [[ "$format" != "$(supported_format_for "$runtime")" ]]; then
    total_weights=$((total_weights + 1))
    [[ $STRICT -eq 1 ]] && echo "STRICT: $id is UNSUPPORTED (must be VERIFIED)" >&2
    printf '  %-12s %s\n' "UNSUPPORTED" "$id"
    continue
  fi

  verify_file "$id" "" "$TARGET/$local_path" "$sha"
  [[ -n "$mmproj_local" ]] && verify_file "$id" " (mmproj)" "$TARGET/$mmproj_local" "$mmproj_sha"
done

# Emit one checksums.json entry per FILE (the GGUF, and a vision model's mmproj — DIST-2).
# Uses the block-scoped `first` (comma separator) set in the --generate command group below.
emit_entry() {
  local id="$1" lp="$2" weight="$TARGET/$2" sha_json size_json present sha size
  if [[ -f "$weight" ]]; then
    sha="$(sha256_of "$weight")"; size="$(wc -c < "$weight" | tr -d ' ')"
    present=true; sha_json="\"$sha\""; size_json="$size"
  else
    present=false; sha_json='null'; size_json='null'
  fi
  [[ $first -eq 0 ]] && echo '    },'
  first=0
  echo '    {'
  echo "      \"id\": \"$id\","
  echo "      \"local_path\": \"$lp\","
  echo "      \"sha256\": $sha_json,"
  echo "      \"size_bytes\": $size_json,"
  echo "      \"present\": $present"
}

if [[ $GENERATE -eq 1 ]]; then
  mkdir -p "$TARGET/config"
  out="$TARGET/config/checksums.json"
  {
    echo '{'
    echo '  "drive_format_version": 1,'
    echo "  \"generated_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo '  "algorithm": "sha256",'
    echo '  "entries": ['
    first=1
    for mf in "${MANIFEST_FILES[@]}"; do
      id="$(field "$mf" id)"; local_path="$(field "$mf" local_path)"
      [[ -z "$local_path" ]] && continue
      mmproj_local="$(field_in "$(mmproj_block_of "$mf")" local_path)"
      emit_entry "$id" "$local_path"
      [[ -n "$mmproj_local" ]] && emit_entry "$id" "$mmproj_local"
    done
    [[ $first -eq 0 ]] && echo '    }'
    echo '  ]'
    echo '}'
  } > "$out"
  echo "Wrote $out"
fi

if [[ $had_mismatch -eq 1 ]]; then
  echo "One or more weights FAILED checksum verification." >&2
  exit 1
fi

# --strict = the sellable posture (assertCommercialDrive parity): every weight must
# be VERIFIED against a REAL manifest hash, and there must be at least one weight.
if [[ $STRICT -eq 1 ]]; then
  if [[ $total_weights -eq 0 ]]; then
    echo "STRICT: no model manifests with a local_path found — nothing to verify." >&2
    exit 1
  fi
  if [[ $verified_weights -ne $total_weights ]]; then
    echo "STRICT: drive is not sellable — every weight must be VERIFIED against a real manifest sha256." >&2
    exit 1
  fi
  echo "STRICT: all $total_weights weight(s) VERIFIED."
fi
exit 0
