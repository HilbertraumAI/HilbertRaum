# Peak-RSS measurement (docs/model-benchmarks.md Part C).
#
# Starts the REAL llama-server with the same chat args the app uses (--jinja
# --reasoning-format deepseek, --ctx-size 8192), runs one generation, and reads the
# process Peak Working Set. The number calibrates each manifest's recommended_min_ram_gb
# (peak RSS + 3 GiB OS/app headroom). Fully offline + local; no network beyond loopback.
#
# Usage:
#   scripts\measure-peak-rss.ps1 -Root D:\ -Model granite-4.1-8b-q4.gguf -Ctx 8192
#
# Output: a friendly summary on the HOST stream, and the peak GiB as the single SUCCESS-stream
# value (so a loop can capture it:  $gib = & scripts\measure-peak-rss.ps1 ... ). Numbers are
# formatted with the invariant culture so a German-locale machine still emits "6.98", not "6,98".
#
# Pure ASCII on purpose (Windows PowerShell 5.1 reads non-BOM scripts in the ANSI codepage).

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Model,
  [int]$Ctx = 8192,
  [int]$Threads = 0,
  [int]$MaxTokens = 128,
  [int]$HealthTimeoutSec = 300,
  [string]$Backend = ""
)

$ErrorActionPreference = "Stop"
$inv = [System.Globalization.CultureInfo]::InvariantCulture
function Fmt([double]$x, [int]$d) { return $x.ToString("F$d", $inv) }

$serverBin = Join-Path $Root "runtime\llama.cpp\win\llama-server.exe"
if (-not (Test-Path $serverBin)) { throw "llama-server not found: $serverBin" }
$modelPath = Join-Path $Root ("models\chat\" + $Model)
if (-not (Test-Path $modelPath)) { throw "model not found: $modelPath" }
if ($Threads -le 0) { $Threads = [Environment]::ProcessorCount }

# Pick a free loopback port (bind to 0, read it back, release).
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()

$serverArgs = @(
  "--host", "127.0.0.1",
  "--port", "$port",
  "--model", $modelPath,
  "--ctx-size", "$Ctx",
  "--threads", "$Threads",
  "--jinja",
  "--reasoning-format", "deepseek"
)
if ($Backend -eq "cpu") { $serverArgs += @("--device", "none") }

Write-Host "Starting llama-server: $Model  (ctx=$Ctx, threads=$Threads, backend=$(if ($Backend) { $Backend } else { 'auto' }))"
$proc = Start-Process -FilePath $serverBin -ArgumentList $serverArgs -PassThru -NoNewWindow

try {
  # Wait for /health to report ready (a multi-GB model on cold disk can take a while).
  $base = "http://127.0.0.1:$port"
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { throw "llama-server exited early (code $($proc.ExitCode)) before becoming healthy" }
    try {
      $h = Invoke-WebRequest -UseBasicParsing -Uri "$base/health" -TimeoutSec 5
      if ($h.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 750 }
  }
  if (-not $ready) { throw "llama-server did not become healthy within $HealthTimeoutSec s" }

  # One generation exercises the KV cache at the requested context window.
  $body = @{
    messages    = @(@{ role = "user"; content = "Write three short sentences about keeping data private and offline." })
    max_tokens  = $MaxTokens
    temperature = 0
    stream      = $false
  } | ConvertTo-Json -Depth 5
  Invoke-WebRequest -UseBasicParsing -Uri "$base/v1/chat/completions" -Method Post `
    -ContentType "application/json" -Body $body -TimeoutSec 600 | Out-Null

  # Read the peak working set of the actual server process.
  $live = Get-Process -Id $proc.Id
  $peakGiB = [double]$live.PeakWorkingSet64 / 1GB
  $suggestRam = [int][math]::Ceiling($peakGiB) + 3

  Write-Host ""
  Write-Host "model:                    $Model"
  Write-Host "peak working set:         $(Fmt $peakGiB 2) GiB"
  Write-Host "suggested min RAM (+3):   $suggestRam GiB  (set recommended_min_ram_gb to the measured tier)"

  # The single success-stream value, so a loop can capture just the number.
  Write-Output (Fmt $peakGiB 2)
}
finally {
  if (-not $proc.HasExited) {
    try { $proc.Kill() } catch {}
    try { $proc.WaitForExit(5000) | Out-Null } catch {}
  }
}
