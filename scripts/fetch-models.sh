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
# --bundled fetches only the models a preconfigured Kit ships preloaded
# (bundled_on_preconfigured_drive: true, #766); build-commercial-drive passes it.
#
# --only <id> fetches one model. An id no manifest carries, or one whose manifest declares no
# download block, exits 2: an explicit request that names nothing fetchable.
#
# Half a download pair (#767): a model whose top-level download has no partner on its mmproj
# projector or on a files: member (or the other way round) is refused with the validator's
# message (BLOCK, exit 1), whatever is on disk and whatever --accept-license says: the app
# refuses such a manifest, so any file of it fetched would never start.
#
# Usage:
#   scripts/fetch-models.sh --target /Volumes/HILBERTRAUM [--only <id>] [--bundled] \
#       [--accept-license] [--dry-run]
set -euo pipefail

TARGET=""
ONLY=""
BUNDLED=0
ACCEPT_LICENSE=0
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --only=*) ONLY="${1#*=}"; shift ;;
    --bundled) BUNDLED=1; shift ;;
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
  # Hash from STDIN, never by filename: when the path contains a backslash (git-bash on
  # Windows, e.g. "$RUNNER_TEMP/…" = "D:\a\_temp/…"), GNU coreutils escapes the name and
  # prefixes the whole output line with "\\" — the extracted hash then never string-equals
  # the manifest value (v0.1.56 release run 31341651519, build-win: "expected ed6156…, got
  # \ed6156…"). Stdin has no filename, so nothing is ever escaped.
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | awk '{print $1}'
  else shasum -a 256 < "$1" | awk '{print $1}'; fi
}

# Flat-YAML line parse — first match wins (top-level sha256 over the nested download one).
# Inline YAML comments (whitespace + '#' + rest) are stripped before unquoting (M17).
field() { sed -n "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//p" "$1" | head -n1 | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

# Same flat parse, but over a string (a YAML sub-block from block_of) instead of a file.
field_in() { printf '%s\n' "$1" | sed -n "s/^[[:space:]]*$2[[:space:]]*:[[:space:]]*//p" | head -n1 | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

# Extract the indented body of a top-level `<key>:` mapping (lines until the next column-0 key);
# field_in then parses it. Three blocks are read this way: the top-level `download:` (the primary
# file's source), `mmproj:` (the SECOND file of a vision model, DIST-1) and `files:` (the
# ADDITIONAL required files of a multi-file weight, #310, e.g. a GGUF shard set's shards 2..N). A
# key nested in one block never answers for another: read flat, a projector's size_bytes reached
# the primary file when the top-level download carried none, and handle_file's size guard then
# deleted a resumable partial (#767).
block_of() { awk -v key="$2" '$0 ~ ("^" key ":[[:space:]]*$") {f=1;next} /^[^[:space:]]/{f=0} f' "$1"; }

# The field separator of the `files:` member records: the ASCII unit separator, not a tab. A tab
# is IFS whitespace, so `read` collapsed an empty field and shifted the rest left: a verified
# member with no size_bytes read its state as its size and was planned as a fetch (#767).
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
# Args: id label dest sha url relpath state expected_size. Updates the global
# fetched/skipped/had_failure.
handle_file() {
  local id="$1" label="$2" dest="$3" sha="$4" url="$5" rel="$6" state="$7" expected_size="${8:-}"
  case "$state" in
    verified)    printf '  skip   %s%s (present + verified)\n' "$id" "$label"; skipped=$((skipped + 1)); return 0 ;;
    placeholder) printf '  skip   %s%s (present; placeholder hash — cannot verify)\n' "$id" "$label"; skipped=$((skipped + 1)); return 0 ;;
    mismatch)    printf '  redo   %s%s (present but checksum mismatch — re-downloading)\n' "$id" "$label" ;;
  esac
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  fetch  %s%s\n           %s\n           -> %s\n' "$id" "$label" "$url" "$rel"; return 0
  fi
  # A "redo" writes onto the file that is already there, and every downloader below resumes:
  # curl (-C -) and wget (-c) resume AT THE FILE'S END; aria2c (--continue) resumes from its
  # own `.aria2` CONTROL FILE, never from the file length. That is deliberate: resuming a
  # part-downloaded weight across runs is a documented feature of this script, and a multi-GB
  # weight on a flaky link must not restart from zero. But the SAME state also covers a file
  # that is complete and WRONG, and an at-EOF resume of that one asks the server for a byte
  # range starting at or past the resource's length — an unsatisfiable range (HTTP 416), so
  # the repair transfers nothing and the run is wasted (AUD-24).
  # Rule: delete first ONLY when resume provably cannot help, i.e. when the bytes on disk
  # already reach the manifest's expected size AND the file is not an aria2 partial the next
  # run will resume. A SHORTER file is a resumable partial and is left alone, exactly as
  # before. A full-length file WITH an `.aria2` control file beside it is aria2's
  # PREALLOCATION (aria2's default file-allocation sizes the destination at download start),
  # i.e. a resumable partial too: aria2 removes the control file itself on completion, so its
  # presence proves the transfer never finished, and aria2's control-file resume cannot hit
  # the 416 trap. Keep it ONLY while aria2c is the downloader that will actually run — to
  # curl/wget the control file is useless and the preallocated file is the 416 case again
  # (full-audit 2026-07-23 review fix F1). When the manifest carries no size_bytes we cannot
  # tell the two apart, so we do NOT delete and keep the previous behaviour (resume; a wrong
  # file is still deleted by the post-download verification below, which self-heals on the
  # next run).
  # NOTE the value comes from this file's own download block (block_of), never from another
  # file's: a projector's size once deleted the primary file's resumable partial (#767).
  if [[ "$state" == mismatch && "$expected_size" =~ ^[0-9]+$ ]]; then
    local on_disk
    on_disk="$(wc -c < "$dest" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "$on_disk" ]] && (( on_disk >= expected_size )); then
      if [[ -f "$dest.aria2" ]] && command -v aria2c >/dev/null 2>&1; then
        printf '         %s bytes on disk >= the manifest'"'"'s %s — .aria2 control file present, keeping the resumable aria2 partial\n' "$on_disk" "$expected_size"
      else
        printf '         %s bytes on disk >= the manifest'"'"'s %s — deleting before re-download (resume cannot repair it)\n' "$on_disk" "$expected_size"
        rm -f "$dest" "$dest.aria2"
      fi
    fi
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
# --only names one model: an id no manifest carries, or one with nothing to fetch, exits 2 below.
only_seen=0; only_fetchable=0

echo "Fetch models -> $TARGET"
[[ $DRY_RUN -eq 1 ]] && echo "(dry run — nothing will be downloaded)"
echo
[[ ${#MANIFEST_FILES[@]} -eq 0 ]] && echo "No model manifests found under '$MANIFESTS_DIR' — nothing to fetch."

# Bash 3.2 + `set -u`: expanding an EMPTY array aborts with "unbound variable" (M23).
for mf in ${MANIFEST_FILES[@]+"${MANIFEST_FILES[@]}"}; do
  id="$(field "$mf" id)"
  # Under --only the rest of a manifest is read only for the one it names: under Git Bash every
  # fork counts.
  if [[ -n "$ONLY" ]]; then
    [[ "$id" != "$ONLY" ]] && continue
    only_seen=1
  fi
  # One grep, and only under --bundled: under Git Bash every fork counts.
  if [[ $BUNDLED -eq 1 ]] && ! grep -Eiq '^[[:space:]]*bundled_on_preconfigured_drive[[:space:]]*:[[:space:]]*true[[:space:]]*(#.*)?$' "$mf"; then
    continue
  fi
  local_path="$(field "$mf" local_path)"
  sha="$(field "$mf" sha256 | tr '[:upper:]' '[:lower:]')"
  # The primary file's source: the top-level `download:` block only, never another file's (#767).
  dl_block="$(block_of "$mf" download)"
  url="$(field_in "$dl_block" url)"
  # Optional (30 of the committed manifests carry it) — used only to tell a complete-but-wrong
  # file apart from a resumable partial in handle_file.
  size_bytes="$(field_in "$dl_block" size_bytes)"
  license_url="$(field_in "$dl_block" license_url)"
  license="$(field "$mf" license)"
  review_status="$(field "$mf" status)"
  # Optional `download.withdrawn` (issue 196): the publisher deleted the exact file this
  # manifest pins, so the URL above is known-dead. Mirrors planModelDownloads' 'source-
  # withdrawn' task status (assets.ts is the source of truth; script-execution.test.ts runs both
  # twins). Note values must not contain " #" — `field` strips inline YAML comments.
  # Read FLAT on purpose, unlike url/size_bytes: a note in ANY file's download block skips the
  # whole model when something needs fetching. The app plans each file on its own, but a model
  # with one file gone can never be completed, so fetching its other files would only spend GBs
  # on a model that stays missing.
  withdrawn="$(field "$mf" withdrawn)"

  # A vision model is TWO files: the language GGUF (above) + the mmproj projector (DIST-1). Parse
  # the projector's own block (its local_path/sha256/download.url) — absent for non-vision models.
  mmproj_block="$(block_of "$mf" mmproj)"
  mmproj_local="$(field_in "$mmproj_block" local_path)"
  mmproj_sha="$(field_in "$mmproj_block" sha256 | tr '[:upper:]' '[:lower:]')"
  mmproj_url="$(field_in "$mmproj_block" url)"
  mmproj_size="$(field_in "$mmproj_block" size_bytes)"

  # Half a download pair (#767): the validator's all-or-nothing rule (shared/manifest.ts, #752),
  # with its messages, collected one per line into `half`.
  half=""
  if [[ -n "$mmproj_local" ]]; then
    if [[ -n "$url" && -z "$mmproj_url" ]]; then
      half="${half}\"mmproj.download\" is required when the model declares a top-level \"download\" (a partial download plan would install a model that cannot start)"$'\n'
    fi
    if [[ -n "$mmproj_url" && -z "$url" ]]; then
      half="${half}\"download\" is required when \"mmproj\" declares one (a partial download plan would install a model that cannot start)"$'\n'
    fi
  fi

  # #310: the ADDITIONAL required files of a multi-file weight (a GGUF shard set's shards 2..N),
  # read here into files_spec (local, sha, url, size per line, SEP-separated) and hashed only once
  # the model passes the checks below.
  files_block="$(block_of "$mf" files)"
  files_spec=""; any_file_url=0; member_idx=0
  if [[ -n "$files_block" ]]; then
    while IFS="$SEP" read -r f_local f_sha f_dlurl f_dlsize; do
      f_local="$(clean_value "$f_local")"
      f_sha="$(clean_value "$f_sha" | tr '[:upper:]' '[:lower:]')"
      f_dlurl="$(clean_value "$f_dlurl")"
      f_dlsize="$(clean_value "$f_dlsize")"
      if [[ -n "$f_dlurl" ]]; then
        any_file_url=1
        if [[ -z "$url" ]]; then
          half="${half}\"download\" is required when \"files[$member_idx]\" declares one (a partial download plan would install a model that cannot start)"$'\n'
        fi
      elif [[ -n "$url" ]]; then
        half="${half}\"files[$member_idx].download\" is required when the model declares a top-level \"download\" (a partial download plan would install a model that cannot start)"$'\n'
      fi
      member_idx=$((member_idx + 1))
      # A command substitution strips its trailing newline, so the separator is appended
      # explicitly — otherwise two concatenated records would run together on one line.
      files_spec="${files_spec}$(printf '%s%s%s%s%s%s%s' "$f_local" "$SEP" "$f_sha" "$SEP" "$f_dlurl" "$SEP" "$f_dlsize")"$'\n'
    done < <(files_member_records "$files_block")
  fi

  # A url stands for its download block: the validator requires one in every block.
  [[ -z "$url" && -z "$mmproj_url" && $any_file_url -eq 0 ]] && continue   # no download block → skip
  [[ -z "$local_path" ]] && continue
  [[ -n "$ONLY" ]] && only_fetchable=1
  planned=$((planned + 1))

  # The app refuses half a pair, so any file of it fetched would belong to a model that never
  # starts; without a top-level download the primary file has no source at all. Checked before
  # any file is hashed, whatever is on disk and whatever --accept-license says.
  if [[ -n "$half" ]]; then
    while IFS= read -r message; do
      [[ -n "$message" ]] && printf '  BLOCK  %s: %s\n' "$id" "$message" >&2
    done <<< "$half"
    echo '         Nothing fetched: the app refuses this manifest, so the model could never start.' >&2
    had_failure=1; continue
  fi

  dest="$TARGET/$local_path"
  has_mmproj=0
  [[ -n "$mmproj_url" && -n "$mmproj_local" ]] && has_mmproj=1
  mmproj_dest="$TARGET/$mmproj_local"

  # Classify each file ONCE (a present multi-GB weight is hashed at most once).
  gguf_state="$(file_state "$dest" "$sha")"
  mmproj_state=""
  [[ $has_mmproj -eq 1 ]] && mmproj_state="$(file_state "$mmproj_dest" "$mmproj_sha")"

  # The files: members, classified once into files_plan (files_spec plus a state per line) so the
  # later fetch pass never re-hashes.
  total_files=1
  files_plan=""
  if [[ -n "$files_spec" ]]; then
    file_count=0
    while IFS="$SEP" read -r f_local f_sha f_dlurl f_dlsize; do
      [[ -z "$f_local" ]] && continue
      f_state="$(file_state "$TARGET/$f_local" "$f_sha")"
      file_count=$((file_count + 1))
      files_plan="${files_plan}$(printf '%s%s%s%s%s%s%s%s%s' "$f_local" "$SEP" "$f_sha" "$SEP" "$f_dlurl" "$SEP" "$f_dlsize" "$SEP" "$f_state")"$'\n'
    done <<< "$files_spec"
    total_files=$((1 + file_count))
  fi

  # Does anything need the network? (absent / checksum-mismatch). A model already fully present
  # is skipped WITHOUT a license prompt (the license is only relevant to an actual download).
  needs_fetch=0
  [[ "$gguf_state" == absent || "$gguf_state" == mismatch ]] && needs_fetch=1
  [[ $has_mmproj -eq 1 && ( "$mmproj_state" == absent || "$mmproj_state" == mismatch ) ]] && needs_fetch=1
  if [[ -n "$files_plan" ]]; then
    while IFS="$SEP" read -r _ _ _ _ f_state; do
      [[ "$f_state" == absent || "$f_state" == mismatch ]] && needs_fetch=1
    done <<< "$files_plan"
  fi

  # Withdrawn upstream source (issue 196) — only relevant when something WOULD be fetched: a
  # drive that already carries the weight is unaffected and verifies as usual. Skipped, not
  # failed: one publisher retiring a file must not break a whole drive build.
  if [[ $needs_fetch -eq 1 && -n "$withdrawn" ]]; then
    printf '  SKIP   %s: upstream source withdrawn — %s\n' "$id" "$withdrawn"
    printf '         Nothing to fetch; copies already on a drive keep verifying.\n'
    skipped=$((skipped + 1)); continue
  fi

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
  handle_file "$id" "" "$dest" "$sha" "$url" "$local_path" "$gguf_state" "$size_bytes" || true
  [[ $has_mmproj -eq 1 ]] && { handle_file "$id" " (mmproj)" "$mmproj_dest" "$mmproj_sha" "$mmproj_url" "$mmproj_local" "$mmproj_state" "$mmproj_size" || true; }
  if [[ -n "$files_plan" ]]; then
    file_n=2
    while IFS="$SEP" read -r f_local f_sha f_dlurl f_dlsize f_state; do
      [[ -z "$f_local" ]] && continue
      handle_file "$id" " (file $file_n/$total_files)" "$TARGET/$f_local" "$f_sha" "$f_dlurl" "$f_local" "$f_state" "$f_dlsize" || true
      file_n=$((file_n + 1))
    done <<< "$files_plan"
  fi
done

# An explicit --only that names nothing fetchable is a usage error, not an empty success: a stale
# default id in prepare-drive --with-assets would otherwise pass silently (#767).
if [[ -n "$ONLY" && $only_seen -eq 0 ]]; then
  echo "No model manifest with id '$ONLY' under '$MANIFESTS_DIR'." >&2
  exit 2
fi
if [[ -n "$ONLY" && $only_fetchable -eq 0 ]]; then
  echo "Model '$ONLY' declares no download block: nothing to fetch." >&2
  exit 2
fi

echo
printf 'Planned %d | fetched %d | skipped %d\n' "$planned" "$fetched" "$skipped"
# A Kit with nothing to preload fails at step 2, not after the builder's runtime downloads (#766).
if [[ $BUNDLED -eq 1 && $planned -eq 0 ]]; then
  echo "No bundled model (bundled_on_preconfigured_drive: true) with a download block: a Kit has nothing to preload." >&2
  exit 1
fi
if [[ $had_failure -eq 1 ]]; then
  echo "One or more models failed to download/verify (or were blocked)." >&2
  exit 1
fi
exit 0
