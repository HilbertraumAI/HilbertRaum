#!/usr/bin/env bash
# Assemble the HilbertRaum bundle for one target: the native loader launcher + the prebuilt
# app-<target> component + the per-OS group manifest (+ the NixOS FHS helper on linux). The
# Electron app component itself is built by `make components` (loader.toml `app` component →
# scripts/stage-app.sh → import-build pack); this script only ASSEMBLES dist/bundle/.
#
# HilbertRaum is self-contained, so there is nothing else to assemble — no runtime, no ollama,
# no daemon, nothing from mac-mgmt.
#
#   linux  -> hilbertraum.<group>.exe + components/<group>/app-<t>.squashfs + nixos-fhs.*
#   win    -> hilbertraum.exe         + components/<group>/app-<t>.zip
#   mac    -> hilbertraum.dmg         + components/<group>/app-<t>.dmg
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

host_target() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;; Darwin) os=mac ;; MINGW*|MSYS*|CYGWIN*) os=win ;;
    *) die "unsupported host OS" ;;
  esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "arch?" ;; esac
  echo "$os-$arch"
}

TARGET="${1:-$(host_target)}"
APP="$REPO_ROOT/app"
VERSION="$(jq -r '.version' "$APP/package.json")"
COMP_SRC="$DIST_DIR/components"   # where `make components` wrote app-<target>.<ext>
OUT="$DIST_DIR/bundle"

# Component format + group dir (os-arch keyed so two linux arches don't collide).
case "$TARGET" in
  linux-*|nixos-*) FMT="squashfs" ;;
  win-*)           FMT="zip" ;;
  mac-*)           FMT="dmg" ;;
  *) die "unsupported target $TARGET" ;;
esac
case "$TARGET" in nixos-x64) GROUP=linux-x64 ;; nixos-arm64) GROUP=linux-arm64 ;; *) GROUP="$TARGET" ;; esac
# The standalone-launcher nix attr + shipped filename (must match loader.toml layout).
case "$TARGET" in
  linux-x64|nixos-x64) LAUNCHER_ATTR=launcher-linux-x64;  LAUNCHER_NAME="hilbertraum.$GROUP.exe"; LBIN=hilbertraum ;;
  linux-arm64)         LAUNCHER_ATTR=launcher-linux-arm64; LAUNCHER_NAME="hilbertraum.$GROUP.exe"; LBIN=hilbertraum ;;
  win-x64)             LAUNCHER_ATTR=launcher-win-x64;     LAUNCHER_NAME="hilbertraum.exe";        LBIN=hilbertraum.exe ;;
  mac-arm64)           LAUNCHER_ATTR=launcher-mac-arm64;   LAUNCHER_NAME="hilbertraum.dmg";        LBIN=hilbertraum ;;
  *) die "no launcher for target $TARGET" ;;
esac

CDST="$OUT/components/$GROUP"
mkdir -p "$CDST"

# Atomic phase: wipe this target's prior bundle outputs (scoped, never races a sibling).
rm -rf "$CDST"; rm -f "$OUT/$LAUNCHER_NAME"; mkdir -p "$CDST"

# 1. The Electron app component (built by `make components` → dist/components/app-<t>.<ext>).
APP_COMP="$COMP_SRC/app-$TARGET.$FMT"
[ -e "$APP_COMP" ] || die "missing app component $APP_COMP — run: make components (TARGET=$TARGET)"
cp -u "$APP_COMP" "$CDST/" || die "copy app component failed"
log "app component -> $CDST/app-$TARGET.$FMT"

# 2. Per-OS group manifest. App-only: the only component is app-<target>.
jq -n --arg os "$GROUP" --arg app "app-$TARGET" --arg ver "$VERSION" \
  '{os:$os, app:$app, version:$ver,
    note:"per-OS component group; the launcher mounts app-<target> and runs HilbertRaum from it"}' \
  > "$CDST/manifest.json"

# 3. NixOS FHS helper closure (linux only): the static-musl launcher squashfuse-mounts it and
# re-execs the generic-glibc Electron inside an FHS sandbox.
emit_nixos_fhs() {
  local fhs_attr sqfs_attr fhs
  case "$TARGET" in
    linux-x64|nixos-x64) fhs_attr=nixosFhs;       sqfs_attr=nixos-fhs-squashfs-x64 ;;
    linux-arm64)         fhs_attr=nixosFhs-arm64; sqfs_attr=nixos-fhs-squashfs-arm64 ;;
    *) return 0 ;;
  esac
  command -v nix >/dev/null 2>&1 || { warn "no nix — skip NixOS FHS helper"; return 0; }
  fhs="$(cd "$REPO_ROOT" && nix build ".#$fhs_attr" --no-link --print-out-paths 2>/dev/null || true)"
  [ -n "$fhs" ] || { warn "$fhs_attr build failed — skip FHS helper"; return 0; }
  log "packing NixOS FHS squashfs ($sqfs_attr) -> components/$GROUP/"
  "$SCRIPT_DIR/nix-component.sh" "$sqfs_attr" "$CDST/nixos-fhs.squashfs"
  echo "$fhs/bin/hilbertraum-fhs" > "$CDST/nixos-fhs.path"
  log "  nixos-fhs.squashfs ($(du -h "$CDST/nixos-fhs.squashfs" | cut -f1)) + nixos-fhs.path"
}

# 4. The standalone launcher beside the app. mac ships as hilbertraum.dmg (a tiny .app holding
# the launcher, wrapped in a dmg so it survives FAT32 with exec bit + signature). win is
# Authenticode-signed if WIN_PFX is set.
sign_windows() {
  [ -n "${WIN_PFX:-}" ] || { warn "WIN_PFX unset — windows launcher unsigned"; return 0; }
  need osslsigncode
  log "osslsigncode sign $LAUNCHER_NAME"
  osslsigncode sign -pkcs12 "$WIN_PFX" -pass "${WIN_PFX_PASS:-}" -n HilbertRaum -i https://hilbertraum.space \
    -t http://timestamp.digicert.com -in "$OUT/$LAUNCHER_NAME" -out "$OUT/$LAUNCHER_NAME.s" \
    && mv "$OUT/$LAUNCHER_NAME.s" "$OUT/$LAUNCHER_NAME"
}
place_launcher() {
  if [ "$TARGET" = mac-arm64 ]; then
    # The ad-hoc-signed HilbertRaum.app (launcher) wrapped in a dmg, built purely in nix.
    "$SCRIPT_DIR/nix-component.sh" launcher-mac-arm64-dmg "$OUT/$LAUNCHER_NAME"
    log "mac launcher -> $OUT/$LAUNCHER_NAME (mount it, then double-click HilbertRaum.app)"
    return
  fi
  local out; out="$(cd "$REPO_ROOT" && nix build ".#$LAUNCHER_ATTR" --no-link --print-out-paths)" \
    || die "launcher build failed: .#$LAUNCHER_ATTR"
  [ -f "$out/$LBIN" ] || die "launcher $LBIN missing in $out"
  cp -f "$out/$LBIN" "$OUT/$LAUNCHER_NAME"; chmod +x "$OUT/$LAUNCHER_NAME" 2>/dev/null || true
  case "$TARGET" in win-*) sign_windows ;; esac
  log "standalone launcher -> $OUT/$LAUNCHER_NAME"
}

case "$TARGET" in linux-*|nixos-*) emit_nixos_fhs ;; esac
place_launcher
log "bundle done -> $OUT/ (launcher $LAUNCHER_NAME + components/$GROUP/app-$TARGET.$FMT)"
