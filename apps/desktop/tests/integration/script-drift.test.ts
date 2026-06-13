import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  DRIVE_LAYOUT_DIRS,
  DRIVE_FORMAT_VERSION,
  buildDriveJson,
  buildPolicyJson,
  SUPPORTED_RUNTIMES,
  SUPPORTED_FORMATS
} from '../../src/main/services/drive'
import { isRealSha256 } from '../../src/shared/manifest'
import { validateRuntimeSources } from '../../src/shared/runtime-sources'

// Drift guard (audit H5 / M-A1). The drive layout, the format version, and the runtime
// build matrix have a single canonical source of truth in TypeScript / `runtime-sources.yaml`,
// but the self-contained `scripts/*.{ps1,sh}` (which must run on a fresh machine with no Node)
// RE-SPELL the same facts as literals. They are kept in sync by "keep in sync" comments only —
// nothing catches a divergence, so a script that creates `runtime/llama.cpp/macos` instead of
// `mac`, or bumps the version in 4 of 5 spots, ships a silently-broken drive that still
// "succeeds". This test mechanically extracts the script literals and asserts they match the
// canonical TS. Pure string parsing — no shell execution — so it runs in CI where only Node exists.

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')

/** Pull the entries of a script array literal that opens at `header` and ends at `close`. */
function extractArray(src: string, header: string, close: string): string[] {
  const start = src.indexOf(header)
  expect(start, `array header ${JSON.stringify(header)} not found`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf(close, start + header.length)
  expect(end, `array close ${JSON.stringify(close)} not found after ${header}`).toBeGreaterThan(start)
  const body = src.slice(start + header.length, end)
  return body
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim()) // strip comments + whitespace
    .map((l) => l.replace(/[,'"]/g, '').trim()) // strip quotes/commas (ps1 + sh both)
    .filter((l) => l.length > 0)
}

describe('TS ↔ shell-script drift (drive layout)', () => {
  it('prepare-drive.ps1 $Dirs matches DRIVE_LAYOUT_DIRS', () => {
    const dirs = extractArray(read('scripts/prepare-drive.ps1'), '$Dirs = @(', ')')
    expect(dirs).toEqual([...DRIVE_LAYOUT_DIRS])
  })

  it('prepare-drive.sh DIRS matches DRIVE_LAYOUT_DIRS', () => {
    const dirs = extractArray(read('scripts/prepare-drive.sh'), 'DIRS=(', ')')
    expect(dirs).toEqual([...DRIVE_LAYOUT_DIRS])
  })

  it('every script that stamps drive_format_version uses the canonical value', () => {
    for (const rel of [
      'scripts/prepare-drive.ps1',
      'scripts/prepare-drive.sh',
      'scripts/verify-models.ps1',
      'scripts/verify-models.sh'
    ]) {
      const src = read(rel)
      const matches = [...src.matchAll(/drive_format_version["']?\s*[=:]\s*(\d+)/g)]
      expect(matches.length, `${rel}: expected at least one drive_format_version literal`).toBeGreaterThan(0)
      for (const m of matches) {
        expect(Number(m[1]), `${rel}: drive_format_version literal`).toBe(DRIVE_FORMAT_VERSION)
      }
    }
  })
})

describe('TS ↔ shell-script drift (runtime build matrix)', () => {
  // The canonical matrix = `runtime-sources.yaml` (the same file the app + assets.ts read).
  function canonicalBuilds(): Set<string> {
    const parsed = validateRuntimeSources(parseYaml(read('model-manifests/runtime-sources.yaml')))
    expect(parsed.errors, `runtime-sources.yaml must validate: ${parsed.errors.join('; ')}`).toEqual([])
    const set = new Set<string>()
    for (const b of parsed.sources!.builds) set.add(`llama_cpp|${b.backend}|${b.extractTo}`)
    if (parsed.whisper) {
      for (const b of parsed.whisper.builds) set.add(`whisper_cpp|${b.backend}|${b.extractTo}`)
    }
    return set
  }

  it('build-commercial-drive.ps1 assertion matrix matches runtime-sources.yaml', () => {
    const src = read('scripts/build-commercial-drive.ps1')
    // Rows look like: @{ family = 'llama_cpp'; dir = '...'; backend = 'vulkan'; bin = '...' }
    const rows = [
      ...src.matchAll(
        /family\s*=\s*'([^']+)'\s*;\s*dir\s*=\s*'([^']+)'\s*;\s*backend\s*=\s*'([^']+)'/g
      )
    ]
    expect(rows.length, 'expected the runtime-assert matrix rows in build-commercial-drive.ps1').toBeGreaterThan(0)
    const scriptSet = new Set(rows.map((m) => `${m[1]}|${m[3]}|${m[2]}`))
    expect(scriptSet).toEqual(canonicalBuilds())
  })
})

// --- config/{drive,policy}.json payload literals (audit M-A1 follow-up) -------------
// `buildDriveJson`/`buildPolicyJson` (drive.ts) are the canonical payload shapes, but the
// no-Node-on-a-fresh-machine constraint forces prepare-drive.{ps1,sh} to RE-SPELL them.
// We parse the script literals into plain objects and assert deep equality against the TS
// builders. `created_at` is dropped (a runtime timestamp, not a literal).

/** Strip the dynamic created_at before comparing — it is generated, not a literal. */
function stripCreatedAt<T extends object>(o: T): Omit<T, 'created_at'> {
  const { created_at: _drop, ...rest } = o as Record<string, unknown>
  return rest as Omit<T, 'created_at'>
}

/** Parse a bash here-doc JSON body (DRIVE_JSON/POLICY_JSON), substituting the dev-mode
 *  shell vars the script computes above, then JSON.parse it. */
function parseShJson(src: string, varName: string, dev: boolean): Record<string, unknown> {
  const m = src.match(new RegExp(`${varName}=\\$\\(cat <<EOF\\n([\\s\\S]*?)\\nEOF`))
  expect(m, `${varName} here-doc not found`).not.toBeNull()
  // The script sets these booleans from the --dev branch (lines ~68-72).
  const subs: Record<string, string> = dev
    ? { CREATED_AT: 'x', ENC_REQUIRED: 'false', PLAINTEXT: 'true', ALLOW_UNVERIFIED: 'true', REQUIRE_SHA: 'false' }
    : { CREATED_AT: 'x', ENC_REQUIRED: 'true', PLAINTEXT: 'false', ALLOW_UNVERIFIED: 'false', REQUIRE_SHA: 'true' }
  let body = m![1]
  for (const [k, v] of Object.entries(subs)) body = body.replaceAll(`$${k}`, v)
  return JSON.parse(body) as Record<string, unknown>
}

/** Parse a PowerShell `[ordered]@{ key = value … }` block into a plain object, resolving
 *  the handful of value forms the prepare-drive payloads use for a given -Dev flag. */
function parsePsOrdered(src: string, assignTarget: string, dev: boolean): Record<string, unknown> {
  const start = src.indexOf(assignTarget)
  expect(start, `${assignTarget} not found`).toBeGreaterThanOrEqual(0)
  const open = src.indexOf('@{', start)
  // Walk to the matching close brace (payloads nest one level — policy has sub-tables).
  let depth = 0
  let end = -1
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  expect(end, `${assignTarget} block not closed`).toBeGreaterThan(open)
  return parsePsBlock(src.slice(open + 2, end), dev)
}

function parsePsValue(raw: string, dev: boolean): unknown {
  const v = raw.trim()
  if (v === '$true') return true
  if (v === '$false') return false
  if (v === '(-not $Dev)') return !dev
  if (v === '[bool]$Dev') return dev
  // created_at is a generated timestamp expression — kept as a sentinel and dropped by
  // stripCreatedAt before comparison (the sh side substitutes a placeholder likewise).
  if (v.startsWith('(Get-Date)')) return '<created_at>'
  if (/^-?\d+$/.test(v)) return Number(v)
  const str = v.match(/^'([^']*)'$/)
  if (str) return str[1]
  throw new Error(`unhandled PS value literal: ${JSON.stringify(v)}`)
}

function parsePsBlock(body: string, dev: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // Tokenize key = value | key = [ordered]@{ … } at this level.
  let i = 0
  while (i < body.length) {
    const km = body.slice(i).match(/^[\s,]*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/)
    if (!km) break
    const key = km[1]
    i += km[0].length
    if (body.slice(i).startsWith('[ordered]@{') || body.slice(i).startsWith('@{')) {
      const subOpen = body.indexOf('@{', i)
      let depth = 0
      let subEnd = -1
      for (let j = subOpen + 1; j < body.length; j++) {
        if (body[j] === '{') depth++
        else if (body[j] === '}') {
          depth--
          if (depth === 0) {
            subEnd = j
            break
          }
        }
      }
      out[key] = parsePsBlock(body.slice(subOpen + 2, subEnd), dev)
      i = subEnd + 1
    } else {
      const vm = body.slice(i).match(/^[^\n]*/)
      out[key] = parsePsValue(vm![0], dev)
      i += vm![0].length
    }
  }
  return out
}

describe('TS ↔ shell-script drift (config payloads)', () => {
  it('prepare-drive.sh drive.json matches buildDriveJson()', () => {
    const parsed = stripCreatedAt(parseShJson(read('scripts/prepare-drive.sh'), 'DRIVE_JSON', false))
    expect(parsed).toEqual(stripCreatedAt(buildDriveJson()))
  })

  it('prepare-drive.ps1 $DriveJson matches buildDriveJson()', () => {
    const parsed = stripCreatedAt(parsePsOrdered(read('scripts/prepare-drive.ps1'), '$DriveJson', false))
    expect(parsed).toEqual(stripCreatedAt(buildDriveJson()))
  })

  // policy.json varies by --dev: assert BOTH editions in both scripts.
  for (const dev of [false, true]) {
    it(`prepare-drive.sh policy.json matches buildPolicyJson({dev:${dev}})`, () => {
      const parsed = parseShJson(read('scripts/prepare-drive.sh'), 'POLICY_JSON', dev)
      expect(parsed).toEqual(buildPolicyJson({ dev }))
    })

    it(`prepare-drive.ps1 $PolicyJson matches buildPolicyJson({dev:${dev}})`, () => {
      const parsed = parsePsOrdered(read('scripts/prepare-drive.ps1'), '$PolicyJson', dev)
      expect(parsed).toEqual(buildPolicyJson({ dev }))
    })
  }
})

// --- verify-models.{ps1,sh} sha256 + supported-runtime/format gates (audit M-A1) ----
// These mirror manifest.ts `isRealSha256` and drive.ts SUPPORTED_RUNTIMES/FORMATS. A
// drift here mislabels weights (a placeholder passing as real, or a loadable format
// rejected as "unsupported"). We extract the gate literals and assert them.

describe('TS ↔ shell-script drift (verify-models gates)', () => {
  it('both verify scripts use the same real-sha256 regex, matching isRealSha256', () => {
    const ps = read('scripts/verify-models.ps1').match(/-match\s+'(\^\[a-f0-9\]\{64\}\$)'/)
    const sh = read('scripts/verify-models.sh').match(/=~\s+(\^\[a-f0-9\]\{64\}\$)/)
    expect(ps, 'verify-models.ps1 real-sha regex not found').not.toBeNull()
    expect(sh, 'verify-models.sh real-sha regex not found').not.toBeNull()
    expect(ps![1]).toBe(sh![1])
    // Behavioural cross-check: the extracted regex agrees with the canonical predicate
    // on representative inputs (real 64-hex, short, uppercase, placeholder).
    const re = new RegExp(ps![1])
    const probes = [
      'a'.repeat(64),
      'a'.repeat(63),
      'A'.repeat(64),
      'REPLACE_WITH_REAL_HASH',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    ]
    for (const p of probes) expect(re.test(p), `regex vs isRealSha256 on ${p}`).toBe(isRealSha256(p))
  })

  it('verify-models.ps1 runtime/format gate matches SUPPORTED_RUNTIMES/FORMATS', () => {
    const src = read('scripts/verify-models.ps1')
    // if ($runtime -notin @('llama_cpp', 'llama.cpp') -or $format -ne 'gguf') {
    const rt = src.match(/\$runtime\s+-notin\s+@\(([^)]*)\)/)
    const fmt = src.match(/\$format\s+-ne\s+'([^']+)'/)
    expect(rt, 'ps1 runtime gate not found').not.toBeNull()
    expect(fmt, 'ps1 format gate not found').not.toBeNull()
    const runtimes = new Set([...rt![1].matchAll(/'([^']+)'/g)].map((m) => m[1]))
    expect(runtimes).toEqual(SUPPORTED_RUNTIMES)
    expect(new Set([fmt![1]])).toEqual(SUPPORTED_FORMATS)
  })

  it('verify-models.sh runtime/format gate matches SUPPORTED_RUNTIMES/FORMATS', () => {
    const src = read('scripts/verify-models.sh')
    // if [[ "$runtime" != "llama_cpp" && "$runtime" != "llama.cpp" ]] || [[ "$format" != "gguf" ]];
    const runtimes = new Set(
      [...src.matchAll(/"\$runtime"\s*!=\s*"([^"]+)"/g)].map((m) => m[1])
    )
    const fmt = src.match(/"\$format"\s*!=\s*"([^"]+)"/)
    expect(runtimes, 'sh runtime gate not found').not.toEqual(new Set())
    expect(fmt, 'sh format gate not found').not.toBeNull()
    expect(runtimes).toEqual(SUPPORTED_RUNTIMES)
    expect(new Set([fmt![1]])).toEqual(SUPPORTED_FORMATS)
  })
})
