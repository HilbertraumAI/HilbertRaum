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
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(__dirname)
const htmlTsPath = join(repoRoot, 'apps/desktop/src/main/services/zim/html.ts')
const fixturesDirDefault = join(repoRoot, 'apps/desktop/tests/fixtures/zim')

const { zimArticleToSegments } = await import(pathToFileURL(htmlTsPath).href)

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

// ---- Verdict ----
const GATES = { laptop: { oneMiB: 50, batch: 150 }, 'early-warning': { oneMiB: 50 / 3, batch: 150 / 3 } }
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
function main() {
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

  console.log('\n== Verdict ==')
  const gate = GATES[gateProfile] ?? GATES['early-warning']
  const oneMiB = sectionA.maxes.find((m) => m.size === 1_048_576)
  console.log(verdictLine('(i) 1 MiB worst case', oneMiB?.warmMs ?? null, gate.oneMiB, oneMiB?.coldMs))
  console.log(verdictLine('(ii) 60-conversion batch', sectionB.warmTotalMs, gate.batch, sectionB.coldTotalMs))

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ header, sectionA, sectionB, sectionC }, null, 2))
    console.log(`\nJSON written to ${jsonPath}`)
  }
  process.exitCode = 0
}

main()
