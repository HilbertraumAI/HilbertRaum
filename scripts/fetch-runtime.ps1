#requires -Version 5.1
<#
.SYNOPSIS
  Download + verify the llama.cpp sidecar binary onto a prepared drive (Phase 12).

.DESCRIPTION
  Reads model-manifests/runtime-sources.yaml (on the drive, falling back to the repo),
  picks the build matching the host OS/arch (or -Os/-Arch/-Backend overrides), downloads
  the release zip, SHA-256-verifies it, and extracts it into the build's extract_to dir
  (runtime/llama.cpp/<os>/ for the default build; runtime/llama.cpp/<os>/cpu/ for the
  pure-CPU safety net). After extraction a .hilbertraum-runtime.json install marker
  ({ version, backend, os, arch }) is written next to the binary.

  Mirrors apps/desktop/src/main/services/assets.ts (selectRuntimeBuild /
  planRuntimeDownload / runtimeInstallCurrent). Self-contained: needs no Node/npm.
  DEFAULT BACKEND = the FIRST build listed per OS in runtime-sources.yaml -- since
  Phase 14 that is the Vulkan full build on win/linux (contains every CPU backend;
  degrades to CPU on GPU-less machines) and Metal on mac. -Backend cpu fetches the
  pure-CPU safety net into <os>/cpu/.

  Verify-before-trust: a real-hash MISMATCH deletes the zip and exits non-zero. A
  placeholder zip hash extracts but reports UNVERIFIED. Idempotent via the MARKER, not
  mere binary presence: a present llama-server[.exe] whose .hilbertraum-runtime.json matches the
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
  Which asset family to fetch from runtime-sources.yaml: llama_cpp (default; the
  llama-server binary), whisper_cpp (the whisper-cli transcriber, Phase 36 -- same
  verify + marker logic), or ocr (Phase 38: the vendored OCR language files, plain
  sha256-verified downloads into ocr/ -- no extraction, no marker; idempotency IS the
  hash).

.PARAMETER DryRun
  Print the plan and download nothing.

.EXAMPLE
  .\scripts\fetch-runtime.ps1 -Target E:\
  .\scripts\fetch-runtime.ps1 -Target E:\ -Os linux -Arch x64 -DryRun
  .\scripts\fetch-runtime.ps1 -Target E:\ -Family whisper_cpp
  .\scripts\fetch-runtime.ps1 -Target E:\ -Family ocr
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Target,
  [string] $Os,
  [string] $Arch,
  [string] $Backend,
  [ValidateSet('llama_cpp', 'whisper_cpp', 'ocr')] [string] $Family = 'llama_cpp',
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# FAILURE REPORTING (AUD-05): every failure below is announced with
# `Write-Host -ForegroundColor Red` plus an explicit `exit`, never with `Write-Error`.
# Under $ErrorActionPreference = 'Stop' a Write-Error is promoted to a SCRIPT-TERMINATING
# exception, which has three consequences that silently break this script's control flow:
#   1. nothing after it on the same line runs -- `Write-Error ...; $failed++; continue`
#      does not continue, it aborts the whole loop at the FIRST failure;
#   2. a following `exit 2` never executes, so the process exits 1 and the documented
#      config-error code collapses into the download-failure code;
#   3. the exception propagates OUT through the `&` call of a parent script (prepare-drive)
#      and kills it before it can inspect $LASTEXITCODE, so a step the parent treats as
#      best-effort becomes fatal and the steps after it never run.
# Write-Host has none of those effects: the message is printed and control flow, exit codes
# and the parent's error handling stay exactly as written.

# Resilient download: a flaky link (beta-tester report — the connection dropped mid-curl)
# can fail repeatedly. curl's own --retry does NOT cover a mid-transfer DROP (exit 18/56/28)
# on older curl, so we wrap it in an OUTER loop that RESUMES the partial file (-C -) on each
# attempt. Combined flags: --retry 3 (transient HTTP), --retry-delay 2, --retry-connrefused
# (curl >=7.52, on Win10 1803+), --connect-timeout 30. --ssl-revoke-best-effort: schannel
# curl on Windows; corporate proxies block CRL/OCSP. Integrity is enforced by the SHA-256
# pin AFTER download, so resume can never weaken verification.
function Invoke-CurlResilient {
  param([Parameter(Mandatory = $true)] [string] $Url,
        [Parameter(Mandatory = $true)] [string] $Dest)
  $attempts = 5
  for ($i = 1; $i -le $attempts; $i++) {
    & curl.exe -L --fail --retry 3 --retry-delay 2 --retry-connrefused `
      --connect-timeout 30 --ssl-revoke-best-effort -C - -o "$Dest" "$Url"
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($i -lt $attempts) {
      $wait = $i * 3
      Write-Host ("    connection interrupted (curl exit {0}) -- retry {1}/{2} in {3}s, resuming…" -f $LASTEXITCODE, $i, $attempts, $wait) -ForegroundColor Yellow
      Start-Sleep -Seconds $wait
    }
  }
  return $false
}

# Normalize -Target to a full path: curl.exe resolves relative paths against the PROCESS
# working directory, which does not follow Set-Location (audit M22).
if (-not [System.IO.Path]::IsPathRooted($Target)) { $Target = Join-Path (Get-Location).Path $Target }
$Target = [System.IO.Path]::GetFullPath($Target)

$SourcesFile = Join-Path $Target 'model-manifests/runtime-sources.yaml'
if (-not (Test-Path $SourcesFile)) { $SourcesFile = Join-Path $RepoRoot 'model-manifests/runtime-sources.yaml' }
if (-not (Test-Path $SourcesFile)) {
  Write-Host "No runtime-sources.yaml found under '$Target' or repo root." -ForegroundColor Red
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

# --- The ocr family (Phase 38, D32): plain verified FILES, not build archives -------
# Parses `ocr.files` (- lang/url/sha256/dest entries), downloads each into its dest,
# verifies the sha256 of the file AS DOWNLOADED, and skips files already present with a
# matching hash. Mirrors assets.ts planOcrDownloads.
if ($Family -eq 'ocr') {
  $lines = (Get-Content -Path $SourcesFile) -split "`n"
  $ocrVersion = $null
  $files = @()
  $cur = $null
  $top = $null
  foreach ($raw in $lines) {
    $line = $raw.TrimEnd()
    if ($line -match '^\s*#') { continue }
    if ($line -match '^([A-Za-z0-9_]+)\s*:\s*$') {
      if ($cur) { $files += $cur; $cur = $null }
      $top = $Matches[1]
      continue
    }
    if ($top -ne 'ocr') { continue }
    if (-not $ocrVersion -and $line -match '^\s*version\s*:\s*(.+?)\s*$') {
      $ocrVersion = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'"); continue
    }
    if ($line -match '^\s*-\s*lang\s*:\s*(.+?)\s*$') {
      if ($cur) { $files += $cur }
      $cur = [ordered]@{ lang = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'") }
      continue
    }
    if ($cur -and $line -match '^\s+([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$') {
      $cur[$Matches[1].Trim()] = ($Matches[2] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
    }
  }
  if ($cur) { $files += $cur }
  if (-not $ocrVersion -or $files.Count -eq 0) {
    Write-Host 'runtime-sources.yaml: no ocr block (version + files) found.' -ForegroundColor Red
    exit 2
  }
  Write-Host "Fetch OCR language files -> $Target (data $ocrVersion)" -ForegroundColor Cyan
  $IsRealShaOcr = { param($h) $h -match '^[a-f0-9]{64}$' }
  $failed = 0
  foreach ($f in $files) {
    foreach ($required in @('url', 'sha256', 'dest')) {
      if (-not $f[$required]) { Write-Host "ocr.files ($($f.lang)): missing '$required'." -ForegroundColor Red; exit 2 }
    }
    if ($f.dest -match '\.\.' -or $f.dest -match '^[/\\]' -or $f.dest -match '^[A-Za-z]:') {
      Write-Host "runtime-sources.yaml: ocr dest escapes the drive root: $($f.dest)" -ForegroundColor Red
      exit 2
    }
    $dest = Join-Path $Target ($f.dest -replace '/', [IO.Path]::DirectorySeparatorChar)
    $sha = ([string]$f.sha256).ToLower()
    Write-Host ("  {0}: {1}" -f $f.lang, $f.dest)
    if ($DryRun) { Write-Host ("    would fetch {0}" -f $f.url) -ForegroundColor Yellow; continue }
    if ((Test-Path $dest) -and (& $IsRealShaOcr $sha)) {
      $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower()
      if ($actual -eq $sha) { Write-Host '    skip (present + verified)' -ForegroundColor Green; continue }
      Write-Host '    present but hash differs -- re-fetching' -ForegroundColor Yellow
      # DELETE the bad file first (AUD-24). The download below resumes at the end of whatever
      # is already on disk (curl -C -), so re-fetching ONTO a complete-but-wrong file asks the
      # server for a byte range that starts at or past the resource's length -- an
      # unsatisfiable range (HTTP 416), which fails every retry instead of replacing the file.
      # Starting from an empty destination makes the repair attempt an actual repair.
      # UNCONDITIONAL here, unlike fetch-models, and deliberately so -- do not "harmonize" the
      # two: fetch-models guards the same delete behind a size test because it must preserve
      # cross-run resume of multi-GB weights, and its manifests carry a size_bytes to test
      # against. These OCR language files are a few MB, runtime-sources.yaml records no size
      # for them, and re-fetching one costs nothing -- so there is no partial worth saving and
      # no field to distinguish one with.
      Remove-Item -Force -Path $dest -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    $Curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)
    if ($Curl) {
      if (-not (Invoke-CurlResilient -Url $f.url -Dest $dest)) {
        Write-Host '    download failed after retries' -ForegroundColor Red; $failed++; continue
      }
    } else {
      # Same warn-and-continue contract as the curl branch: a failing Invoke-WebRequest is a
      # terminating error under $ErrorActionPreference = 'Stop', which would abort the whole
      # batch at the first bad file instead of attempting the rest (AUD-05).
      try {
        Invoke-WebRequest -Uri $f.url -OutFile $dest -UseBasicParsing
      } catch {
        Write-Host ("    download failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
        $failed++
        continue
      }
    }
    if (& $IsRealShaOcr $sha) {
      $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower()
      if ($actual -ne $sha) {
        Write-Host ("    FAIL: checksum mismatch (expected {0}, got {1}) -- deleting" -f $sha, $actual) -ForegroundColor Red
        Remove-Item -Force -Path $dest -ErrorAction SilentlyContinue
        $failed++
        continue
      }
      Write-Host '    VERIFIED' -ForegroundColor Green
    } else {
      Write-Host '    UNVERIFIED (placeholder hash)' -ForegroundColor Yellow
    }
  }
  if ($failed -gt 0) { exit 1 }
  exit 0
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

if (-not $version) { Write-Host "runtime-sources.yaml: missing $Family.version (is the $Family block present?)" -ForegroundColor Red; exit 2 }

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
  Write-Host "No runtime build for os=$Os arch=$Arch$(if ($Backend) { " backend=$Backend" }). Try -Os/-Arch/-Backend overrides." -ForegroundColor Red
  exit 2
}

# A selected build must carry every field the plan needs; a silent miss here would
# disable verification forever (the audited C1 bug), so fail loudly instead.
foreach ($required in @('url', 'sha256', 'extract_to')) {
  if (-not $build[$required]) {
    Write-Host "runtime-sources.yaml: selected build ($Os/$Arch) is missing '$required'." -ForegroundColor Red
    exit 2
  }
}

# Escape guard (M18): runtime-sources.yaml on the DRIVE is user-writable; a tampered
# extract_to must not be able to write outside the drive root (TS planRuntimeDownload
# already rejects this -- mirror it).
if ($build.extract_to -match '\.\.' -or $build.extract_to -match '^[/\\]' -or $build.extract_to -match '^[A-Za-z]:') {
  Write-Host "runtime-sources.yaml: extract_to escapes the drive root: $($build.extract_to)" -ForegroundColor Red
  exit 2
}

$IsRealSha = { param($h) $h -match '^[a-f0-9]{64}$' }
$extractTo = Join-Path $Target ($build.extract_to -replace '/', [IO.Path]::DirectorySeparatorChar)
# Binary name follows the FAMILY + the SELECTED build's OS (we may be provisioning the
# mac/linux dir from a Windows build machine), mirroring assets.ts sidecarBinaryName.
$binaryBase = if ($Family -eq 'whisper_cpp') { 'whisper-cli' } else { 'llama-server' }
$binaryName = if ($build.os -eq 'win') { "$binaryBase.exe" } else { $binaryBase }
$binaryPath = Join-Path $extractTo $binaryName
$markerPath = Join-Path $extractTo '.hilbertraum-runtime.json'
$sha = ([string]$build.sha256).ToLower()

Write-Host "Fetch runtime -> $Target" -ForegroundColor Cyan
Write-Host ("  build: {0}/{1} {2} @ {3}" -f $build.os, $build.arch, $build.backend, $version)
Write-Host ("  url:   {0}" -f $build.url)
Write-Host ("  into:  {0}" -f $extractTo)
if ($DryRun) { Write-Host '(dry run -- nothing will be downloaded)' -ForegroundColor Yellow; exit 0 }

# Idempotent skip is MARKER-based (Phase 14, mirrors assets.ts runtimeInstallCurrent):
# "binary exists" alone would silently keep a CPU-era build in place after the default
# became vulkan. Skip only when .hilbertraum-runtime.json matches the selected version+backend.
if (Test-Path $binaryPath) {
  $skip = $false
  if (Test-Path $markerPath) {
    try {
      $marker = Get-Content -Path $markerPath -Raw | ConvertFrom-Json
      if ($marker.version -eq $version -and $marker.backend -eq $build.backend) { $skip = $true }
    } catch { $skip = $false }
  }
  if ($skip) {
    Write-Host "  skip ($binaryName already installed: $version/$($build.backend) per .hilbertraum-runtime.json)" -ForegroundColor Green
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
  # Resilient curl (see Invoke-CurlResilient): retries + resumes a dropped transfer so a
  # flaky connection doesn't lose the whole archive. Integrity is enforced by the SHA-256
  # pin below, so resume can never weaken verification.
  if (-not (Invoke-CurlResilient -Url $build.url -Dest $archive)) {
    Write-Host 'curl failed after retries' -ForegroundColor Red; exit 1
  }
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
    Write-Host "tar extraction failed (exit $tarExit; $unresolved unresolved entries)" -ForegroundColor Red
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
  # `binaries` records the extracted binary's own SHA-256 so the app can re-hash it
  # immediately before spawn (vuln-scan B / binary-verifier.ts). The key is the binary's
  # name relative to the extract dir (here it sits at the root after the flatten above).
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $binSha = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLower()
  $markerJson = '{"version":"' + $version + '","backend":"' + $build.backend + '","os":"' + $build.os + '","arch":"' + $build.arch + '","binaries":{"' + $binaryName + '":"' + $binSha + '"}}'
  [System.IO.File]::WriteAllText($markerPath, $markerJson, $utf8NoBom)
  Write-Host "  extracted $binaryName (+ .hilbertraum-runtime.json install marker)" -ForegroundColor Green
  if ($build.os -ne 'win') {
    Write-Host "  NOTE: exec bit for $binaryName cannot be set from Windows; exFAT mounts are typically all-executable, otherwise chmod +x it on the target OS." -ForegroundColor Yellow
  }
  exit 0
}
Write-Host "  FAIL: $binaryName not found under $extractTo after extraction -- the release archive layout may have changed." -ForegroundColor Red
exit 1
