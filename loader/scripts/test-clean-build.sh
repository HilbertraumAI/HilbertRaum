#!/usr/bin/env bash
# Verify the project builds from a CLEAN checkout: a throwaway git worktree (submodules
# included) so the main tree's artifacts are untouched. Builds the bundle for TARGET from
# scratch and asserts the launcher + app component exist.
#
# Usage: scripts/test-clean-build.sh [target]   (default: linux-x64)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need git; need nix

TARGET="${1:-linux-x64}"
WT="$(mktemp -d /tmp/hbr-clean-XXXXXX)"
cleanup() { git -C "$REPO_ROOT" worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"; }
trap cleanup EXIT

log "creating clean worktree at $WT (TARGET=$TARGET)"
git -C "$REPO_ROOT" worktree add --detach "$WT" HEAD >/dev/null
git -C "$WT" submodule update --init --recursive >/dev/null 2>&1 || die "submodule init failed in clean worktree"

log "building bundle-$TARGET in the clean tree"
( cd "$WT" && nix develop -c make bundle "TARGET=$TARGET" )

case "$TARGET" in
  win-x64)   LN="hilbertraum.exe";              FMT=zip ;;
  mac-arm64) LN="hilbertraum.dmg";              FMT=dmg ;;
  *)         LN="hilbertraum.$TARGET.exe";      FMT=squashfs ;;
esac
[ -e "$WT/dist/bundle/$LN" ] || die "missing launcher $LN in clean build"
[ -e "$WT/dist/bundle/components/$TARGET/app-$TARGET.$FMT" ] || die "missing app component in clean build"
log "PASS — clean build produced $LN + app-$TARGET.$FMT"
