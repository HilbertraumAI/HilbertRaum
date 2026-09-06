// ZIM article HTML converter — D2 performance measurement (PR #294 / issue #301, Phase 1, H1).
// Recorded gate: docs/rag-design.md §17 D-Z3.
//
// Measures `zimArticleToSegments` (apps/desktop/src/main/services/zim/html.ts) against the D2
// gate: (i) worst-case 1 MiB pathological article <= 50 ms and (ii) ruled batch B01 — 60
// conversions (12 packs x 5 articles at real ~30 KB sizes) <= 150 ms total — both on the
// i7-8550U reference laptop. Plain Node, no deps beyond builtins; not under tests/**, so
// Vitest's `tests/**/*.test.{ts,tsx}` include never collects it, and it runs outside Electron
// (no Smart App Control).
//
// Cold vs warm: "cold" is the very first call of a given (family, size) input in the process,
// timed BEFORE any warm-up call of that same input. "Warm" is the median of 20 timed calls
// after 5 untimed warm-up calls of that same input (Section C uses fewer — see runSectionC).
// Different inputs never share a cold measurement; incidental JIT warm-up from earlier
// families/sizes may still carry over, which is why "warm" (not "cold") is what the gate checks.
//
// Run (from the repo root): node --no-warnings scripts/zim-html-perf.mjs [flags]
// Node 24 imports html.ts directly via type stripping (a MODULE_TYPELESS_PACKAGE_JSON warning
// is expected — `--no-warnings` silences it). Node 22 needs `--experimental-strip-types`.
//
// Flags:
//   --quick           Cap Section A (pathologies) to 30k/60k chars — the pre-P1 quadratic
//                      converter is too slow on 300k/1 MiB pathological input for a smoke run.
//                      Section B/C are unaffected (well-formed ~30 KB content is fast
//                      regardless of H1). Full sizes are the orchestrator's run post-scanner.
//   --json <path>     Also write the full result set as JSON to <path>.
//   --fixtures <dir>  Real *.html kiwix-serve articles for Section B (cycled to 60); falls back
//                      to $HILBERTRAUM_ZIM_FIXTURES, else synthetic articles.
//   --slice-work <n>  Section D slice size in work units (default: the converter's
//                      DEFAULT_SLICE_WORK). Lets a slow machine try a smaller slice without a code
//                      change — the per-slice gate is what it tunes.
//   --gate <profile>  laptop | early-warning (default). laptop = i7-8550U decisive figures
//                      (50 ms / 150 ms); early-warning = one third (~17 ms / ~50 ms), the
//                      i9-14900K rule (a P-core is ~2.5-3x an 8550U core).
//
// Hybrid CPUs (the i9-14900K dev box has 8 P-cores + 16 E-cores): Windows may schedule the
// single-threaded converter on an E-core, which measured ~1.7-2x slower than a P-core here, and
// an unpinned run landed in between. The one-third early-warning rule assumes a P-core, so pin
// the run and record which cores it ran on — from cmd.exe:
//   start /affinity FFFF /b /wait node --no-warnings scripts/zim-html-perf.mjs   (P-cores 0-15)
//   start /affinity FFFF0000 /b /wait node --no-warnings scripts/zim-html-perf.mjs (E-cores 16-31)
// The i7-8550U (the decisive laptop) has no E-cores; run it unpinned.
//
// Exit code is always 0 — this is a report, not a test.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { PerformanceObserver } from 'node:perf_hooks'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(__dirname)
const htmlTsPath = join(repoRoot, 'apps/desktop/src/main/services/zim/html.ts')
const fixturesDirDefault = join(repoRoot, 'apps/desktop/tests/fixtures/zim')

const { zimArticleToSegments, zimArticleSlices, DEFAULT_SLICE_WORK } = await import(
  pathToFileURL(htmlTsPath).href
)

// ---- CLI ----
const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const quick = hasFlag('--quick')
const jsonPath = flagValue('--json', null)
const fixturesDir = flagValue('--fixtures', process.env.HILBERTRAUM_ZIM_FIXTURES || null)
const gateProfile = flagValue('--gate', 'early-warning')
const sliceWorkArg = Number.parseInt(flagValue('--slice-work', ''), 10)
const sliceWork = Number.isFinite(sliceWorkArg) && sliceWorkArg > 0 ? sliceWorkArg : DEFAULT_SLICE_WORK

// ---- Converter call + generic result-field access (tolerates the old converter, which returns
// only {title, segments} — the new contract adds {truncated, work}). The converter runs with its
// PRODUCTION defaults (1 MiB maxChars, the default work budget): the gate measures what the app
// does, so the 1 MiB rows are sized to fit the cap including the lead/tail wrapper. ----
function convert(html) {
  return zimArticleToSegments(html)
}
const outputChars = (r) => (r.segments ?? []).reduce((a, s) => a + s.text.length, 0)
const workCell = (r) => (typeof r.work === 'number' ? r.work : 'n/a')
const truncatedCell = (r) => (!('truncated' in r) ? 'n/a' : r.truncated === null ? '-' : r.truncated.reason)

/** The p-quantile of xs (p in [0,1]), nearest-rank. */
function quantile(xs, p) {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function timeOnce(html) {
  const t0 = performance.now()
  const result = convert(html)
  return { ms: performance.now() - t0, result }
}
function timeWarm(html, warmups = 5, runs = 20) {
  for (let i = 0; i < warmups; i++) convert(html)
  const times = []
  let result
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    result = convert(html)
    times.push(performance.now() - t0)
  }
  return { ms: median(times), result }
}

// ---- Synthetic content generators (shared by Section A's "wellformed" family and Section B's
// synthetic articles) — a small Parsoid-like article, tiled until it reaches a target length. ----
const TOPICS = ['Nitrogen fixation', 'Volcanic activity', 'River deltas', 'Steel alloys', 'Cloud formation']

function articleChunk(seed, i) {
  const topic = TOPICS[seed % TOPICS.length]
  return (
    `<div class="mw-heading mw-heading2"><h2 id="s${i}">Section ${i}: ${topic}</h2></div>` +
    `<p>Paragraph ${i} describes ${topic} in technical detail, mixing named &amp; numeric entities like &#8201;a thin space.</p>` +
    `<p><math alttext="x_{${i}} = y_{${i}} + 1">x</math> a follow-up sentence with` +
    `<sup class="mw-ref reference"><a href="#n${i}">[${i}]</a></sup> a reference marker.</p>` +
    (i === 0 ? '<table class="infobox"><tbody><tr><th>Field</th><td>Value</td></tr></tbody></table>' : '') +
    `<ul><li>Point A${i}</li><li>Point B${i}</li></ul>`
  )
}
function tiledArticleBody(seed, targetLen) {
  let out = ''
  for (let i = 0; out.length < targetLen; i++) out += articleChunk(seed, i)
  if (seed === 0) out += '<figure><img src="x.jpg"><figcaption>Figure caption</figcaption></figure>'
  return out
}
function syntheticArticleDoc(seed, targetLen) {
  const topic = TOPICS[seed % TOPICS.length]
  return (
    `<!DOCTYPE html><html><head><title>${topic}</title></head><body><h1>${topic}</h1>` +
    tiledArticleBody(seed, targetLen) +
    '</body></html>'
  )
}

// ---- Section A: pathology families ----
function repeatToLength(unit, targetLen) {
  if (targetLen <= 0) return ''
  return unit.repeat(Math.ceil(targetLen / unit.length)).slice(0, targetLen)
}
const FAMILY_BODY = {
  'unclosed-lt': (n) => repeatToLength('<x ', n),
  'unmatched-quote': (n) => repeatToLength('<a href="unterminated attribute value keeps going ', n),
  'unterminated-comment': (n) => '<!--' + repeatToLength('filler text inside an unterminated comment block ', Math.max(0, n - 4)),
  'unterminated-script': (n) =>
    '<script>' + repeatToLength('var filler = "text inside an unterminated script block"; ', Math.max(0, n - 8)),
  'repeated-lt': (n) => repeatToLength('<<<<', n),
  'entity-heavy': (n) => repeatToLength('&amp;&#8201;&aaaa', n),
  'deep-nesting': (n) => {
    const text = 'deeply nested text marker '
    const d = Math.max(1, Math.floor((n - text.length) / ('<div>'.length + '</div>'.length)))
    return '<div>'.repeat(d) + text + '</div>'.repeat(d)
  },
  wellformed: (n) => tiledArticleBody(0, n)
}
const WRAP_LEN = '<p>lead</p><p>tail</p>'.length
const wrapPathology = (body) => `<p>lead</p>${body}<p>tail</p>`

const FULL_SIZES = [30_000, 60_000, 300_000, 1_048_576]
const QUICK_SIZES = [30_000, 60_000]

function runSectionA(sizes) {
  const rows = []
  const maxes = []
  for (const size of sizes) {
    const sizeRows = []
    for (const [family, bodyFn] of Object.entries(FAMILY_BODY)) {
      const html = wrapPathology(bodyFn(size - WRAP_LEN)) // total = size exactly (1 MiB fits the cap)
      const cold = timeOnce(html)
      const warm = timeWarm(html)
      const work = workCell(warm.result)
      sizeRows.push({
        family,
        size,
        chars: html.length,
        coldMs: cold.ms,
        warmMs: warm.ms,
        work,
        workPerChar: typeof work === 'number' ? (work / html.length).toFixed(3) : 'n/a',
        outputChars: outputChars(warm.result),
        truncated: truncatedCell(warm.result)
      })
    }
    rows.push(...sizeRows)
    const worstWarm = sizeRows.reduce((a, b) => (b.warmMs > a.warmMs ? b : a))
    const worstCold = sizeRows.reduce((a, b) => (b.coldMs > a.coldMs ? b : a))
    maxes.push({
      size,
      warmMs: worstWarm.warmMs,
      warmFamily: worstWarm.family,
      coldMs: worstCold.coldMs,
      coldFamily: worstCold.family
    })
  }
  return { rows, maxes }
}

// ---- Section B: the ruled batch (B01) — 60 conversions = 12 packs × 5 articles at ~30 KB ----
function loadBatchArticles() {
  const dir = fixturesDir && existsSync(fixturesDir) ? fixturesDir : null
  if (dir) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.html'))
    if (files.length > 0) {
      return { articles: files.map((f) => ({ name: f, html: readFileSync(join(dir, f), 'utf8') })), source: dir }
    }
  }
  const articles = Array.from({ length: 5 }, (_, i) => ({
    name: `synthetic-${i}.html`,
    html: syntheticArticleDoc(i, 28_000 + i * 1_000)
  }))
  return { articles, source: 'synthetic' }
}

function runSectionB() {
  const { articles, source } = loadBatchArticles()
  const batch = Array.from({ length: 60 }, (_, i) => articles[i % articles.length])

  const t0 = performance.now()
  for (const a of batch) convert(a.html)
  const coldTotalMs = performance.now() - t0

  const passTimes = []
  let lastPassResults = []
  for (let p = 0; p < 10; p++) {
    const results = []
    const s = performance.now()
    for (const a of batch) results.push(convert(a.html))
    passTimes.push(performance.now() - s)
    lastPassResults = results
  }
  const warmTotalMs = median(passTimes)
  const worksKnown = lastPassResults.every((r) => typeof r.work === 'number')
  return {
    source,
    articleSizes: articles.map((a) => ({ name: a.name, chars: a.html.length })),
    coldTotalMs,
    warmTotalMs,
    perConversionMeanMs: warmTotalMs / batch.length,
    totalWork: worksKnown ? lastPassResults.reduce((a, r) => a + r.work, 0) : 'n/a',
    totalOutputChars: lastPassResults.reduce((a, r) => a + outputChars(r), 0)
  }
}

// ---- Section C: the committed fixtures — a sanity row each ----
function runSectionC() {
  const files = ['article.html', 'parsoid-datamw.html', 'zimit-page.html', 'devdocs-page.html', 'stackexchange-question.html']
  const rows = []
  for (const f of files) {
    const p = join(fixturesDirDefault, f)
    if (!existsSync(p)) continue
    const html = readFileSync(p, 'utf8')
    const warm = timeWarm(html, 3, 10)
    rows.push({
      file: f,
      chars: html.length,
      warmMs: warm.ms,
      work: workCell(warm.result),
      outputChars: outputChars(warm.result),
      truncated: truncatedCell(warm.result)
    })
  }
  return rows
}

// ---- Section D: cooperative slicing (P1b) — per-slice main-thread stall ----
// The D2 remedy is slicing, so the gate that matters is no longer the total but the longest
// single main-thread stall between two yields. This drives `zimArticleSlices` by hand and
// times every `next()` call: that is exactly the work the event loop cannot interrupt.
//
// EVERY pathology family is measured at 1 MiB, not only Section A's worst by total: the
// slowest family overall is not the one with the longest single slice. A family whose work
// arrives in one indivisible hop (one giant text run, one failed lookahead) does most of its
// work — including `decodeEntities` over that run — inside a single slice, and the final
// `flush()`/`tidy()` after the loop is likewise one uninterruptible step. Those, not the scan,
// are what the per-slice gate has to survive, and they are invisible in a totals-only view.
//
// The 1 MiB leg always runs at 1 MiB even under --quick (which caps Section A at 60k): a
// per-slice measurement needs a multi-slice input, and post-scanner one 1 MiB conversion is a
// few tens of ms, not the minutes the pre-P1 quadratic converter took.
// ---- GC attribution (P1b follow-up). The reference laptop showed 6-9 ms batch-leg maxima that did
// NOT shrink when sliceWork halved, at a random article each run: not scan work, so the likeliest
// cause is an allocation-driven minor GC pause landing inside a slice. Count and time the GC
// events per row so the verdict can say "GC" from evidence, not from inference. Entries reach the
// observer asynchronously, so each row awaits one macrotask before reading its counters.
const gc = { n: 0, ms: 0, majors: 0 }
let gcObserver = null
try {
  gcObserver = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gc.n += 1
      gc.ms += e.duration
      // kind 2 = mark-sweep-compact (major); 4 = scavenge (minor) in Node's perf_hooks constants.
      if (e.detail?.kind === 2 || e.kind === 2) gc.majors += 1
    }
  })
  gcObserver.observe({ entryTypes: ['gc'] })
} catch {
  gcObserver = null
}
const flushGc = () => new Promise((resolve) => setImmediate(resolve))
async function gcDelta(fn) {
  await flushGc()
  const n0 = gc.n
  const ms0 = gc.ms
  const maj0 = gc.majors
  const result = await fn()
  await flushGc()
  return { result, gcN: gc.n - n0, gcMs: gc.ms - ms0, gcMajors: gc.majors - maj0 }
}

function sliceTimes(html) {
  const run = zimArticleSlices(html, { sliceWork })
  const times = []
  let result = null
  for (;;) {
    const s = performance.now()
    const step = run.next()
    times.push(performance.now() - s)
    if (step.done) {
      result = step.value
      break
    }
  }
  return { times, result }
}

async function sliceRow(label, html, warmups) {
  for (let i = 0; i < warmups; i++) sliceTimes(html)
  const { result: runs, gcN, gcMs, gcMajors } = await gcDelta(async () =>
    [sliceTimes(html), sliceTimes(html), sliceTimes(html)].map(({ times, result }) => ({
      times,
      result,
      maxMs: Math.max(...times),
      totalMs: times.reduce((a, b) => a + b, 0)
    }))
  )
  // Three timed runs. The reported max is the MEDIAN of the three runs' maxima, not the worst
  // sample: at sub-millisecond slice sizes a single OS interruption or JIT tier-up shows up as
  // one 3-6x outlier at a random slice index, and the point of this gate is the longest
  // uninterruptible unit of OUR work, which is present in every run. `worstMaxMs` keeps the
  // outlier visible — a real indivisible step makes the two columns agree.
  const byTotal = [...runs].sort((a, b) => a.totalMs - b.totalMs)
  const { times, result, totalMs } = byTotal[1]
  const maxima = runs.map((r) => r.maxMs).sort((a, b) => a - b)
  const pooledTimes = runs.flatMap((r) => r.times)
  const syncMs = timeWarm(html, 2, 5).ms
  return {
    label,
    chars: html.length,
    slices: times.length,
    reportedSlices: result.slices,
    maxMs: maxima[1],
    p95Ms: quantile(pooledTimes, 0.95),
    worstMaxMs: maxima[2],
    /** Which slice was the worst in the reported run — a fixed index across runs means a real
     *  indivisible step (a giant leading text run, or a trailing flush); a random one is noise. */
    maxAt: times.indexOf(Math.max(...times)),
    medianMs: median(times),
    totalMs,
    syncMs,
    overheadPct: (totalMs / syncMs - 1) * 100,
    /** GC events (and their summed ms, majors) observed during the three timed runs. */
    gcN,
    gcMs,
    gcMajors
  }
}

async function runSectionD() {
  const oneMiB = []
  for (const [family, bodyFn] of Object.entries(FAMILY_BODY)) {
    oneMiB.push(await sliceRow(family, wrapPathology(bodyFn(1_048_576 - WRAP_LEN)), 2))
  }

  // The batch: 60 conversions driven slice by slice. The event loop turns between every pair
  // of slices, so the stall is the worst single slice pooled across the whole batch.
  const { articles, source } = loadBatchArticles()
  const batch = Array.from({ length: 60 }, (_, i) => articles[i % articles.length])
  for (const a of batch) sliceTimes(a.html)
  // Three passes over the batch, reported through the median of their maxima (see sliceRow),
  // with the GC events observed during them.
  const { result: passes, gcN: batchGcN, gcMs: batchGcMs, gcMajors: batchGcMajors } = await gcDelta(async () => {
    const out = []
    for (let p = 0; p < 3; p++) {
      const pooled = []
      let slices = 0
      let totalMs = 0
      for (const a of batch) {
        const { times } = sliceTimes(a.html)
        slices += times.length
        totalMs += times.reduce((x, y) => x + y, 0)
        pooled.push(...times)
      }
      out.push({ pooled, slices, totalMs, maxMs: Math.max(...pooled) })
    }
    return out
  })
  const batchMaxima = passes.map((p) => p.maxMs).sort((x, y) => x - y)
  const byTotal = [...passes].sort((x, y) => x.totalMs - y.totalMs)
  const { pooled, slices: batchSlices, totalMs: batchTotalMs } = byTotal[1]
  const batchSyncMs = median(
    Array.from({ length: 5 }, () => {
      const s = performance.now()
      for (const a of batch) convert(a.html)
      return performance.now() - s
    })
  )

  return {
    sliceWork,
    oneMiB,
    batch: {
      source,
      conversions: batch.length,
      slices: batchSlices,
      maxMs: batchMaxima[1],
      p95Ms: quantile(passes.flatMap((p) => p.pooled), 0.95),
      worstMaxMs: batchMaxima[2],
      medianMs: median(pooled),
      totalMs: batchTotalMs,
      syncMs: batchSyncMs,
      overheadPct: (batchTotalMs / batchSyncMs - 1) * 100,
      gcN: batchGcN,
      gcMs: batchGcMs,
      gcMajors: batchGcMajors
    },
    gcObserved: gcObserver !== null
  }
}

// ---- Verdict ----
// (iii) is the P1b gate: the longest uninterruptible main-thread stall between two yields.
// 5 ms on the i7-8550U reference is a third of a 16 ms frame; the early-warning profile is
// a third of that again, the i9-14900K P-core rule the other two thresholds already use.
const GATES = {
  laptop: { oneMiB: 50, batch: 150, slice: 5 },
  'early-warning': { oneMiB: 50 / 3, batch: 150 / 3, slice: 5 / 3 }
}
function verdictLine(label, value, thresholdMs, coldValue) {
  if (value === null || value === undefined) {
    return `${label}: n/a (size not run under --quick)`
  }
  const pass = value <= thresholdMs
  const ratio = (value / thresholdMs).toFixed(2)
  const cold = typeof coldValue === 'number' ? ` (cold ${coldValue.toFixed(2)} ms)` : ''
  return `${label}: ${pass ? 'PASS' : 'FAIL'}  measured=${value.toFixed(2)}ms threshold=${thresholdMs.toFixed(2)}ms ratio=${ratio}x${cold}`
}

// ---- Printing ----
function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)))
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  console.log(line(headers))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of rows) console.log(line(r))
}
function gitShortSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()
  } catch {
    return 'unknown'
  }
}

// ---- Main ----
async function main() {
  const cpus = os.cpus()
  const header = {
    date: new Date().toISOString(),
    gitSha: gitShortSha(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCores: cpus.length,
    ramGiB: (os.totalmem() / 2 ** 30).toFixed(1),
    gateProfile,
    mode: quick ? 'quick (Section A capped to 30k/60k)' : 'full'
  }
  console.log('ZIM HTML converter performance — D2 measurement (docs/rag-design.md §17 D-Z3)')
  console.log(`date: ${header.date}`)
  console.log(`git: ${header.gitSha}`)
  console.log(`node: ${header.node}  platform: ${header.platform}`)
  console.log(`cpu: ${header.cpuModel} (${header.cpuCores} logical cores)`)
  console.log(`ram: ${header.ramGiB} GiB`)
  console.log(`gate profile: ${header.gateProfile}`)
  console.log(`mode: ${header.mode}`)

  console.log('\n== Section A — pathologies (cold/warm ms, work, work/char, output chars, truncated) ==')
  const sectionA = runSectionA(quick ? QUICK_SIZES : FULL_SIZES)
  for (const size of quick ? QUICK_SIZES : FULL_SIZES) {
    console.log(`\n-- size ${size.toLocaleString()} chars --`)
    const sizeRows = sectionA.rows.filter((r) => r.size === size)
    printTable(
      ['family', 'chars', 'cold ms', 'warm ms', 'work', 'work/char', 'out chars', 'truncated'],
      sizeRows.map((r) => [
        r.family,
        r.chars,
        r.coldMs.toFixed(2),
        r.warmMs.toFixed(2),
        r.work,
        r.workPerChar,
        r.outputChars,
        r.truncated
      ])
    )
    const max = sectionA.maxes.find((m) => m.size === size)
    console.log(`MAX  warm=${max.warmMs.toFixed(2)}ms (${max.warmFamily})  cold=${max.coldMs.toFixed(2)}ms (${max.coldFamily})`)
  }

  console.log('\n== Section B — batch B01: 60 conversions (12 packs × 5 articles at ~30 KB) ==')
  const sectionB = runSectionB()
  console.log(`fixture set: ${sectionB.source}`)
  for (const a of sectionB.articleSizes) console.log(`  ${a.name}: ${a.chars} chars`)
  console.log(`cold total (first full pass): ${sectionB.coldTotalMs.toFixed(2)} ms`)
  console.log(`warm total (median of 10 passes): ${sectionB.warmTotalMs.toFixed(2)} ms`)
  console.log(`per-conversion mean (warm): ${sectionB.perConversionMeanMs.toFixed(3)} ms`)
  console.log(`total work: ${sectionB.totalWork}`)
  console.log(`total output chars: ${sectionB.totalOutputChars}`)

  console.log('\n== Section C — committed fixtures (sanity rows) ==')
  const sectionC = runSectionC()
  printTable(
    ['file', 'chars', 'warm ms', 'work', 'out chars', 'truncated'],
    sectionC.map((r) => [r.file, r.chars, r.warmMs.toFixed(2), r.work, r.outputChars, r.truncated])
  )

  console.log('\n== Section D — cooperative slicing (P1b): per-slice main-thread stall ==')
  const sectionD = await runSectionD()
  console.log(`sliceWork: ${sectionD.sliceWork} work units (every family at 1 MiB)`)
  printTable(
    ['family (1 MiB)', 'slices', 'max slice ms', 'p95 slice ms', 'worst of 3', 'worst slice #', 'median slice ms', 'total ms', 'sync ms', 'overhead %', 'gc n', 'gc ms'],
    sectionD.oneMiB.map((r) => [
      r.label,
      r.slices,
      r.maxMs.toFixed(3),
      r.p95Ms.toFixed(3),
      r.worstMaxMs.toFixed(3),
      `${r.maxAt}/${r.slices - 1}`,
      r.medianMs.toFixed(3),
      r.totalMs.toFixed(2),
      r.syncMs.toFixed(2),
      r.overheadPct.toFixed(1),
      r.gcN,
      r.gcMs.toFixed(2)
    ])
  )
  const worstOneMiB = sectionD.oneMiB.reduce((a, b) => (b.maxMs > a.maxMs ? b : a))
  console.log(
    `MAX per-slice (1 MiB): ${worstOneMiB.maxMs.toFixed(3)} ms in ${worstOneMiB.label}` +
      ` (slice ${worstOneMiB.maxAt} of ${worstOneMiB.slices - 1})`
  )
  printTable(
    ['batch leg', 'conversions', 'slices', 'max slice ms', 'p95 slice ms', 'worst of 3', 'median slice ms', 'total ms', 'sync ms', 'overhead %', 'gc n', 'gc ms'],
    [
      [
        sectionD.batch.source,
        sectionD.batch.conversions,
        sectionD.batch.slices,
        sectionD.batch.maxMs.toFixed(3),
        sectionD.batch.p95Ms.toFixed(3),
        sectionD.batch.worstMaxMs.toFixed(3),
        sectionD.batch.medianMs.toFixed(3),
        sectionD.batch.totalMs.toFixed(2),
        sectionD.batch.syncMs.toFixed(2),
        sectionD.batch.overheadPct.toFixed(1),
        sectionD.batch.gcN,
        sectionD.batch.gcMs.toFixed(2)
      ]
    ]
  )
  console.log(
    sectionD.gcObserved
      ? 'GC during the three batch passes: ' + sectionD.batch.gcN + ' events (' + sectionD.batch.gcMajors + ' major), ' + sectionD.batch.gcMs.toFixed(2) + ' ms - a GC pause inside a slice shows up as a random-index max that does not shrink with --slice-work'
      : 'GC observation unavailable on this Node'
  )
  console.log('\n== Verdict ==')
  const gate = GATES[gateProfile] ?? GATES['early-warning']
  const oneMiB = sectionA.maxes.find((m) => m.size === 1_048_576)
  console.log(verdictLine('(i) 1 MiB worst case', oneMiB?.warmMs ?? null, gate.oneMiB, oneMiB?.coldMs))
  console.log(verdictLine('(ii) 60-conversion batch', sectionB.warmTotalMs, gate.batch, sectionB.coldTotalMs))
  const worstSliceMs = Math.max(...sectionD.oneMiB.map((r) => r.maxMs), sectionD.batch.maxMs)
  console.log(verdictLine('(iii) max per-slice stall', worstSliceMs, gate.slice))
  const worstP95Ms = Math.max(...sectionD.oneMiB.map((r) => r.p95Ms), sectionD.batch.p95Ms)
  console.log(verdictLine('(iii-p95) per-slice stall, p95', worstP95Ms, gate.slice))

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ header, sectionA, sectionB, sectionC, sectionD }, null, 2))
    console.log(`\nJSON written to ${jsonPath}`)
  }
  process.exitCode = 0
}

await main()
