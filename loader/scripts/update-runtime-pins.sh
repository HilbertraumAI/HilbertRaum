#!/usr/bin/env bash
# Refresh nix/runtime-pins.json — the pinned upstream prebuilt llama.cpp / whisper.cpp
# release archives that the `llamacpp` / `whispercli` loader components pack.
#
# Picks the asset matching each build target from a GitHub release (default: each repo's
# latest), reads its sha256 from the GitHub asset `digest`, and writes the JSON the nix
# build reads (nix/builds.nix `runtimePins`). A version bump is then one command:
#
#   ./scripts/update-runtime-pins.sh                 # latest of both repos
#   ./scripts/update-runtime-pins.sh b9712 v1.9.1    # explicit llama / whisper tags
#
# Requires: gh (authenticated), jq. Network only (no build). Review the diff before commit.
set -euo pipefail

LLAMA_REPO="ggml-org/llama.cpp"
WHISPER_REPO="ggml-org/whisper.cpp"
LLAMA_TAG="${1:-}"
WHISPER_TAG="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/../nix/runtime-pins.json"

command -v gh >/dev/null || { echo "need gh (GitHub CLI)"; exit 1; }
command -v jq >/dev/null || { echo "need jq"; exit 1; }

# Resolve "" → the repo's latest tag.
resolve_tag() { local repo="$1" tag="$2"; [ -n "$tag" ] && { echo "$tag"; return; }
  gh release view --repo "$repo" --json tagName -q .tagName; }

# Emit "url\tsha256hex" for the asset whose name == $3 in $1's release $2, or fail loudly.
asset() {
  local repo="$1" tag="$2" name="$3" row
  row=$(gh release view "$tag" --repo "$repo" --json assets \
    -q ".assets[] | select(.name==\"$name\") | \"\(.url)\t\(.digest)\"") || true
  [ -n "$row" ] || { echo "  !! $repo $tag: asset '$name' not found" >&2; return 1; }
  # digest is "sha256:<hex>"; nix fetchurl wants the bare hex.
  printf '%s\t%s\n' "$(cut -f1 <<<"$row")" "$(cut -f2 <<<"$row" | sed 's/^sha256://')"
}

# pin <repo> <tag> <asset-name> → a {url,sha256} JSON object (or empty on miss).
pin() {
  local row; row=$(asset "$1" "$2" "$3") || return 1
  jq -n --arg url "$(cut -f1 <<<"$row")" --arg sha "$(cut -f2 <<<"$row")" \
    '{url:$url, sha256:$sha}'
}

LT=$(resolve_tag "$LLAMA_REPO" "$LLAMA_TAG")
WT=$(resolve_tag "$WHISPER_REPO" "$WHISPER_TAG")
echo "llama.cpp $LT / whisper.cpp $WT"

# target → asset name. Vulkan-first for llama (full build, degrades to CPU on GPU-less
# machines). whisper ships plain-CPU ubuntu/win archives; NO mac CLI (xcframework only).
declare -A LLAMA=(
  [linux-x64]="llama-$LT-bin-ubuntu-vulkan-x64.tar.gz"
  [linux-arm64]="llama-$LT-bin-ubuntu-vulkan-arm64.tar.gz"
  [win-x64]="llama-$LT-bin-win-vulkan-x64.zip"
  [mac-arm64]="llama-$LT-bin-macos-arm64.tar.gz"
)
declare -A WHISPER=(
  [linux-x64]="whisper-bin-ubuntu-x64.tar.gz"
  [linux-arm64]="whisper-bin-ubuntu-arm64.tar.gz"
  [win-x64]="whisper-bin-x64.zip"
)

build_family() {
  local repo="$1" tag="$2"; shift 2
  local -n MAP="$1"
  local obj="{}" t
  for t in "${!MAP[@]}"; do
    echo "  $t <- ${MAP[$t]}" >&2
    local p; p=$(pin "$repo" "$tag" "${MAP[$t]}")
    obj=$(jq --arg t "$t" --argjson v "$p" '. + {($t): $v}' <<<"$obj")
  done
  echo "$obj"
}

echo "llamacpp:" >&2;   LLAMACPP_JSON=$(build_family "$LLAMA_REPO" "$LT" LLAMA)
echo "whispercli:" >&2; WHISPERCLI_JSON=$(build_family "$WHISPER_REPO" "$WT" WHISPER)

jq -n \
  --arg c "Pinned upstream prebuilt sidecar binaries packed as the llamacpp/whispercli loader components. GENERATED — refresh with scripts/update-runtime-pins.sh. Keys are build targets; only listed targets get a component (mac-arm64 whisper-cli has no upstream CLI archive)." \
  --argjson llama "$LLAMACPP_JSON" \
  --argjson whisper "$WHISPERCLI_JSON" \
  '{_comment:$c, llamacpp:$llama, whispercli:$whisper}' > "$OUT"

echo "wrote $OUT"
