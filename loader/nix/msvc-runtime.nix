# Shared pin for the MSVC C++ redistributable runtime DLLs, extracted from the
# `msvc-runtime` PyPI wheel. The wheel just ships the redist DLLs (the cp311 tag is
# irrelevant — we take only the DLLs; they're version-agnostic), so a portable
# kiosk that can't assume the VC++ redist is installed can carry them itself.
#
# Three consumers, one pin:
#   - nix/runtime.nix: bundle the full C++ runtime into the python root so torch
#     loads (its torch_cpu/torch_python.dll link MSVCP140* — see runtime.nix).
#   - flake.nix (llmfit-win-x64): ship vcruntime140*.dll beside llmfit.exe. It's an
#     msvc-linked rust binary, so it dynamically links VCRUNTIME140.dll; on a machine
#     with no VC++ redist it dies with "VCRUNTIME140.dll was not found" before main().
#   - nix/builds.nix (llamacpp-windows-*-dir): upstream's win zips ship no C++
#     runtime; drop the redist DLLs beside llama-server.exe.
#
# Bump: pick a newer msvc_runtime wheel from PyPI, then update url + hash here.
{ pkgs }:
let
  wheel = pkgs.fetchurl {
    url = "https://files.pythonhosted.org/packages/ce/92/5a10262c2a489d5854f96d69e287923d6f720c4935dd26634deb7a5426e9/msvc_runtime-14.44.35112-cp311-cp311-win_amd64.whl";
    hash = "sha256-q6f75xiX0l7VP7t/OR6fUCiTeKipriGLoYUwxmNEg5E=";
  };
  # All redist DLLs (vcruntime140*, msvcp140*, concrt140, …) in one flat dir, ready
  # to drop next to an msvc-linked exe (or onto its DLL search path). The wheel
  # splits them across .data/data/ and .data/data/Scripts/ — and the critical
  # VCRUNTIME140.dll + VCRUNTIME140_1.dll live ONLY under Scripts/ — so collect
  # recursively and flatten (the one name in both dirs is the same file).
  dlls = pkgs.runCommand "msvc-runtime-dlls" { nativeBuildInputs = [ pkgs.unzip ]; } ''
    mkdir -p "$out" unpack
    unzip -q ${wheel} -d unpack
    find unpack -name '*.dll' -exec cp -f {} "$out/" \;
    [ -f "$out/vcruntime140.dll" ] || { echo "vcruntime140.dll missing from wheel" >&2; exit 1; }
  '';
in
{ inherit wheel dlls; }
