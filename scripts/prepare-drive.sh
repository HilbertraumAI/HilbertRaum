#!/usr/bin/env bash
# Lay out a HilbertRaum portable drive (spec §6 / Phase 11).
#
# Creates the directory tree the app actually reads (workspace/, models/{chat,embeddings}/,
# model-manifests/, runtime/llama.cpp/{win,mac,linux}/, logs/, config/, docs/), copies the
# committed model manifests + user docs onto the drive, and generates config/{drive,policy}.json.
# It does NOT download model weights or sidecar binaries (git-ignored, not in the repo, R5).
#
# Canonical, unit-tested reference: apps/desktop/src/main/services/drive.ts — keep in sync.
#
# --with-assets downloads + verifies a launch-ready default asset set (Phase 12), so one
# command yields a usable drive (build-time network; the app stays offline). To keep setup
# fast the default set is small but complete for the core features: the default chat model
# (Ministral 3 8B), the embeddings model, the reranker, the Whisper transcriber model, and
# the Qwen2.5-VL image-description model (GGUF + mmproj), PLUS both sidecar runtimes
# (llama.cpp + whisper.cpp). The user downloads any other models
# (larger chat models) from inside the app. Pass --all-models to fetch every model instead
# (the sidecar runtimes are fetched either way).
#
# Usage:
#   scripts/prepare-drive.sh --target /Volumes/PRIVATE_AI_DRIVE [--dry-run] [--force] \
#       [--dev] [--with-assets] [--all-models] [--accept-license]
set -euo pipefail

# The models --with-assets provisions by default (fast setup): the default chat model plus
# the embeddings model, reranker, Whisper transcriber, and the Qwen2.5-VL image-description
# model, so chat, document Q&A, retrieval quality, audio/dictation, and image understanding
# all work out of the box. Every OTHER model (larger chat models) is downloaded by the user
# from inside the app. Pass --all-models to fetch everything. The whisper.cpp runtime is
# fetched alongside these (see the --with-assets block). Keep these ids in sync with the
# manifests under model-manifests/.
DEFAULT_MODEL_IDS=(
  ministral3-8b-instruct-2512-q4   # chat (benchmark-winning 8B)
  multilingual-e5-small-q8         # embeddings (document Q&A)
  bge-reranker-v2-m3-f16           # reranker (retrieval quality)
  whisper-small-multilingual       # transcriber (audio / dictation)
  qwen2.5-vl-3b-instruct-q4        # vision (image description; GGUF + mmproj, two files)
)

TARGET=""
DRY_RUN=0
FORCE=0
DEV=0
WITH_ASSETS=0
ALL_MODELS=0
ACCEPT_LICENSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    --dev) DEV=1; shift ;;
    --with-assets) WITH_ASSETS=1; shift ;;
    --all-models) ALL_MODELS=1; shift ;;
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
  app-skills
  user-skills
  models/chat
  models/embeddings
  models/reranker
  models/transcriber
  models/vision
  model-manifests
  model-manifests/vision
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

# Copy the committed product skills (text-only: SKILL.md + JSON schemas + examples) from the
# repo app-skills/ tree onto the drive, the same wholesale copy as model-manifests/ (skills
# plan S9 / DS17). user-skills/ is left EMPTY (the buyer fills it). Canonical reference:
# drive.ts listSkillFolders / planPrepareDrive.appSkillsToCopy.
echo "App skills:"
if [[ -d "$REPO_ROOT/app-skills" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  copy $REPO_ROOT/app-skills -> $TARGET/app-skills (product skills)"
  else
    cp -R "$REPO_ROOT/app-skills/." "$TARGET/app-skills/"
    echo "  copied app skills to app-skills/"
  fi
else
  echo "  WARNING: $REPO_ROOT/app-skills not found (run from a repo clone)"
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
  "product": "HilbertRaum",
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
    "allow_model_downloads": true,
    "allow_update_checks": false
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

  # Common model args (license + dry-run) shared by every fetch-models call below.
  COMMON_MODEL_ARGS=()
  [[ $ACCEPT_LICENSE -eq 1 ]] && COMMON_MODEL_ARGS+=(--accept-license)
  [[ $DRY_RUN -eq 1 ]] && COMMON_MODEL_ARGS+=(--dry-run)

  # fetch-models takes a single --only id, so the default set is fetched one id at a time;
  # --all-models fetches every manifest in one pass (a single call with no --only).
  if [[ $ALL_MODELS -eq 1 ]]; then
    bash "$SCRIPT_DIR/fetch-models.sh" --target "$TARGET" "${COMMON_MODEL_ARGS[@]}"
  else
    echo "  (default set: ${DEFAULT_MODEL_IDS[*]}; pass --all-models for every model)"
    for id in "${DEFAULT_MODEL_IDS[@]}"; do
      bash "$SCRIPT_DIR/fetch-models.sh" --target "$TARGET" --only "$id" "${COMMON_MODEL_ARGS[@]}"
    done
  fi

  # llama.cpp sidecar (the chat + embeddings engine) — always.
  RUNTIME_ARGS=(--target "$TARGET")
  [[ $DRY_RUN -eq 1 ]] && RUNTIME_ARGS+=(--dry-run)
  bash "$SCRIPT_DIR/fetch-runtime.sh" "${RUNTIME_ARGS[@]}"

  # whisper.cpp sidecar (the transcriber engine) — always, to match the bundled Whisper
  # model. Best-effort: prebuilt whisper.cpp binaries exist for Windows only, so on a
  # mac/linux build host there is no build to fetch — a miss is a warning, not a failure
  # (those drives build whisper.cpp from source; see docs/packaging.md).
  if ! bash "$SCRIPT_DIR/fetch-runtime.sh" "${RUNTIME_ARGS[@]}" --family whisper_cpp; then
    echo "  note: whisper.cpp runtime not provisioned (no prebuilt build for this host — build from source on mac/linux)."
  fi
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
echo "Launch from the drive with HILBERTRAUM_DRIVE_ROOT set to the drive root:"
echo "  export HILBERTRAUM_DRIVE_ROOT=\"$TARGET\""
