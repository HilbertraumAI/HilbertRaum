# Helpers for run-hold.ps1 (the stub hold-and-probe measurement, docs/packaging.md "Manual pre-ship checklist").
# Dot-source it. It came from the app-update wave's spike 1 harness; every path is the caller's parameter.
# Rules kept here: every start clears ELECTRON_RUN_AS_NODE; one packaged-app run at a time (a run starts only
# when no HilbertRaum* process exists); only processes this harness started are ever stopped; the host profile
# %APPDATA%\@hilbertraum\desktop is only listed (top level: names, sizes, times), no file in it is opened.
# ASCII only: Windows PowerShell 5.1 reads a file without a byte-order mark in the system code page.
$ErrorActionPreference = 'Stop'
if (-not ('T11' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'T11Native.cs') }
[void][T11]::timeBeginPeriod(1)
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Now-Utc { [T11]::UtcMsPreciseF() }

function Write-Log([string]$File, [string]$Line) {
  [IO.File]::AppendAllText($File, $Line + "`r`n", $Utf8)
  $Line
}

# The host profile's top level as lines (name, size or <dir>, LastWriteTimeUtc to the tick), '<absent>' when
# the folder does not exist. Lists entries only.
function Get-HostProfileListing {
  $p = Join-Path $env:APPDATA '@hilbertraum\desktop'
  if (-not [IO.Directory]::Exists($p)) { return @('<absent>') }
  $lines = @()
  Get-ChildItem -Force -LiteralPath $p | Sort-Object Name | ForEach-Object {
    $len = if ($_.PSIsContainer) { '<dir>' } else { $_.Length }
    $lines += ("{0}`t{1}`t{2}" -f $_.Name, $len, $_.LastWriteTimeUtc.ToString('o'))
  }
  $lines += ("(the folder itself)`t`t{0}" -f (Get-Item -Force -LiteralPath $p).LastWriteTimeUtc.ToString('o'))
  return $lines
}

# True when the host profile's listing still equals $Before; a difference is written to $LogFile.
function Test-HostProfileUnchanged([string[]]$Before, [string]$Tag, [string]$LogFile) {
  $now = @(Get-HostProfileListing)
  $d = Compare-Object @($Before) $now
  if ($d) {
    Write-Log $LogFile "HOST PROFILE CHANGED ($Tag): $(($d | ForEach-Object { $_.SideIndicator + ' ' + $_.InputObject }) -join ' | ')" | Out-Null
    return $false
  }
  return $true
}

# Every process whose image name starts with HilbertRaum (the packaged app and its portable stubs).
function Get-AppProcs { @([T11]::ProcTable() | Where-Object { $_.Split('|')[2] -like 'HilbertRaum*' }) }

function Wait-NoApp([int]$Ms = 60000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $Ms) { if ((Get-AppProcs).Count -eq 0) { return $true }; Start-Sleep -Milliseconds 200 }
  throw ('a HilbertRaum process is still running, refusing to start another: ' + ((Get-AppProcs) -join ', '))
}

# A scratch drive root: config\drive.json = {} and a copy of the portable exe under its own name.
function New-DriveRoot([string]$Root, [string]$Src, [string]$Sha) {
  [void][IO.Directory]::CreateDirectory((Join-Path $Root 'config'))
  $dj = Join-Path $Root 'config\drive.json'
  if (-not [IO.File]::Exists($dj)) { [IO.File]::WriteAllText($dj, '{}', $Utf8) }
  $exe = Join-Path $Root (Split-Path -Leaf $Src)
  if (-not [IO.File]::Exists($exe)) { Copy-Item -LiteralPath $Src -Destination $exe }
  if ($Sha) { $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLower(); if ($h -ne $Sha.ToLower()) { throw "sha256 mismatch for $exe : $h" } }
  return $exe
}

# Start an exe with ELECTRON_RUN_AS_NODE removed and $Env set only for the start (restored after).
function Start-Exe([string]$Exe, [string[]]$ArgList = @(), [hashtable]$Env = @{}) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $saved = @{}
  foreach ($k in $Env.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, $Env[$k], 'Process') }
  try {
    $wd = Split-Path -Parent $Exe
    if ($ArgList.Count -gt 0) { $p = Start-Process -FilePath $Exe -ArgumentList $ArgList -WorkingDirectory $wd -PassThru }
    else { $p = Start-Process -FilePath $Exe -WorkingDirectory $wd -PassThru }
  } finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  }
  return $p
}

function Get-TempNsDirs { @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'ns*.tmp' -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) }

# 'min / median / max (n=..)' of the numeric values; 'n/a' when there is none.
function Get-Stats($v) {
  $v = @($v | Where-Object { $null -ne $_ -and $_ -ne 'null' -and $_ -ne '' } | ForEach-Object { [double]$_ } | Sort-Object)
  if ($v.Count -eq 0) { return 'n/a' }
  $med = if ($v.Count % 2) { $v[[int][math]::Floor($v.Count / 2)] } else { ($v[$v.Count / 2 - 1] + $v[$v.Count / 2]) / 2 }
  return ('{0} / {1} / {2} (n={3})' -f [math]::Round($v[0], 1), [math]::Round($med, 1), [math]::Round($v[-1], 1), $v.Count)
}
