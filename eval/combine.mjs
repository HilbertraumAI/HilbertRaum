// Join the Phase-29 QA + speed/RSS halves into the combined results row per machine x backend
// (docs/model-benchmarks.md §5 — "one row per model x laptop x backend"). Run:
//
//   node eval/combine.mjs
//
// For each <stem>-quality-rescored.csv (authoritative QA) + <stem>-speed.csv it writes
// eval/results/<stem>.csv. Join key = model id (the speed CSV's model has a .gguf suffix).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), 'results')
const readCsv = (p) => {
  const [head, ...rows] = readFileSync(p, 'utf8').trim().split('\n')
  const cols = head.split(',')
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])))
}
const id = (m) => m.replace(/\.gguf$/, '')

const OUT_COLS = [
  'model', 'backend',
  'pp512_tps', 'pp2048_tps', 'pp8192_tps', 'tg_tps', 'peak_rss_gib', 'suggested_min_ram_gb',
  'em_rate', 'mean_f1', 'citation_correct_rate', 'grounded_rate', 'over_abstain_rate',
  'abstain_rate_unans', 'hallucination_rate', 'em_rate_de', 'em_rate_en', 'f1_de', 'f1_en'
]

for (const f of readdirSync(RESULTS).filter((f) => f.endsWith('-quality-rescored.csv'))) {
  const stem = f.replace(/-quality-rescored\.csv$/, '')
  const speedPath = join(RESULTS, `${stem}-speed.csv`)
  if (!existsSync(speedPath)) {
    console.log(`skip ${stem}: no speed CSV yet`)
    continue
  }
  const quality = new Map(readCsv(join(RESULTS, f)).map((r) => [id(r.model), r]))
  const speed = new Map(readCsv(speedPath).map((r) => [id(r.model), r]))
  const out = [OUT_COLS.join(',')]
  for (const [model, s] of speed) {
    const q = quality.get(model) ?? {}
    out.push(OUT_COLS.map((c) => (c === 'model' ? model : (s[c] ?? q[c] ?? ''))).join(','))
  }
  const outPath = join(RESULTS, `${stem}.csv`)
  writeFileSync(outPath, out.join('\n') + '\n', 'utf8')
  console.log(`wrote ${outPath} (${speed.size} models)`)
}
