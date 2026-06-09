#!/usr/bin/env bash
# One-shot developer bootstrap for Private AI Drive Lite (Phase 11).
#
# Installs dependencies, then runs the build + tests as a smoke check. Uses
# NODE_OPTIONS=--use-system-ca so npm install works behind a TLS-intercepting corporate
# proxy (BUILD_STATE R6).
#
# Note: `npm install` downloads the Electron binary (~100 MB) the first time (R2). This is
# the ONLY network the project needs and it is dev-time only — the app stays offline.
#
# Usage:
#   scripts/setup-dev.sh [--skip-tests]
set -euo pipefail

SKIP_TESTS=0
[[ "${1:-}" == "--skip-tests" ]] && SKIP_TESTS=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# R6: read the system cert store so a corporate TLS proxy doesn't break the install.
export NODE_OPTIONS=--use-system-ca

echo '==> npm install (downloads the Electron binary on first run, R2)'
if ! npm install; then
  echo 'npm install failed. If this is a TLS/cert error, see BUILD_STATE R6:' >&2
  echo '  - ensure NODE_OPTIONS=--use-system-ca (set automatically by this script)' >&2
  echo '  - or (dev-only, less secure): npm config set strict-ssl false' >&2
  exit 1
fi

echo '==> npm run build'
npm run build

if [[ $SKIP_TESTS -eq 0 ]]; then
  echo '==> npm test'
  npm test
fi

echo
echo 'Setup complete. Next:'
echo '  npm run dev                                   # launch the app'
echo '  scripts/prepare-drive.sh --target /Volumes/PRIVATE_AI_DRIVE'
