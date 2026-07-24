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
  SUPPORTED_RUNTIME_FORMATS
} from '../../src/main/services/drive'
import { isRealSha256 } from '../../src/shared/manifest'
import { validateRuntimeSources } from '../../src/shared/runtime-sources'
import { DRIVE_LICENSE_ARTIFACTS } from '../../src/main/services/commercial-drive'

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

  /** ps1 rows: `@{ family = 'llama_cpp'; dir = '…'; backend = 'vulkan'; bin = '…' }` */
  function ps1Matrix(): { family: string; dir: string; backend: string; bin: string }[] {
    const src = read('scripts/build-commercial-drive.ps1')
    const rows = [
      ...src.matchAll(
        /family\s*=\s*'([^']+)'\s*;\s*dir\s*=\s*'([^']+)'\s*;\s*backend\s*=\s*'([^']+)'\s*;\s*bin\s*=\s*'([^']+)'/g
      )
    ]
    expect(rows.length, 'expected the runtime-assert matrix rows in build-commercial-drive.ps1').toBeGreaterThan(0)
    return rows.map((m) => ({ family: m[1], dir: m[2], backend: m[3], bin: m[4] }))
  }

  /** sh rows: the `for rt_entry in "family|dir|backend|bin" …; do` list. The family token is the
   *  SHORT form (`llama`/`whisper`) because the loop only uses it to pick $LLAMA_VERSION vs
   *  $WHISPER_VERSION — map it back onto the canonical family name before comparing. */
  function shMatrix(): { family: string; dir: string; backend: string; bin: string }[] {
    const src = read('scripts/build-commercial-drive.sh')
    const start = src.indexOf('for rt_entry in')
    expect(start, 'the runtime-assert matrix loop in build-commercial-drive.sh not found').toBeGreaterThanOrEqual(0)
    const end = src.indexOf('; do', start)
    expect(end, 'the runtime-assert matrix loop in build-commercial-drive.sh is not closed').toBeGreaterThan(start)
    const rows = [...src.slice(start, end).matchAll(/"([^"|]+)\|([^"|]+)\|([^"|]+)\|([^"|]+)"/g)]
    expect(rows.length, 'expected the runtime-assert matrix rows in build-commercial-drive.sh').toBeGreaterThan(0)
    const FAMILIES: Record<string, string> = { llama: 'llama_cpp', whisper: 'whisper_cpp' }
    return rows.map((m) => {
      const family = FAMILIES[m[1]]
      expect(
        family,
        `unknown runtime-family token '${m[1]}' in build-commercial-drive.sh — the loop maps the ` +
          'short token onto a $<FAMILY>_VERSION variable; teach this test the new mapping'
      ).toBeDefined()
      return { family, dir: m[2], backend: m[3], bin: m[4] }
    })
  }

  it('build-commercial-drive.ps1 assertion matrix matches runtime-sources.yaml', () => {
    const scriptSet = new Set(ps1Matrix().map((r) => `${r.family}|${r.backend}|${r.dir}`))
    expect(scriptSet).toEqual(canonicalBuilds())
  })

  // AUD-20: the `.sh` twin re-spells the SAME matrix as its own hard-coded literals and was
  // unguarded — only the .ps1 was checked. A drive built on mac/linux therefore gated its
  // "is this drive sellable?" runtime assertion against a matrix that could silently fall behind
  // runtime-sources.yaml: a build dropped from the loop is never verified, so a drive missing
  // that sidecar (or carrying a stale-backend one) still passes the gate and ships as SELLABLE.
  it('build-commercial-drive.sh assertion matrix matches runtime-sources.yaml', () => {
    const scriptSet = new Set(shMatrix().map((r) => `${r.family}|${r.backend}|${r.dir}`))
    expect(scriptSet).toEqual(canonicalBuilds())
  })

  // The yaml pins (family, backend, extract_to) but NOT the binary name, so the two scripts are
  // each other's only check on that column — and a wrong `bin` means the gate looks for a file
  // that never exists (drive always rejected) or, worse, one that always exists (gate blind).
  it('both build-commercial-drive twins agree on the per-directory runtime binary name', () => {
    const asMap = (rows: { dir: string; bin: string }[]): Record<string, string> =>
      Object.fromEntries(rows.map((r) => [r.dir, r.bin]))
    expect(asMap(shMatrix())).toEqual(asMap(ps1Matrix()))
  })
})

// --- Root license/attribution artifacts (LIC-1, full-audit 2026-07-12b) -------------
// prepare-drive.{ps1,sh} COPY the three drive-root notice files and
// build-commercial-drive.{ps1,sh} GATE on them — four re-spelled literals of the one
// canonical list (commercial-drive.ts DRIVE_LICENSE_ARTIFACTS). A drift here ships a
// drive the sell gate rejects (or, worse, a gate that checks the wrong filename and
// passes a non-compliant drive).
describe('TS ↔ shell-script drift (drive license artifacts, LIC-1)', () => {
  it.each([
    ['scripts/prepare-drive.ps1', '$LicenseArtifacts = @(', ')'],
    ['scripts/prepare-drive.sh', 'LICENSE_ARTIFACTS=(', ')'],
    ['scripts/build-commercial-drive.ps1', '$LicenseArtifacts = @(', ')'],
    ['scripts/build-commercial-drive.sh', 'LICENSE_ARTIFACTS=(', ')']
  ])('%s spells exactly the canonical artifact list', (rel, header, close) => {
    expect(extractArray(read(rel), header, close)).toEqual([...DRIVE_LICENSE_ARTIFACTS])
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
// These mirror manifest.ts `isRealSha256` and the canonical (runtime → format) support
// table SUPPORTED_RUNTIME_FORMATS (models.ts, re-exported via drive.ts). A drift here
// mislabels weights (a placeholder passing as real, or a loadable format like the bundled
// ggml/whisper_cpp transcriber rejected as "unsupported"). We extract the gate literals
// and assert them against the canonical (runtime|format) pairs.

/** Flatten SUPPORTED_RUNTIME_FORMATS to a set of `runtime|format` strings for comparison. */
function canonicalRuntimeFormatPairs(): Set<string> {
  const set = new Set<string>()
  for (const [runtime, formats] of SUPPORTED_RUNTIME_FORMATS) {
    for (const fmt of formats) set.add(`${runtime}|${fmt}`)
  }
  return set
}

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

  it('verify-models.ps1 runtime/format gate matches SUPPORTED_RUNTIME_FORMATS', () => {
    const src = read('scripts/verify-models.ps1')
    // $SupportedRuntimeFormats = [ordered]@{ 'llama_cpp' = 'gguf'; ...; 'whisper_cpp' = 'ggml' }
    const start = src.indexOf('$SupportedRuntimeFormats = [ordered]@{')
    expect(start, 'ps1 $SupportedRuntimeFormats table not found').toBeGreaterThanOrEqual(0)
    const end = src.indexOf('}', start)
    expect(end, 'ps1 $SupportedRuntimeFormats table not closed').toBeGreaterThan(start)
    const body = src.slice(start, end)
    const pairs = new Set(
      [...body.matchAll(/'([^']+)'\s*=\s*'([^']+)'/g)].map((m) => `${m[1]}|${m[2]}`)
    )
    expect(pairs).toEqual(canonicalRuntimeFormatPairs())
  })

  it('verify-models.sh runtime/format gate matches SUPPORTED_RUNTIME_FORMATS', () => {
    const src = read('scripts/verify-models.sh')
    // supported_format_for() { case "$1" in llama_cpp|llama.cpp) printf 'gguf' ;; whisper_cpp) printf 'ggml' ;; esac }
    const start = src.indexOf('supported_format_for() {')
    expect(start, 'sh supported_format_for() not found').toBeGreaterThanOrEqual(0)
    const end = src.indexOf('}', start)
    expect(end, 'sh supported_format_for() not closed').toBeGreaterThan(start)
    const body = src.slice(start, end)
    const pairs = new Set<string>()
    // Each case arm `pat1|pat2) printf 'format'` maps every runtime in the pattern to that format.
    for (const m of body.matchAll(/^\s*([A-Za-z0-9_.|]+)\)\s*printf '([^']+)'/gm)) {
      for (const runtime of m[1].split('|')) pairs.add(`${runtime}|${m[2]}`)
    }
    expect(pairs).toEqual(canonicalRuntimeFormatPairs())
  })
})

// --- Provisioning-script error/repair structure (AUD-05 + AUD-24) --------------------
// These scripts have no Node, no test harness and no CI leg of their own — they run once, on a
// maintainer's machine, against multi-GB downloads. The three properties below are structural
// (they hold or don't by the shape of the source), so a text guard is the only automated check
// available and is worth far more than nothing.

/** Source lines with pure-comment lines dropped (`#` after optional leading whitespace). */
function codeLines(rel: string): { n: number; text: string }[] {
  return read(rel)
    .split('\n')
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => !text.trim().startsWith('#'))
}

describe('provisioning scripts — warn-and-continue error reporting (AUD-05)', () => {
  // Under `$ErrorActionPreference = 'Stop'` — which all of these set — `Write-Error` is promoted
  // from a non-terminating record to a SCRIPT-TERMINATING exception. Three consequences, all of
  // which actually bit: (a) `Write-Error '…'; $failed++; continue` never continued, so a single
  // transient download aborted the whole batch; (b) `Write-Error '…'; exit 2` never reached the
  // exit, so the process died with code 1 and callers keying on 2 mis-read the outcome; and
  // (c) the exception propagated OUT of a parent script's `& .\child.ps1` call and killed the
  // parent too. The fix is `Write-Host -ForegroundColor Red` plus an explicit `exit`.
  //
  // build-commercial-drive.ps1 is deliberately NOT in this list: it still has two
  // `Write-Error …; exit 1` pairs whose exit CODE is already 1, so the terminating behaviour is
  // currently harmless there. It carries the same hazard and should be converted, but that is a
  // separate change — adding it here now would redden on an untouched file.
  const PROVISIONING_PS1 = [
    'scripts/fetch-runtime.ps1',
    'scripts/fetch-models.ps1',
    'scripts/prepare-drive.ps1',
    'scripts/verify-models.ps1'
  ]

  it.each(PROVISIONING_PS1)('%s never uses Write-Error (it is script-terminating under Stop)', (rel) => {
    // Comment lines are dropped first: the scripts legitimately NAME Write-Error in the
    // explanatory comments that record exactly this reasoning.
    const offenders = codeLines(rel)
      .filter(({ text }) => text.includes('Write-Error'))
      .map(({ n, text }) => `${rel}:${n}: ${text.trim()}`)
    expect(
      offenders,
      'use `Write-Host -ForegroundColor Red` + an explicit `exit`/`continue` instead — a ' +
        'Write-Error here terminates the script (and any parent that invoked it with `&`)'
    ).toEqual([])
  })
})

describe('fetch-models — the mismatch re-download deletes only when resume cannot help (AUD-24)', () => {
  // A checksum "mismatch" covers two different files: a SHORT cross-run partial (resume is the
  // whole point — a multi-GB weight on a flaky link must not restart from zero) and a file that
  // is complete and WRONG (resuming that one requests a byte range at/past the resource length,
  // an unsatisfiable HTTP 416, so every retry transfers nothing). So the redo deletes the
  // destination first, but ONLY when the bytes on disk already reach the manifest's expected
  // size. If that delete ever escapes its size guard, every interrupted multi-GB download in
  // the wild restarts from zero — an expensive, silent regression with no error to notice.
  //
  // Asserted structurally: inside the mismatch region (from the mismatch test to the download
  // call), the size comparison must appear BEFORE the first delete, which is only true while
  // the delete is nested inside the guard.
  it('fetch-models.ps1 compares the on-disk size before its first Remove-Item', () => {
    const src = read('scripts/fetch-models.ps1')
    const region = src.indexOf("$state -eq 'mismatch' -and $expectedSize -match")
    expect(region, 'the size-guarded mismatch branch in fetch-models.ps1 not found').toBeGreaterThanOrEqual(0)
    const download = src.indexOf('Invoke-Download', region)
    expect(download, 'the download call after the mismatch branch not found').toBeGreaterThan(region)
    const body = src.slice(region, download)
    const compare = body.indexOf('-ge [long]$expectedSize')
    const remove = body.indexOf('Remove-Item')
    expect(compare, 'the on-disk-vs-expected size comparison is gone').toBeGreaterThanOrEqual(0)
    expect(remove, 'the pre-download delete is gone').toBeGreaterThanOrEqual(0)
    expect(remove, 'the delete escaped its size guard — it must stay nested inside it').toBeGreaterThan(compare)
  })

  it('fetch-models.sh compares the on-disk size before its first rm -f', () => {
    const src = read('scripts/fetch-models.sh')
    const region = src.indexOf('"$state" == mismatch && "$expected_size" =~')
    expect(region, 'the size-guarded mismatch branch in fetch-models.sh not found').toBeGreaterThanOrEqual(0)
    const download = src.indexOf('if ! download ', region)
    expect(download, 'the download call after the mismatch branch not found').toBeGreaterThan(region)
    const body = src.slice(region, download)
    const compare = body.indexOf('on_disk >= expected_size')
    const remove = body.indexOf('rm -f')
    expect(compare, 'the on-disk-vs-expected size comparison is gone').toBeGreaterThanOrEqual(0)
    expect(remove, 'the pre-download delete is gone').toBeGreaterThanOrEqual(0)
    expect(remove, 'the delete escaped its size guard — it must stay nested inside it').toBeGreaterThan(compare)
  })

  // The guard above FAILS OPEN: with no expected size it does not delete and the old
  // resume-onto-a-wrong-file behaviour returns. So a dropped call-site argument disables the fix
  // for every model with nothing erroring anywhere — the highest-value assertion in this file.
  /** Split a shell/PowerShell call's argument list into tokens ('' and "" runs stay whole). */
  const callArgs = (line: string, fn: string): string[] => {
    let rest = line.slice(line.indexOf(fn) + fn.length)
    const chain = rest.indexOf('||')
    if (chain >= 0) rest = rest.slice(0, chain)
    return [...rest.matchAll(/'[^']*'|"[^"]*"|[^\s;{}]+/g)].map((m) => m[0])
  }

  it('every Invoke-HandleFile call in fetch-models.ps1 still passes the expected size', () => {
    const calls = codeLines('scripts/fetch-models.ps1').filter(
      ({ text }) => text.includes('Invoke-HandleFile') && !text.trim().startsWith('function ')
    )
    expect(calls.length, 'expected the gguf + mmproj call sites').toBeGreaterThanOrEqual(2)
    for (const { n, text } of calls) {
      const args = callArgs(text, 'Invoke-HandleFile')
      expect(args.length, `fetch-models.ps1:${n}: argument count`).toBe(8)
      expect(args[7], `fetch-models.ps1:${n}: the 8th argument must be the manifest size`).toMatch(
        /^\$[A-Za-z0-9_]*[Ss]ize[A-Za-z0-9_]*$/
      )
    }
  })

  it('every handle_file call in fetch-models.sh still passes the expected size', () => {
    const calls = codeLines('scripts/fetch-models.sh').filter(
      ({ text }) => text.includes('handle_file "') && !text.trim().startsWith('handle_file()')
    )
    expect(calls.length, 'expected the gguf + mmproj call sites').toBeGreaterThanOrEqual(2)
    for (const { n, text } of calls) {
      const args = callArgs(text, 'handle_file')
      expect(args.length, `fetch-models.sh:${n}: argument count`).toBe(8)
      expect(args[7], `fetch-models.sh:${n}: the 8th argument must be the manifest size`).toMatch(
        /^"\$[a-z0-9_]*size[a-z0-9_]*"$/i
      )
    }
  })
})

describe('fetch-runtime — the OCR re-fetch delete is deliberately UNCONDITIONAL (AUD-24)', () => {
  // The asymmetry with fetch-models is intentional and must not be "harmonized" away: the OCR
  // language files are a few MB, runtime-sources.yaml records no size field for them, and
  // re-fetching one costs nothing — there is no partial worth saving and no field to distinguish
  // one with. Wrapping this delete in a fetch-models-style size guard would make it a no-op
  // (there is no size to compare against), silently restoring the HTTP-416 repair loop it fixes.
  //
  // Asserted structurally: between the "hash differs" message and the delete there is nothing
  // but comments — no intervening condition of any kind.
  it.each([
    ['scripts/fetch-runtime.ps1', 'Remove-Item'],
    ['scripts/fetch-runtime.sh', 'rm -f']
  ])('%s deletes the mismatching OCR file with no size test in between', (rel, deleteToken) => {
    const src = read(rel)
    const msg = src.indexOf('present but hash differs')
    expect(msg, `${rel}: the OCR hash-mismatch branch not found`).toBeGreaterThanOrEqual(0)
    const del = src.indexOf(deleteToken, msg)
    expect(del, `${rel}: the OCR re-fetch delete is gone`).toBeGreaterThan(msg)
    const between = src
      .slice(src.indexOf('\n', msg) + 1, src.lastIndexOf('\n', del) + 1)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
    expect(
      between,
      `${rel}: the OCR delete gained a condition. It is unconditional on purpose — see the ` +
        'comment above it; do not harmonize it with the size-guarded fetch-models delete.'
    ).toEqual([])
  })
})
