// Join the Phase-29 QA + speed/RSS halves into the combined results row per machine x backend
// (docs/model-benchmarks.md §5 — "one row per model x laptop x backend"). Run:
//
//   node eval/combine.mjs
//
// For each <stem>-quality-rescored.csv (authoritative QA) + <stem>-speed.csv it writes
// eval/results/<stem>.csv. Join key = model id (the speed CSV's model has a .gguf suffix).
// A stem with no speed CSV is a quality-only run: it gets no combined file of its own.
// apps/desktop/tests/eval/combine.test.ts re-runs this script over the committed inputs and
// compares the output with the committed combined CSVs byte for byte (#833).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), 'results')
const readCsv = (p) => {
  const [head, ...rows] = readFileSync(p, 'utf8').trim().split('\n')
  const cols = head.split(',')
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])))
}
// Extra rescored QA runs whose models join a stem's own QA. The i9 speed run covers the four Gemma 4 models whose
// QA was run in a separate wave. First source wins: the stem's own rescored CSV, then these in order. A model that
// is in both runs (gemma4-12b, qwen3.6-27b-q4) keeps the main run's whole row; a later source only adds missing models.
const EXTRA_QA = { 'i9-9900X-vulkan': ['i9-9900X-gemma4wave-vulkan'] }
const id = (m) => m.replace(/\.gguf$/, '')

// By name. mean_answer_chars sits right after mean_f1, as in the rescored CSVs, so the F1 is never read without the answer length (#378, #833).
const OUT_COLS = [
  'model', 'backend',
  'pp512_tps', 'pp2048_tps', 'pp8192_tps', 'tg_tps', 'peak_rss_gib', 'suggested_min_ram_gb',
  'em_rate', 'mean_f1', 'mean_answer_chars', 'citation_correct_rate', 'grounded_rate', 'over_abstain_rate',
  'abstain_rate_unans', 'hallucination_rate', 'em_rate_de', 'em_rate_en', 'f1_de', 'f1_en'
]

for (const f of readdirSync(RESULTS).filter((f) => f.endsWith('-quality-rescored.csv'))) {
  const stem = f.replace(/-quality-rescored\.csv$/, '')
  const speedPath = join(RESULTS, `${stem}-speed.csv`)
  if (!existsSync(speedPath)) {
    console.log(`skip ${stem}: no speed CSV (quality-only run)`)
    continue
  }
  const quality = new Map()
  for (const src of [f, ...(EXTRA_QA[stem] ?? []).map((x) => `${x}-quality-rescored.csv`)]) {
    for (const r of readCsv(join(RESULTS, src))) if (!quality.has(id(r.model))) quality.set(id(r.model), r)
  }
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
