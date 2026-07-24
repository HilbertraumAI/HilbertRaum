#!/usr/bin/env bash
# Download + verify the llama.cpp sidecar binary onto a prepared drive (Phase 12).
#
# Reads model-manifests/runtime-sources.yaml (on the drive, falling back to the repo),
# picks the build matching the host OS/arch (or --os/--arch/--backend overrides), downloads
# the release zip, SHA-256-verifies it, and extracts it into the build's extract_to dir
# (runtime/llama.cpp/<os>/ for the default build; runtime/llama.cpp/<os>/cpu/ for the
# pure-CPU safety net), then chmod +x the binary. After extraction a .hilbertraum-runtime.json
# install marker ({ version, backend, os, arch }) is written next to the binary.
#
# Mirrors apps/desktop/src/main/services/assets.ts (selectRuntimeBuild /
# planRuntimeDownload / runtimeInstallCurrent). Self-contained: needs no Node/npm.
# DEFAULT BACKEND = the FIRST build listed per OS in runtime-sources.yaml — since
# Phase 14 that is the Vulkan full build on win/linux (contains every CPU backend;
# degrades to CPU on GPU-less machines) and Metal on mac. --backend cpu fetches the
# pure-CPU safety net into <os>/cpu/.
#
# Verify-before-trust: a real-hash MISMATCH deletes the zip and exits non-zero. A
# placeholder zip hash extracts but reports UNVERIFIED. Idempotent via the MARKER, not
# mere binary presence: a present llama-server whose .hilbertraum-runtime.json matches the
# selected version + backend is skipped; a missing/stale marker re-fetches (so upgrading
# a CPU-era drive to the Vulkan default actually replaces the build).
#
# --family selects the asset family: llama_cpp (default, llama-server), whisper_cpp
# (the whisper-cli transcriber, runtime/whisper.cpp/<os>/ — same verify + marker
# logic), or ocr (Phase 38: the vendored OCR language files, plain sha256-verified
# downloads into ocr/ — no extraction, no marker; idempotency IS the hash).
#
# Usage:
#   scripts/fetch-runtime.sh --target /Volumes/HILBERTRAUM \
#       [--os linux] [--arch x64] [--backend cpu] [--family whisper_cpp|ocr] [--dry-run]
set -euo pipefail

TARGET=""; OS=""; ARCH=""; BACKEND=""; FAMILY="llama_cpp"; DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --os) OS="${2:-}"; shift 2 ;;
    --os=*) OS="${1#*=}"; shift ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --arch=*) ARCH="${1#*=}"; shift ;;
    --backend) BACKEND="${2:-}"; shift 2 ;;
    --backend=*) BACKEND="${1#*=}"; shift ;;
    --family) FAMILY="${2:-}"; shift 2 ;;
    --family=*) FAMILY="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$TARGET" ]] && { echo "Error: --target <drive-root> is required" >&2; exit 2; }
case "$FAMILY" in
  llama_cpp|whisper_cpp|ocr) ;;
  *) echo "Error: --family must be llama_cpp, whisper_cpp, or ocr" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Resilient curl: a flaky link (beta-tester report — the connection dropped mid-curl) can
# fail repeatedly. curl's own --retry does not cover a mid-transfer DROP (exit 18/56/28) on
# older curl, so an OUTER loop RESUMES the partial file (-C -) on each attempt. $3 = extra
# flags (e.g. schannel's --ssl-revoke-best-effort). Integrity is enforced by the SHA-256 pin
# AFTER download, so resume can never weaken verification.
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

SOURCES_FILE="$TARGET/model-manifests/runtime-sources.yaml"
[[ -f "$SOURCES_FILE" ]] || SOURCES_FILE="$REPO_ROOT/model-manifests/runtime-sources.yaml"
[[ -f "$SOURCES_FILE" ]] || { echo "No runtime-sources.yaml found under '$TARGET' or repo root." >&2; exit 2; }

# Host detection. When --os is explicitly overridden but --arch is not, we are
# cross-provisioning another OS's dir — the host arch is meaningless there, so the
# selection below takes that OS's first build instead.
OS_EXPLICIT=0; [[ -n "$OS" ]] && OS_EXPLICIT=1
ARCH_EXPLICIT=0; [[ -n "$ARCH" ]] && ARCH_EXPLICIT=1
if [[ -z "$OS" ]]; then
  case "$(uname -s)" in
    Darwin) OS="mac" ;;
    Linux) OS="linux" ;;
    MINGW*|MSYS*|CYGWIN*) OS="win" ;;
    *) OS="linux" ;;
  esac
fi
if [[ -z "$ARCH" ]]; then
  case "$(uname -m)" in
    arm64|aarch64) ARCH="arm64" ;;
    *) ARCH="x64" ;;
  esac
fi

is_real_sha() { [[ "$1" =~ ^[a-f0-9]{64}$ ]]; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# --- The ocr family (Phase 38, D32): plain verified FILES, not build archives -------
# Parses `ocr.files` (- lang/url/sha256/dest entries), downloads each into its dest,
# verifies the sha256 of the file AS DOWNLOADED, and skips files already present with
# a matching hash. Mirrors assets.ts planOcrDownloads.
if [[ "$FAMILY" == "ocr" ]]; then
  OCR_VERSION=""
  declare -a F_LANG F_URL F_SHA F_DEST
  fidx=-1
  TOP_KEY=""
  strip_value_ocr() { echo "$1" | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }
  while IFS= read -r raw; do
    line="${raw%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^([A-Za-z0-9_]+)[[:space:]]*:[[:space:]]*$ ]]; then
      TOP_KEY="${BASH_REMATCH[1]}"
      continue
    fi
    [[ "$TOP_KEY" == "ocr" ]] || continue
    if [[ -z "$OCR_VERSION" && "$line" =~ ^[[:space:]]*version[[:space:]]*:[[:space:]]*(.+)$ ]]; then
      OCR_VERSION="$(strip_value_ocr "${BASH_REMATCH[1]}")"; continue
    fi
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*lang[[:space:]]*:[[:space:]]*(.+)$ ]]; then
      fidx=$((fidx + 1))
      F_LANG[$fidx]="$(strip_value_ocr "${BASH_REMATCH[1]}")"
      continue
    fi
    if [[ $fidx -ge 0 && "$line" =~ ^[[:space:]]+([A-Za-z0-9_]+)[[:space:]]*:[[:space:]]*(.+)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="$(strip_value_ocr "${BASH_REMATCH[2]}")"
      case "$key" in
        url) F_URL[$fidx]="$val" ;;
        sha256) F_SHA[$fidx]="$(echo "$val" | tr '[:upper:]' '[:lower:]')" ;;
        dest) F_DEST[$fidx]="$val" ;;
      esac
    fi
  done < "$SOURCES_FILE"
  if [[ -z "$OCR_VERSION" || $fidx -lt 0 ]]; then
    echo "runtime-sources.yaml: no ocr block (version + files) found." >&2; exit 2
  fi
  echo "Fetch OCR language files -> $TARGET (data $OCR_VERSION)"
  FAILED=0
  for i in $(seq 0 $fidx); do
    for required in url sha256 dest; do
      case "$required" in
        url) v="${F_URL[$i]:-}" ;;
        sha256) v="${F_SHA[$i]:-}" ;;
        dest) v="${F_DEST[$i]:-}" ;;
      esac
      [[ -z "$v" ]] && { echo "ocr.files (${F_LANG[$i]}): missing '$required'." >&2; exit 2; }
    done
    case "${F_DEST[$i]}" in
      *..*|/*|[A-Za-z]:*)
        echo "runtime-sources.yaml: ocr dest escapes the drive root: ${F_DEST[$i]}" >&2; exit 2 ;;
    esac
    DEST="$TARGET/${F_DEST[$i]}"
    SHA="${F_SHA[$i]}"
    echo "  ${F_LANG[$i]}: ${F_DEST[$i]}"
    if [[ $DRY_RUN -eq 1 ]]; then echo "    would fetch ${F_URL[$i]}"; continue; fi
    if [[ -f "$DEST" ]] && is_real_sha "$SHA"; then
      if [[ "$(sha256_of "$DEST")" == "$SHA" ]]; then echo "    skip (present + verified)"; continue; fi
      echo "    present but hash differs — re-fetching"
      # DELETE the bad file first (AUD-24). The download below resumes at the end of whatever
      # is already on disk (curl -C -), so re-fetching ONTO a complete-but-wrong file asks the
      # server for a byte range that starts at or past the resource's length — an
      # unsatisfiable range (HTTP 416), which fails every retry instead of replacing the file.
      # Starting from an empty destination makes the repair attempt an actual repair.
      # UNCONDITIONAL here, unlike fetch-models, and deliberately so — do not "harmonize" the
      # two: fetch-models guards the same delete behind a size test because it must preserve
      # cross-run resume of multi-GB weights, and its manifests carry a size_bytes to test
      # against. These OCR language files are a few MB, runtime-sources.yaml records no size
      # for them, and re-fetching one costs nothing — so there is no partial worth saving and
      # no field to distinguish one with.
      rm -f "$DEST"
    fi
    mkdir -p "$(dirname "$DEST")"
    if command -v curl >/dev/null 2>&1; then
      CURL_EXTRA=""
      curl --version 2>/dev/null | head -n1 | grep -qi schannel && CURL_EXTRA="--ssl-revoke-best-effort"
      curl_resilient "${F_URL[$i]}" "$DEST" "$CURL_EXTRA" || { echo "    curl failed after retries" >&2; FAILED=$((FAILED + 1)); continue; }
    elif command -v wget >/dev/null 2>&1; then
      wget -O "$DEST" "${F_URL[$i]}" || { echo "    wget failed" >&2; FAILED=$((FAILED + 1)); continue; }
    else
      echo "No downloader found (need curl or wget)." >&2; exit 3
    fi
    if is_real_sha "$SHA"; then
      ACTUAL="$(sha256_of "$DEST")"
      if [[ "$ACTUAL" != "$SHA" ]]; then
        echo "    FAIL: checksum mismatch (expected $SHA, got $ACTUAL) — deleting" >&2
        rm -f "$DEST"; FAILED=$((FAILED + 1)); continue
      fi
      echo "    VERIFIED"
    else
      echo "    UNVERIFIED (placeholder hash)"
    fi
  done
  [[ $FAILED -gt 0 ]] && exit 1
  exit 0
fi

# --- Parse runtime-sources.yaml (list of build maps under <family>.builds:) ---------
# BLOCK-AWARE since Phase 36: the file holds TWO top-level families (llama_cpp +
# whisper_cpp) with the same shape — only the selected --family's version/builds are
# collected, so the whisper builds can never leak into a llama selection or vice versa.
VERSION=""
declare -a B_OS B_ARCH B_BACKEND B_URL B_SHA B_EXTRACT
idx=-1
TOP_KEY=""
# Strip an inline YAML comment (whitespace + '#' + rest) before unquoting (M17) — the
# committed `version: b9196   # PLACEHOLDER …` used to leak the comment into the value.
strip_value() { echo "$1" | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'' | sed 's/[[:space:]]*$//'; }

while IFS= read -r raw; do
  line="${raw%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  # A non-indented `key:` line starts a new top-level family block.
  if [[ "$line" =~ ^([A-Za-z0-9_]+)[[:space:]]*:[[:space:]]*$ ]]; then
    TOP_KEY="${BASH_REMATCH[1]}"
    continue
  fi
  [[ "$TOP_KEY" == "$FAMILY" ]] || continue
  if [[ -z "$VERSION" && "$line" =~ ^[[:space:]]*version[[:space:]]*:[[:space:]]*(.+)$ ]]; then
    VERSION="$(strip_value "${BASH_REMATCH[1]}")"; continue
  fi
  if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*os[[:space:]]*:[[:space:]]*(.+)$ ]]; then
    idx=$((idx + 1))
    B_OS[$idx]="$(strip_value "${BASH_REMATCH[1]}")"
    continue
  fi
  if [[ $idx -ge 0 && "$line" =~ ^[[:space:]]+([A-Za-z0-9_]+)[[:space:]]*:[[:space:]]*(.+)$ ]]; then
    key="${BASH_REMATCH[1]}"
    val="$(strip_value "${BASH_REMATCH[2]}")"
    case "$key" in
      arch) B_ARCH[$idx]="$val" ;;
      backend) B_BACKEND[$idx]="$val" ;;
      url) B_URL[$idx]="$val" ;;
      sha256) B_SHA[$idx]="$(echo "$val" | tr '[:upper:]' '[:lower:]')" ;;
      extract_to) B_EXTRACT[$idx]="$val" ;;
    esac
  fi
done < "$SOURCES_FILE"

[[ -z "$VERSION" ]] && { echo "runtime-sources.yaml: missing $FAMILY.version (is the $FAMILY block present?)" >&2; exit 2; }

# --- Select the build (os + arch [+ backend]); default = first os/arch match
# (vulkan on win/linux, metal on mac since Phase 14).
# Explicit --os without --arch = cross-provisioning: take that OS's first build (any arch).
SEL=-1
for i in $(seq 0 $idx); do
  [[ "${B_OS[$i]}" == "$OS" ]] || continue
  if [[ $OS_EXPLICIT -eq 0 || $ARCH_EXPLICIT -eq 1 ]]; then
    [[ "${B_ARCH[$i]}" == "$ARCH" ]] || continue
  fi
  [[ -n "$BACKEND" && "${B_BACKEND[$i]}" != "$BACKEND" ]] && continue
  SEL=$i; break
done
if [[ $SEL -lt 0 ]]; then
  echo "No runtime build for os=$OS arch=$ARCH${BACKEND:+ backend=$BACKEND}. Try --os/--arch/--backend overrides." >&2
  exit 2
fi

# A selected build must carry every field the plan needs; a silent miss here would
# disable verification forever (the audited C1 bug), so fail loudly instead.
for required in url sha256 extract_to; do
  case "$required" in
    url) v="${B_URL[$SEL]:-}" ;;
    sha256) v="${B_SHA[$SEL]:-}" ;;
    extract_to) v="${B_EXTRACT[$SEL]:-}" ;;
  esac
  if [[ -z "$v" ]]; then
    echo "runtime-sources.yaml: selected build ($OS/$ARCH) is missing '$required'." >&2
    exit 2
  fi
done

# Escape guard (M18): runtime-sources.yaml on the DRIVE is user-writable; a tampered
# extract_to must not be able to write outside the drive root (mirrors TS planRuntimeDownload).
case "${B_EXTRACT[$SEL]}" in
  *..*|/*|[A-Za-z]:*)
    echo "runtime-sources.yaml: extract_to escapes the drive root: ${B_EXTRACT[$SEL]}" >&2
    exit 2
    ;;
esac

EXTRACT_TO="$TARGET/${B_EXTRACT[$SEL]}"
# Binary name follows the FAMILY + the selected build's OS (mirrors assets.ts
# sidecarBinaryName): llama-server for llama_cpp, whisper-cli for whisper_cpp.
BIN_BASE="llama-server"; [[ "$FAMILY" == "whisper_cpp" ]] && BIN_BASE="whisper-cli"
BIN_NAME="$BIN_BASE"; [[ "${B_OS[$SEL]}" == "win" ]] && BIN_NAME="$BIN_BASE.exe"
BIN_PATH="$EXTRACT_TO/$BIN_NAME"
MARKER_PATH="$EXTRACT_TO/.hilbertraum-runtime.json"
URL="${B_URL[$SEL]}"
SHA="${B_SHA[$SEL]}"

echo "Fetch runtime -> $TARGET"
echo "  build: ${B_OS[$SEL]}/${B_ARCH[$SEL]} ${B_BACKEND[$SEL]} @ $VERSION"
echo "  url:   $URL"
echo "  into:  $EXTRACT_TO"
[[ $DRY_RUN -eq 1 ]] && { echo "(dry run — nothing will be downloaded)"; exit 0; }

# Idempotent skip is MARKER-based (Phase 14, mirrors assets.ts runtimeInstallCurrent):
# "binary exists" alone would silently keep a CPU-era build in place after the default
# became vulkan. Skip only when .hilbertraum-runtime.json matches the selected version+backend.
if [[ -f "$BIN_PATH" ]]; then
  SKIP=0
  if [[ -f "$MARKER_PATH" ]]; then
    # The marker is written by us as flat single-line JSON — parse with sed (no jq dep).
    m_version="$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$MARKER_PATH")"
    m_backend="$(sed -n 's/.*"backend":"\([^"]*\)".*/\1/p' "$MARKER_PATH")"
    [[ "$m_version" == "$VERSION" && "$m_backend" == "${B_BACKEND[$SEL]}" ]] && SKIP=1
  fi
  if [[ $SKIP -eq 1 ]]; then
    echo "  skip ($BIN_NAME already installed: $VERSION/${B_BACKEND[$SEL]} per .hilbertraum-runtime.json)"; exit 0
  fi
  echo "  $BIN_NAME present but install marker is missing or differs — re-fetching $VERSION/${B_BACKEND[$SEL]}"
fi

mkdir -p "$EXTRACT_TO"
# Archive name from the URL basename so a .tar.gz (the macOS/Linux release format) is
# not saved — and mis-extracted — as a .zip. Strip a trailing ?query / #fragment after the
# basename: an HF-style URL (`...file.tar.gz?download=true`, the convention the model manifests
# already use everywhere) would otherwise yield 'file.tar.gz?download=true', which fails the
# `*.tar.gz` extraction glob below and gets fed to unzip. fetch-runtime.ps1 ([uri].AbsolutePath)
# and assets.ts (split('?')[0]) already strip it; the sh variant had drifted (F-19, full audit
# 2026-07-16). All current runtime-sources URLs are query-free, so this is latent-until-edit.
ARCHIVE_NAME="$(basename "$URL")"
ARCHIVE_NAME="${ARCHIVE_NAME%%\?*}"
ARCHIVE_NAME="${ARCHIVE_NAME%%#*}"
[[ -z "$ARCHIVE_NAME" ]] && ARCHIVE_NAME="$BIN_BASE-$VERSION-${B_OS[$SEL]}-${B_ARCH[$SEL]}.zip"
ARCHIVE="$EXTRACT_TO/$ARCHIVE_NAME"

if command -v curl >/dev/null 2>&1; then
  # Schannel curl (Windows/git-bash): corporate proxies often block CRL/OCSP, failing
  # with CRYPT_E_NO_REVOCATION_CHECK. Best-effort revocation only on that backend;
  # artifact integrity is enforced by the SHA-256 pin below. curl_resilient retries +
  # resumes a dropped transfer so a flaky connection doesn't lose the whole archive.
  CURL_EXTRA=""
  curl --version 2>/dev/null | head -n1 | grep -qi schannel && CURL_EXTRA="--ssl-revoke-best-effort"
  curl_resilient "$URL" "$ARCHIVE" "$CURL_EXTRA" || { echo "curl failed after retries" >&2; exit 1; }
elif command -v wget >/dev/null 2>&1; then
  wget -c -O "$ARCHIVE" "$URL"
else
  echo "No downloader found (need curl or wget)." >&2; exit 3
fi

if is_real_sha "$SHA"; then
  ACTUAL="$(sha256_of "$ARCHIVE")"
  if [[ "$ACTUAL" != "$SHA" ]]; then
    echo "  FAIL: archive checksum mismatch (expected $SHA, got $ACTUAL) — deleting" >&2
    rm -f "$ARCHIVE"; exit 1
  fi
  echo "  archive VERIFIED"
else
  echo "  archive UNVERIFIED (placeholder hash) — verify after a real release bump"
fi

# Remove the previous install (if any) BEFORE extracting. Extraction over an existing
# build must never mix files from two builds — and on the nesting mac/linux tarballs a
# stale root llama-server would satisfy the flatten guard below, leaving the OLD binary
# in place while a fresh marker claims the new build (audit fix: the cpu->vulkan upgrade
# path). The cpu/ safety net and the just-downloaded archive survive; the stale marker
# dies with the old build, so a failed extraction cannot leave a lying marker behind.
find "$EXTRACT_TO" -mindepth 1 -maxdepth 1 \
  ! -name "$ARCHIVE_NAME" ! -name cpu -exec rm -rf {} +

# Extract: tar.gz via tar; zip via unzip (linux) / ditto (macOS).
case "$ARCHIVE_NAME" in
  *.tar.gz|*.tgz)
    TAR_EXIT=0
    tar -xzf "$ARCHIVE" -C "$EXTRACT_TO" 2>/dev/null || TAR_EXIT=$?
    # The llama.cpp tarballs contain version SYMLINKS (lib*.so -> lib*.so.X.Y.Z), which
    # an exFAT/FAT32 drive cannot hold. Materialize each missing link as a COPY of its
    # target — the dynamic loader only needs the name to exist. Multi-pass, because
    # links can chain (libllama.so -> libllama.so.0 -> ...0.14.0).
    LINK_PAIRS=()
    while IFS= read -r pair; do
      [[ -n "$pair" ]] && LINK_PAIRS+=("$pair")
    done < <(tar -tvzf "$ARCHIVE" 2>/dev/null | sed -n 's/^l.*[[:space:]]\([^[:space:]]*\)[[:space:]]->[[:space:]]\([^[:space:]]*\)$/\1|\2/p')
    UNRESOLVED=0
    if [[ ${#LINK_PAIRS[@]} -gt 0 ]]; then
      for _pass in 1 2 3 4; do
        UNRESOLVED=0
        for pair in "${LINK_PAIRS[@]}"; do
          lnk="${pair%%|*}"; tgt="${pair#*|}"
          [[ -e "$EXTRACT_TO/$lnk" ]] && continue
          src="$EXTRACT_TO/$(dirname "$lnk")/$tgt"
          if [[ -f "$src" ]]; then cp -f "$src" "$EXTRACT_TO/$lnk"; else UNRESOLVED=$((UNRESOLVED + 1)); fi
        done
        [[ $UNRESOLVED -eq 0 ]] && break
      done
    fi
    if [[ $TAR_EXIT -ne 0 && $UNRESOLVED -gt 0 ]]; then
      echo "tar extraction failed (exit $TAR_EXIT; $UNRESOLVED unresolved entries)" >&2
      exit 1
    fi
    ;;
  *)
    if command -v unzip >/dev/null 2>&1; then
      unzip -o -q "$ARCHIVE" -d "$EXTRACT_TO"
    elif command -v ditto >/dev/null 2>&1; then
      ditto -x -k "$ARCHIVE" "$EXTRACT_TO"
    else
      echo "No unzip tool found (need unzip or ditto)." >&2; exit 3
    fi
    ;;
esac
rm -f "$ARCHIVE"

# Flatten: the macOS/Linux tarballs nest everything under llama-<tag>/ — move the
# binary's directory contents up so llama-server sits at the extract_to root, where
# services/runtime/sidecar.ts resolves it.
if [[ ! -f "$BIN_PATH" ]]; then
  # Exclude the cpu/ safety-net subdir from the search: when the DEFAULT build is being
  # (re)fetched into <os>/ and <os>/cpu/ already holds its own llama-server, the flatten
  # must not mistake the safety net for the freshly extracted nested binary.
  FOUND="$(find "$EXTRACT_TO" -path "$EXTRACT_TO/cpu" -prune -o -type f -name "$BIN_NAME" -print | head -n1)"
  if [[ -n "$FOUND" ]]; then
    SRC_DIR="$(dirname "$FOUND")"
    if [[ "$SRC_DIR" != "$EXTRACT_TO" ]]; then
      find "$SRC_DIR" -mindepth 1 -maxdepth 1 -exec mv -f {} "$EXTRACT_TO"/ \;
      find "$EXTRACT_TO" -mindepth 1 -type d -empty -delete 2>/dev/null || true
    fi
  fi
fi

if [[ -f "$BIN_PATH" ]]; then
  chmod +x "$BIN_PATH" 2>/dev/null || true
  # Record exactly which build is installed (mirrors assets.ts writeRuntimeMarker). The
  # `binaries` map records the extracted binary's own SHA-256 (keyed by its name relative
  # to the extract dir — it sits at the root after the flatten above) so the app can
  # re-hash it immediately before spawn (vuln-scan B / binary-verifier.ts).
  BIN_SHA="$(sha256_of "$BIN_PATH")"
  printf '{"version":"%s","backend":"%s","os":"%s","arch":"%s","binaries":{"%s":"%s"}}' \
    "$VERSION" "${B_BACKEND[$SEL]}" "${B_OS[$SEL]}" "${B_ARCH[$SEL]}" "$BIN_NAME" "$BIN_SHA" > "$MARKER_PATH"
  echo "  extracted + chmod +x $BIN_NAME (+ .hilbertraum-runtime.json install marker)"
  exit 0
fi
echo "  FAIL: $BIN_NAME not found under $EXTRACT_TO after extraction — the release archive layout may have changed." >&2
exit 1
