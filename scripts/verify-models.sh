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

# Flat-YAML line parse for a single key.
field() { sed -n "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//p" "$1" | head -n1 | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

is_real_sha() { [[ "$1" =~ ^[a-f0-9]{64}$ ]]; }

had_mismatch=0
total_weights=0
verified_weights=0
# Collect manifest paths WITHOUT `mapfile` (a Bash 4+ builtin absent from macOS's stock
# Bash 3.2) and WITHOUT `sort -z` (not on BSD/macOS sort). Newline-delimited read is
# portable; manifest filenames are controlled and contain no newlines.
MANIFEST_FILES=()
while IFS= read -r mf; do
  [ -n "$mf" ] && MANIFEST_FILES+=("$mf")
done < <(find "$MANIFESTS_DIR" \( -name '*.yaml' -o -name '*.yml' \) -type f | sort)

for mf in "${MANIFEST_FILES[@]}"; do
  id="$(field "$mf" id)"
  local_path="$(field "$mf" local_path)"
  sha="$(field "$mf" sha256 | tr '[:upper:]' '[:lower:]')"
  runtime="$(field "$mf" runtime)"
  format="$(field "$mf" format)"
  [[ -z "$local_path" ]] && continue
  weight="$TARGET/$local_path"

  if [[ "$runtime" != "llama_cpp" && "$runtime" != "llama.cpp" ]] || [[ "$format" != "gguf" ]]; then
    status="UNSUPPORTED"
  elif [[ ! -f "$weight" ]]; then
    status="MISSING"
  else
    actual="$(sha256_of "$weight")"
    if ! is_real_sha "$sha"; then status="UNVERIFIED"
    elif [[ "$actual" == "$sha" ]]; then status="VERIFIED"
    else status="MISMATCH"; had_mismatch=1; fi
  fi
  total_weights=$((total_weights + 1))
  if [[ "$status" == "VERIFIED" ]]; then verified_weights=$((verified_weights + 1)); fi
  if [[ $STRICT -eq 1 && "$status" != "VERIFIED" ]]; then
    echo "STRICT: $id is $status (must be VERIFIED)" >&2
  fi
  printf '  %-12s %s\n' "$status" "$id"
done

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
      weight="$TARGET/$local_path"
      if [[ -f "$weight" ]]; then
        sha="$(sha256_of "$weight")"; size="$(wc -c < "$weight" | tr -d ' ')"; present=true
        sha_json="\"$sha\""; size_json="$size"
      else
        present=false; sha_json='null'; size_json='null'
      fi
      [[ $first -eq 0 ]] && echo '    },'
      first=0
      echo '    {'
      echo "      \"id\": \"$id\","
      echo "      \"local_path\": \"$local_path\","
      echo "      \"sha256\": $sha_json,"
      echo "      \"size_bytes\": $size_json,"
      echo "      \"present\": $present"
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
