// Offline re-score of a completed benchmark run (model-benchmarks.md §2).
//
//   node eval/rescore.mjs                  # every dump
//   node eval/rescore.mjs --existing-only  # only the dumps that already have a rescored CSV
//
// Re-applies the CURRENT abstention detector (apps/desktop/tests/eval/text.mjs — shared
// VERBATIM with the harness scorer) to every `eval/results/*-items.jsonl` dump and rewrites
// the per-model quality CSV as `*-quality-rescored.csv`. This is why the harness dumps every
// raw answer: when the heuristic improves (as it did after auditing the first run's
// unanswerable answers), we recompute the numbers WITHOUT re-running any model.
// `--existing-only` is for a scorer change that adds a column: it refreshes the committed CSVs
// without minting new authoritative ones for runs that never had one (#378).
//
// Only abstention-derived fields change. `em`, `f1`, `citationCorrect`, `grounded`, `lang`
// are taken from the dump (they don't depend on the abstention detector); the answer length is
// recomputed from the dumped `answer`. The aggregate formulas mirror score.ts `aggregate()`
// (guarded by score.test.ts, which runs this script).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isAbstention } from '../apps/desktop/tests/eval/text.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(DIR, 'results')

const args = process.argv.slice(2)
const unknownArgs = args.filter((a) => a !== '--existing-only')
if (unknownArgs.length > 0) {
  // Refused rather than ignored: a mistyped flag would otherwise write a CSV for every dump.
  console.error(`Unknown argument(s): ${unknownArgs.join(' ')}. Usage: node eval/rescore.mjs [--existing-only]`)
  process.exit(2)
}
const existingOnly = args.includes('--existing-only')

const HEADER = [
  'model', 'n', 'em_rate', 'mean_f1', 'mean_answer_chars', 'citation_correct_rate', 'grounded_rate',
  'over_abstain_rate', 'abstain_rate_unans', 'hallucination_rate',
  'em_rate_de', 'em_rate_en', 'f1_de', 'f1_en'
]
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const rate = (n, d) => (d ? n / d : 0)
const f = (x) => x.toFixed(4)
const chars = (x) => x.toFixed(1) // a mean character count, as score.ts `chars`

function aggregate(model, scores) {
  const ans = scores.filter((s) => !s.unanswerable)
  const un = scores.filter((s) => s.unanswerable)
  const de = ans.filter((s) => s.lang === 'de')
  const en = ans.filter((s) => s.lang === 'en')
  return {
    model,
    n: scores.length,
    em_rate: rate(ans.filter((s) => s.em === 1).length, ans.length),
    mean_f1: mean(ans.map((s) => s.f1)),
    mean_answer_chars: mean(ans.map((s) => s.answerChars)),
    citation_correct_rate: rate(ans.filter((s) => s.citationCorrect).length, ans.length),
    grounded_rate: rate(ans.filter((s) => s.grounded).length, ans.length),
    over_abstain_rate: rate(ans.filter((s) => s.abstained && s.em === 0).length, ans.length),
    abstain_rate_unans: rate(un.filter((s) => s.abstained).length, un.length),
    hallucination_rate: rate(un.filter((s) => !s.abstained).length, un.length),
    em_rate_de: rate(de.filter((s) => s.em === 1).length, de.length),
    em_rate_en: rate(en.filter((s) => s.em === 1).length, en.length),
    f1_de: mean(de.map((s) => s.f1)),
    f1_en: mean(en.map((s) => s.f1))
  }
}

const rescoredPath = (stem) => join(RESULTS, `${stem}-quality-rescored.csv`)
const stemOf = (file) => file.replace(/-items\.jsonl$/, '')
const dumps = readdirSync(RESULTS)
  .filter((f) => f.endsWith('-items.jsonl'))
  .filter((f) => !existingOnly || existsSync(rescoredPath(stemOf(f))))
if (dumps.length === 0) {
  console.error(`No *-items.jsonl dumps${existingOnly ? ' with a rescored CSV' : ''} in ${RESULTS}`)
  process.exit(1)
}

for (const file of dumps) {
  const stem = stemOf(file)
  const rows = readFileSync(join(RESULTS, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const byModel = new Map()
  for (const r of rows) {
    const abstained = isAbstention(r.answer)
    const score = {
      lang: r.lang, unanswerable: r.unanswerable, em: r.em, f1: r.f1,
      citationCorrect: r.citationCorrect, grounded: r.grounded, abstained,
      // recompute the verdict with the new abstention + the post-audit `correct` rule
      correct: r.unanswerable ? abstained : r.em === 1 && r.citationCorrect,
      // UTF-16 code units, the same expression as score.ts `scoreItem` (#378)
      answerChars: r.answer.length
    }
    if (!byModel.has(r.model)) byModel.set(r.model, { scores: [], oldHall: 0, un: 0 })
    const m = byModel.get(r.model)
    m.scores.push(score)
    if (r.unanswerable) { m.un++; if (!r.abstained) m.oldHall++ }
  }

  const csv = [HEADER.join(',')]
  console.log(`\n=== ${stem}  (re-scored; abstention detector v4, 2026-09-27 — #517) ===`)
  console.log('model'.padEnd(34) + 'halluc% old->new   abstain(unans)%')
  for (const [model, m] of byModel) {
    const a = aggregate(model, m.scores)
    csv.push([
      a.model, a.n, f(a.em_rate), f(a.mean_f1), chars(a.mean_answer_chars), f(a.citation_correct_rate),
      f(a.grounded_rate), f(a.over_abstain_rate), f(a.abstain_rate_unans), f(a.hallucination_rate),
      f(a.em_rate_de), f(a.em_rate_en), f(a.f1_de), f(a.f1_en)
    ].join(','))
    const oldH = (rate(m.oldHall, m.un) * 100).toFixed(0)
    const newH = (a.hallucination_rate * 100).toFixed(0)
    console.log(
      model.padEnd(34) + `${oldH}% -> ${newH}%`.padEnd(19) + `${(a.abstain_rate_unans * 100).toFixed(0)}%`
    )
  }
  const out = rescoredPath(stem)
  writeFileSync(out, csv.join('\n') + '\n', 'utf8')
  console.log(`wrote ${out}`)
}
