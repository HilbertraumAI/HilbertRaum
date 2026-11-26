# run-hold.ps1 - how long the Windows portable stub holds the drive-root exe after the app quits.
#
# When: before a release that bumps electron-builder, NSIS or the Electron major (docs/packaging.md, "Manual
# pre-ship checklist"): 3 runs on NTFS. The update's apply waits on exactly this (docs/app-updates.md 5.5, 5.6).
#
# What one run does: copies the built portable exe into a scratch drive root, starts it there with a scratch
# profile, waits for the window, then closes the app's window (taskkill /PID <app>, no /F: WM_CLOSE) and polls
# every -IntervalMs ms for: app exit, app tree exit, unpack dir gone, the stub's exe handle closed, the start
# files' write-open probe reading "free", the first successful rename of the root exe (renamed back at once),
# stub exit. The unpack dir is checked again right after the first free probe and right after the first
# successful rename.
#
# Pass (every run): the probe reads "held" while the app runs (what the update's wait rests on), the unpack dir
# is absent when the probe first reads free, and the probe reads free at most -MaxProbeFreeMs (1500) ms after
# WM_CLOSE. The rename's time is recorded beside it, for comparison only. The verdict line names the rule and
# marks a limit other than 1500.
# Exit code: 0 pass, 1 a run failed the pass rule, 2 the app did not start (no app process within 240 s, or no app
# window within 300 s: nothing of that run is measured), 3 the host profile changed,
# 5 a bad parameter, or a drive root that already holds an exe of -Exe's name with other content.
#
# Usage (Windows PowerShell 5.1 or pwsh, from any folder; nothing else of HilbertRaum may be running):
#   powershell -NoProfile -File scripts\release\run-hold.ps1 `
#     -Exe apps\desktop\release\HilbertRaum-<version>-portable.exe -WorkDir <scratch folder on the volume to measure>
#   -WorkDir       holds drive\ (the scratch drive root), ud\ (the scratch profile) and logs\ unless
#                  -DriveRoot, -UserDataDir or -LogDir name other places (a stick: -DriveRoot <letter>:\<folder>).
#                  A drive root that already holds a file of -Exe's name is used only if that file's sha256
#                  equals -Exe's; otherwise the script stops (exit 5) and replaces nothing.
#   -ExeSha256     optional: -Exe (and so the copy in the drive root) must have this sha256.
#   -Runs 3  -IntervalMs 25  -SettleMs 5000 (time at the first window before the close)  -Tag <name for the log folder>
# Output: <LogDir>\<Tag>-<UTC start time>\run.log (both sha256 values, one line per run, min / median / max,
# PASS or FAIL), run<N>.json, all.json, and the stub's and the app tree's file handles per run. Every run of
# the script writes a folder of its own.
#
# History: this is the app-update wave's spike 1 harness, moved here with three changes. The close poll gained
# the write-open probe (the pass rule is stated on it; the spike's poll had only the rename), the unpack dir is
# checked again right after the first free probe and right after the first successful rename (the poll alone
# cannot order two events 1 to 2 ms apart), and the parts that fitted only the spike's computer are gone (the
# reading of one antivirus product's logs, the USB 2 port check, the fixed build and medium names).
#
# Safety: the app is started with HILBERTRAUM_DRIVE_ROOT = the scratch root (config\drive.json = {}) and
# --user-data-dir = the scratch profile, so it never opens this computer's own profile
# (%APPDATA%\@hilbertraum\desktop); that folder's top level is listed before, during and after every run and a
# change stops the script. Only processes this script started are stopped. The script deletes nothing: remove
# -WorkDir yourself afterwards.
param(
  [Parameter(Mandatory)][string]$Exe,
  [Parameter(Mandatory)][string]$WorkDir,
  [string]$DriveRoot = '',
  [string]$UserDataDir = '',
  [string]$LogDir = '',
  [string]$ExeSha256 = '',
  [string]$AppImageName = 'HilbertRaum.exe',
  [int]$Runs = 3, [int]$IntervalMs = 25, [int]$SettleMs = 5000, [int]$MaxProbeFreeMs = 1500,
  [string]$Tag = 'hold'
)
. (Join-Path $PSScriptRoot 'lib.ps1')
if (-not [IO.File]::Exists($Exe)) { Write-Output "no file at -Exe $Exe"; exit 5 }
$Exe = (Resolve-Path -LiteralPath $Exe).Path
[void][IO.Directory]::CreateDirectory($WorkDir)
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
if (-not $DriveRoot) { $DriveRoot = Join-Path $WorkDir 'drive' }
if (-not $UserDataDir) { $UserDataDir = Join-Path $WorkDir 'ud' }
if (-not $LogDir) { $LogDir = Join-Path $WorkDir 'logs' }
$rootExeName = Split-Path -Leaf $Exe
# The probe is a cmd line: these characters would change what it means.
if ((Join-Path $DriveRoot $rootExeName) -match '["%^!]') { Write-Output "the drive root or the exe name holds one of `" % ^ ! : $DriveRoot\$rootExeName"; exit 5 }
# One folder, and so one run.log, per run of this script: the start time is part of the folder's name.
$startUtc = (Get-Date).ToUniversalTime()
$runDir = Join-Path $LogDir "$Tag-$($startUtc.ToString('yyyyMMddTHHmmssZ'))"
if ([IO.Directory]::Exists($runDir)) { Write-Output "the log folder $runDir exists already (a run started in the same second): start again"; exit 5 }
[void][IO.Directory]::CreateDirectory($runDir)
$log = Join-Path $runDir 'run.log'
Write-Log $log "# run-hold $Tag runs=$Runs interval=$IntervalMs settle=$SettleMs maxProbeFree=$MaxProbeFreeMs start $($startUtc.ToString('o'))"
$rootExe = New-DriveRoot $DriveRoot $Exe
# The exe measured is the copy in the drive root. A copy left by an earlier run has the same name after a bump
# of electron-builder, NSIS or Electron (the app's version did not change), so it is compared with -Exe and a
# different one is refused, not replaced: this script deletes and overwrites nothing.
$exeSha = Get-Sha256 $Exe
$rootSha = Get-Sha256 $rootExe
Write-Log $log "exe=$Exe sha256=$exeSha"
Write-Log $log "root exe=$rootExe sha256=$rootSha"
if ($rootSha -ne $exeSha) {
  Write-Log $log "STOP: $rootExe is not a copy of -Exe (the sha256 values above differ; a file an earlier run left?). Remove it, or name an empty -DriveRoot or -WorkDir."
  exit 5
}
if ($ExeSha256 -and $exeSha -ne $ExeSha256.ToLower()) { Write-Log $log "STOP: -Exe has sha256 $exeSha, not -ExeSha256 $($ExeSha256.ToLower())"; exit 5 }
[void][IO.Directory]::CreateDirectory($UserDataDir)
$volume = try { (Get-Volume -FilePath $DriveRoot -ErrorAction Stop).FileSystem } catch { 'unknown' }
Write-Log $log "root=$DriveRoot ($volume) ud=$UserDataDir harness pid=$PID in job=$([T11]::InJob($PID))"
$hostBefore = @(Get-HostProfileListing)
$results = @()
for ($i = 1; $i -le $Runs; $i++) {
  $r = [ordered]@{ id = $Tag; run = $i }
  [void](Wait-NoApp)
  if (-not (Test-HostProfileUnchanged $hostBefore "r$i-pre" $log)) { Write-Log $log 'STOP: host profile changed before the run'; exit 3 }
  $nsBefore = Get-TempNsDirs
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $stub = Start-Exe $rootExe @("--user-data-dir=`"$UserDataDir`"") @{ HILBERTRAUM_DRIVE_ROOT = $DriveRoot }
  $hStub = [T11]::Hold($stub.Id)
  $r.stub_pid = $stub.Id
  $appPid = 0
  while ($sw.ElapsedMilliseconds -lt 240000) {
    $appPid = [T11]::ChildOf($stub.Id, $AppImageName); if ($appPid) { break }
    if ([T11]::Exited($hStub)) { break }
    [Threading.Thread]::Sleep($IntervalMs)
  }
  if (-not $appPid) { Write-Log $log "run $i : no $AppImageName child (stub exited=$([T11]::Exited($hStub)) code=$([T11]::ExitCode($hStub)))"; if (-not [T11]::Exited($hStub)) { Stop-Process -Id $stub.Id -Force }; exit 2 }
  $r.start_ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
  $hApp = [T11]::Hold($appPid); $r.app_pid = $appPid
  $hwnd = [IntPtr]::Zero
  while ($sw.ElapsedMilliseconds -lt 300000) {
    $hwnd = [T11]::FirstVisibleTopWindow($appPid, 'Chrome_WidgetWin_1'); if ($hwnd -ne [IntPtr]::Zero) { break }
    if ([T11]::Exited($hApp)) { break }
    [Threading.Thread]::Sleep($IntervalMs)
  }
  # No window: the app ended before its first one (its image path is then unreadable), or it stays alive behind
  # something that is no app window (main's own error box). Either way the app did not start: one line, the stub and
  # the app stopped if they still run (both this script's: it started the stub, the stub the app), nothing measured.
  if ($hwnd -eq [IntPtr]::Zero) {
    $appWas = if ([T11]::Exited($hApp)) { "the app exited, code $([T11]::ExitCode($hApp))" } else { Stop-Process -Id $appPid -Force -ErrorAction SilentlyContinue; 'the app still ran: stopped' }
    $stubWas = if ([T11]::Exited($hStub)) { "the stub exited, code $([T11]::ExitCode($hStub))" } else { Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue; 'the stub still ran: stopped' }
    Write-Log $log "run $i : no $AppImageName window within 300 s ($appWas; $stubWas)"
    foreach ($h in @($hStub, $hApp)) { [void][T11]::CloseHandle($h) }
    exit 2
  }
  $r.window_ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
  $appExe = [T11]::ImagePath($appPid)
  $unpack = Split-Path -Parent $appExe
  $nsNew = @(Get-TempNsDirs | Where-Object { $nsBefore -notcontains $_ })
  # The stub's own temp folder: the unpack dir's parent when the stub unpacks per start (an ns*.tmp folder),
  # else the one new ns*.tmp folder of this start.
  $plugins = $null
  $parent = Split-Path -Parent $unpack
  if ((Split-Path -Leaf $parent) -like 'ns*.tmp') { $plugins = $parent } elseif ($nsNew.Count -eq 1) { $plugins = Join-Path $env:TEMP $nsNew[0] }
  $r.app_exe = $appExe; $r.unpack_dir = $unpack; $r.unpack_dir_name = Split-Path -Leaf $unpack; $r.ns_new = ($nsNew -join ','); $r.plugins_dir = $plugins
  # settle at the first window
  while ($sw.ElapsedMilliseconds -lt ($r.window_ms + $SettleMs)) { Start-Sleep -Milliseconds 100 }
  $r.stub_in_job = [T11]::InJob($stub.Id); $r.app_in_job = [T11]::InJob($appPid); $r.harness_in_job = [T11]::InJob($PID)
  $files = @(Get-ChildItem -LiteralPath $unpack -Recurse -Force -File -ErrorAction SilentlyContinue)
  $r.unpack_files = $files.Count; $r.unpack_mb = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 1)
  if ($plugins) { $r.plugins_files = (@(Get-ChildItem -LiteralPath $plugins -Force -File -ErrorAction SilentlyContinue) | ForEach-Object { $_.Name }) -join ',' }
  $r.rename_while_running = [T11]::TryRename($rootExe, "$rootExe.t11ren")
  $r.open_delete_while_running = [T11]::TryOpenDelete($rootExe)
  $pm = 0.0; $r.probe_while_running = [T11]::Probe($rootExe, [ref]$pm); $r.probe_while_running_ms = [math]::Round($pm, 1)
  # handles: the stub's (all File handles), the app tree's (only those on the drive root)
  $sh = @([T11]::FileHandles($stub.Id, 300))
  [IO.File]::WriteAllLines((Join-Path $runDir "run$i-stub-handles.txt"), [string[]]$sh, $Utf8)
  $rootExeH = @($sh | Where-Object { $_.Split('|')[2] -like "*\$rootExeName" })
  $r.stub_file_handles = $sh.Count
  $r.stub_exe_handles = ($rootExeH -join ' ; ')
  $stubExeHandle = if ($rootExeH.Count -ge 1) { [Convert]::ToInt64($rootExeH[0].Split('|')[0].Substring(2), 16) } else { 0 }
  $tree = @([T11]::Descendants($appPid))
  $treeH = @(); $treeTotal = 0
  foreach ($p in @($appPid) + $tree) {
    $hs = @([T11]::FileHandles($p, 300)); $treeTotal += $hs.Count
    foreach ($h in $hs) { $path = $h.Split('|')[2]; if ($path.IndexOf($DriveRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $path -like "*\$rootExeName") { $treeH += "pid $p $h" } }
  }
  [IO.File]::WriteAllLines((Join-Path $runDir "run$i-tree-root-handles.txt"), [string[]]@("tree pids: $(@($appPid) + $tree -join ',') ; file handles in all: $treeTotal") + $treeH, $Utf8)
  $r.tree_pids = (@($appPid) + $tree) -join ','; $r.tree_file_handles = $treeTotal; $r.tree_root_handles = ($treeH -join ' ; ')
  $r.rm_who = ([T11]::RmWho($rootExe) -join ' ; ')
  $hTree = @($tree | ForEach-Object { [T11]::Hold($_) })
  $hostUp = Test-HostProfileUnchanged $hostBefore "r$i-up" $log
  if (-not $hostUp) { Write-Log $log 'STOP: host profile changed while the app ran' }
  # WM_CLOSE at the first window
  $tClose = $sw.Elapsed.TotalMilliseconds; $tCloseUtc = Now-Utc
  $tk = (& taskkill.exe /PID $appPid) -join ' '
  $r.taskkill_return_ms = [math]::Round($sw.Elapsed.TotalMilliseconds - $tClose, 1)
  $r.taskkill = $tk
  $poll = [T11]::PollAfterClose($sw, $tClose, $hStub, $stub.Id, $hApp, [IntPtr[]]$hTree, $unpack, $plugins, $rootExe, $stubExeHandle, $IntervalMs, 120000)
  foreach ($kv in $poll.Split(';')) { $p = $kv.Split('=', 2); if ($p.Count -eq 2) { $r[$p[0]] = $p[1] } }
  if ($poll -like 'FATAL*') { Write-Log $log "run $i : $poll (the root exe may now be named $rootExeName.t11ren)" }
  $kApp = [T11]::ExitUtcMs($hApp); $kStub = [T11]::ExitUtcMs($hStub)
  $r.k_app_exit = if ([double]::IsNaN($kApp)) { $null } else { [math]::Round($kApp - $tCloseUtc, 1) }
  $r.k_stub_exit = if ([double]::IsNaN($kStub)) { $null } else { [math]::Round($kStub - $tCloseUtc, 1) }
  $kt = @($hTree | ForEach-Object { [T11]::ExitUtcMs($_) } | Where-Object { -not [double]::IsNaN($_) })
  $r.k_tree_last_exit = if ($kt.Count) { [math]::Round((($kt | Measure-Object -Maximum).Maximum) - $tCloseUtc, 1) } else { $null }
  $r.app_exit_code = [T11]::ExitCode($hApp); $r.stub_exit_code = [T11]::ExitCode($hStub)
  $r.k_stub_start_to_app_start = [math]::Round([T11]::CreateUtcMs($hApp) - [T11]::CreateUtcMs($hStub), 1)
  if ($r.stub_exit -eq 'null' -or $null -eq $r.stub_exit) {
    Write-Log $log "run $i : the stub had not exited 120 s after WM_CLOSE (app exit $($r.app_exit))"
    if (-not [T11]::Exited($hStub)) { Stop-Process -Id $stub.Id -Force; Write-Log $log "stopped my stub $($stub.Id)" }
  }
  $r.unpack_exists_after = [IO.Directory]::Exists($unpack)
  $r.plugins_exists_after = if ($plugins) { [IO.Directory]::Exists($plugins) } else { $null }
  $r.root_top_after = (@(Get-ChildItem -LiteralPath $DriveRoot -Force | ForEach-Object { $_.Name }) -join ',')
  foreach ($h in @($hStub, $hApp) + $hTree) { [void][T11]::CloseHandle($h) }
  $r.host_post_identical = Test-HostProfileUnchanged $hostBefore "r$i-post" $log
  # the pass rule
  $why = @()
  if ($r.probe_while_running -ne 'held') { $why += "the probe read '$($r.probe_while_running)', not 'held', while the app ran" }
  if ($r.unpack_at_probe -ne 'absent') { $why += "the unpack dir was '$($r.unpack_at_probe)' when the probe first read free" }
  if ($r.probe_free_end -eq 'null' -or $null -eq $r.probe_free_end) { $why += 'the probe never read free' }
  elseif ([double]::Parse($r.probe_free_end, [Globalization.CultureInfo]::InvariantCulture) -gt $MaxProbeFreeMs) { $why += "the probe read free $($r.probe_free_end) ms after WM_CLOSE (limit $MaxProbeFreeMs)" }
  $r.pass = ($why.Count -eq 0); $r.fail_reasons = ($why -join '; ')
  $o = [pscustomobject]$r
  $o | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 (Join-Path $runDir "run$i.json")
  Write-Log $log ("run {0}: {1} | start {2} win {3} | close: app {4} tree {5} unpack {6} plugins {7} handle {8} probe-free {9}..{10} (unpack then: {11}) rename {12} (unpack then: {13}; took {14}+{15} ms) stub {16} | k_app {17} k_stub {18} | while running: probe {19}, rename err {20} | unpack {21} ({22} files) | stub exe handles: {23}{24}" -f `
      $i, $(if ($r.pass) { 'PASS' } else { 'FAIL' }), $r.start_ms, $r.window_ms, $r.app_exit, $r.tree_exit, $r.unpack_gone, $r.plugins_gone, $r.handle_closed, $r.probe_free, $r.probe_free_end, $r.unpack_at_probe, `
      $r.rename_ok, $r.unpack_at_rename, $r.rename_out_ms, $r.rename_back_ms, $r.stub_exit, $r.k_app_exit, $r.k_stub_exit, $r.probe_while_running, $r.rename_while_running, $r.unpack_dir_name, $r.unpack_files, $r.stub_exe_handles, `
      $(if ($r.pass) { '' } else { " | FAIL: $($r.fail_reasons)" })) | Out-Null
  $results += $o
  if (-not $hostUp -or -not $r.host_post_identical) { Write-Log $log 'STOP: host profile changed'; exit 3 }
  Start-Sleep -Seconds 2
}
$results | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 (Join-Path $runDir 'all.json')
foreach ($k in 'start_ms', 'window_ms', 'app_exit', 'tree_exit', 'unpack_gone', 'plugins_gone', 'handle_closed', 'probe_free', 'probe_free_end', 'rename_ok', 'stub_exit', 'k_app_exit', 'k_stub_exit') {
  Write-Log $log ("{0,-14} {1}" -f $k, (Get-Stats ($results | ForEach-Object { $_.$k }))) | Out-Null
}
$failed = @($results | Where-Object { -not $_.pass })
$rule = "probe held while the app ran, probe free <= $MaxProbeFreeMs ms after WM_CLOSE with the unpack dir absent"
if ($MaxProbeFreeMs -ne 1500) { $rule += " (NOT the checklist's rule: its limit is 1500 ms)" }
$verdict = if ($results.Count -eq $Runs -and $failed.Count -eq 0) { "PASS: $Runs of $Runs runs on $volume; $rule" } else { "FAIL: $($failed.Count) of $($results.Count) runs failed the pass rule ($Runs asked) on $volume; $rule" }
Write-Log $log $verdict | Out-Null
Write-Log $log "# end $((Get-Date).ToUniversalTime().ToString('o'))" | Out-Null
Get-Content $log
if ($verdict -like 'PASS*') { exit 0 } else { exit 1 }
