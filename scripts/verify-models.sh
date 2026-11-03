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
#            exists).
# --kit      the Kit ship gate, --strict over what a preconfigured Kit ships (#766): every
#            bundled model (bundled_on_preconfigured_drive: true, >= 1 of them) and every
#            model with any file on the drive. A model with no file on the drive is the in-app
#            download catalog, listed as CATALOG and not verified. Mirrors commercial-drive.ts
#            assertCommercialDrive.
#
# Usage:
#   scripts/verify-models.sh --target /Volumes/HILBERTRAUM [--generate] [--strict | --kit]
set -euo pipefail

TARGET=""
GENERATE=0
STRICT=0
KIT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --generate) GENERATE=1; shift ;;
    --strict) STRICT=1; shift ;;
    --kit) KIT=1; STRICT=1; shift ;;
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
  # Hash from STDIN, never by filename: when the path contains a backslash (git-bash on
  # Windows, e.g. "$RUNNER_TEMP/…" = "D:\a\_temp/…"), GNU coreutils escapes the name and
  # prefixes the whole output line with "\\" — the extracted hash then never string-equals
  # the manifest value (v0.1.56 release run 31341651519, build-win: "expected ed6156…, got
  # \ed6156…"). Stdin has no filename, so nothing is ever escaped.
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | awk '{print $1}'
  else shasum -a 256 < "$1" | awk '{print $1}'; fi
}

# Flat-YAML line parse for a single key. Inline YAML comments (whitespace + '#' + rest)
# are stripped before unquoting (M17).
field() { sed -n "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//p" "$1" | head -n1 | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

# Same flat parse over a string (a YAML sub-block) — reads the mmproj projector's local_path/sha256
# (the SECOND file of a vision model, DIST-2: verify BOTH files, mirroring services/models.ts).
field_in() { printf '%s\n' "$1" | sed -n "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//p" | head -n1 | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

# Extract the indented body of a top-level `<key>:` mapping (lines until the next column-0 key);
# field_in then reads it. Two blocks are read this way: `mmproj:` (the SECOND file of a vision
# model, DIST-2) and `files:` (the ADDITIONAL required files of a multi-file weight, #310, e.g. a
# GGUF shard set's shards 2..N). `files:` is emitted AFTER local_path/sha256/download/mmproj in
# every manifest (model-policy.md key-order rule), so it never poisons the flat top-level reads.
block_of() { awk -v key="$2" '$0 ~ ("^" key ":[[:space:]]*$") {f=1;next} /^[^[:space:]]/{f=0} f' "$1"; }

# The field separator of the `files:` member records: the ASCII unit separator, not a tab. A tab
# is IFS whitespace, so `read` collapsed an empty field and shifted the rest left (#767).
SEP=$'\037'

# Split a `files:` block (as text, from block_of) into one SEP-separated record per list member:
# local_path, sha256, download.url, download.size_bytes (raw — comments/quotes are stripped by
# the caller via clean_value). A member starts at its own `- local_path:` line and runs to the
# next one (or the end of the block).
files_member_records() {
  printf '%s\n' "$1" | awk '
    function emit() { if (started) printf "%s\037%s\037%s\037%s\n", lp, sha, durl, dsize }
    /^[[:space:]]*-[[:space:]]*local_path:/ {
      emit()
      started = 1; indl = 0
      lp = $0; sub(/^[[:space:]]*-[[:space:]]*local_path:[[:space:]]*/, "", lp)
      sha = ""; durl = ""; dsize = ""
      next
    }
    started && /^[[:space:]]*download:[[:space:]]*$/ { indl = 1; next }
    started && !indl && /^[[:space:]]*sha256:/ {
      sha = $0; sub(/^[[:space:]]*sha256:[[:space:]]*/, "", sha); next
    }
    started && indl && /^[[:space:]]*url:/ {
      durl = $0; sub(/^[[:space:]]*url:[[:space:]]*/, "", durl); next
    }
    started && indl && /^[[:space:]]*size_bytes:/ {
      dsize = $0; sub(/^[[:space:]]*size_bytes:[[:space:]]*/, "", dsize); next
    }
    END { emit() }
  '
}

# Same cleanup field()/field_in() apply after extracting a raw value: strip an inline YAML
# comment, then quotes, then trailing whitespace.
clean_value() { printf '%s\n' "$1" | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

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

# Whether a manifest is in the Kit's bundled set (#766). One grep, not `field`'s five processes:
# under Git Bash every fork counts, and --kit asks this of every manifest.
is_bundled() { grep -Eiq '^[[:space:]]*bundled_on_preconfigured_drive[[:space:]]*:[[:space:]]*true[[:space:]]*(#.*)?$' "$1"; }

# Whether ANY file of a model is on the drive: its weight, its projector, or an extra file of a
# multi-file weight (#766). Args: local_path mmproj_local files_block.
any_file_present() {
  local f_local
  [[ -f "$TARGET/$1" ]] && return 0
  [[ -n "$2" && -f "$TARGET/$2" ]] && return 0
  [[ -z "$3" ]] && return 1
  while IFS="$SEP" read -r f_local _ _ _; do
    [[ -n "$f_local" && -f "$TARGET/$(clean_value "$f_local")" ]] && return 0
  done < <(files_member_records "$3")
  return 1
}

had_mismatch=0
total_weights=0
verified_weights=0
bundled_models=0

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

# No manifests is not an early exit: --generate still writes `entries: []` (as the .ps1 and the
# app's buildChecksumsJson do), and --strict / --kit still fail below (#767).
[[ ${#MANIFEST_FILES[@]} -eq 0 ]] && echo "No model manifests found under '$MANIFESTS_DIR' — nothing to verify." >&2

# Bash 3.2 + `set -u`: expanding an EMPTY array aborts with "unbound variable" (M23).
for mf in ${MANIFEST_FILES[@]+"${MANIFEST_FILES[@]}"}; do
  id="$(field "$mf" id)"
  local_path="$(field "$mf" local_path)"
  sha="$(field "$mf" sha256 | tr '[:upper:]' '[:lower:]')"
  runtime="$(field "$mf" runtime)"
  format="$(field "$mf" format)"
  [[ -z "$local_path" ]] && continue

  # A vision model is TWO files: the language GGUF + the mmproj projector (DIST-2).
  mmproj_block="$(block_of "$mf" mmproj)"
  mmproj_local="$(field_in "$mmproj_block" local_path)"
  mmproj_sha="$(field_in "$mmproj_block" sha256 | tr '[:upper:]' '[:lower:]')"

  # #310: the ADDITIONAL required files of a multi-file weight (a GGUF shard set's shards
  # 2..N), each verified with an " (file N/M)" label — M is the primary plus every declared
  # file (mmproj is reported separately and does not count towards M).
  files_block="$(block_of "$mf" files)"
  total_files=1
  if [[ -n "$files_block" ]]; then
    file_count="$(files_member_records "$files_block" | grep -c '^' || true)"
    total_files=$((1 + file_count))
  fi

  # --kit (#766): a model ships when it is bundled or has any file on the drive. Every other
  # manifest is the in-app download catalog, where the app's own download gates apply.
  if [[ $KIT -eq 1 ]]; then
    if is_bundled "$mf"; then
      bundled_models=$((bundled_models + 1))
    elif ! any_file_present "$local_path" "$mmproj_local" "$files_block"; then
      printf '  %-12s %s\n' "CATALOG" "$id"
      continue
    fi
  fi

  # A runtime the table does not name, or none at all, is UNSUPPORTED (the app's
  # isSupportedRuntimeFormat): compared with an empty answer, a manifest with neither runtime nor
  # format passed as supported (#767).
  supported_format="$(supported_format_for "$runtime")"
  if [[ -z "$supported_format" || "$format" != "$supported_format" ]]; then
    total_weights=$((total_weights + 1))
    [[ $STRICT -eq 1 ]] && echo "STRICT: $id is UNSUPPORTED (must be VERIFIED)" >&2
    printf '  %-12s %s\n' "UNSUPPORTED" "$id"
    continue
  fi

  verify_file "$id" "" "$TARGET/$local_path" "$sha"
  [[ -n "$mmproj_local" ]] && verify_file "$id" " (mmproj)" "$TARGET/$mmproj_local" "$mmproj_sha"
  if [[ -n "$files_block" ]]; then
    file_n=2
    while IFS="$SEP" read -r f_local f_sha _ _; do
      [[ -z "$f_local" ]] && continue
      f_local="$(clean_value "$f_local")"
      f_sha="$(clean_value "$f_sha" | tr '[:upper:]' '[:lower:]')"
      verify_file "$id" " (file $file_n/$total_files)" "$TARGET/$f_local" "$f_sha"
      file_n=$((file_n + 1))
    done < <(files_member_records "$files_block")
  fi
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
    for mf in ${MANIFEST_FILES[@]+"${MANIFEST_FILES[@]}"}; do
      id="$(field "$mf" id)"; local_path="$(field "$mf" local_path)"
      [[ -z "$local_path" ]] && continue
      mmproj_local="$(field_in "$(block_of "$mf" mmproj)" local_path)"
      emit_entry "$id" "$local_path"
      [[ -n "$mmproj_local" ]] && emit_entry "$id" "$mmproj_local"
      # #310: one entry per ADDITIONAL declared file, same order as manifestFiles().
      files_block="$(block_of "$mf" files)"
      if [[ -n "$files_block" ]]; then
        while IFS="$SEP" read -r f_local _ _ _; do
          [[ -z "$f_local" ]] && continue
          emit_entry "$id" "$(clean_value "$f_local")"
        done < <(files_member_records "$files_block")
      fi
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
  if [[ $KIT -eq 1 && $bundled_models -eq 0 ]]; then
    echo "KIT: no bundled model (bundled_on_preconfigured_drive: true) — a Kit ships its bundled set preloaded." >&2
    exit 1
  fi
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
