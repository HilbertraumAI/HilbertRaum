import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DRIVE_LAYOUT_DIRS,
  DRIVE_FORMAT_VERSION,
  buildDriveJson,
  buildPolicyJson
} from '../../src/main/services/drive'
import { SUPPORTED_RUNTIME_FORMATS } from '../../src/main/services/models'
import { sidecarBinaryName, sidecarFamilySpec } from '../../src/main/services/assets'
import { isRealSha256 } from '../../src/shared/manifest'
import { KIT_PLATFORMS, type RuntimeFamily } from '../../src/shared/runtime-sources'
import { DRIVE_LICENSE_ARTIFACTS, KIT_PLATFORM_SPECS } from '../../src/main/services/commercial-drive'
import { REPO_ROOT, modelManifestDocs, repoText } from '../helpers/repo-files'
import { extractScriptArray } from '../helpers/script-legs'
import { committedRuntimeSources } from '../helpers/catalog'

// Drift guard (audit H5 / M-A1). The drive layout, the format version, and the runtime
// build matrix have a single canonical source of truth in TypeScript / `runtime-sources.yaml`,
// but the self-contained `scripts/*.{ps1,sh}` (which must run on a fresh machine with no Node)
// RE-SPELL the same facts as literals. They are kept in sync by "keep in sync" comments only —
// nothing catches a divergence, so a script that creates `runtime/llama.cpp/macos` instead of
// `mac`, or bumps the version in 4 of 5 spots, ships a silently-broken drive that still
// "succeeds". This test mechanically extracts the script literals and asserts they match the
// canonical TS. Pure string parsing — no shell execution — so it runs in CI where only Node exists.

describe('TS ↔ shell-script drift (drive layout)', () => {
  it('prepare-drive.ps1 $Dirs matches DRIVE_LAYOUT_DIRS', () => {
    const dirs = extractScriptArray(repoText('scripts/prepare-drive.ps1'), '$Dirs = @(')
    expect(dirs).toEqual([...DRIVE_LAYOUT_DIRS])
  })

  it('prepare-drive.sh DIRS matches DRIVE_LAYOUT_DIRS', () => {
    const dirs = extractScriptArray(repoText('scripts/prepare-drive.sh'), 'DIRS=(')
    expect(dirs).toEqual([...DRIVE_LAYOUT_DIRS])
  })

  it('every script that stamps drive_format_version uses the canonical value', () => {
    for (const rel of [
      'scripts/prepare-drive.ps1',
      'scripts/prepare-drive.sh',
      'scripts/verify-models.ps1',
      'scripts/verify-models.sh'
    ]) {
      const src = repoText(rel)
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
  // Family-driven over `parsed.families` (#339 P8-1) rather than hand-enumerated per-family
  // reads, so a FIFTH family can never again go unnoticed by this net the way `kiwix_tools`
  // did before this change. An OPTIONAL family (kiwix_tools) is excluded by default: it is
  // provisioned by its OWN un-numbered builder step (-KiwixSourceDir/--kiwix-source-dir,
  // #339 P8-4), not by rows in this runtime-assert matrix — the canonical gate's
  // `checkSourceBundle` verifies the source bundle, not this test — so including it here
  // would assert a matrix shape the builders deliberately never produce.
  // `includeOptional: true` is how the "the builders skip exactly the optional families"
  // test below still keeps that carve-out honest.
  function canonicalBuilds(opts: { includeOptional?: boolean } = {}): Set<string> {
    const parsed = committedRuntimeSources()
    const set = new Set<string>()
    for (const [family, block] of Object.entries(parsed.families ?? {})) {
      if (block!.optional && !opts.includeOptional) continue
      for (const b of block!.builds) set.add(`${family}|${b.backend}|${b.extractTo}`)
    }
    return set
  }

  /** The families runtime-sources.yaml marks `optional: true` today. */
  function optionalFamilies(): Set<string> {
    const parsed = committedRuntimeSources()
    const set = new Set<string>()
    for (const [family, block] of Object.entries(parsed.families ?? {})) {
      if (block!.optional) set.add(family)
    }
    return set
  }

  /** ps1 rows: `@{ family = 'llama_cpp'; dir = '…'; backend = 'vulkan'; bin = '…' }` */
  function ps1Matrix(): { family: string; dir: string; backend: string; bin: string }[] {
    const src = repoText('scripts/build-commercial-drive.ps1')
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
    const src = repoText('scripts/build-commercial-drive.sh')
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
  // unguarded — only the .ps1 was checked. Since #233 the verdict is the canonical gate's, so a
  // matrix that falls behind runtime-sources.yaml now means a false NOT SELLABLE, or a build the
  // native pre-flight silently skips.
  it('build-commercial-drive.sh assertion matrix matches runtime-sources.yaml', () => {
    const scriptSet = new Set(shMatrix().map((r) => `${r.family}|${r.backend}|${r.dir}`))
    expect(scriptSet).toEqual(canonicalBuilds())
  })

  // The yaml pins (family, backend, extract_to) but NOT the binary name: SIDECAR_FAMILY_SPECS does.
  // A wrong `bin` means the gate looks for a file that never exists (drive always rejected) or,
  // worse, one that always exists (gate blind).
  it('both build-commercial-drive twins agree on the per-directory runtime binary name', () => {
    const asMap = (rows: { dir: string; bin: string }[]): Record<string, string> =>
      Object.fromEntries(rows.map((r) => [r.dir, r.bin]))
    for (const r of [...ps1Matrix(), ...shMatrix()]) {
      const spec = sidecarFamilySpec(r.family as RuntimeFamily)
      expect(spec, `no SIDECAR_FAMILY_SPECS entry for ${r.family}`).toBeDefined()
      expect(r.bin, `${r.family} ${r.dir}`).toBe(sidecarBinaryName(spec!.binaryBase, r.dir.includes('/win') ? 'win' : 'linux'))
    }
    expect(asMap(shMatrix())).toEqual(asMap(ps1Matrix()))
  })

  // #339 P8-1 R-c: the two comparisons above deliberately exclude optional families
  // (kiwix_tools) because it is provisioned by its own un-numbered builder step, never by a
  // row in this runtime-assert matrix (#339 P8-4: -KiwixSourceDir/--kiwix-source-dir installs
  // the source bundle then fetches the binaries; the canonical gate's `checkSourceBundle`
  // verifies it, not this matrix). That carve-out must not become a permanent, silent blind
  // spot: this test asserts the SET of families the builder matrices skip is EXACTLY the set
  // the yaml marks optional — no more (a required family accidentally excluded would hide
  // from both matrix comparisons above) and no less (an optional family a builder DOES
  // provision through this matrix would mean the carve-out is stale).
  it('the runtime-sources families the drive builders skip are exactly the optional ones', () => {
    const allFamilies = canonicalBuilds({ includeOptional: true })
    const coveredFamilies = new Set([...ps1Matrix(), ...shMatrix()].map((r) => r.family))
    const skipped = new Set(
      [...new Set([...allFamilies].map((entry) => entry.split('|')[0]))].filter(
        (family) => !coveredFamilies.has(family)
      )
    )
    expect(skipped).toEqual(optionalFamilies())
  })
})

// --- fetch-runtime.{ps1,sh} family allow-list (#339 P8-3) ---------------------------
// The scripts hard-allow-list the families they know how to fetch (`-Family`/`--family`),
// separately from the yaml-driven `canonicalBuilds()` net above — a family can be added to
// runtime-sources.yaml (and even to `canonicalBuilds()`'s families) while the fetch scripts
// still reject it at the CLI. `ocr` is a different asset shape (`files:`, not `builds:`) and
// is hand-added to the expected set since it never appears in `parsed.families`.
describe('TS ↔ shell-script drift (fetch-runtime family allow-list, #339 P8-3)', () => {
  function yamlBuildFamilies(): string[] {
    const parsed = committedRuntimeSources()
    return Object.keys(parsed.families ?? {}).sort()
  }

  it('fetch-runtime.ps1 -Family ValidateSet matches the yaml build families + ocr', () => {
    const src = repoText('scripts/fetch-runtime.ps1')
    const m = src.match(/\[ValidateSet\(([^)]+)\)\]/)
    expect(m, 'fetch-runtime.ps1 -Family ValidateSet not found').not.toBeNull()
    const families = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort()
    expect(families).toEqual([...yamlBuildFamilies(), 'ocr'].sort())
  })

  it('fetch-runtime.sh --family case allow-list matches the yaml build families + ocr', () => {
    const src = repoText('scripts/fetch-runtime.sh')
    const m = src.match(/case "\$FAMILY" in\n\s*([A-Za-z0-9_|]+)\)/)
    expect(m, 'fetch-runtime.sh --family case allow-list not found').not.toBeNull()
    const families = m![1].split('|').sort()
    expect(families).toEqual([...yamlBuildFamilies(), 'ocr'].sort())
  })
})

// --- Kiwix-tools corresponding-source bundle (#339 P8-4) ----------------------------
// The builder twins gained their own un-numbered step (-KiwixSourceDir/--kiwix-source-dir):
// install the source bundle via the node helper, then fetch the kiwix_tools binaries for
// the three Kit platforms with EXPLICIT archs. Both re-spell the platform list as literals —
// the same drift risk as every other matrix in this file. SOURCE FIRST is behaviour, run in
// script-orchestration.test.ts: a source dir without the archives fetches no kiwix-tools.
describe('TS ↔ shell-script drift (kiwix source bundle, #339 P8-4)', () => {
  /** ps1: `@{ Os = 'win'; Arch = 'x64' }` rows inside the kiwix fetch loop. */
  function ps1KiwixPlatforms(): Set<string> {
    const src = repoText('scripts/build-commercial-drive.ps1')
    const rows = [...src.matchAll(/Os\s*=\s*'([^']+)'\s*;\s*Arch\s*=\s*'([^']+)'/g)]
    expect(rows.length, 'expected the kiwix fetch platform rows in build-commercial-drive.ps1').toBeGreaterThan(0)
    return new Set(rows.map((m) => `${m[1]}|${m[2]}`))
  }

  /** sh: `for kiwix_entry in "win|x64" "mac|arm64" "linux|x64"; do` list. */
  function shKiwixPlatforms(): Set<string> {
    const src = repoText('scripts/build-commercial-drive.sh')
    const start = src.indexOf('for kiwix_entry in')
    expect(start, 'the kiwix fetch platform loop in build-commercial-drive.sh not found').toBeGreaterThanOrEqual(0)
    const end = src.indexOf('; do', start)
    expect(end, 'the kiwix fetch platform loop in build-commercial-drive.sh is not closed').toBeGreaterThan(start)
    const rows = [...src.slice(start, end).matchAll(/"([^"|]+)\|([^"|]+)"/g)]
    expect(rows.length, 'expected the kiwix fetch platform rows in build-commercial-drive.sh').toBeGreaterThan(0)
    return new Set(rows.map((m) => `${m[1]}|${m[2]}`))
  }

  it('both twins fetch the same three kiwix_tools platform pairs', () => {
    const canonical = new Set(KIT_PLATFORMS.map((p) => p.replace('-', '|')))
    expect(ps1KiwixPlatforms()).toEqual(canonical)
    expect(shKiwixPlatforms()).toEqual(canonical)
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
    ['scripts/prepare-drive.ps1', '$LicenseArtifacts = @('],
    ['scripts/prepare-drive.sh', 'LICENSE_ARTIFACTS=('],
    ['scripts/build-commercial-drive.ps1', '$LicenseArtifacts = @('],
    ['scripts/build-commercial-drive.sh', 'LICENSE_ARTIFACTS=(']
  ])('%s spells exactly the canonical artifact list', (rel, header) => {
    expect(extractScriptArray(repoText(rel), header)).toEqual([...DRIVE_LICENSE_ARTIFACTS])
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

/** Extract the dev/commercial variable assignments from the script's REAL
 *  `if [[ $DEV -eq 1 ]] … else … fi` branch — hardcoding the expected values here would
 *  let a flipped branch (e.g. a commercial drive shipping `ALLOW_LOCAL_API=true`,
 *  violating owner decision O4) stay green (review 2026-08-18). */
function parseShDevBranch(src: string, dev: boolean): Record<string, string> {
  const m = src.match(/if \[\[ \$DEV -eq 1 \]\]; then\n([\s\S]*?)\nelse\n([\s\S]*?)\nfi/)
  expect(m, 'prepare-drive.sh $DEV branch not found').not.toBeNull()
  const branch = dev ? m![1] : m![2]
  const out: Record<string, string> = {}
  for (const am of branch.matchAll(/([A-Z_]+)=(\S+?)(?:;|\s|$)/g)) out[am[1]] = am[2]
  expect(Object.keys(out).length, 'no assignments parsed from the $DEV branch').toBeGreaterThan(0)
  return out
}

/** Parse a bash here-doc JSON body (DRIVE_JSON/POLICY_JSON), substituting the dev-mode
 *  shell vars from the script's ACTUAL branch assignments, then JSON.parse it. */
function parseShJson(src: string, varName: string, dev: boolean): Record<string, unknown> {
  const m = src.match(new RegExp(`${varName}=\\$\\(cat <<EOF\\n([\\s\\S]*?)\\nEOF`))
  expect(m, `${varName} here-doc not found`).not.toBeNull()
  const subs: Record<string, string> = { CREATED_AT: 'x', ...parseShDevBranch(src, dev) }
  let body = m![1]
  // Longest names first so e.g. $ALLOW_LOCAL_API is never half-replaced by a prefix var.
  for (const k of Object.keys(subs).sort((a, b) => b.length - a.length)) {
    body = body.replaceAll(`$${k}`, subs[k])
  }
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
    const parsed = stripCreatedAt(parseShJson(repoText('scripts/prepare-drive.sh'), 'DRIVE_JSON', false))
    expect(parsed).toEqual(stripCreatedAt(buildDriveJson()))
  })

  it('prepare-drive.ps1 $DriveJson matches buildDriveJson()', () => {
    const parsed = stripCreatedAt(parsePsOrdered(repoText('scripts/prepare-drive.ps1'), '$DriveJson', false))
    expect(parsed).toEqual(stripCreatedAt(buildDriveJson()))
  })

  // policy.json varies by --dev: assert BOTH editions in both scripts.
  for (const dev of [false, true]) {
    it(`prepare-drive.sh policy.json matches buildPolicyJson({dev:${dev}})`, () => {
      const parsed = parseShJson(repoText('scripts/prepare-drive.sh'), 'POLICY_JSON', dev)
      expect(parsed).toEqual(buildPolicyJson({ dev }))
    })

    it(`prepare-drive.ps1 $PolicyJson matches buildPolicyJson({dev:${dev}})`, () => {
      const parsed = parsePsOrdered(repoText('scripts/prepare-drive.ps1'), '$PolicyJson', dev)
      expect(parsed).toEqual(buildPolicyJson({ dev }))
    })
  }
})

// --- verify-models.{ps1,sh} sha256 + supported-runtime/format gates (audit M-A1) ----
// These mirror manifest.ts `isRealSha256` and the canonical (runtime → format) support
// table SUPPORTED_RUNTIME_FORMATS (models.ts). A drift here
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
    const ps = repoText('scripts/verify-models.ps1').match(/-match\s+'(\^\[a-f0-9\]\{64\}\$)'/)
    const sh = repoText('scripts/verify-models.sh').match(/=~\s+(\^\[a-f0-9\]\{64\}\$)/)
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

  it.each([
    ['scripts/fetch-models.ps1', 1],
    ['scripts/fetch-models.sh', 1],
    ['scripts/fetch-runtime.ps1', 2],
    ['scripts/fetch-runtime.sh', 1],
    ['scripts/build-commercial-drive.ps1', 1],
    ['scripts/build-commercial-drive.sh', 1]
  ])('%s spells the real-sha256 regex exactly as verify-models does', (rel, sites) => {
    const code = codeLines(rel).map((l) => l.text).join('\n')
    const found = [...code.matchAll(/\^\[[^\]]+\]\{\d+\}\$/g)].map((m) => m[0])
    expect(found).toEqual(Array<string>(sites).fill('^[a-f0-9]{64}$'))
  })

  it('verify-models.ps1 runtime/format gate matches SUPPORTED_RUNTIME_FORMATS', () => {
    const src = repoText('scripts/verify-models.ps1')
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
    const src = repoText('scripts/verify-models.sh')
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
// These scripts have no Node — they run once, on a maintainer's machine, against multi-GB
// downloads. The properties below are structural (they hold or don't by the shape of the source),
// so a text guard is the cheapest automated check. fetch-models' AUD-24 delete rule is no longer
// read here but run, over real `file://` downloads on both twins: script-fetch-models.test.ts (#769).

/** Source lines with pure-comment lines dropped (`#` after optional leading whitespace). */
function codeLines(rel: string): { n: number; text: string }[] {
  return repoText(rel)
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
  const PROVISIONING_PS1 = [
    'scripts/build-commercial-drive.ps1',
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

describe('fetch-models — a withdrawn upstream source is skipped, never requested (issue #196)', () => {
  // Both twins parse flat YAML and strip an inline comment at " #", so a note containing one
  // would reach the operator truncated mid-sentence. Pinned on the committed manifests because
  // that is where a maintainer writes the next note.
  it('no committed manifest hides part of its withdrawal note behind a " #"', () => {
    const notes = modelManifestDocs()
      .map((m) => (m.doc.download as Record<string, unknown> | undefined)?.withdrawn)
      .filter((n): n is string => typeof n === 'string')
    expect(notes.length, 'expected the issue-#196 notes').toBeGreaterThan(0)
    for (const n of notes) expect(n, 'truncated by the scripts\' inline-comment strip').not.toContain(' #')
  })
})

// fetch-runtime's OCR re-fetch deletes a mismatching file unconditionally (AUD-24), unlike fetch-models' size-guarded
// delete: script-fetch-runtime.test.ts runs it on both twins over a wrong file of the right length.

// The commercial gate is ONE function (#233, #234): both builders call the built
// assert-commercial-drive tool, spell the same platform labels, pass --commercial to
// every fetch-runtime run, and the fetch scripts record a binary hash only after the
// archive verified. Text pins; the execution cases live in script-execution.test.ts.
describe('one commercial gate — builder + fetch-runtime literals (#233, #234)', () => {
  const GATE_TOOL = 'apps/desktop/out/tools/assert-commercial-drive.mjs'

  it.each([
    ['scripts/build-commercial-drive.ps1', '$KitPlatforms = @('],
    ['scripts/build-commercial-drive.sh', 'KIT_PLATFORMS=(']
  ])('%s spells exactly the canonical KitPlatform list', (rel, header) => {
    expect(extractScriptArray(repoText(rel), header)).toEqual([...KIT_PLATFORMS])
  })

  it.each([
    ['scripts/build-commercial-drive.ps1', '& $nodeCmd.Source $gateTool', '$problems.Count -gt 0'],
    ['scripts/build-commercial-drive.sh', 'node "$GATE_TOOL"', '${#PROBLEMS[@]} -gt 0']
  ])('%s invokes the built canonical gate and prints SELLABLE only from its result', (rel, call, guard) => {
    const code = codeLines(rel).map((l) => l.text)
    expect(code.some((l) => l.includes(GATE_TOOL))).toBe(true)
    // One SELLABLE line, after the gate ran and after the guard that exits on any problem.
    const callAt = code.findIndex((l) => l.includes(call))
    const guardAt = code.findIndex((l) => l.includes(guard))
    const verdicts = code.flatMap((l, i) => (/SELLABLE:/.test(l) && !/NOT SELLABLE/.test(l) ? [i] : []))
    expect(callAt).toBeGreaterThanOrEqual(0)
    expect(guardAt).toBeGreaterThan(callAt)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toBeGreaterThan(guardAt)
  })

  it('build-commercial-drive.ps1 passes -Commercial to every fetch-runtime run', () => {
    const code = codeLines('scripts/build-commercial-drive.ps1').map((l) => l.text)
    const runs = code.filter((l) => l.includes("Run 'fetch-runtime.ps1'")).length
    const flagged = code.filter((l) => /Commercial\s*=\s*\$true/.test(l)).length
    expect(runs).toBeGreaterThan(0)
    expect(flagged).toBeGreaterThanOrEqual(runs)
  })

  it('build-commercial-drive.sh passes --commercial to every fetch-runtime run', () => {
    const code = codeLines('scripts/build-commercial-drive.sh').map((l) => l.text)
    const runs = code.filter((l) => l.includes('fetch-runtime.sh')).length
    const flagged = code.filter((l) => l.includes('--commercial')).length
    expect(runs).toBeGreaterThan(0)
    expect(flagged).toBeGreaterThanOrEqual(runs)
  })

  it.each([
    ['scripts/fetch-runtime.ps1', '$archiveVerified'],
    ['scripts/fetch-runtime.sh', 'ARCHIVE_VERIFIED']
  ])('%s writes the marker binary hash only behind the archive-verified flag', (rel, flag) => {
    const src = repoText(rel)
    // The LAST `"binaries"` literal is the marker write (earlier ones read a marker).
    const markerWrite = src.lastIndexOf('"binaries"')
    expect(markerWrite, 'marker write not found').toBeGreaterThan(0)
    // The flag is tested within the 25 lines that precede the marker write.
    const window = src.slice(Math.max(0, markerWrite - 2000), markerWrite)
    expect(window.split('\n').slice(-25).join('\n')).toContain(flag)
  })
})

// #769: one name per flag across the twins: `-AcceptLicense` in the .ps1's param() is `--accept-license` among the .sh's
// case arms. A flag added to one twin alone is a command that works on one OS and stops at "Unknown argument" on the other.
describe('twin scripts take the same flags', () => {
  const kebab = (name: string): string => `--${name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`

  /**
   * A .ps1's `param(...)` names, kebab-cased. Strings, comments and the `[...]` attributes and types go first, so
   * `[Parameter(Mandatory = $true)]` names no `$true` and a default `@('a', 'b')` is no list of names; a name right after
   * a `=` is a default's value, not a parameter.
   */
  function ps1Flags(src: string): string[] {
    const start = src.search(/^param\(/im)
    if (start < 0) throw new Error('no param( block')
    let depth = 0
    let end = -1
    let quote = ''
    for (let i = start + 'param'.length; i < src.length && end < 0; i++) {
      const c = src[i]
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === "'" || c === '"') quote = c
      else if (c === '#') i = src.includes('\n', i) ? src.indexOf('\n', i) : src.length
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) end = i
    }
    if (end < 0) throw new Error('param( block not closed')
    let body = src
      .slice(start + 'param('.length, end)
      .replace(/'[^']*'|"[^"]*"/g, "''")
      .replace(/#.*$/gm, '')
    while (/\[[^[\]]*\]/.test(body)) body = body.replace(/\[[^[\]]*\]/g, ' ')
    return [...body.matchAll(/(?<!=\s*)\$([A-Za-z_]\w*)(?=\s*(?:[=,]|$))/g)].map((m) => kebab(m[1])).sort()
  }

  /** A .sh's long flags: its case arms (`--x)`, `--x=*)`, `-h|--help)`) and any `== "--x"` test, less `--help`. */
  function shFlags(src: string): string[] {
    const flags = new Set<string>()
    for (const line of src.split('\n')) {
      if (line.trim().startsWith('#')) continue
      const arm = /^\s*([-\w|=*]+)\)/.exec(line)
      for (const alt of arm?.[1].split('|') ?? []) if (alt.startsWith('--')) flags.add(alt.replace(/=\*$/, ''))
      for (const m of line.matchAll(/==\s*"(--[\w-]+)"/g)) flags.add(m[1])
    }
    flags.delete('--help') // PowerShell answers -? and Get-Help on its own
    return [...flags].sort()
  }

  const TWINS = readdirSync(join(REPO_ROOT, 'scripts'))
    .filter((f) => f.endsWith('.ps1') && existsSync(join(REPO_ROOT, 'scripts', f.replace(/\.ps1$/, '.sh'))))
    .map((f) => f.replace(/\.ps1$/, ''))

  it('finds the twins, and reads both spellings of an example', () => {
    expect(TWINS).toEqual(expect.arrayContaining(['build-commercial-drive', 'fetch-models', 'prepare-drive', 'setup-dev']))
    const ps1 = [
      'param(',
      '  [Parameter(Mandatory = $true)] [string] $Target,',
      "  [string[]] $Platforms = @('a', 'b'),",
      '  [bool] $Keep = $true, # a comment (with a paren',
      '  [switch] $DryRun',
      ')',
      '$Ignored = 1'
    ].join('\n')
    expect(ps1Flags(ps1)).toEqual(['--dry-run', '--keep', '--platforms', '--target'])
    const sh = [
      'case "$1" in',
      '  --target) T="$2"; shift 2 ;;',
      '  --target=*) T="${1#*=}"; shift ;;',
      '  --dry-run|-n) D=1; shift ;;',
      '  -h|--help) exit 0 ;;',
      '  *) exit 2 ;;',
      'esac',
      '[[ "${1:-}" == "--keep" ]] && K=1'
    ].join('\n')
    expect(shFlags(sh)).toEqual(['--dry-run', '--keep', '--target'])
  })

  it.each(TWINS)('%s: the .ps1 param() names are the .sh flags', (base) => {
    expect(shFlags(repoText(`scripts/${base}.sh`))).toEqual(ps1Flags(repoText(`scripts/${base}.ps1`)))
  })
})

const SHELL_SCRIPTS = [
  ...readdirSync(join(REPO_ROOT, 'scripts'))
    .filter((f) => f.endsWith('.sh'))
    .map((f) => `scripts/${f}`),
  'launchers/start-hilbertraum.sh',
  'launchers/Start HilbertRaum.command'
]

describe('shell scripts — runnable under macOS stock Bash 3.2', () => {
  // macOS ships Bash 3.2 (GPLv2) and `#!/usr/bin/env bash` resolves to it on a stock machine
  // and on the macOS runners. A Bash 4+ construct passes every Windows/Linux leg (git-bash and
  // ubuntu carry Bash 5) and then dies on a Mac with "command not found": a `mapfile` in
  // fetch-runtime.sh, added after v0.1.59, failed the v0.1.60 release's mac leg, then the only
  // place any CI ran these scripts on macOS. String scan of CODE lines only (the comments
  // legitimately name the builtins they avoid).
  const BASH4_ONLY: Array<[string, RegExp, string]> = [
    ['mapfile / readarray', /(^|[\s;&|(])(mapfile|readarray)\s/, 'mapfile -t lines'],
    ['associative array (declare/local -A)', /\b(declare|local|typeset)\s+-[a-zA-Z]*A/, 'declare -A map'],
    ['nameref (declare/local -n)', /\b(declare|local|typeset)\s+-[a-zA-Z]*n\s/, 'local -n ref=x'],
    ['case-modifying expansion ${x,,} / ${x^^}', /\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?(,,?|\^\^?)[^}]*\}/, 'x=${name,,}'],
    ['coproc', /(^|[\s;&|(])coproc\s/, 'coproc cat'],
    ['|& pipe', /\|&/, 'a |& b'],
    ['&>> redirect', /&>>/, 'a &>> log'],
    ['declare -g', /\b(declare|local|typeset)\s+-[a-zA-Z]*g/, 'declare -g FOO=1'],
    ['[[ -v', /\[\[\s+-v\s/, '[[ -v FOO ]]'],
    ['case fall-through ;& / ;;&', /;;?&\s*$/, '  a) echo a ;;&'],
    ['negative array index', /\$\{[A-Za-z_][A-Za-z0-9_]*\[-\d+\]\}/, 'x=${arr[-1]}'],
    ['${x@op} transform', /\$\{[A-Za-z_][A-Za-z0-9_]*@[A-Za-z]\}/, 'x=${y@Q}'],
    ['wait -n', /\bwait\s+-n\b/, 'wait -n'],
    ['globstar', /\bshopt\s+-s\s+globstar\b/, 'shopt -s globstar']
  ]

  it('finds the scripts it is meant to scan', () => {
    expect(SHELL_SCRIPTS).toContain('scripts/fetch-runtime.sh')
    expect(SHELL_SCRIPTS.length).toBeGreaterThanOrEqual(8)
  })

  it('every construct pattern matches its own example', () => {
    for (const [name, re, example] of BASH4_ONLY) expect(re.test(example), name).toBe(true)
  })

  for (const rel of SHELL_SCRIPTS) {
    it(`${rel} uses no Bash 4+ construct`, () => {
      const hits: string[] = []
      repoText(rel)
        .split('\n')
        .forEach((text, i) => {
          if (text.trim().startsWith('#')) return
          for (const [name, re] of BASH4_ONLY) {
            if (re.test(text)) hits.push(`${rel}:${i + 1} ${name}: ${text.trim()}`)
          }
        })
      expect(hits).toEqual([])
    })
  }
})

// #765: a `[[ … =~ … ]]` rewrites BASH_REMATCH. A function that runs one, called between a caller's
// match and its read of the capture, leaves the caller the function's capture or none, and under
// `set -u` that read ends the script. It shows only on the input that takes the call (a second OCR
// file in build-commercial-drive.sh), so the shape is checked as text, on every script.
describe('shell scripts — no capture read after a call that rewrites it', () => {
  const code = (line: string): boolean => !line.trim().startsWith('#')

  /** The functions whose body runs a `=~`, one-line (`f() { …; }`) or block form. */
  function matchingFunctions(lines: string[]): string[] {
    const names: string[] = []
    lines.forEach((line, i) => {
      const head = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{(.*)$/.exec(line)
      if (!head) return
      const [, indent, name, rest] = head
      const body = [rest]
      if (!rest.trim().endsWith('}')) {
        for (let j = i + 1; j < lines.length && lines[j] !== `${indent}}`; j++) body.push(lines[j])
      }
      if (body.some((l) => code(l) && l.includes('=~'))) names.push(name)
    })
    return names
  }

  /** `file:line` for each read of BASH_REMATCH that a completed call to such a function precedes. */
  function clobberedReads(rel: string, text: string): string[] {
    const lines = text.split('\n')
    const fns = matchingFunctions(lines)
    // A call that completes before the read: the name ends a command. `f "${BASH_REMATCH[1]}"` expands first, so it is fine.
    const call = (s: string): boolean => fns.some((fn) => new RegExp(`(^|[;&|{(\\s])${fn}\\s*(;|$)`, 'm').test(s))
    const hits: string[] = []
    let match = -1
    lines.forEach((line, i) => {
      if (!code(line)) return
      const read = line.indexOf('BASH_REMATCH')
      // A match ahead of the read on its own line is the one the read belongs to.
      if (line.includes('=~') && (read < 0 || line.indexOf('=~') < read)) match = i
      if (read >= 0 && match >= 0) {
        const after = (s: string): string => s.slice(s.lastIndexOf(']]') + 2)
        const between =
          match === i
            ? after(line.slice(0, read))
            : [after(lines[match]), ...lines.slice(match + 1, i).filter(code), line.slice(0, read)].join('\n')
        if (call(between)) hits.push(`${rel}:${i + 1}`)
      }
      if (line.includes('=~') && read >= 0 && line.indexOf('=~') > read) match = i
    })
    return hits
  }

  it('finds the #765 shape, and passes a capture handed to a function as its argument', () => {
    const fixture = [
      'check() {',
      '  [[ "$x" =~ ^[a-f0-9]{64}$ ]] && echo ok',
      '}',
      'strip() { echo "$1"; }',
      'while read -r line; do',
      '  if [[ "$line" =~ ^-\\ lang:\\ (.+)$ ]]; then',
      '    check',
      '    lang="${BASH_REMATCH[1]}"',
      '  fi',
      '  [[ "$line" =~ ^(.+)$ ]] && v="$(strip "${BASH_REMATCH[1]}")"',
      'done'
    ].join('\n')
    expect(clobberedReads('fixture', fixture)).toEqual(['fixture:8'])
  })

  for (const rel of SHELL_SCRIPTS) {
    it(`${rel} reads no capture after a call that rewrites it`, () => {
      expect(clobberedReads(rel, repoText(rel))).toEqual([])
    })
  }
})

// GNU tar reads a `C:` in an archive name as a remote host, so under Git Bash `tar -xzf 'C:\…'` opens nothing (#767). No CI
// leg runs a shell script with a tar archive on Windows, yet release.yml runs fetch-runtime.sh under Git Bash; so the shape
// is checked as text: a script hands tar its archive on stdin (`-f -`).
describe('shell scripts — tar reads its archive from stdin', () => {
  const BY_NAME = /\btar\s+(-[A-Za-z]*f|--file)[\s=]+(?!-(\s|$))\S/

  it('the pattern finds an archive passed by name and passes stdin', () => {
    expect(BY_NAME.test('tar -xzf "$ARCHIVE" -C "$DIR"')).toBe(true)
    expect(BY_NAME.test('tar --file="$ARCHIVE" -t')).toBe(true)
    expect(BY_NAME.test('tar -xzf - -C "$DIR" < "$ARCHIVE"')).toBe(false)
  })

  it('no shell script passes tar an archive name', () => {
    const hits = SHELL_SCRIPTS.flatMap((rel) =>
      codeLines(rel)
        .filter(({ text }) => BY_NAME.test(text))
        .map(({ n, text }) => `${rel}:${n}: ${text.trim()}`)
    )
    expect(hits).toEqual([])
  })
})

// A renamed launcher or doc is skipped silently: both copy steps sit behind a plain existence test.
describe('what the scripts copy onto a drive', () => {
  it.each(['scripts/build-commercial-drive.ps1', 'scripts/build-commercial-drive.sh'])(
    '%s copies every Kit launcher and READ ME FIRST.txt',
    (rel) => {
      const line = codeLines(rel).map((l) => l.text).find((l) => l.includes('READ ME FIRST.txt'))
      for (const name of [...KIT_PLATFORMS.map((p) => KIT_PLATFORM_SPECS[p].launcher), 'READ ME FIRST.txt']) {
        expect(line, `${rel} step 5`).toContain(name)
        expect(existsSync(join(REPO_ROOT, 'launchers', name)), name).toBe(true)
      }
    }
  )

  it('both prepare-drive twins copy the same user docs, and each one exists', () => {
    const ps = repoText('scripts/prepare-drive.ps1').match(/\$DocFiles = @\(([^)]*)\)/)
    const sh = repoText('scripts/prepare-drive.sh').match(/for rel in ([^;]+);/)
    const psDocs = [...ps![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(sh![1].trim().split(/\s+/)).toEqual(psDocs)
    expect(psDocs.length).toBeGreaterThan(0)
    for (const d of psDocs) expect(existsSync(join(REPO_ROOT, d)), d).toBe(true)
  })
})

describe('launchers keep the line endings their shell needs (audit M20)', () => {
  it.each(['launchers/Start HilbertRaum.cmd', 'launchers/READ ME FIRST.txt'])('%s is CRLF on every line', (rel) => {
    const text = repoText(rel)
    expect(text.length).toBeGreaterThan(0)
    expect(text.match(/(?<!\r)\n/g) ?? []).toEqual([])
  })

  it.each(['launchers/Start HilbertRaum.command', 'launchers/start-hilbertraum.sh'])('%s has no CR', (rel) => {
    expect(repoText(rel)).not.toContain('\r')
  })
})
