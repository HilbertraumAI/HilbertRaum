#!/usr/bin/env bash
# Stage the HilbertRaum Electron app's UNPACKED tree for one target into dist/app/<target>.
# The `app` component (loader.toml, builder=import-build) store-imports this and packs it
# OFFLINE via nix (app-<target>-{squashfs,dmg,dir} in nix/builds.nix). Producing the tree is
# the impure step (electron-builder/@electron/packager download Electron + patch helpers).
#
#   linux  -> electron-builder --dir  (linux[-arm64]-unpacked) -> dist/app/<t>/
#   win    -> electron-builder --dir  (win-unpacked)           -> dist/app/<t>/
#   mac    -> @electron/packager + rcodesign (HilbertRaum.app) -> dist/app/<t>/ (holds the .app)
#
# Requires the `build` step (electron-vite build → app/apps/desktop/out) to have run; we
# rebuild it if missing so this also works standalone.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TARGET="${1:?usage: stage-app.sh <target>}"
APP="$(app_root)"                            # npm workspace root (the app; ../ from loader/)
DESKTOP="$APP/apps/desktop"                  # the Electron app (electron-builder.yml + vite)
RELEASE="$DESKTOP/release"                   # electron-builder `directories.output`
DEST="$DIST_DIR/app/$TARGET"                 # the staged unpacked tree the component imports

case "$TARGET" in
  linux-x64|nixos-x64) EB_OS=--linux; EB_ARCH=--x64;   UNPACK_DIR="linux-unpacked" ;;
  linux-arm64)         EB_OS=--linux; EB_ARCH=--arm64; UNPACK_DIR="linux-arm64-unpacked" ;;
  win-x64)             EB_OS=--win;   EB_ARCH=--x64;   UNPACK_DIR="win-unpacked" ;;
  mac-arm64)           EB_OS="";      EB_ARCH="";      UNPACK_DIR="" ;;
  *) die "unsupported target $TARGET" ;;
esac

# electron-builder/@electron/packager read+write the shared workspace (node_modules) and the
# global electron cache — only one target may run that at a time across concurrent bundles.
APP_LOCK="$DIST_DIR/.stage.lock"   # outside the submodule, to keep app/ pristine
app_lock()   { exec 9>"$APP_LOCK"; flock 9 || die "could not acquire app staging lock"; }
app_unlock() { flock -u 9 2>/dev/null || true; exec 9>&- 2>/dev/null || true; }
ensure_deps()  { [ -x "$APP/node_modules/.bin/electron-builder" ] || ( cd "$APP" && npm ci ); }
ensure_built() { [ -d "$DESKTOP/out/main" ] || ( cd "$DESKTOP" && npm run build ); }

# Patch electron-builder's downloaded ELF helpers (mksquashfs/appimagetool/…) for NixOS.
patch_eb_build_tools() {
  [ -n "${NIX_LD:-}" ] && command -v patchelf >/dev/null 2>&1 || return 0
  local cache="${XDG_CACHE_HOME:-$HOME/.cache}/electron-builder" f
  for f in $(find "$cache" -type f \( -name mksquashfs -o -name appimagetool \
      -o -name desktop-file-validate -o -name makensis \) 2>/dev/null); do
    patchelf --set-interpreter "$NIX_LD" "$f" 2>/dev/null || true
    [ -n "${NIX_LD_LIBRARY_PATH:-}" ] && patchelf --set-rpath "$NIX_LD_LIBRARY_PATH" "$f" 2>/dev/null || true
  done
}

stage_linux_win() {
  # AI_Drive's electron-builder.yml carries `includeSubNodeModules`, which electron-builder 26
  # (the version it pins) removed — it now bundles the hoisted production deps by default. Strip
  # the key so the config validates, without touching the submodule. cwd stays $DESKTOP so the
  # config's relative paths (extraResources ../../model-manifests, buildResources) still resolve.
  local cfg="$DIST_DIR/eb-$TARGET.yml"; mkdir -p "$DIST_DIR"
  grep -v '^includeSubNodeModules:' "$DESKTOP/electron-builder.yml" > "$cfg"
  # electron-builder can't auto-detect the Electron version from an npm WORKSPACE: electron is
  # hoisted to the workspace root (app/node_modules), not beside the app (app/apps/desktop), so
  # it falls back to the devDep RANGE ("^37.0.0") and errors. Pin the exact installed version so
  # electron-builder fetches + bundles it (build-only network; the packaged app stays offline).
  local ev; ev="$(jq -r '.version' "$APP/node_modules/electron/package.json" 2>/dev/null || true)"
  [ -n "$ev" ] && [ "$ev" != "null" ] && printf '\nelectronVersion: %s\n' "$ev" >> "$cfg"
  # Pin the linux/win executable name so the launcher resolves it deterministically. Without
  # this, electron-builder derives it from the package name (e.g. `@hilbertraumdesktop`), which
  # the launcher's electron_in() would not recognise. mac (@electron/packager) uses HilbertRaum.
  printf 'executableName: hilbertraum\n' >> "$cfg"
  build_once() { ( cd "$DESKTOP" && DEBUG="${DEBUG:-electron-builder*}" \
      npx --no-install electron-builder $EB_OS $EB_ARCH --dir --config "$cfg" ); }
  log "electron-builder $EB_OS $EB_ARCH --dir -> $RELEASE"
  app_lock; ensure_deps; ensure_built; patch_eb_build_tools
  build_once || { warn "package failed; patching helpers + retrying"; patch_eb_build_tools; build_once; }
  app_unlock
  local UNPACK="$RELEASE/$UNPACK_DIR"; [ -d "$UNPACK" ] || die "no $UNPACK_DIR from electron-builder"
  rm -rf "$DEST"; mkdir -p "$(dirname "$DEST")"; cp -a "$UNPACK" "$DEST"
  log "staged app tree -> $DEST ($(du -sh "$DEST" | cut -f1))"
}

stage_mac() {  # @electron/packager (cross from linux) + rcodesign ad-hoc (real cert via MAC_P12)
  need rcodesign
  local ARCH=arm64 APPROOT; APPROOT="$(mktemp -d)"
  log "@electron/packager mac/$ARCH"
  app_lock; ensure_deps; ensure_built
  # @electron/packager cross-builds the mac .app from linux (electron-builder's mac target needs
  # macOS). HilbertRaum doesn't depend on it, so fetch it on demand (--yes) — build-only network.
  ( cd "$DESKTOP" && DEBUG="${DEBUG:-electron-*}" npx --yes @electron/packager@20.0.1 . "HilbertRaum" \
      --platform=darwin --arch="$ARCH" --out="$APPROOT" --overwrite \
      --app-bundle-id=space.hilbertraum.app --ignore="(^/release)" )
  app_unlock
  local APPDIR; APPDIR="$(ls -d "$APPROOT"/HilbertRaum-darwin-*/HilbertRaum.app 2>/dev/null | head -1)"
  [ -d "$APPDIR" ] || die "packager produced no .app"
  if [ -n "${MAC_P12:-}" ]; then
    rcodesign sign --p12-file "$MAC_P12" --p12-password "${MAC_P12_PASS:-}" --code-signature-flags runtime "$APPDIR"
    rcodesign verify "$APPDIR/Contents/MacOS/HilbertRaum" 2>&1 | tail -1 || true
  else rcodesign sign "$APPDIR"; warn "MAC_P12 unset — ad-hoc signature (not notarizable)"; fi
  rm -rf "$DEST"; mkdir -p "$DEST"; cp -a "$APPDIR" "$DEST/HilbertRaum.app"; rm -rf "$APPROOT"
  log "staged mac app -> $DEST/HilbertRaum.app"
}

case "$TARGET" in
  linux-*|win-*) stage_linux_win ;;
  mac-*)         stage_mac ;;
  *) die "unknown TARGET '$TARGET'" ;;
esac
