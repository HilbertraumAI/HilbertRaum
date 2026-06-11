#!/usr/bin/env bash
# Lay out a Private AI Drive Lite portable drive (spec §6 / Phase 11).
#
# Creates the directory tree the app actually reads (workspace/, models/{chat,embeddings}/,
# model-manifests/, runtime/llama.cpp/{win,mac,linux}/, logs/, config/, docs/), copies the
# committed model manifests + user docs onto the drive, and generates config/{drive,policy}.json.
# It does NOT download model weights or sidecar binaries (git-ignored, not in the repo, R5).
#
# Canonical, unit-tested reference: apps/desktop/src/main/services/drive.ts — keep in sync.
#
# --with-assets downloads + verifies the model weights + llama.cpp sidecar (Phase 12), so
# one command yields a launch-ready drive (build-time network; the app stays offline).
#
# Usage:
#   scripts/prepare-drive.sh --target /Volumes/PRIVATE_AI_DRIVE [--dry-run] [--force] \
#       [--dev] [--with-assets] [--accept-license]
set -euo pipefail

TARGET=""
DRY_RUN=0
FORCE=0
DEV=0
WITH_ASSETS=0
ACCEPT_LICENSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --dev) DEV=1; shift ;;
    --with-assets) WITH_ASSETS=1; shift ;;
    --accept-license) ACCEPT_LICENSE=1; shift ;;
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

# Directory tree (must match drive.ts DRIVE_LAYOUT_DIRS / sidecar.ts llamaOsDir).
DIRS=(
  workspace
  models/chat
  models/embeddings
  models/reranker
  models/transcriber
  model-manifests
  runtime/llama.cpp/win
  runtime/llama.cpp/mac
  runtime/llama.cpp/linux
  runtime/whisper.cpp/win
  runtime/whisper.cpp/mac
  runtime/whisper.cpp/linux
  ocr
  logs
  config
  docs
)

if [[ $DEV -eq 1 ]]; then
  ENC_REQUIRED=false; PLAINTEXT=true; ALLOW_UNVERIFIED=true; REQUIRE_SHA=false
else
  ENC_REQUIRED=true; PLAINTEXT=false; ALLOW_UNVERIFIED=false; REQUIRE_SHA=true
fi

CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Prepare drive at: $TARGET"
[[ $DRY_RUN -eq 1 ]] && echo "(dry run — nothing will be created)"
echo

echo "Directories:"
for d in "${DIRS[@]}"; do
  full="$TARGET/$d"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  + $full"
  else
    mkdir -p "$full"
    echo "  ok $d"
  fi
done
echo

echo "Model manifests:"
if [[ -d "$REPO_ROOT/model-manifests" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  copy $REPO_ROOT/model-manifests -> $TARGET/model-manifests"
  else
    cp -R "$REPO_ROOT/model-manifests/." "$TARGET/model-manifests/"
    echo "  copied manifests to model-manifests/"
  fi
else
  echo "  WARNING: $REPO_ROOT/model-manifests not found (run from a repo clone)"
fi
echo

echo "User docs:"
for rel in docs/user-guide.md docs/troubleshooting.md PRIVACY.md; do
  src="$REPO_ROOT/$rel"
  if [[ -f "$src" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then echo "  copy $rel -> docs/"
    else cp "$src" "$TARGET/docs/"; echo "  copied $rel"; fi
  fi
done
echo

write_json() {
  local rel="$1" content="$2" full="$TARGET/$1"
  if [[ $DRY_RUN -eq 1 ]]; then echo "  + $rel"; return; fi
  if [[ -f "$full" && $FORCE -eq 0 ]]; then
    echo "  skip $rel (exists; use --force to overwrite)"; return
  fi
  printf '%s\n' "$content" > "$full"
  echo "  wrote $rel"
}

DRIVE_JSON=$(cat <<EOF
{
  "product": "Private AI Drive Lite",
  "drive_format_version": 1,
  "created_at": "$CREATED_AT",
  "edition": "lite",
  "offline_by_default": true,
  "models_dir": "models",
  "workspace_dir": "workspace",
  "allow_network_by_default": false
}
EOF
)

POLICY_JSON=$(cat <<EOF
{
  "network": {
    "allow_model_downloads": false,
    "allow_update_checks": false,
    "allow_telemetry": false
  },
  "workspace": {
    "encryption_required": $ENC_REQUIRED,
    "allow_plaintext_dev_mode": $PLAINTEXT
  },
  "models": {
    "allow_unverified_models": $ALLOW_UNVERIFIED,
    "require_manifest": true,
    "require_sha256_match": $REQUIRE_SHA
  }
}
EOF
)

echo "Config files:"
write_json "config/drive.json" "$DRIVE_JSON"
write_json "config/policy.json" "$POLICY_JSON"
echo

if [[ $WITH_ASSETS -eq 1 ]]; then
  echo "Fetching assets (build-time network; the app itself stays offline):"
  MODEL_ARGS=(--target "$TARGET")
  [[ $ACCEPT_LICENSE -eq 1 ]] && MODEL_ARGS+=(--accept-license)
  [[ $DRY_RUN -eq 1 ]] && MODEL_ARGS+=(--dry-run)
  bash "$SCRIPT_DIR/fetch-models.sh" "${MODEL_ARGS[@]}"
  RUNTIME_ARGS=(--target "$TARGET")
  [[ $DRY_RUN -eq 1 ]] && RUNTIME_ARGS+=(--dry-run)
  bash "$SCRIPT_DIR/fetch-runtime.sh" "${RUNTIME_ARGS[@]}"
  echo
  echo "Now capture real hashes: scripts/verify-models.sh --target \"$TARGET\" --generate"
else
  echo "Next steps (artifacts NOT provisioned without --with-assets):"
  echo "  1. Drop GGUF weights into models/chat/ and models/embeddings/ (see manifest local_path),"
  echo "     or re-run with --with-assets to download + verify them (scripts/fetch-models.sh)."
  echo "  2. Drop llama-server binaries into runtime/llama.cpp/{win,mac,linux}/ (or --with-assets)."
  echo "  3. Run scripts/verify-models.sh --target \"$TARGET\" to verify checksums."
fi
echo
echo "Launch from the drive with PAID_DRIVE_ROOT set to the drive root:"
echo "  export PAID_DRIVE_ROOT=\"$TARGET\""
