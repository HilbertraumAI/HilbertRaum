// Assemble one #318 start comment from <stem>.json + <stem>.fields.json (the hand-written fields).
// Usage: node mk-comment.mjs <dir> <stem>   → writes <dir>/<stem>.comment.md
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const [dir, stem] = process.argv.slice(2)
const j = JSON.parse(readFileSync(path.join(dir, stem + '.json'), 'utf8'))
const f = JSON.parse(readFileSync(path.join(dir, stem + '.fields.json'), 'utf8'))
const gib = (b) => (b / 1024 ** 3).toFixed(2) + ' GiB'
const t = j.timings
const body = `### Start: ${j.hw_slug} · leg ${j.leg} · ${j.variant}
1. **File:** \`${j.model_id}\` · \`${j.model_file}\` · ${j.model_bytes.toLocaleString('en-US')} B (${gib(j.model_bytes)}) · sha256 \`${f.sha256}\`
2. **Runtime:** ${j.runtime} · ${f.runtime_env} · driver ${f.driver} · heaps: ${f.heaps}
3. **Argv:** \`llama-server ${j.argv}\` (source: ${f.argv_sources})
4. **Memory at start:** device_info ${f.device_info_free_total} · nvidia-smi ${j.before.nvidia_smi.used}/${j.before.nvidia_smi.total} MiB used/total (${j.before.nvidia_smi.free} free) · desktop: ${f.desktop}
5. **Fit outcome:** ${f.fit}
6. **Peak use:** ${j.peak_nvidia_smi.used} MiB used (nvidia-smi, 1 s polling; +${j.peak_nvidia_smi.used - j.before.nvidia_smi.used} MiB over the pre-spawn figure; ${j.after_load.nvidia_smi.used} MiB right after load, ${j.after_stop.nvidia_smi.used} MiB after stop) during ${t.prompt_n}-token prefill / ${t.predicted_n}-token decode
7. **Speed:** decode ${t.predicted_per_second.toFixed(2)} tok/s (\`predicted_per_second\`, ${t.predicted_n} tokens in ${(t.predicted_ms / 1000).toFixed(1)} s) · prefill ${t.prompt_per_second.toFixed(1)} tok/s (\`prompt_per_second\`, ${t.prompt_n} tokens in ${(t.prompt_ms / 1000).toFixed(1)} s) · load to /health ${(j.load_ms / 1000).toFixed(1)} s
8. **Varied:** ${f.varied}
9. **App view:** ${f.app_view}
**Predicted vs measured:** ${f.predicted_vs_measured}
<details><summary>Load-log excerpt (redacted, ${j.excerpt.length} lines)</summary>

\`\`\`text
${j.excerpt.join('\n')}
\`\`\`
</details>
`
writeFileSync(path.join(dir, stem + '.comment.md'), body)
console.log(path.join(dir, stem + '.comment.md'))
