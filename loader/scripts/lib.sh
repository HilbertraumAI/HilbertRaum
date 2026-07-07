#!/usr/bin/env bash
# Shared helpers for the HilbertRaum loader project scripts (bundle.sh, stage-app.sh,
# nix-component.sh, make-update-tarball.sh, test-*.sh). Source it:
#   . "$(dirname "$0")/lib.sh"
#
# This is a THIN shim over the shared loader helpers in the vendored engine
# (third_party/loader/scripts/lib.sh): source those (log/warn/die/need, the loader.toml
# accessors, app_root, flakeref, app_version, pack_zip, …) so there is one source of truth,
# then add only the genuinely HilbertRaum-specific helpers below. App-only HilbertRaum has no
# usb.lock / vendored-download / ollama machinery — those upstream helpers simply go unused.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The engine's lib.sh resolves REPO_ROOT from PLANAI_REPO_ROOT (the build exports it) or falls
# back to its own $SCRIPT_DIR/.. — which, sourced from the submodule, would re-root at
# third_party/loader. Pin it to THIS loader root before sourcing so both agree.
export PLANAI_REPO_ROOT="${PLANAI_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
. "$SCRIPT_DIR/../third_party/loader/scripts/lib.sh"
# The sourced engine lib set SCRIPT_DIR to ITS own dir; restore ours so callers that shell out
# to sibling scripts (bundle.sh → $SCRIPT_DIR/nix-component.sh) hit the project-local copy.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- HilbertRaum-specific helpers (not in the shared loader lib) -------------

# Seed a staged drive-root with update.json + platforms.json so the launcher treats it as an
# already-provisioned drive and runs from the LOCAL pushed components, instead of bootstrapping
# a download from the update server. Mirrors what make-usb-image.sh writes onto a real drive.
#   seed_drive_manifest <staged-drive-root> <platform>
seed_drive_manifest() {
  local drive="$1" platform="$2"
  need jq
  local commit; commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo test)"
  ( cd "$REPO_ROOT" && nix run "$FLAKE_DIR#xtask" -- gen-manifest "$drive" \
      --version "0.0.0-test" --commit "$commit" --url "http://127.0.0.1:1/" \
      --out "$drive/update.json" ) || die "gen-manifest failed for $drive"
  printf '{"platforms":["%s"]}\n' "$platform" > "$drive/platforms.json"
  log "seeded update.json + platforms.json ($platform) — launcher runs from the local pool"
}

# Assert a launcher run booted HilbertRaum: its main process logs "Workspace resolved" once
# Electron's app is ready. <logfile> is the captured launcher stdout+stderr.
assert_hilbertraum_booted() {  # <logfile>
  local logf="$1"
  if grep -qa "Workspace resolved" "$logf"; then
    log "PASS — HilbertRaum booted (Workspace resolved)"
    grep -aE "Workspace resolved|Offline posture|control API on" "$logf" | sed 's/^/    /' >&2
    return 0
  fi
  warn "FAIL — HilbertRaum did not boot; launcher log tail:"
  tail -25 "$logf" | sed 's/^/    /' >&2
  return 1
}
