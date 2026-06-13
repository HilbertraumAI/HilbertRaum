import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { DRIVE_LAYOUT_DIRS, DRIVE_FORMAT_VERSION } from '../../src/main/services/drive'
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
