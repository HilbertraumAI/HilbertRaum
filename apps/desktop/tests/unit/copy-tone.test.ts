import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NO_DOCUMENT_CONTEXT_ANSWER, REINDEX_NEEDED_ANSWER } from '../../src/main/services/rag'
import { COMPATIBILITY_MODE_NOTICE } from '../../src/main/services/runtime/factory'

// Phase 27 copy-tone guard (guidelines §7): keeps the swept user-facing strings swept.
// Two layers: (1) tone assertions on the exported user-facing constants — calm, no
// exclamation marks, next step included; (2) a source scan that fails if a stale phrase
// reappears INSIDE a string literal (comments are fine — they aren't user-facing).

const SRC = join(__dirname, '..', '..', 'src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Lines where `phrase` occurs inside a quoted string (rough but effective). */
function literalOccurrences(phrase: string): string[] {
  const hits: string[] = []
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const idx = line.indexOf(phrase)
      if (idx === -1) return
      // Inside a string literal = an odd number of quote chars before the phrase.
      const before = line.slice(0, idx)
      const quotes = (before.match(/['"`]/g) ?? []).length
      if (quotes % 2 === 1) hits.push(`${file}:${i + 1}`)
    })
  }
  return hits
}

describe('user-facing constants follow the §7 voice', () => {
  it.each([
    ['NO_DOCUMENT_CONTEXT_ANSWER', NO_DOCUMENT_CONTEXT_ANSWER],
    ['REINDEX_NEEDED_ANSWER', REINDEX_NEEDED_ANSWER],
    ['COMPATIBILITY_MODE_NOTICE', COMPATIBILITY_MODE_NOTICE]
  ])('%s is calm and jargon-free', (_name, text) => {
    expect(text).not.toMatch(/!/) // no exclamation marks in failure states
    expect(text).not.toMatch(/checksum|exit code|GPU|embedding model|quantization/i)
    expect(text.length).toBeGreaterThan(20)
  })

  it('the not-found answer offers a next step without blaming the user', () => {
    expect(NO_DOCUMENT_CONTEXT_ANSWER).toMatch(/try rephrasing/i)
    expect(NO_DOCUMENT_CONTEXT_ANSWER).not.toMatch(/0 results|no results returned/i)
  })
})

describe('stale phrases stay out of user-facing string literals', () => {
  it.each([
    'the Models screen', // renamed to "AI Model" in Phase 26
    'Checksum verification failed',
    'Stop generation',
    'Regenerate response',
    'Telemetry disabled',
    'GPU acceleration auto-disabled',
    // The auto "suggested project" feature was removed — no suggestion copy may remain (EN/DE).
    'Suggested project',
    'Suggested new project',
    'Vorgeschlagenes Projekt',
    'Vorgeschlagenes neues Projekt'
  ])('no string literal says %j', (phrase) => {
    expect(literalOccurrences(phrase)).toEqual([])
  })
})
