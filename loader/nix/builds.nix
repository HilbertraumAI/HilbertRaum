# Pure-nix build layer for store-imported (impure-fetched) inputs.
#
# The shape: scripts/stage-app.sh builds the Electron app's unpacked tree impurely
# (electron-builder/@electron/packager download Electron + patch helpers), then
# scripts/store-import.sh adds it to the store + pins a GC root + records its path under
# dist/.stores/<name>; ./stores.nix reads those records into storePaths. The derivations
# here consume those store paths and pack OFFLINE in the sandbox, so nix owns the graph +
# caching + invalidation past the impure stage.
#
# Evaluate with --impure (builtins.storePath, currentSystem, getFlake on the dirty tree,
# and reading dist/.stores all require it):
#   nix-build --impure nix/builds.nix -A <attr>
let
  # git+file so the flake source is the GIT tree (tracked files only) — a bare path: flakeref
  # would copy the whole repo (incl. multi-GB gitignored dist/) into the store every build.
  # PLANAI_FLAKEREF (exported by the loader scripts) carries the correct ref even when the
  # flake lives elsewhere than this loader/ dir (git+file://<root>?dir=<sub>, or bare
  # git+file://<root> when the flake IS the repo root). Fall back to the repo root — this
  # builds.nix sits at loader/nix/, so ../.. is the git root where flake.nix lives.
  flakeref = let e = builtins.getEnv "PLANAI_FLAKEREF"; in
    if e != "" then e else "git+file://${toString ../..}";
  flake = builtins.getFlake flakeref;
  pkgs = flake.inputs.nixpkgs.legacyPackages.${builtins.currentSystem};
  lib = pkgs.lib;
  stores = import ./stores.nix;

  # The generic component packers (mkSqfs / mkClosureSqfs / mkDmg) live in the shared loader
  # nix lib (third_party/loader/nix/loader). mkDmg is curried with our libdmg pin.
  loader = import ../third_party/loader/nix/loader { inherit pkgs; nixpkgs = flake.inputs.nixpkgs; };
  libdmg = flake.packages.${builtins.currentSystem}.libdmg-hfsplus;
  mkSqfs = loader.mkSqfs;
  mkClosureSqfs = loader.mkClosureSqfs;
  mkDmg = loader.mkDmg { inherit libdmg; };

  # --- mac launcher .app, wrapped + ad-hoc signed in nix ---------------------
  # The standalone launcher binary is already nix (launcher-mac-arm64). Wrap it in a
  # HilbertRaum.app + ad-hoc code-sign with rcodesign (fully OFFLINE), so the launcher dmg
  # needs no host sudo loop-mount (mkDmg packs it in a VM; its mount + cp -a preserves the
  # exec bit + signature). The .app's MacOS exe IS the launcher; at runtime it mounts
  # app-mac-arm64.dmg from the pool and runs the real HilbertRaum Electron app from it.
  launcherMac = flake.packages.${builtins.currentSystem}.launcher-mac-arm64;
  # The app's package.json is at the PROJECT root (app_root), which — when the loader is
  # vendored in <project>/loader/ — is the flake's PARENT and thus outside the flake source.
  # Prefer PLANAI_APP_VERSION (exported by the bundle scripts via app_version, impure eval);
  # fall back to a package.json inside the flake (app_root=".") ; else 0.0.0. Only the mac dmg
  # Info.plist consumes this, so a plain default is harmless for non-mac builds.
  appVersion =
    let env = builtins.getEnv "PLANAI_APP_VERSION";
        pj = flake.outPath + "/package.json";
    in if env != "" then env
       else if builtins.pathExists pj then (builtins.fromJSON (builtins.readFile pj)).version
       else "0.0.0";
  launcherInfoPlist = pkgs.writeText "Info.plist" ''
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
      <key>CFBundleName</key><string>HilbertRaum</string>
      <key>CFBundleDisplayName</key><string>HilbertRaum</string>
      <key>CFBundleIdentifier</key><string>space.hilbertraum.app.launcher</string>
      <key>CFBundleVersion</key><string>${appVersion}</string>
      <key>CFBundleShortVersionString</key><string>${appVersion}</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleExecutable</key><string>hilbertraum</string>
      <key>LSMinimumSystemVersion</key><string>11.0</string>
      <key>NSHighResolutionCapable</key><true/>
    </dict></plist>
  '';
  launcherMacApp = pkgs.runCommand "hilbertraum-launcher-app" { nativeBuildInputs = [ pkgs.rcodesign ]; } ''
    app=$out/HilbertRaum.app
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    cp ${launcherMac}/hilbertraum "$app/Contents/MacOS/hilbertraum"
    chmod 0755 "$app/Contents/MacOS/hilbertraum"
    cp ${launcherInfoPlist} "$app/Contents/Info.plist"
    printf 'APPL????' > "$app/Contents/PkgInfo"
    rcodesign sign "$app"
  '';

  # --- NixOS FHS helper closure, packed PURELY in the sandbox ----------------
  # closureInfo gives the FHS env's closure store-paths; mkClosureSqfs packs them into a
  # squashfs the launcher mounts + bind/overlays as /nix/store on NixOS (no nix-store
  # --import, so no trusted-user requirement), one per linux arch.
  nixosFhs = flake.packages.${builtins.currentSystem}.nixosFhs;
  nixosFhsArm64 = flake.packages.${builtins.currentSystem}.nixosFhs-arm64;
  nixosFhsClosureInfo = pkgs.closureInfo { rootPaths = [ nixosFhs ]; };
  nixosFhsArm64ClosureInfo = pkgs.closureInfo { rootPaths = [ nixosFhsArm64 ]; };

  # --- llama.cpp / whisper.cpp sidecar binaries (upstream prebuilt releases) ---
  # The chat server + audio transcriber the app spawns from the packaged root. ALL-PREBUILT:
  # upstream ships PORTABLE Ubuntu x64+arm64 CLI archives (llama b9690, whisper v1.9.0), built
  # against a baseline glibc — so they run on any matching-arch Linux, not just NixOS. mac-arm64
  # whisper-cli has NO upstream CLI archive (xcframework is a library, not a binary) → omitted;
  # the app falls back to no transcriber on mac. Pins (URL + sha256) live in ./runtime-pins.json,
  # refreshed by scripts/update-runtime-pins.sh (a version bump is one scripted step).
  #
  # Layout: each derivation extracts the archive preserving its internal tree and symlinks the
  # executable at the output ROOT, so the app resolves <root>/<exe> while the binary still execs
  # from its real dir (rpath=$ORIGIN finds the sibling ggml/backend libs). Windows has no
  # $ORIGIN — its DLLs sit beside the .exe, so we flatten that dir to root.
  runtimePins = builtins.fromJSON (builtins.readFile ./runtime-pins.json);
  unpackRuntime = { pname, url, sha256, exe, isWin ? false }:
    pkgs.runCommand pname
      {
        src = pkgs.fetchurl { inherit url sha256; name = "${pname}-archive"; };
        nativeBuildInputs = [ pkgs.gnutar pkgs.gzip pkgs.unzip ];
      }
      (if isWin then ''
        mkdir -p un && cd un && unzip -q "$src"
        d=$(dirname "$(find . -type f -name '${exe}' | head -1)")
        [ -n "$d" ] || { echo "no ${exe} in ${url}"; exit 1; }
        mkdir -p "$out" && cp -a "$d"/. "$out"/
      '' else ''
        mkdir -p un && cd un && tar xf "$src"
        rel=$(find . -type f -name '${exe}' | head -1)
        [ -n "$rel" ] || { echo "no ${exe} in ${url}"; exit 1; }
        mkdir -p "$out" && cp -a ./. "$out"/
        ln -s "''${rel#./}" "$out/${exe}"
      '');
  # The upstream linux binary runs fine under the runtime host's glibc (the FHS sandbox on
  # NixOS, the system on Ubuntu) — interpreter is the standard /lib64/ld-linux, rpath is $ORIGIN
  # (so its own ggml libs resolve). It just needs a few libs the FHS sandbox / a minimal host may
  # not provide (libssl/libcrypto). We DON'T patch or bundle a loader/glibc (that mixes a foreign
  # binary with a nix loader and crashed). Instead ship those libs in a `lib/` subdir and let the
  # app prepend it to LD_LIBRARY_PATH when it spawns the sidecar (sidecarSpawnEnv). GPU/driver
  # libs (libvulkan) are deliberately NOT shipped: ggml dlopens its vulkan backend and falls back
  # to CPU if absent, and a driver lib must match the actual host.
  extraLibDirs = lib.makeLibraryPath [ pkgs.openssl ]; # libssl.so.3, libcrypto.so.3
  extraLibs = [ "libssl.so.3" "libcrypto.so.3" ];
  withExtraLibs = name: drv:
    pkgs.runCommand name { inherit extraLibDirs; } ''
      mkdir -p "$out"; cp -a ${drv}/. "$out"/; chmod -R u+w "$out"; mkdir -p "$out/lib"
      for so in ${lib.concatStringsSep " " extraLibs}; do
        for d in $(echo "$extraLibDirs" | tr ':' ' '); do
          [ -e "$d/$so" ] && { cp -L "$d/$so" "$out/lib/"; break; }
        done
        [ -e "$out/lib/$so" ] || { echo "extra lib $so not found in $extraLibDirs"; exit 1; }
      done
    '';

  # Windows: the upstream MSVC-linked binaries import VCRUNTIME140.dll / MSVCP140.dll (the VC++
  # redistributable), which the release zip does NOT ship and a fresh Windows may lack → the exe
  # dies with STATUS_DLL_NOT_FOUND before main(). Drop the redist DLLs beside the exe (Windows
  # searches the exe's own dir). Reuses the upstream loader lib's shared pin (the redist DLLs
  # extracted from the msvc-runtime wheel) — see third_party/loader/nix/loader/msvc-runtime.nix.
  msvcDlls = loader.msvcDlls;
  withMsvcRuntime = name: drv:
    pkgs.runCommand name { } ''
      mkdir -p "$out"; cp -aL ${drv}/. "$out"/; chmod -R u+w "$out"
      cp -n ${msvcDlls}/*.dll "$out"/   # beside the .exe; never clobber one the zip shipped
    '';

  # family → target → derivation, driven by runtime-pins.json (only present targets exist).
  # Linux targets get the shipped `lib/` (openssl); win gets the MSVC redist DLLs; mac ships the
  # upstream layout as-is (dylibs beside the binary).
  runtimeBin = family: exeBase: target: pin:
    let
      exe = if target == "win-x64" then "${exeBase}.exe" else exeBase;
      unpacked = unpackRuntime { pname = "${family}-${target}"; inherit (pin) url sha256; inherit exe; isWin = target == "win-x64"; };
    in
    if lib.hasPrefix "linux" target then withExtraLibs "${family}-${target}" unpacked
    else if lib.hasPrefix "win" target then withMsvcRuntime "${family}-${target}" unpacked
    else unpacked;
  llamacppSrc = lib.mapAttrs (runtimeBin "llamacpp" "llama-server") runtimePins.llamacpp;
  whispercliSrc = lib.mapAttrs (runtimeBin "whispercli" "whisper-cli") runtimePins.whispercli;
  # Pack one runtime component for a target in the OS-appropriate format (matches `app`).
  packRuntime = family: target: src:
    if lib.hasPrefix "win" target then
      pkgs.runCommand "${family}-${target}" { } "mkdir -p $out && cp -a ${src}/. $out/"
    else if lib.hasPrefix "mac" target then
      mkDmg { name = "${family}-${target}"; inherit src; }
    else
      mkSqfs "${family}-${target}" src;
  ext = target: if lib.hasPrefix "win" target then "dir" else if lib.hasPrefix "mac" target then "dmg" else "squashfs";
  runtimeComponents =
    (lib.mapAttrs' (t: s: { name = "llamacpp-${t}-${ext t}"; value = packRuntime "llamacpp" t s; }) llamacppSrc)
    // (lib.mapAttrs' (t: s: { name = "whispercli-${t}-${ext t}"; value = packRuntime "whispercli" t s; }) whispercliSrc);
in
{
  # the Electron app itself, packed as the app-<target> component. stage-app.sh produces the
  # unpacked tree impurely; store-import records it (stores.app-<target>); these pack it
  # OFFLINE: linux squashfs, mac dmg (the VM mount + cp -a preserves the .app's exec bit +
  # signature), win dir (zipped by import-build-component.sh when out ends .zip).
  "app-linux-x64-squashfs" = mkSqfs "app-linux-x64" (stores.app-linux-x64 or (throw "app-linux-x64 not imported"));
  "app-linux-arm64-squashfs" = mkSqfs "app-linux-arm64" (stores.app-linux-arm64 or (throw "app-linux-arm64 not imported"));
  "app-mac-arm64-dmg" = mkDmg { name = "app-mac-arm64"; src = stores.app-mac-arm64 or (throw "app-mac-arm64 not imported"); };
  "app-win-x64-dir" = pkgs.runCommand "app-win-x64" { }
    "mkdir -p $out && cp -a ${stores.app-win-x64 or (throw "app-win-x64 not imported")}/. $out/";

  # the mac LAUNCHER dmg (hilbertraum.dmg): the ad-hoc-signed HilbertRaum.app packed by mkDmg
  # (volume "HilbertRaum" — the user mounts it, then double-clicks HilbertRaum.app). No sudo.
  "launcher-mac-arm64-dmg" = mkDmg { name = "hilbertraum-launcher-mac"; src = launcherMacApp; vol = "HilbertRaum"; };

  # the NixOS FHS helper closure as a SQUASHFS (mounted + bind/overlaid as /nix/store on
  # NixOS, no import), one per linux arch (bundle.sh picks the one matching target).
  "nixos-fhs-squashfs-x64" = mkClosureSqfs nixosFhsClosureInfo;
  "nixos-fhs-squashfs-arm64" = mkClosureSqfs nixosFhsArm64ClosureInfo;

  # Smoke proof: a pure derivation consuming every imported store path.
  stores-proof = pkgs.runCommand "stores-proof" { } ''
    mkdir -p $out
    echo "imported store paths consumed by nix:" > $out/report.txt
    ${lib.concatStringsSep "\n" (lib.mapAttrsToList (n: p: ''
      test -e ${p} || { echo "MISSING import ${n}"; exit 1; }
      echo "  ${n} -> ${p} ($(du -sh ${p} | cut -f1))" >> $out/report.txt
    '') stores)}
    cat $out/report.txt
  '';
}
# the prebuilt llama.cpp / whisper.cpp sidecar components (llamacpp-<target>-<ext>, …)
// runtimeComponents
# expose each import directly too (handy for `nix-build --impure nix/builds.nix -A <name>`)
// stores
