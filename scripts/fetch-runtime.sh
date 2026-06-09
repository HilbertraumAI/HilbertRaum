#!/usr/bin/env bash
# Download + verify the llama.cpp sidecar binary onto a prepared drive (Phase 12).
#
# Reads model-manifests/runtime-sources.yaml (on the drive, falling back to the repo),
# picks the build matching the host OS/arch (or --os/--arch/--backend overrides), downloads
# the release zip, SHA-256-verifies it, and extracts it into runtime/llama.cpp/<os>/
# (the dirs services/runtime/sidecar.ts resolves: win/mac/linux), then chmod +x the binary.
#
# Mirrors apps/desktop/src/main/services/assets.ts (selectRuntimeBuild / planRuntimeDownload).
# Self-contained: needs no Node/npm. Default backend = CPU (broadest-compatible build).
#
# Verify-before-trust: a real-hash MISMATCH deletes the zip and exits non-zero. A
# placeholder zip hash extracts but reports UNVERIFIED. Idempotent: an already-extracted
# llama-server is skipped.
#
# Usage:
#   scripts/fetch-runtime.sh --target /Volumes/PRIVATE_AI_DRIVE \
#       [--os linux] [--arch x64] [--backend cpu] [--dry-run]
set -euo pipefail

TARGET=""; OS=""; ARCH=""; BACKEND=""; DRY_RUN=0
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
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$TARGET" ]] && { echo "Error: --target <drive-root> is required" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

# --- Parse runtime-sources.yaml (list of build maps under builds:) ------------------
VERSION=""
declare -a B_OS B_ARCH B_BACKEND B_URL B_SHA B_EXTRACT
idx=-1
while IFS= read -r raw; do
  line="${raw%$'\r'}"
  case "$line" in \#*|*' #'*) ;; esac
  if [[ -z "$VERSION" && "$line" =~ ^[[:space:]]*version[[:space:]]*:[[:space:]]*(.+)$ ]]; then
    VERSION="$(echo "${BASH_REMATCH[1]}" | tr -d '"'"'"'' | sed 's/[[:space:]]*$//')"; continue
  fi
  if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*os[[:space:]]*:[[:space:]]*(.+)$ ]]; then
    idx=$((idx + 1))
    B_OS[$idx]="$(echo "${BASH_REMATCH[1]}" | tr -d '"'"'"'' | sed 's/[[:space:]]*$//')"
    continue
  fi
  if [[ $idx -ge 0 && "$line" =~ ^[[:space:]]+([A-Za-z0-9_]+)[[:space:]]*:[[:space:]]*(.+)$ ]]; then
    key="${BASH_REMATCH[1]}"
    val="$(echo "${BASH_REMATCH[2]}" | tr -d '"'"'"'' | sed 's/[[:space:]]*$//')"
    case "$key" in
      arch) B_ARCH[$idx]="$val" ;;
      backend) B_BACKEND[$idx]="$val" ;;
      url) B_URL[$idx]="$val" ;;
      sha256) B_SHA[$idx]="$(echo "$val" | tr '[:upper:]' '[:lower:]')" ;;
      extract_to) B_EXTRACT[$idx]="$val" ;;
    esac
  fi
done < "$SOURCES_FILE"

[[ -z "$VERSION" ]] && { echo "runtime-sources.yaml: missing llama_cpp.version" >&2; exit 2; }

# --- Select the build (os + arch [+ backend]); default = first os/arch match (CPU).
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

EXTRACT_TO="$TARGET/${B_EXTRACT[$SEL]}"
BIN_NAME="llama-server"; [[ "${B_OS[$SEL]}" == "win" ]] && BIN_NAME="llama-server.exe"
BIN_PATH="$EXTRACT_TO/$BIN_NAME"
URL="${B_URL[$SEL]}"
SHA="${B_SHA[$SEL]}"

echo "Fetch runtime -> $TARGET"
echo "  build: ${B_OS[$SEL]}/${B_ARCH[$SEL]} ${B_BACKEND[$SEL]} @ $VERSION"
echo "  url:   $URL"
echo "  into:  $EXTRACT_TO"
[[ $DRY_RUN -eq 1 ]] && { echo "(dry run — nothing will be downloaded)"; exit 0; }

# Idempotent skip: the binary name is derived from the selected build's OS, so
# presence is a valid skip signal even when cross-provisioning another OS's dir.
if [[ -f "$BIN_PATH" ]]; then
  echo "  skip ($BIN_NAME already extracted)"; exit 0
fi

mkdir -p "$EXTRACT_TO"
ZIP="$EXTRACT_TO/llama-$VERSION-${B_OS[$SEL]}-${B_ARCH[$SEL]}.zip"

if command -v curl >/dev/null 2>&1; then
  curl -L --fail --retry 3 -C - -o "$ZIP" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -c -O "$ZIP" "$URL"
else
  echo "No downloader found (need curl or wget)." >&2; exit 3
fi

if is_real_sha "$SHA"; then
  ACTUAL="$(sha256_of "$ZIP")"
  if [[ "$ACTUAL" != "$SHA" ]]; then
    echo "  FAIL: zip checksum mismatch (expected $SHA, got $ACTUAL) — deleting" >&2
    rm -f "$ZIP"; exit 1
  fi
  echo "  zip VERIFIED"
else
  echo "  zip UNVERIFIED (placeholder hash) — verify after a real release bump"
fi

# Extract (unzip on linux; ditto/unzip on macOS).
if command -v unzip >/dev/null 2>&1; then
  unzip -o -q "$ZIP" -d "$EXTRACT_TO"
elif command -v ditto >/dev/null 2>&1; then
  ditto -x -k "$ZIP" "$EXTRACT_TO"
else
  echo "No unzip tool found (need unzip or ditto)." >&2; exit 3
fi
rm -f "$ZIP"

if [[ -f "$BIN_PATH" ]]; then
  chmod +x "$BIN_PATH" 2>/dev/null || true
  echo "  extracted + chmod +x $BIN_NAME"
else
  echo "  NOTE: $BIN_NAME not at $EXTRACT_TO root — the release zip may nest binaries in a subfolder; flatten them into $EXTRACT_TO (and chmod +x)."
fi
exit 0
