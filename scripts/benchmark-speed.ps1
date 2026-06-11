# Phase-29 speed + memory sweep across the whole chat catalog
# (docs/model-benchmarks.md Parts B + C / plan sections 5.1-5.2). Runs `llama-bench`
# (prefill + decode throughput at 512/2048/8192 prompt tokens) and the peak-RSS probe for
# every chat GGUF on the drive, and writes ONE speed CSV per machine x backend. Fully
# offline + local. Pair its rows with the QA harness's *-quality-rescored.csv to form the
# combined results row (decision rule, section 5.4).
#
# Usage (run once per machine; CPU is the default backend):
#   scripts\benchmark-speed.ps1 -Root D:\ -Machine i7-1185G7 -Backend cpu
#   scripts\benchmark-speed.ps1 -Root D:\ -Machine devbox  -Backend vulkan
#
# Output: eval\results\<machine>-<backend>-speed.csv. Numbers use the invariant culture so a
# German-locale machine emits "12.34", not "12,34" (which would corrupt the CSV).
#
# Pure ASCII (Windows PowerShell 5.1 reads non-BOM scripts in the ANSI codepage).

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Machine = $env:COMPUTERNAME,
  [string]$Backend = "cpu",
  [int]$Threads = 0,
  [int]$Reps = 3,
  [string[]]$Models = @()
)

$ErrorActionPreference = "Stop"
$inv = [System.Globalization.CultureInfo]::InvariantCulture
function Fmt([double]$x, [int]$d) { return $x.ToString("F$d", $inv) }
function ParseTs([string]$s) { return [double]::Parse($s, $inv) }

$benchBin = Join-Path $Root "runtime\llama.cpp\win\llama-bench.exe"
if (-not (Test-Path $benchBin)) {
  throw "llama-bench.exe not found at $benchBin. Verify it ships in the b9585 archive (plan section 7 risk); fallback = time llama-server streaming."
}
$rssScript = Join-Path $PSScriptRoot "measure-peak-rss.ps1"
$chatDir = Join-Path $Root "models\chat"
if (-not (Test-Path $chatDir)) { throw "no models\chat dir under $Root" }

# Physical cores (llama-bench's own default) unless overridden.
if ($Threads -le 0) {
  try { $Threads = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum } catch {}
  if (-not $Threads -or $Threads -le 0) { $Threads = [Environment]::ProcessorCount }
}

if ($Models.Count -eq 0) {
  $Models = Get-ChildItem -Path $chatDir -Filter *.gguf | Sort-Object Length | Select-Object -ExpandProperty Name
}
if ($Models.Count -eq 0) { throw "no .gguf files in $chatDir" }

$resultsDir = Join-Path (Split-Path $PSScriptRoot -Parent) "eval\results"
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
$stem = ("$Machine-$Backend" -replace '[^A-Za-z0-9._-]+', '_')
$outCsv = Join-Path $resultsDir "$stem-speed.csv"

$header = "model,backend,threads,pp512_tps,pp2048_tps,pp8192_tps,tg_tps,peak_rss_gib,suggested_min_ram_gb"
$rows = @($header)
Write-Host "=== speed+RSS sweep: $($Models.Count) models | backend=$Backend | threads=$Threads ==="

foreach ($model in $Models) {
  $modelPath = Join-Path $chatDir $model
  Write-Host "`n--- $model ---"
  $pp512 = $null; $pp2048 = $null; $pp8192 = $null; $tg = $null; $gib = $null; $suggest = $null

  try {
    # --- llama-bench: prefill (pp) at 3 sizes + decode (tg128) ---
    $benchArgs = @("-m", $modelPath, "-p", "512,2048,8192", "-n", "128", "-t", "$Threads", "-r", "$Reps", "-o", "csv")
    if ($Backend -eq "cpu") { $benchArgs += @("-ngl", "0") }
    $raw = & $benchBin @benchArgs
    $parsed = $raw | ConvertFrom-Csv
    if (-not $parsed) { throw "llama-bench produced no CSV rows" }

    # Throughput column name varies by build (avg_ts on current builds, t/s on older ones).
    $tsProp = @('avg_ts', 't/s', 'ts') | Where-Object { $parsed[0].PSObject.Properties.Name -contains $_ } | Select-Object -First 1
    if (-not $tsProp) { throw "no throughput column in llama-bench CSV (have: $($parsed[0].PSObject.Properties.Name -join ', '))" }

    foreach ($r in $parsed) {
      $ts = ParseTs ([string]$r.$tsProp)
      if ([int]$r.n_gen -gt 0) { $tg = $ts }
      else {
        switch ([string]$r.n_prompt) {
          '512'  { $pp512 = $ts }
          '2048' { $pp2048 = $ts }
          '8192' { $pp8192 = $ts }
        }
      }
    }
    Write-Host ("  pp512={0} pp2048={1} pp8192={2} tg={3} t/s" -f (Fmt $pp512 1), (Fmt $pp2048 1), (Fmt $pp8192 1), (Fmt $tg 1))

    # --- peak RSS at the 8192 RAG window (captures the single number the script emits) ---
    $rssOut = & $rssScript -Root $Root -Model $model -Ctx 8192 -Backend $Backend -Threads $Threads
    $gib = ParseTs ([string](@($rssOut)[-1]))
    $suggest = [int][math]::Ceiling($gib) + 3
    Write-Host ("  peak RSS={0} GiB -> suggested min RAM={1} GiB" -f (Fmt $gib 2), $suggest)
  }
  catch {
    Write-Warning "  $model failed: $($_.Exception.Message)"
  }

  $rows += @(($model, $Backend, $Threads,
    $(if ($null -ne $pp512) { Fmt $pp512 2 } else { "" }),
    $(if ($null -ne $pp2048) { Fmt $pp2048 2 } else { "" }),
    $(if ($null -ne $pp8192) { Fmt $pp8192 2 } else { "" }),
    $(if ($null -ne $tg) { Fmt $tg 2 } else { "" }),
    $(if ($null -ne $gib) { Fmt $gib 2 } else { "" }),
    $(if ($null -ne $suggest) { "$suggest" } else { "" })) -join ",")
}

$rows -join "`n" | Out-File -FilePath $outCsv -Encoding ascii
Write-Host "`nWrote $outCsv"
