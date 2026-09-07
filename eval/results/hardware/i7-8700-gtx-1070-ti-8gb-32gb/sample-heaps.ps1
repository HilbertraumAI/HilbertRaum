# Samples the Vulkan heap budgets (VK_EXT_memory_budget via vulkaninfo) and nvidia-smi used memory
# every ~2 s for the duration of one #318 start. Answers protocol question (e): does the 214 MiB
# BAR heap (heap 2) budget move while llama-server holds the card.
param([string]$Out, [int]$Seconds = 480, [int]$IntervalMs = 2000)
$end = (Get-Date).AddSeconds($Seconds)
"t_iso,heap0_budget_mib,heap1_budget_mib,heap2_budget_mib,heap0_usage_b,heap1_usage_b,heap2_usage_b,smi_used_mib" | Out-File -Encoding utf8 $Out
while ((Get-Date) -lt $end) {
  $lines = @(vulkaninfo 2>$null)
  $start = [array]::FindIndex($lines, [Predicate[string]]{ param($l) $l -match 'VkPhysicalDeviceMemoryProperties' })
  $b = @(); $u = @()
  if ($start -ge 0) {
    for ($k = $start; $k -lt [math]::Min($start + 30, $lines.Count); $k++) {
      if ($lines[$k] -match '^\s+budget\s+=\s+(\d+)') { $b += [int64]$Matches[1] }
      if ($lines[$k] -match '^\s+usage\s+=\s+(\d+)') { $u += [int64]$Matches[1] }
    }
  }
  $smi = (nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits).Trim()
  $mib = { param($x) if ($null -ne $x) { [math]::Round($x / 1MB, 2) } else { '' } }
  "$((Get-Date).ToUniversalTime().ToString('o')),$(& $mib $b[0]),$(& $mib $b[1]),$(& $mib $b[2]),$($u[0]),$($u[1]),$($u[2]),$smi" | Out-File -Encoding utf8 -Append $Out
  Start-Sleep -Milliseconds $IntervalMs
}
