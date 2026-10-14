import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ENV_NOT_SCRUBBED, SCRUBBED_ENV } from '../setup-env-scrub'

// #687 — keeps tests/setup-env-scrub.ts honest. The scrub deletes an EXPLICIT list (a prefix sweep
// would also delete the harness's and the gated tiers' own variables), so a new override read in
// `src/` would silently reach `npm test` from a developer's shell again. This inventory fails until
// every `HILBERTRAUM_*` / `HR_*` name in `src/` code is either scrubbed or kept on purpose, and
// until a list entry `src/` no longer uses is dropped.

const SRC_DIR = join(__dirname, '..', '..', 'src')

/** Crude comment strip, so a name that only appears in prose does not count as a read. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** Every `HILBERTRAUM_*` / `HR_*` name in src code → the first file that uses it. */
function envNamesInSrc(dir: string, found = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      envNamesInSrc(full, found)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    for (const [name] of stripComments(readFileSync(full, 'utf8')).matchAll(/\b(?:HILBERTRAUM|HR)_[A-Z0-9_]+\b/g)) {
      if (!found.has(name)) found.set(name, relative(SRC_DIR, full))
    }
  }
  return found
}

describe('setup-env-scrub inventory (#687)', () => {
  const inSrc = envNamesInSrc(SRC_DIR)

  it('every HILBERTRAUM_* / HR_* name src reads is scrubbed for tests or deliberately kept', () => {
    const listed = new Set([...SCRUBBED_ENV, ...ENV_NOT_SCRUBBED])
    const unlisted = [...inSrc].filter(([name]) => !listed.has(name)).map(([name, file]) => `${name} (${file})`)
    // Add each to SCRUBBED_ENV (a behaviour override) or ENV_NOT_SCRUBBED (with the reason).
    expect(unlisted).toEqual([])
  })

  it('every listed name is still used in src', () => {
    expect([...SCRUBBED_ENV, ...ENV_NOT_SCRUBBED].filter((name) => !inSrc.has(name))).toEqual([])
  })
})
