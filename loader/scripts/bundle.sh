#!/usr/bin/env bash
# Assemble the HilbertRaum bundle for one target: the native loader launcher + the prebuilt
# app-<target> + llamacpp-<target> + whispercli-<target> components + the per-OS group manifest
# (+ the NixOS FHS helper on linux). The components themselves are built by `make components`
# (loader.toml `app`/`llamacpp`/`whispercli` components → stage-app.sh / pure-nix runtime
# attrs); this script only ASSEMBLES dist/bundle/.
#
# HilbertRaum is otherwise self-contained (RAG/embeddings live in the Electron main process) —
# no ollama, no daemon, nothing from mac-mgmt. The sidecar components carry only the ENGINE
# binaries (llama.cpp chat server + whisper.cpp transcriber); model weights live on the drive.
# whispercli is optional per target (no upstream mac CLI → mac bundles omit it).
#
#   linux  -> hilbertraum.<group>.exe + components/<group>/{app,llamacpp,whispercli}-<t>.squashfs + nixos-fhs.*
#   win    -> hilbertraum.exe         + components/<group>/{app,llamacpp,whispercli}-<t>.zip
#   mac    -> hilbertraum.dmg         + components/<group>/{app,llamacpp}-<t>.dmg  (no whispercli)
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
APP="$(app_root)"                # npm workspace root (the app; ../ from loader/)
VERSION="$(jq -r '.version' "$APP/package.json")"
# The mac dmg's Info.plist reads the version in nix (nix/builds.nix); the app package.json is
# outside the flake when the loader is a subdir, so hand it the version via the env instead.
export PLANAI_APP_VERSION="$VERSION"
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
cp "$APP_COMP" "$CDST/" || die "copy app component failed"
log "app component -> $CDST/app-$TARGET.$FMT"

# 1b. Sidecar runtime components: the llama.cpp chat server + whisper.cpp transcriber the
# app spawns. Optional per target (e.g. no whispercli on mac — upstream ships no mac CLI),
# so copy whichever `make components` produced. The launcher mounts each present one beside
# the app and exports its dir; the app resolves the binary there (drive runtime/ fallback).
RUNTIME_COMPS=""
for rc in llamacpp whispercli; do
  f="$COMP_SRC/$rc-$TARGET.$FMT"
  if [ -e "$f" ]; then
    cp "$f" "$CDST/" && { RUNTIME_COMPS="$RUNTIME_COMPS $rc-$TARGET"; log "$rc component -> $CDST/$rc-$TARGET.$FMT"; }
  else
    log "no $rc component for $TARGET (none built) — app falls back"
  fi
done

# 2. Per-OS group manifest. `runtime` lists the sidecar component bases the launcher should
# mount alongside `app`.
RUNTIME_JSON="$(printf '%s\n' $RUNTIME_COMPS | jq -R . | jq -s 'map(select(length>0))')"
jq -n --arg os "$GROUP" --arg app "app-$TARGET" --arg ver "$VERSION" \
  --argjson runtime "$RUNTIME_JSON" \
  '{os:$os, app:$app, version:$ver, runtime:$runtime,
    note:"per-OS component group; the launcher mounts app-<target> + the runtime[] sidecars and runs HilbertRaum from them"}' \
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
