#!/usr/bin/env bash
# Build the update-server tarball: manifest.json + files/<path>, for every platform. Drop +
# extract at the update URL's webroot; the launcher updater fetches <url>/manifest.json then
# <url>/files/<path>. Manifest generation + tarball assembly live in xtask (shared schema with
# the launcher updater).
#
# Usage: scripts/make-update-tarball.sh [out.tar.gz]
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT="${1:-$DIST_DIR/hilbertraum-update.tar.gz}"
BUNDLE="$DIST_DIR/bundle"
VERSION="$(jq -r '.version' "$REPO_ROOT/package.json")"
UPDATE_URL="${HILBERTRAUM_UPDATE_URL:-https://hilbertraum-test.plan.ai}"
COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ -d "$BUNDLE/components" ] || die "no $BUNDLE/components — run 'make bundles' first"

# Curated symlink mirror of exactly the drive contents (NOT $BUNDLE wholesale — it holds
# electron-builder's *-unpacked dirs). xtask dereferences the symlinks (tar -h) so real content
# lands under files/<path>.
MIRROR="$DIST_DIR/.update-mirror"; rm -rf "$MIRROR"; mkdir -p "$MIRROR"
shopt -s nullglob
for f in "$BUNDLE"/hilbertraum.*.exe "$BUNDLE"/hilbertraum.exe "$BUNDLE"/hilbertraum.dmg; do
  [ -e "$f" ] && ln -s "$f" "$MIRROR/$(basename "$f")"
done
shopt -u nullglob
ln -s "$BUNDLE/components" "$MIRROR/components"
[ -f "$BUNDLE/README.txt" ] && ln -s "$BUNDLE/README.txt" "$MIRROR/README.txt"

( cd "$REPO_ROOT" && nix run .#xtask -- tarball "$MIRROR" "$OUT" \
    --version "$VERSION" --commit "$COMMIT" --url "$UPDATE_URL" --built-at "$BUILT_AT" )
rm -rf "$MIRROR"
log "update tarball -> $OUT  (url=$UPDATE_URL commit=${COMMIT:0:8})"
