# Samples llama-server's process working set and the UHD 620's Vulkan heap budget every ~2 s for
# the duration of one start.
#
# ADAPTED FOR THIS MACHINE (integrated-only, no NVIDIA device). The Ryzen and GTX-1070-Ti copies
# of this sampler are built around `nvidia-smi --query-gpu=memory.used`, which is the peak-memory
# figure points 6 of those comments report. `nvidia-smi` does not exist here, so that column would
# be empty for every row and the start would have no memory figure at all. Two substitutions:
#
#  1. **Process working set** (`llama-server`, summed over the process tree) is the honest peak
#     figure on a machine whose "GPU memory" is system RAM. It is what the protocol's peak-RSS
#     line actually wants on the CPU path.
#  2. **The Vulkan heap** of the UHD 620 via `VK_EXT_memory_budget` is the only way to see whether
#     a Vulkan allocation happened at all. The preflight recorded ONE heap here (7.93 GiB size,
#     7.28 GiB budget, usage 0, DEVICE_LOCAL) — an integrated part's shared carve-out, so heap
#     `usage` rising during a start is the tell that llama.cpp put something on the iGPU, and
#     `usage` staying at 0 is the tell that it did not. There is no second device to disambiguate
#     against, so no -DeviceMatch parameter: this box has exactly one Vulkan device.
param([string]$Out, [int]$Seconds = 900, [int]$IntervalMs = 2000)

$end = (Get-Date).AddSeconds($Seconds)
"t_iso,llama_ws_mib,llama_private_mib,llama_procs,heap0_size_mib,heap0_budget_mib,heap0_usage_b,host_free_mib" |
  Out-File -Encoding utf8 $Out

function Heap0() {
  # vulkaninfo prints one "GPU id : N (<name>)" section per device; this box has exactly one.
  $txt = (vulkaninfo 2>$null) -join "`n"
  $m = [regex]::Match($txt, 'memoryHeaps\[0\]:\s*\n\s*size\s*=\s*(\d+)[^\n]*\n\s*budget\s*=\s*(\d+)[^\n]*\n\s*usage\s*=\s*(\d+)')
  if (-not $m.Success) { return $null }
  return [pscustomobject]@{
    size   = [int64]$m.Groups[1].Value
    budget = [int64]$m.Groups[2].Value
    usage  = [int64]$m.Groups[3].Value
  }
}

# Numbers are formatted with InvariantCulture on purpose. The first copy of this script used
# `[math]::Round(...)` interpolated directly into the row, which on a German-locale Windows
# renders 3661.0 as "3661,0" — a decimal COMMA that splits one value across two CSV columns and
# silently shifts every column after it. Format explicitly, never rely on the ambient culture.
$inv = [Globalization.CultureInfo]::InvariantCulture
function N2([double]$x) { $x.ToString('F2', $inv) }

while ((Get-Date) -lt $end) {
  $p = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)
  $ws   = if ($p.Count) { (($p | Measure-Object WorkingSet64 -Sum).Sum) / 1MB } else { 0 }
  $priv = if ($p.Count) { (($p | Measure-Object PrivateMemorySize64 -Sum).Sum) / 1MB } else { 0 }
  $h = Heap0
  $os = Get-CimInstance Win32_OperatingSystem
  $row = @(
    (Get-Date).ToUniversalTime().ToString('o', $inv)
    (N2 $ws), (N2 $priv), $p.Count
    $(if ($h) { N2 ($h.size / 1MB) } else { '' })
    $(if ($h) { N2 ($h.budget / 1MB) } else { '' })
    $(if ($h) { $h.usage } else { '' })
    ([math]::Round($os.FreePhysicalMemory / 1KB)).ToString($inv)
  ) -join ','
  $row | Out-File -Encoding utf8 -Append $Out
  Start-Sleep -Milliseconds $IntervalMs
}
