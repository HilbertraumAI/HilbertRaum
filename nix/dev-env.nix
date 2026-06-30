# Shared dev-leg definition: the package set + environment that make the build toolchain
# behave on NixOS. Consumed by BOTH the interactive `nix develop` shell and the bundled
# Docker image, so the container reproduces the devshell 1:1.
#
# App-only HilbertRaum: the toolchain builds the Electron app (node + electron-builder +
# @electron/packager), packs components (squashfs/dmg), and assembles the FAT32 image. No
# python/ollama/openwebui toolchain.
{ pkgs, lib }:
let
  buildTools = with pkgs; [
    # node (HilbertRaum requires >=22.5) + electron app packaging + tailwind (the app's own)
    nodejs_22
    tailwindcss_3
    # archive + fetch + json
    jq curl cacert zstd gnutar unzip gzip pigz git gnused coreutils which
    # electron-builder linux packaging helpers
    fakeroot dpkg fuse
    p7zip     # system 7za so electron-builder skips its non-NixOS bundled one
    patchelf  # repoint electron-builder's prebuilt helpers at the nix loader
    # cross-target packaging from NixOS
    rcodesign                 # Apple code signing from Linux (mac target)
    wineWowPackages.stable    # electron-builder's win step runs a 32-bit rcedit
    osslsigncode              # Authenticode signing for the windows .exe
    nsis                      # windows installer
    # build graph: ninja runs every step with dependency tracking (xtask emits build.ninja)
    ninja
    # USB image: FAT32 only (mtools, no root) — artifacts stay < 4 GiB
    mtools dosfstools zip
    # component images: squashfs (linux, mounted via bundled squashfuse) and HFS+ .dmg
    squashfsTools hfsprogs
    # VM test (ubuntu): qemu + cloud-utils fallback (incus is used from the host)
    qemu cloud-utils
    # NixOS launch test (make test-nixos runs the bundle headless under Xvfb)
    xvfb-run
    # push the devshell Docker image to a registry (make docker-push) without a docker daemon
    skopeo
  ];

  # Generic prebuilt binaries (electron-builder helpers; the bundled Electron) expect FHS
  # libs absent on NixOS. Exposed via NIX_LD (build helpers) and, for runtime children,
  # PLANAI_CHILD_LD_LIBRARY_PATH.
  ldLibs = with pkgs; [
    stdenv.cc.cc.lib            # libstdc++, libgcc_s, libgomp
    zlib glib fuse libGL
    libffi openssl expat bzip2 xz
    stdenv.cc.libc              # libm, libpthread, libdl, libc
  ];

  packages = buildTools;

  env = {
    # NOTE: we intentionally do NOT override Electron with nixpkgs' electron here. HilbertRaum
    # pins a specific Electron (37.x — it needs node:sqlite, ≥37), and electron-builder bundles
    # exactly the version installed in node_modules. Letting `npm ci` download the app's pinned
    # Electron at build time is build-only network (the packaged app stays fully offline) and
    # matches AI_Drive's own packaging model. (nixpkgs' electron is a different major.)
    PLAYWRIGHT_BROWSERS_PATH = "0";
    SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
    # Let electron-builder's prebuilt helpers run via the nix-ld stub.
    NIX_LD = lib.fileContents "${pkgs.stdenv.cc}/nix-support/dynamic-linker";
    NIX_LD_LIBRARY_PATH = lib.makeLibraryPath ldLibs;
    USE_SYSTEM_7ZA = "true";
    # marker the Makefile guards on (loader.toml [make].devshell_var)
    HILBERTRAUM_DEVSHELL = "1";
  };
in
{
  inherit buildTools ldLibs packages env;
}
