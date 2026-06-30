{
  description = "HilbertRaum — portable offline local-LLM Electron workspace, packaged with the loader";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # rust toolchain with cross-target std (for the native launcher, cross-built
    # win/mac from NixOS via cargo-zigbuild). Pattern from plan-ai/mac-mgmt.
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Include git submodules in the flake source: the launcher builds against the
    # loader submodule (third_party/loader/crates/*). Pinned by commit.
    self.submodules = true;
  };

  # Thin entrypoint. The project-agnostic build engine, nix lib and scripts live in the
  # loader submodule (third_party/loader); this flake only builds the HilbertRaum-specific
  # bits: the native launcher (+ splash spinner), the NixOS FHS helper, the Electron app
  # component packers (nix/builds.nix), and a packaging devshell.
  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; overlays = [ (import rust-overlay) ]; };
        lib = pkgs.lib;
        loaderToml = builtins.fromTOML (builtins.readFile ./loader.toml);

        # The shared loader nix library — toolchains, the spinner cross-builder, the FHS
        # helper, component packers, devshell base, xtask, libdmg. Consumed directly from
        # the submodule (self.submodules brings its tree into the flake source).
        loaderLib = import ./third_party/loader/nix/loader { inherit pkgs; nixpkgs = nixpkgs; };

        # cross-target rust toolchain (win/mac/linux gnu+musl) + the Apple SDK source for
        # the mac cross leg — both owned by the loader, single source of truth.
        rustToolchain = loaderLib.rustToolchain;
        macosx-sdk = loaderLib.macosx-sdk;

        # the launcher crate (the whole dir is the source — no spa).
        launcherSrc = ./launcher;
        # registry deps for the launcher's Cargo.lock (clap, tokio, axum, loader-core's
        # reqwest/rustls/…), vendored offline.
        launcherVendor = pkgs.rustPlatform.importCargoLock {
          lockFile = ./launcher/Cargo.lock;
        };

        # The splash spinner cross-builder. The crate, its Cargo.lock, the cross toolchain,
        # the macOS SDK and the macho-dedupe fixup all live in the loader; we only feed it
        # this product's loader.toml [spinner] brand colours.
        spinnerFor = loaderLib.mkSpinner { inherit loaderToml; };

        # native launcher cross-compiled via cargo-zigbuild. It depends only on loader-core
        # (+ clap/tokio/axum), so the build vendors crates.io (launcherVendor) and copies the
        # loader crates beside src/. The matching-target spinner is embedded via build.rs of
        # loader-splash (PLANAI_SPINNER_BIN); the linux launcher also embeds squashfuse +
        # bubblewrap (mount + NixOS FHS namespace) — all from loader-core's build.rs.
        launcherFor = { zigTarget, outDir }:
          let
            spinnerPkg =
              if lib.hasInfix "windows" zigTarget then
                spinnerFor { zigTarget = "x86_64-pc-windows-gnu"; outDir = "x86_64-pc-windows-gnu"; }
              else if lib.hasInfix "apple-darwin" zigTarget then
                spinnerFor { zigTarget = "aarch64-apple-darwin"; outDir = "aarch64-apple-darwin"; }
              else if lib.hasInfix "aarch64" zigTarget then
                spinnerFor { zigTarget = "aarch64-unknown-linux-gnu"; outDir = "aarch64-unknown-linux-gnu"; }
              else if lib.hasInfix "x86_64" zigTarget then
                spinnerFor { zigTarget = "x86_64-unknown-linux-gnu"; outDir = "x86_64-unknown-linux-gnu"; }
              else
                throw "launcherFor: no spinner mapping for zigTarget '${zigTarget}'";
            spinnerBin = "${spinnerPkg}/${if lib.hasInfix "windows" zigTarget then "plan-ai-spinner.exe" else "plan-ai-spinner"}";
          in
          pkgs.runCommand "hilbertraum-launcher-${outDir}"
            ({
              nativeBuildInputs = [ rustToolchain pkgs.cargo-zigbuild pkgs.zig ]
                ++ lib.optionals (lib.hasInfix "apple-darwin" zigTarget) [ pkgs.python3 pkgs.rcodesign ];
              # loader-core's build.rs embeds these into the linux launcher (mounts squashfs
              # itself, like the AppImage runtime); ignored for win/mac targets.
              PLANAI_SQUASHFUSE_LL = "${pkgs.pkgsStatic.squashfuse}/bin/squashfuse_ll";
              PLANAI_UNSQUASHFS = "${pkgs.pkgsStatic.squashfsTools}/bin/unsquashfs";
              # the splash spinner, embedded into the launcher for every target.
              PLANAI_SPINNER_BIN = spinnerBin;
              # the product id baked into loader-manifest (loader.toml [manifest].product).
              PLANAI_PRODUCT = loaderToml.manifest.product or "";
              # the optional-feature catalog (none for app-only HilbertRaum → empty).
              PLANAI_FEATURES = builtins.concatStringsSep " "
                (map (f: "${f.name}=${if (f.default or false) then "1" else "0"}") (loaderToml.feature or [ ]));
              # the fallback update URL baked into loader-manifest's DEFAULT_UPDATE_URL (used
              # only when a drive has no local manifest) — sourced from loader.toml, never hardcoded.
              PLANAI_UPDATE_URL = loaderToml.manifest.update_url or "";
            } // lib.optionalAttrs (lib.hasInfix "linux" zigTarget) {
              # Static bubblewrap, embedded into the linux launcher: on NixOS it sets up the
              # outer namespace that binds/overlays the FHS-closure squashfs over /nix/store,
              # then runs the buildFHSEnv wrapper inside it.
              PLANAI_BWRAP_BIN = "${pkgs.pkgsStatic.bubblewrap}/bin/bwrap";
            } // lib.optionalAttrs (lib.hasInfix "apple-darwin" zigTarget) {
              SDKROOT = macosx-sdk;
            })
            ''
              export HOME="$TMPDIR" CARGO_HOME="$TMPDIR/cargo" XDG_CACHE_HOME="$TMPDIR/cache"
              # the loader crates copied as siblings of src/ so Cargo's relative path dep
              # (../third_party/loader/crates/loader-core) resolves.
              mkdir -p third_party/loader/crates
              cp -r ${./third_party/loader/crates/loader-core} third_party/loader/crates/loader-core
              cp -r ${./third_party/loader/crates/loader-manifest} third_party/loader/crates/loader-manifest
              cp -r ${./third_party/loader/crates/loader-splash} third_party/loader/crates/loader-splash
              chmod -R u+w third_party
              cp -r ${launcherSrc}/. src && chmod -R u+w src && cd src
              mkdir -p .cargo
              printf '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "%s"\n' "${launcherVendor}" > .cargo/config.toml
              cargo zigbuild --release --offline --target ${zigTarget}
              mkdir -p "$out"
              for b in hilbertraum hilbertraum.exe; do
                if [ -f "target/${outDir}/release/$b" ]; then cp "target/${outDir}/release/$b" "$out/"; fi
              done
              ${lib.optionalString (lib.hasInfix "apple-darwin" zigTarget) ''
                chmod +w "$out/hilbertraum"
                python3 ${loaderLib.machoDedupe} "$out/hilbertraum"
                rcodesign sign "$out/hilbertraum" "$out/hilbertraum"
              ''}
            '';

        # NixOS FHS helper. NixOS's bare nix-ld stub can't run a generic-glibc FHS binary
        # (the bundled Electron). buildFHSEnv gives a bubblewrap sandbox with the GUI/runtime
        # libs under an FHS layout; the static-musl launcher mounts this closure (a squashfs)
        # and re-execs inside the wrapper. The package set is DATA from loader.toml [fhs].
        mkNixosFhs = fhsSystem: loaderLib.mkNixosFhs {
          system = fhsSystem;
          name = loaderToml.fhs.name;
          runScript = loaderToml.fhs.run_script;
          targetPkgNames = loaderToml.fhs.target_pkgs;
        };
        nixosFhs = mkNixosFhs "x86_64-linux";
        nixosFhs-arm64 = mkNixosFhs "aarch64-linux";

        # Packaging dev environment (nix/dev-env.nix): node + electron-builder + squashfs +
        # the FAT32 image tooling. Plus the local-LLM engines so the app's own `npm run dev`
        # still works from this shell.
        devEnv = import ./nix/dev-env.nix { inherit pkgs lib; };
        projectShellHook = ''
          export HILBERTRAUM_LLAMA_BIN="${pkgs.llama-cpp}/bin/llama-server"
          export HILBERTRAUM_WHISPER_BIN="${pkgs.whisper-cpp}/bin/whisper-cli"
          if [ -f .gitmodules ]; then
            [ -e third_party/loader/crates/loader-core/Cargo.toml ] || \
              echo "==> third_party/loader submodule missing — run: git submodule update --init"
          fi
          echo "HilbertRaum loader devshell — node $(node -v 2>/dev/null)"
          echo "build: nix build .#launcher-win-x64   (or make image PLATFORMS=linux-x64)"
        '';
      in {
        packages = {
          inherit nixosFhs nixosFhs-arm64 macosx-sdk;
          xtask = loaderLib.xtask;
          libdmg-hfsplus = loaderLib.libdmg-hfsplus;
          # native launcher per target (cargo-zigbuild). linux is STATIC musl → runs on any
          # linux incl. NixOS (it FHS-reexecs there); win/mac are cross-built.
          launcher-linux-x64 = launcherFor { zigTarget = "x86_64-unknown-linux-musl"; outDir = "x86_64-unknown-linux-musl"; };
          launcher-linux-arm64 = launcherFor { zigTarget = "aarch64-unknown-linux-musl"; outDir = "aarch64-unknown-linux-musl"; };
          launcher-win-x64 = launcherFor { zigTarget = "x86_64-pc-windows-gnu"; outDir = "x86_64-pc-windows-gnu"; };
          launcher-mac-arm64 = launcherFor { zigTarget = "aarch64-apple-darwin"; outDir = "aarch64-apple-darwin"; };
        };
        devShells.default = loaderLib.mkDevShell {
          packages = devEnv.packages ++ [ pkgs.llama-cpp pkgs.whisper-cpp ];
          env = devEnv.env;
          shellHook = projectShellHook;
        };
      });
}
