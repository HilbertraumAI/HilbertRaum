// `performance:get`'s manifest-scan read cost — issue #333.
//
// The Performance screen builds every snapshot from a SYNCHRONOUS `discoverManifests` scan
// (`apps/desktop/src/main/services/models.ts`) beside a settings read and `detectSystem()`.
// `docs/benchmark.md` §2 row N6 / §4 row I5 record that this was measured ONCE, at ~100 ms, in a
// dev-build launch smoke on the reviewing machine's internal disk — never on the slow removable
// media the app is meant to run from, and the drive launchers point `HILBERTRAUM_MANIFESTS_DIR`
// at the drive's own copy, so the shipped path reads off the stick. This script produces the
// missing figures.
//
// Run (from the repo root):
//   node --no-warnings scripts/measure-manifest-read.mjs --dir <drive>/model-manifests
//   node --no-warnings scripts/measure-manifest-read.mjs --log <workspace>/logs/perf.log
//
// TWO MODES, and #333 wants both:
//
//   TRIALS (default) — repeats the scan against a directory and splits it three ways: the
//     recursive `readdirSync` walk, the `readFileSync` bytes, and YAML parse + `validateManifest`.
//     The validator is IMPORTED FROM THE APP'S OWN SOURCE (Node 24 type stripping), so the
//     expensive half is never reimplemented here; only the file-selection rule is restated (see
//     MANIFEST_EXTENSIONS below). No Electron, no workspace, no unlock — this is the media
//     measurement, and it is the one that can be repeated cold.
//
//   LOG (--log) — reads a real app run's opt-in `perf.log` (`HILBERTRAUM_PERF_LOG=1`) and
//     summarises the `performance_get` marks with the `discover_manifests` line each one sits
//     behind. This is the END-TO-END half: the actual IPC the renderer awaits, on the real drive,
//     through the real settings read. Pairing is by ADJACENCY — the two marks are synchronous and
//     consecutive — so a `discover_manifests` with anything between it and the next
//     `performance_get` is reported separately as another caller's scan (the §7.4 start gate, the
//     Models screen, the downloader and nine other call sites all scan too).
//
// COLD VS WARM IS THE WHOLE MEASUREMENT, and it is easy to get wrong: this project has recorded
// page-cache contamination three times (#392 a Models-screen hash, #404 a warm relaunch, #414
// an EXTERNAL `Get-FileHash` in the test protocol itself — 1,008 MB/s reported for a 407.9 MB/s
// drive). The manifests are ~158 KB total and stay resident indefinitely once read, so a naive
// "open the screen and time it" measures RAM and closes #333 on a fiction.
//
//   Cold  = the first read of these files since the drive's cache was dropped. On Windows there
//           is no supported way to drop it for a volume, so the protocol is: EJECT the drive,
//           re-insert it, then run with --cold-only. A reboot works too. Trial 1 of a normal run
//           is reported apart from the warm figures for the same reason, but it is only honestly
//           cold if nothing touched the directory since insertion.
//   Warm  = every later trial. This is what the Performance screen's push-driven refetch pays,
//           and its floor is parse+validate CPU, which no drive speed moves.
//
// THE RIG RUN, end to end — three commands, in this order:
//
//   1. Media half, cold. Eject the drive, re-insert it, then WITHOUT opening anything on it:
//        node --no-warnings scripts/measure-manifest-read.mjs --dir <drive>/model-manifests --cold-only
//      Repeat the eject/re-insert for each cold sample; run without --cold-only for the warm set.
//
//   2. End-to-end half. Launch the app with the perf log on, from the drive's own launcher so
//      HILBERTRAUM_MANIFESTS_DIR points at the drive (a two-line wrapper beside the launcher, the
//      #334 protocol's `_334-start-perf.cmd`):
//        @echo off
//        set "HILBERTRAUM_PERF_LOG=1"
//        call "%~dp0Start HilbertRaum.cmd" %*
//      Unlock, open Performance, and LEAVE IT OPEN through a few chat answers and a model start —
//      every one of those pushes a refetch, and that repeat cost is what the issue is about.
//
//   3. Summarise what the run wrote:
//        node --no-warnings scripts/measure-manifest-read.mjs --log <workspace>/logs/perf.log
//
// Take both halves on an IDLE machine: parse+validate dominates the warm cost, so a build or a
// test suite running alongside inflates the figures roughly twofold (observed while writing this).
//
// Flags:
//   --dir <path>     Manifests directory. Default: $HILBERTRAUM_MANIFESTS_DIR, else the repo's
//                    own `model-manifests/` (which measures the INTERNAL disk — fine for the CPU
//                    half, wrong for the media half; the script says so in the header it prints).
//   --trials <n>     Timed trials (default 10). Trial 1 is always reported separately.
//   --cold-only      One trial, then exit — the eject/re-insert protocol above.
//   --log <path>     LOG mode: summarise `performance_get` / `discover_manifests` from a perf.log.
//   --json <path>    Also write the full result set as JSON (for the evidence directory).
//
// Exit code is always 0 — this is a report, not a test.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(__dirname)

const { validateManifest } = await import(
  pathToFileURL(join(repoRoot, 'apps/desktop/src/shared/manifest.ts')).href
)

// RESTATED from models.ts:55-61 — the only rule this script duplicates. Keep them in step; a
// drift shows up immediately as a differing `files:` count against the app's own mark. (The
// script also skips the app's duplicate-id dedupe, which costs nothing and cannot fire on a
// catalog the committed-catalog test already forbids duplicates in — so `ok` here means
// "parsed and validated", where the app's means "accepted".)
const MANIFEST_EXTENSIONS = new Set(['.yaml', '.yml'])
const RESERVED_MANIFEST_FILES = new Set(['runtime-sources.yaml', 'runtime-sources.yml'])

// ---- args -----------------------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(name)

const coldOnly = has('--cold-only')
const trials = coldOnly ? 1 : Number(arg('--trials', '10'))
const jsonOut = arg('--json')
const logPath = arg('--log')
const manifestsDir =
  arg('--dir') ?? process.env.HILBERTRAUM_MANIFESTS_DIR ?? join(repoRoot, 'model-manifests')

// ---- helpers --------------------------------------------------------------------------------

const ms = (n) => `${n.toFixed(1)} ms`
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : '—')

function stats(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length
  }
}

function line(label, s) {
  if (!s) return `  ${label.padEnd(26)} —`
  return `  ${label.padEnd(26)} median ${ms(s.median).padStart(9)}   min ${ms(s.min).padStart(9)}   p95 ${ms(
    s.p95
  ).padStart(9)}   max ${ms(s.max).padStart(9)}   (n=${s.n})`
}

function machineHeader() {
  const cpu = os.cpus()?.[0]?.model?.trim() ?? 'unknown CPU'
  const ramGb = Math.round((os.totalmem() / 1e9) * 10) / 10
  return [
    `HilbertRaum — performance:get manifest-scan read cost (issue #333)`,
    `${new Date().toISOString()}`,
    `${os.platform()} ${os.arch()} · ${cpu} · ${os.cpus()?.length ?? 0} cores · ${ramGb} GB RAM`
  ].join('\n')
}

// ---- TRIALS mode ------------------------------------------------------------------------------

/** The walk, timed apart — mirrors `collectManifestFiles`. */
function collectManifestFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectManifestFiles(full))
    else if (
      MANIFEST_EXTENSIONS.has(extname(entry.name).toLowerCase()) &&
      !RESERVED_MANIFEST_FILES.has(entry.name.toLowerCase())
    )
      out.push(full)
  }
  return out
}

/** One full scan, split into the three phases `discover_manifests` marks in the app. */
function oneScan() {
  const t0 = performance.now()
  const files = collectManifestFiles(manifestsDir)
  const walkMs = performance.now() - t0

  let readMs = 0
  let bytes = 0
  let ok = 0
  let invalid = 0
  for (const file of files) {
    const readAt = performance.now()
    const text = readFileSync(file, 'utf8')
    readMs += performance.now() - readAt
    bytes += Buffer.byteLength(text, 'utf8')
    let raw
    try {
      raw = parseYaml(text)
    } catch {
      invalid++
      continue
    }
    const result = validateManifest(raw)
    if (result.ok && result.manifest) ok++
    else invalid++
  }
  const totalMs = performance.now() - t0
  return { files: files.length, ok, invalid, bytes, walkMs, readMs, parseMs: totalMs - walkMs - readMs, totalMs }
}

function runTrials() {
  let dirOk = true
  try {
    dirOk = statSync(manifestsDir).isDirectory()
  } catch {
    dirOk = false
  }
  if (!dirOk) {
    console.error(`\nNo manifests directory at: ${manifestsDir}`)
    console.error(`Pass --dir <drive>/model-manifests (the launchers set HILBERTRAUM_MANIFESTS_DIR to it).\n`)
    return { error: 'no-dir', manifestsDir }
  }

  const isRepoCopy = manifestsDir === join(repoRoot, 'model-manifests')
  const runs = []
  for (let i = 0; i < trials; i++) runs.push(oneScan())

  const first = runs[0]
  const warm = runs.slice(1)
  const shape = { files: first.files, ok: first.ok, invalid: first.invalid, bytes: first.bytes }

  const out = []
  out.push(machineHeader())
  out.push('')
  out.push(`Directory     ${manifestsDir}`)
  out.push(
    `Catalog       ${shape.files} manifest files · ${(shape.bytes / 1024).toFixed(1)} KiB · ${shape.ok} valid, ${
      shape.invalid
    } rejected`
  )
  out.push(`Trials        ${runs.length}${coldOnly ? ' (--cold-only)' : ''}`)
  if (isRepoCopy)
    out.push(
      `\n  ! This is the repo's own model-manifests/ on the INTERNAL disk. The CPU half below is\n` +
        `    valid; the media half is not the drive. Re-run with --dir <drive>/model-manifests.`
    )
  out.push('')
  out.push(`FIRST TRIAL (cold only if the drive's cache was dropped — eject/re-insert, then --cold-only)`)
  out.push(`  total ${ms(first.totalMs)}   walk ${ms(first.walkMs)} (${pct(first.walkMs, first.totalMs)})   read ${ms(
    first.readMs
  )} (${pct(first.readMs, first.totalMs)})   parse+validate ${ms(first.parseMs)} (${pct(
    first.parseMs,
    first.totalMs
  )})`)
  if (first.readMs > 0)
    out.push(
      `  effective read ${((shape.bytes / 1e6 / first.readMs) * 1000).toFixed(1)} MB/s over ${
        shape.files
      } opens — compare against the drive's known sequential figure; far above it means a warm cache`
    )

  if (warm.length > 0) {
    out.push('')
    out.push(`WARM TRIALS (trials 2..${runs.length}) — what a pushed refetch pays`)
    out.push(line('total', stats(warm.map((r) => r.totalMs))))
    out.push(line('walk (readdir)', stats(warm.map((r) => r.walkMs))))
    out.push(line('read (readFileSync)', stats(warm.map((r) => r.readMs))))
    out.push(line('parse + validate (CPU)', stats(warm.map((r) => r.parseMs))))
    const warmTotal = stats(warm.map((r) => r.totalMs))
    const warmParse = stats(warm.map((r) => r.parseMs))
    out.push('')
    out.push(
      `  Warm floor: ${pct(warmParse.median, warmTotal.median)} of the warm median is parse+validate CPU —` +
        ` a faster drive cannot move it.`
    )
  }

  out.push('')
  out.push(`#333 acceptance — what this run answers and what it does not:`)
  out.push(`  [~] box 1 (end-to-end performance:get cost)  → --log mode, from a real app run on the drive`)
  out.push(`  [x] box 2 (the scan's share, isolated)       → the phase split above`)
  out.push(`  [ ] box 3 (the decision)                     → owner call on these figures`)
  out.push('')

  console.log(out.join('\n'))
  return { mode: 'trials', manifestsDir, machine: machineHeader(), shape, runs }
}

// ---- LOG mode ---------------------------------------------------------------------------------

/** `<ISO> <monotonic> <event> <json>` — the format perf.ts writes. */
function parsePerfLog(text) {
  const marks = []
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim()
    if (l === '') continue
    const m = /^(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(l)
    if (!m) continue
    let fields = {}
    if (m[4]) {
      try {
        fields = JSON.parse(m[4])
      } catch {
        /* a truncated final line of an interrupted run — skip its fields, keep the event */
      }
    }
    marks.push({ wall: m[1], mono: Number(m[2]), event: m[3], fields })
  }
  return marks
}

function runLog() {
  let text
  try {
    text = readFileSync(logPath, 'utf8')
  } catch (err) {
    console.error(`\nCould not read ${logPath}: ${String(err)}\n`)
    return { error: 'no-log', logPath }
  }
  const marks = parsePerfLog(text)
  const gets = []
  let unpairedScans = 0
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].event !== 'performance_get') continue
    const prev = marks[i - 1]
    const scan = prev && prev.event === 'discover_manifests' ? prev.fields : null
    gets.push({ mono: marks[i].mono, totalMs: Number(marks[i].fields.ms), scan })
  }
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].event !== 'discover_manifests') continue
    const next = marks[i + 1]
    if (!next || next.event !== 'performance_get') unpairedScans++
  }

  const out = []
  out.push(machineHeader())
  out.push('')
  out.push(`Log           ${logPath}`)
  out.push(`Marks         ${marks.length} total · ${gets.length} performance_get · ${unpairedScans} scans by other callers`)
  if (gets.length === 0) {
    out.push('')
    out.push(`  No performance_get marks. Launch with HILBERTRAUM_PERF_LOG=1 and open the Performance`)
    out.push(`  screen; leave it open through a few chat answers — every finished answer and every`)
    out.push(`  model start pushes a refetch, and that repeat cost is the figure #333 is really about.`)
    out.push('')
    console.log(out.join('\n'))
    return { mode: 'log', logPath, gets: [] }
  }

  const paired = gets.filter((g) => g.scan)
  const firstGet = gets[0]
  out.push('')
  out.push(`FIRST performance:get of the run (cold cache, if the app had not scanned yet)`)
  out.push(
    `  total ${ms(firstGet.totalMs)}` +
      (firstGet.scan
        ? `   scan ${ms(Number(firstGet.scan.ms))} (${pct(Number(firstGet.scan.ms), firstGet.totalMs)} of it)` +
          `   walk ${ms(Number(firstGet.scan.walkMs))}   read ${ms(Number(firstGet.scan.readMs))}` +
          `   parse+validate ${ms(Number(firstGet.scan.ms) - Number(firstGet.scan.walkMs) - Number(firstGet.scan.readMs))}`
        : '   (no adjacent scan mark)')
  )
  if (gets.length > 1) {
    const rest = gets.slice(1)
    out.push('')
    out.push(`SUBSEQUENT READS (n=${rest.length}) — the pushed refetches`)
    out.push(line('performance:get end to end', stats(rest.map((g) => g.totalMs))))
    const scans = rest.filter((g) => g.scan)
    if (scans.length > 0) {
      out.push(line('  of which: manifest scan', stats(scans.map((g) => Number(g.scan.ms)))))
      out.push(line('  … walk (readdir)', stats(scans.map((g) => Number(g.scan.walkMs)))))
      out.push(line('  … read (bytes)', stats(scans.map((g) => Number(g.scan.readMs)))))
      out.push(
        line(
          '  … parse + validate',
          stats(scans.map((g) => Number(g.scan.ms) - Number(g.scan.walkMs) - Number(g.scan.readMs)))
        )
      )
      const t = stats(rest.map((g) => g.totalMs))
      const s = stats(scans.map((g) => Number(g.scan.ms)))
      out.push('')
      out.push(`  The scan is ${pct(s.median, t.median)} of the median read — the rest is the settings`)
      out.push(`  read and detectSystem(), which touch no manifest file.`)
    }
    if (paired.length < gets.length)
      out.push(`\n  (${gets.length - paired.length} reads had no adjacent scan mark — a scan that ran under`)
    if (paired.length < gets.length) out.push(`   another caller in between; their totals are still counted.)`)
  }
  out.push('')
  out.push(`#333 acceptance — what this run answers and what it does not:`)
  out.push(`  [x] box 1 (end-to-end performance:get cost)  → above, on the real drive`)
  out.push(`  [x] box 2 (the scan's share, isolated)       → the split above`)
  out.push(`  [ ] box 3 (the decision)                     → owner call on these figures`)
  out.push('')
  console.log(out.join('\n'))
  return { mode: 'log', logPath, machine: machineHeader(), gets, unpairedScans }
}

// ---- main -------------------------------------------------------------------------------------

const result = logPath ? runLog() : runTrials()
if (jsonOut) {
  try {
    writeFileSync(jsonOut, JSON.stringify(result, null, 2) + '\n', 'utf8')
    console.log(`JSON written to ${basename(jsonOut)}\n`)
  } catch (err) {
    console.error(`Could not write ${jsonOut}: ${String(err)}`)
  }
}
