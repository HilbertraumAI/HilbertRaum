# Samples the Vulkan heap budgets (VK_EXT_memory_budget via vulkaninfo) and nvidia-smi used memory
# every ~2 s for the duration of one #318 start.
#
# ADAPTED FOR THIS MACHINE (hybrid laptop). The GTX-1070-Ti session's copy took the FIRST
# `VkPhysicalDeviceMemoryProperties` block, which on a single-card desktop is the card. Here the
# integrated AMD Radeon(TM) Graphics is enumerated FIRST (and twice over, under two ICDs), so the
# first block is the iGPU's. This version selects the block belonging to -DeviceMatch (default
# 'NVIDIA') and additionally records the iGPU's device-local budget, because llama.cpp's `--fit`
# spreads over every listed device (#320) and this machine is exactly the hybrid case.
#
# Protocol question (e) — does an allocation land in a small BAR heap — has no subject on this
# card: the RTX 3060 Laptop exposes ONE device-local heap (5,994 MiB) and one host heap, with no
# separate ~256 MiB BAR heap of the kind the RTX 3090 and GTX 1070 Ti expose. The iGPU's 256 MiB
# device-local heap is a different thing (an APU carve-out) and is sampled as `igpu_heap2_*`.
param([string]$Out, [int]$Seconds = 480, [int]$IntervalMs = 2000, [string]$DeviceMatch = 'NVIDIA')

$end = (Get-Date).AddSeconds($Seconds)
"t_iso,dgpu_heap0_budget_mib,dgpu_heap0_usage_b,dgpu_heap1_budget_mib,igpu_heap0_budget_mib,igpu_heap0_usage_b,igpu_heap2_budget_mib,igpu_heap2_usage_b,smi_used_mib" | Out-File -Encoding utf8 $Out

function HeapsFor([string]$text, [string]$match) {
  # vulkaninfo prints one "GPU id : N (<name>)" section per device; take the memory heaps of the
  # first section whose deviceName matches, so a hybrid box never mixes the two devices' figures.
  foreach ($block in ($text -split 'GPU id\s*:\s*' | Select-Object -Skip 1)) {
    $name = ([regex]::Match($block, 'deviceName\s*=\s*(.+)')).Groups[1].Value.Trim()
    if ($name -notmatch $match) { continue }
    $heaps = @()
    foreach ($h in [regex]::Matches($block, 'memoryHeaps\[(\d+)\]:\s*\n\s*size\s*=\s*(\d+)[^\n]*\n\s*budget\s*=\s*(\d+)[^\n]*\n\s*usage\s*=\s*(\d+)')) {
      $heaps += [pscustomobject]@{ budget = [int64]$h.Groups[3].Value; usage = [int64]$h.Groups[4].Value }
    }
    return $heaps
  }
  return @()
}

while ((Get-Date) -lt $end) {
  $txt = (vulkaninfo 2>$null) -join "`n"
  $d = HeapsFor $txt $DeviceMatch
  $i = HeapsFor $txt 'Radeon'
  $smi = (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits).Trim()
  $mib = { param($x) if ($null -ne $x) { [math]::Round($x / 1MB, 2) } else { '' } }
  $row = @(
    (Get-Date).ToUniversalTime().ToString('o')
    (& $mib $d[0].budget), $d[0].usage, (& $mib $d[1].budget)
    (& $mib $i[0].budget), $i[0].usage, (& $mib $i[2].budget), $i[2].usage
    $smi
  ) -join ','
  $row | Out-File -Encoding utf8 -Append $Out
  Start-Sleep -Milliseconds $IntervalMs
}
