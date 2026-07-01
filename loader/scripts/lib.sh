#!/usr/bin/env bash
# Shared helpers for the hilbertraum-usb project scripts (bundle.sh, stage-app.sh,
# nix-component.sh, make-update-tarball.sh, test-*.sh). Source it:
#   . "$(dirname "$0")/lib.sh"
#
# App-only HilbertRaum: there is no usb.lock / vendored-download / ollama machinery here
# (that lives in the loader's @loader scripts for products that need it).
set -euo pipefail

# --- paths ------------------------------------------------------------------
# REPO_ROOT is the PROJECT root (flake.nix, dist/). The build engine exports
# PLANAI_REPO_ROOT=$PWD before invoking ninja; honour it, falling back to $SCRIPT_DIR/..
# for standalone use.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${PLANAI_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DIST_DIR="$REPO_ROOT/dist"

# --- logging ----------------------------------------------------------------
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisites ----------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1 (enter 'nix develop')"; }

# --- app root ---------------------------------------------------------------
# app_root -> the packaged PROJECT root, from loader.toml [layout].app_root (default ".",
# resolved against REPO_ROOT the loader root). Mirrors the loader engine's helper: default "."
# keeps the app AT the loader root; HilbertRaum vendors the loader in <project>/loader/ and
# sets app_root=".." so these scripts (stage-app, bundle, make-update-tarball) reach the app
# one level up. Memoised (config-json runs xtask).
app_root() {
  [ -n "${_APP_ROOT:-}" ] && { printf '%s' "$_APP_ROOT"; return; }
  need jq; need nix
  local rel; rel="$( ( cd "$REPO_ROOT" && nix run ".#xtask" -- config-json ) | jq -r '.layout.app_root // "."')"
  _APP_ROOT="$(cd "$REPO_ROOT" && cd "$rel" && pwd)" || die "app_root '$rel' not found under $REPO_ROOT"
  printf '%s' "$_APP_ROOT"
}

# flakeref -> a `git+file://` flakeref for the loader flake, correct even when the loader
# lives in a subdirectory of the git repo (git+file://<root>?dir=<sub>). nix/builds.nix reads
# it (PLANAI_FLAKEREF) so getFlake fetches the right git tree. Mirrors the engine helper.
flakeref() {
  need git
  local top rel
  top="$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null)" || { printf 'git+file://%s' "$REPO_ROOT"; return; }
  rel="$(realpath --relative-to="$top" "$REPO_ROOT")"
  if [ "$rel" = "." ]; then printf 'git+file://%s' "$top"
  else printf 'git+file://%s?dir=%s' "$top" "$rel"; fi
}

# --- test drive provisioning ------------------------------------------------
# Seed a staged drive-root with update.json + platforms.json so the launcher treats it as an
# already-provisioned drive and runs from the LOCAL pushed components, instead of bootstrapping
# a download from the update server. Mirrors what make-usb-image.sh writes onto a real drive.
#   seed_drive_manifest <staged-drive-root> <platform>
seed_drive_manifest() {
  local drive="$1" platform="$2"
  need jq
  local commit; commit="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo test)"
  ( cd "$REPO_ROOT" && nix run ".#xtask" -- gen-manifest "$drive" \
      --version "0.0.0-test" --commit "$commit" --url "http://127.0.0.1:1/" \
      --out "$drive/update.json" ) || die "gen-manifest failed for $drive"
  printf '{"platforms":["%s"]}\n' "$platform" > "$drive/platforms.json"
  log "seeded update.json + platforms.json ($platform) — launcher runs from the local pool"
}

# --- component packing primitive --------------------------------------------
# pack_zip: the Windows component delivery format (one .zip the launcher/image unpacks).
# Used by nix-component.sh when a component's out path ends .zip.
pack_zip() {  # <srcdir> <out.zip>
  need zip; local src="$1" out="$2" tmp
  mkdir -p "$(dirname "$out")"; out="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")"
  tmp="$out.tmp.$$"; rm -f "$tmp"
  ( cd "$src" && find . -mindepth 1 | LC_ALL=C sort | zip -q -X -@ "$tmp" )
  mv -f "$tmp" "$out"
}

# --- HilbertRaum boot assertion (shared by the test-* scripts) --------------
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
