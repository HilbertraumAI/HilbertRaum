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
  flake = builtins.getFlake "git+file://${toString ../.}";
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
  appVersion = (builtins.fromJSON (builtins.readFile (flake.outPath + "/package.json"))).version;
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
# expose each import directly too (handy for `nix-build --impure nix/builds.nix -A <name>`)
// stores
