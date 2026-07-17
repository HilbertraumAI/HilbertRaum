import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// F-41 (audit-2026-07-16): a ONE-WAY ratchet on `as never` casts in the test tree.
//
// `stubApi(overrides: Partial<PreloadApi>)` (tests/helpers/renderer.ts) exists so stub payloads
// are typechecked against the real preload bridge contract; a blanket `... as never` opts a
// payload out of that check, so a shared-type or method rename keeps compiling against a stale
// stub (the vacuous-green class the audit flagged). Phase 9 converted the five heaviest offenders
// (fileTranslateSession, ImagesScreen, TranslateScreen, AppLock, translateSession) to typed
// partial builders + narrow named casts. This net stops the erosion re-opening: the count of real
// `as never` casts under tests/ may only DECREASE. It is a ratchet, not a ban — the remaining
// casts get converted fix-when-touched (CONTRIBUTING test guidance), and whoever removes some
// should LOWER `BASELINE` to the new number so the ratchet stays tight.
//
// The counter strips comments first, so prose that mentions `as never` (including this file's own
// explanation and the converted files' header notes) never inflates the count.

const TESTS_DIR = join(__dirname, '..')
const SELF = 'as-never-ratchet.test.ts'

/** Crude comment strip — good enough to keep prose mentions of the cast out of the count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function countAsNever(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      total += countAsNever(full)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry) || entry === SELF) continue
    const matches = stripComments(readFileSync(full, 'utf8')).match(/\bas never\b/g)
    total += matches ? matches.length : 0
  }
  return total
}

// The count AT Phase 9's commit, after converting the five heaviest cast files. LOWER this when
// you remove casts; the test fails if it ever climbs (a new `as never` was added).
const BASELINE = 110

describe('F-41 `as never` ratchet (audit-2026-07-16)', () => {
  it('the number of `as never` casts under tests/ never exceeds the recorded baseline', () => {
    expect(countAsNever(TESTS_DIR)).toBeLessThanOrEqual(BASELINE)
  })
})
