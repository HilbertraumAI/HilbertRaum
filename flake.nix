{
  description = "HilbertRaum dev shell — offline local-LLM Electron workspace";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      devShells = forAll (pkgs:
        let
          # Shared libs the npm-installed Electron binary needs at runtime on Linux.
          # ponytail: only loaded on Linux; macOS Electron ships self-contained.
          electronLibs = with pkgs; [
            glib nss nspr atk at-spi2-atk at-spi2-core cups dbus gtk3
            pango cairo gdk-pixbuf expat libxkbcommon mesa libgbm libdrm
            libglvnd alsa-lib systemd
            libx11 libxcomposite libxdamage libxext libxfixes libxrandr
            libxcb libxcursor libxi libxrender libxtst libxscrnsaver
          ];
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_22 pkgs.llama-cpp pkgs.whisper-cpp ]
              ++ pkgs.lib.optionals pkgs.stdenv.isLinux electronLibs;


            shellHook = ''
              export HILBERTRAUM_LLAMA_BIN="${pkgs.llama-cpp}/bin/llama-server"
              export HILBERTRAUM_WHISPER_BIN="${pkgs.whisper-cpp}/bin/whisper-cli"

              ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
                export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath electronLibs}:$LD_LIBRARY_PATH"
              ''}
              alias hr-install='npm install'
              alias hr-dev='npm run dev'
              alias hr-build='npm run build'
              alias hr-test='npm test'
              alias hr-check='npm run typecheck'
              alias hr-package='npm run package'
              echo "HilbertRaum dev shell — node $(node -v)"
              echo "engines: $(command -v llama-server) | $(command -v whisper-cli)"
              echo "aliases: hr-install hr-dev hr-build hr-test hr-check hr-package"
            '';
          };
        });
    };
}
