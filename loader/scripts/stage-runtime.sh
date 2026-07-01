#!/usr/bin/env bash
# Stage the HilbertRaum sidecar RUNTIMES for one target into dist/runtime/<target>. The
# `runtime` component (loader.toml, builder=import-build) store-imports this and packs it
# OFFLINE via nix (runtime-<target>-{squashfs,dmg,dir} in nix/builds.nix), exactly like the
# `app` component. Producing the tree is the impure step (it downloads + SHA-verifies the
# prebuilt llama.cpp + whisper.cpp release binaries via the app's scripts/fetch-runtime.sh).
#
# The native launcher mounts this component at run time and exports HILBERTRAUM_RUNTIME_ROOT
# pointing at the mounted tree; the app resolves its sidecars from there (component wins,
# on-drive runtime/ is the fallback — see apps/desktop/src/main/services/runtime/sidecar.ts).
# So the on-disk shape here MUST match what the app expects under that root:
#
#   dist/runtime/<target>/runtime/llama.cpp/<os>/llama-server[.exe]
#   dist/runtime/<target>/runtime/whisper.cpp/<os>/whisper-cli[.exe]   (win prebuilt only)
#
# fetch-runtime.sh --target <dir> extracts into <dir>/runtime/<family>/<os>/, so we simply
# point it at dist/runtime/<target> with the target's OS/arch. Cross-provisioning another
# OS is fine — these are prebuilt release zips selected by --os/--arch, not host-built.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TARGET="${1:?usage: stage-runtime.sh <target>}"
APP="$(app_root)"                            # npm workspace root (the app; ../ from loader/)
FETCH="$APP/scripts/fetch-runtime.sh"        # the app's downloader (repo-root runtime-sources.yaml)
DEST="$DIST_DIR/runtime/$TARGET"             # the staged runtime tree the component imports
[ -x "$FETCH" ] || die "missing $FETCH (run from a repo clone)"

# Map the loader target -> the fetch-runtime OS/arch keys (matches llamaOsDir: win/mac/linux).
case "$TARGET" in
  linux-x64|nixos-x64) OS=linux; ARCH=x64 ;;
  linux-arm64|nixos-arm64) OS=linux; ARCH=arm64 ;;
  win-x64)             OS=win;   ARCH=x64 ;;
  mac-arm64)           OS=mac;   ARCH=arm64 ;;
  *) die "unsupported target $TARGET" ;;
esac

rm -rf "$DEST"; mkdir -p "$DEST"

# llama.cpp (chat + embeddings engine) — the default backend for this OS (required).
log "fetch llama.cpp runtime ($OS/$ARCH) -> $DEST"
bash "$FETCH" --target "$DEST" --os "$OS" --arch "$ARCH"

# whisper.cpp (transcriber engine) — best-effort: upstream ships prebuilt binaries for
# Windows only, so a mac/linux runtime component simply omits it (the app degrades the
# transcriber gracefully). A miss is a warning, not a failure.
log "fetch whisper.cpp runtime ($OS/$ARCH) -> $DEST (best-effort)"
if ! bash "$FETCH" --target "$DEST" --os "$OS" --arch "$ARCH" --family whisper_cpp; then
  warn "whisper.cpp not provisioned for $TARGET (no prebuilt build) — transcriber falls back"
fi

# The store-import wants a NON-EMPTY tree; a llama-server must be present.
BIN="$DEST/runtime/llama.cpp/$OS/llama-server"; [ "$OS" = win ] && BIN="$BIN.exe"
[ -f "$BIN" ] || die "no llama-server staged at $BIN — fetch-runtime.sh failed for $TARGET"
log "staged runtime tree -> $DEST ($(du -sh "$DEST" | cut -f1))"
