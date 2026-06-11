#requires -Version 5.1
<#
.SYNOPSIS
  Download + verify the llama.cpp sidecar binary onto a prepared drive (Phase 12).

.DESCRIPTION
  Reads model-manifests/runtime-sources.yaml (on the drive, falling back to the repo),
  picks the build matching the host OS/arch (or -Os/-Arch/-Backend overrides), downloads
  the release zip, SHA-256-verifies it, and extracts it into the build's extract_to dir
  (runtime/llama.cpp/<os>/ for the default build; runtime/llama.cpp/<os>/cpu/ for the
  pure-CPU safety net). After extraction a .paid-runtime.json install marker
  ({ version, backend, os, arch }) is written next to the binary.

  Mirrors apps/desktop/src/main/services/assets.ts (selectRuntimeBuild /
  planRuntimeDownload / runtimeInstallCurrent). Self-contained: needs no Node/npm.
  DEFAULT BACKEND = the FIRST build listed per OS in runtime-sources.yaml -- since
  Phase 14 that is the Vulkan full build on win/linux (contains every CPU backend;
  degrades to CPU on GPU-less machines) and Metal on mac. -Backend cpu fetches the
  pure-CPU safety net into <os>/cpu/.

  Verify-before-trust: a real-hash MISMATCH deletes the zip and exits non-zero. A
  placeholder zip hash extracts but reports UNVERIFIED. Idempotent via the MARKER, not
  mere binary presence: a present llama-server[.exe] whose .paid-runtime.json matches the
  selected version + backend is skipped; a missing/stale marker re-fetches (so upgrading
  a CPU-era drive to the Vulkan default actually replaces the build).

.PARAMETER Target
  The prepared drive root (e.g. E:\). Required.

.PARAMETER Os
  Override the host OS (win/mac/linux).

.PARAMETER Arch
  Override the host arch (x64/arm64).

.PARAMETER Backend
  Override the backend (e.g. cpu, vulkan, metal) -- default is the first build listed
  for the os/arch (vulkan on win/linux, metal on mac). -Backend cpu fetches the pure-CPU
  safety net into runtime/llama.cpp/<os>/cpu/.

.PARAMETER Family
  Which sidecar family to fetch from runtime-sources.yaml (Phase 36): llama_cpp
  (default; the llama-server binary) or whisper_cpp (the whisper-cli transcriber,
  extracted to runtime/whisper.cpp/<os>/). Same verify + marker logic for both.

.PARAMETER DryRun
  Print the plan and download nothing.

.EXAMPLE
  .\scripts\fetch-runtime.ps1 -Target E:\
  .\scripts\fetch-runtime.ps1 -Target E:\ -Os linux -Arch x64 -DryRun
  .\scripts\fetch-runtime.ps1 -Target E:\ -Family whisper_cpp
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [string] $Os,
  [string] $Arch,
  [string] $Backend,
  [ValidateSet('llama_cpp', 'whisper_cpp')] [string] $Family = 'llama_cpp',
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Normalize -Target to a full path: curl.exe resolves relative paths against the PROCESS
# working directory, which does not follow Set-Location (audit M22).
if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
$Target = [System.IO.Path]::GetFullPath($Target)

$SourcesFile = Join-Path $Target 'model-manifests/runtime-sources.yaml'
if (-not (Test-Path $SourcesFile)) { $SourcesFile = Join-Path $RepoRoot 'model-manifests/runtime-sources.yaml' }
if (-not (Test-Path $SourcesFile)) {
  Write-Error "No runtime-sources.yaml found under '$Target' or repo root."
  exit 2
}

# Host detection (PS 5.1 is always Windows; $IsWindows exists only on PS Core).
# When -Os is explicitly overridden but -Arch is not, we are cross-provisioning another
# OS's dir -- the host arch is meaningless there, so we take that OS's first build instead.
$OsExplicit = [bool]$Os
$ArchExplicit = [bool]$Arch
if (-not $Os) {
  if ($PSVersionTable.PSVersion.Major -ge 6) {
    $Os = if ($IsWindows) { 'win' } elseif ($IsMacOS) { 'mac' } else { 'linux' }
  } else { $Os = 'win' }
}
if (-not $Arch) {
  # PROCESSOR_ARCHITECTURE reports the (possibly emulated) PROCESS arch -- an x64
  # PowerShell on ARM64 Windows says AMD64. PROCESSOR_ARCHITEW6432 reveals the real OS
  # arch under WOW emulation.
  $procArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $Arch = if ($procArch -match 'ARM64') { 'arm64' } else { 'x64' }
}

# --- Parse runtime-sources.yaml: a list of build maps under <family>.builds: --------
# BLOCK-AWARE since Phase 36: the file holds TWO top-level families (llama_cpp +
# whisper_cpp) with the same shape -- only the selected -Family's version/builds are
# collected, so the whisper builds can never leak into a llama selection or vice versa.
$lines = (Get-Content -Path $SourcesFile) -split "`n"
$version = $null
$builds = @()
$current = $null
$topKey = $null
foreach ($raw in $lines) {
  $line = $raw.TrimEnd()
  if ($line -match '^\s*#') { continue }
  # A non-indented `key:` line starts a new top-level family block.
  if ($line -match '^([A-Za-z0-9_]+)\s*:\s*$') {
    if ($current) { $builds += $current; $current = $null }
    $topKey = $Matches[1]
    continue
  }
  if ($topKey -ne $Family) { continue }
  # Strip inline YAML comments (whitespace + '#' + rest) before unquoting (M17) -- the
  # committed `version: b9196   # PLACEHOLDER ...` used to leak the comment into the value.
  if (-not $version -and $line -match '^\s*version\s*:\s*(.+?)\s*$') {
    $version = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'"); continue
  }
  if ($line -match '^\s*-\s*os\s*:\s*(.+?)\s*$') {
    if ($current) { $builds += $current }
    $current = [ordered]@{ os = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'") }
    continue
  }
  if ($current -and $line -match '^\s+([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$') {
    $current[$Matches[1].Trim()] = ($Matches[2] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
  }
}
if ($current) { $builds += $current }

if (-not $version) { Write-Error "runtime-sources.yaml: missing $Family.version (is the $Family block present?)"; exit 2 }

# --- Select the build (os + arch [+ backend]); default = first os/arch match
# (vulkan on win/linux, metal on mac since Phase 14).
# Explicit -Os without -Arch = cross-provisioning: take that OS's first build (any arch).
if ($OsExplicit -and -not $ArchExplicit) {
  $candidates = $builds | Where-Object { $_.os -eq $Os }
} else {
  $candidates = $builds | Where-Object { $_.os -eq $Os -and $_.arch -eq $Arch }
}
if ($Backend) { $candidates = $candidates | Where-Object { $_.backend -eq $Backend } }
$build = $candidates | Select-Object -First 1

if (-not $build) {
  Write-Error "No runtime build for os=$Os arch=$Arch$(if ($Backend) { " backend=$Backend" }). Try -Os/-Arch/-Backend overrides."
  exit 2
}

# A selected build must carry every field the plan needs; a silent miss here would
# disable verification forever (the audited C1 bug), so fail loudly instead.
foreach ($required in @('url', 'sha256', 'extract_to')) {
  if (-not $build[$required]) {
    Write-Error "runtime-sources.yaml: selected build ($Os/$Arch) is missing '$required'."
    exit 2
  }
}

# Escape guard (M18): runtime-sources.yaml on the DRIVE is user-writable; a tampered
# extract_to must not be able to write outside the drive root (TS planRuntimeDownload
# already rejects this -- mirror it).
if ($build.extract_to -match '\.\.' -or $build.extract_to -match '^[/\\]' -or $build.extract_to -match '^[A-Za-z]:') {
  Write-Error "runtime-sources.yaml: extract_to escapes the drive root: $($build.extract_to)"
  exit 2
}

$IsRealSha = { param($h) $h -match '^[a-f0-9]{64}$' }
$extractTo = Join-Path $Target ($build.extract_to -replace '/', [IO.Path]::DirectorySeparatorChar)
# Binary name follows the FAMILY + the SELECTED build's OS (we may be provisioning the
# mac/linux dir from a Windows build machine), mirroring assets.ts sidecarBinaryName.
$binaryBase = if ($Family -eq 'whisper_cpp') { 'whisper-cli' } else { 'llama-server' }
$binaryName = if ($build.os -eq 'win') { "$binaryBase.exe" } else { $binaryBase }
$binaryPath = Join-Path $extractTo $binaryName
$markerPath = Join-Path $extractTo '.paid-runtime.json'
$sha = ([string]$build.sha256).ToLower()

Write-Host "Fetch runtime -> $Target" -ForegroundColor Cyan
Write-Host ("  build: {0}/{1} {2} @ {3}" -f $build.os, $build.arch, $build.backend, $version)
Write-Host ("  url:   {0}" -f $build.url)
Write-Host ("  into:  {0}" -f $extractTo)
if ($DryRun) { Write-Host '(dry run -- nothing will be downloaded)' -ForegroundColor Yellow; exit 0 }

# Idempotent skip is MARKER-based (Phase 14, mirrors assets.ts runtimeInstallCurrent):
# "binary exists" alone would silently keep a CPU-era build in place after the default
# became vulkan. Skip only when .paid-runtime.json matches the selected version+backend.
if (Test-Path $binaryPath) {
  $skip = $false
  if (Test-Path $markerPath) {
    try {
      $marker = Get-Content -Path $markerPath -Raw | ConvertFrom-Json
      if ($marker.version -eq $version -and $marker.backend -eq $build.backend) { $skip = $true }
    } catch { $skip = $false }
  }
  if ($skip) {
    Write-Host "  skip ($binaryName already installed: $version/$($build.backend) per .paid-runtime.json)" -ForegroundColor Green
    exit 0
  }
  Write-Host "  $binaryName present but install marker is missing or differs -- re-fetching $version/$($build.backend)" -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force -Path $extractTo | Out-Null
# Archive name from the URL basename so a .tar.gz (the macOS/Linux release format) is
# not saved -- and mis-extracted -- as a .zip.
$archiveName = [System.IO.Path]::GetFileName(([uri]$build.url).AbsolutePath)
if (-not $archiveName) { $archiveName = "{0}-{1}-{2}-{3}.zip" -f $binaryBase, $version, $build.os, $build.arch }
$archive = Join-Path $extractTo $archiveName

$Curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)
if ($Curl) {
  # --ssl-revoke-best-effort: corporate TLS proxies often block the CRL/OCSP endpoints,
  # making schannel fail with CRYPT_E_NO_REVOCATION_CHECK. Best-effort still checks
  # revocation when reachable; artifact integrity is enforced by the SHA-256 pin below.
  & curl.exe -L --fail --retry 3 --ssl-revoke-best-effort -C - -o "$archive" "$($build.url)"
  if ($LASTEXITCODE -ne 0) { Write-Error "curl failed (exit $LASTEXITCODE)"; exit 1 }
} else {
  Invoke-WebRequest -Uri $build.url -OutFile $archive -UseBasicParsing
}

if (& $IsRealSha $sha) {
  $actual = (Get-FileHash -Path $archive -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $sha) {
    Write-Host ("  FAIL: archive checksum mismatch (expected {0}, got {1}) -- deleting" -f $sha, $actual) -ForegroundColor Red
    Remove-Item -Force -Path $archive -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host "  archive VERIFIED" -ForegroundColor Green
} else {
  Write-Host "  archive UNVERIFIED (placeholder hash) -- verify after a real release bump" -ForegroundColor Yellow
}

# Remove the previous install (if any) BEFORE extracting. Extraction over an existing
# build must never mix files from two builds -- and on the nesting mac/linux tarballs a
# stale root llama-server would satisfy the flatten guard below, leaving the OLD binary
# in place while a fresh marker claims the new build (audit fix: the cpu->vulkan upgrade
# path). The cpu/ safety net and the just-downloaded archive survive; the stale marker
# dies with the old build, so a failed extraction cannot leave a lying marker behind.
Get-ChildItem -Path $extractTo -Force |
  Where-Object { $_.Name -ne $archiveName -and $_.Name -ne 'cpu' } |
  Remove-Item -Recurse -Force

if ($archiveName -match '\.(tar\.gz|tgz)$') {
  # bsdtar (tar.exe) ships with Windows 10 1803+ and handles .tar.gz natively.
  # NOTE: EAP must be Continue around native stderr redirects (PS 5.1 wraps redirected
  # stderr in error records, which would terminate under 'Stop').
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & tar -xzf "$archive" -C "$extractTo" 2>$null
  $tarExit = $LASTEXITCODE
  $listing = & tar -tvzf "$archive" 2>$null
  $ErrorActionPreference = $prevEap

  # The llama.cpp tarballs contain version SYMLINKS (lib*.so -> lib*.so.X.Y.Z), which
  # cannot be created on Windows (or on an exFAT drive at all). Materialize each missing
  # link as a COPY of its target -- the dynamic loader only needs the name to exist.
  # Multi-pass, because links can chain (libllama.so -> libllama.so.0 -> ...0.14.0).
  $links = @()
  foreach ($line in @($listing)) {
    if ($line -match '^l' -and $line -match '\s(\S+)\s->\s(\S+)\s*$') {
      $links += , @($Matches[1], $Matches[2])
    }
  }
  $unresolved = 0
  for ($pass = 0; $pass -lt 4; $pass++) {
    $unresolved = 0
    foreach ($l in $links) {
      $lnkPath = Join-Path $extractTo ($l[0] -replace '/', [IO.Path]::DirectorySeparatorChar)
      if (Test-Path $lnkPath) { continue }
      $srcPath = Join-Path (Split-Path -Parent $lnkPath) $l[1]
      if (Test-Path $srcPath) { Copy-Item -Force -Path $srcPath -Destination $lnkPath }
      else { $unresolved++ }
    }
    if ($unresolved -eq 0) { break }
  }
  if ($tarExit -ne 0 -and $unresolved -gt 0) {
    Write-Error "tar extraction failed (exit $tarExit; $unresolved unresolved entries)"
    exit 1
  }
} else {
  Expand-Archive -Path $archive -DestinationPath $extractTo -Force
}
Remove-Item -Force -Path $archive -ErrorAction SilentlyContinue

# Flatten: the macOS/Linux tarballs nest everything under llama-<tag>/ -- move the
# binary's directory contents up so llama-server sits at the extract_to root, where
# services/runtime/sidecar.ts resolves it.
if (-not (Test-Path $binaryPath)) {
  $rootFull = [System.IO.Path]::GetFullPath($extractTo).TrimEnd('\', '/')
  # Exclude the cpu/ safety-net subdir from the search: when the DEFAULT build is being
  # (re)fetched into <os>/ and <os>/cpu/ already holds its own llama-server, the flatten
  # must not mistake the safety net for the freshly extracted nested binary.
  $cpuSubdir = Join-Path $rootFull 'cpu'
  $found = Get-ChildItem -Path $extractTo -Recurse -File -Filter $binaryName -ErrorAction SilentlyContinue |
    Where-Object { -not $_.FullName.StartsWith($cpuSubdir + [IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1
  if ($found) {
    $srcFull = [System.IO.Path]::GetFullPath($found.DirectoryName).TrimEnd('\', '/')
    if ($srcFull -ne $rootFull) {
      Get-ChildItem -Path $found.DirectoryName -Force | Move-Item -Destination $extractTo -Force
      # Clean up the now-empty nesting dirs (deepest first).
      Get-ChildItem -Path $extractTo -Recurse -Directory -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Where-Object { -not (Get-ChildItem -Path $_.FullName -Force -ErrorAction SilentlyContinue) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    }
  }
}

if (Test-Path $binaryPath) {
  # Record exactly which build is installed (UTF-8 without BOM -- PS 5.1 Set-Content
  # would prepend one and break Node's JSON.parse). Mirrors assets.ts writeRuntimeMarker.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $markerJson = '{"version":"' + $version + '","backend":"' + $build.backend + '","os":"' + $build.os + '","arch":"' + $build.arch + '"}'
  [System.IO.File]::WriteAllText($markerPath, $markerJson, $utf8NoBom)
  Write-Host "  extracted $binaryName (+ .paid-runtime.json install marker)" -ForegroundColor Green
  if ($build.os -ne 'win') {
    Write-Host "  NOTE: exec bit for $binaryName cannot be set from Windows; exFAT mounts are typically all-executable, otherwise chmod +x it on the target OS." -ForegroundColor Yellow
  }
  exit 0
}
Write-Host "  FAIL: $binaryName not found under $extractTo after extraction -- the release archive layout may have changed." -ForegroundColor Red
exit 1
