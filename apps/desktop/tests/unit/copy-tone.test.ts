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

/**
 * Lines where `phrase` occurs inside a string literal. T-3 (#147): a real single-pass
 * scanner replacing the old per-line quote-parity count, which (a) missed phrases inside
 * MULTI-LINE template literals entirely and (b) let an apostrophe in a same-line comment
 * flip the parity — both false-NEGATIVE modes that let stale phrases slip back silently.
 * The scanner tracks comment state (quotes in comments never count) and carries template-
 * literal state across lines. Still a heuristic (regex literals containing quote chars can
 * briefly confuse it), but strictly tighter than the parity count it replaces.
 */
function literalOccurrences(phrase: string): string[] {
  const hits: string[] = []
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8')
    let inLine = false
    let inBlock = false
    let quote: string | null = null
    let literal = ''
    let literalStartLine = 0
    let lineNo = 1
    const closeLiteral = (): void => {
      if (literal.includes(phrase)) hits.push(`${file}:${literalStartLine}`)
      literal = ''
    }
    for (let i = 0; i < src.length; i++) {
      const c = src[i]
      const next = src[i + 1]
      if (c === '\n') lineNo++
      if (inLine) {
        if (c === '\n') inLine = false
        continue
      }
      if (inBlock) {
        if (c === '*' && next === '/') {
          inBlock = false
          i++
        }
        continue
      }
      if (quote) {
        if (c === '\\') {
          literal += c + (next ?? '')
          i++
          continue
        }
        if (c === quote) {
          quote = null
          closeLiteral()
          continue
        }
        literal += c
        continue
      }
      if (c === '/' && next === '/') {
        inLine = true
        i++
        continue
      }
      if (c === '/' && next === '*') {
        inBlock = true
        i++
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c
        literalStartLine = lineNo
      }
    }
    if (quote) closeLiteral() // unterminated at EOF — still check what accumulated
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
    // The import-failure copy was localized + softened (§7): the raw English literal is gone,
    // routed through `main.ingest.unsupportedType` ("This file type isn't supported (…)").
    'Unsupported file type',
    // The auto "suggested project" feature was removed — no suggestion copy may remain (EN/DE).
    'Suggested project',
    'Suggested new project',
    'Vorgeschlagenes Projekt',
    'Vorgeschlagenes neues Projekt',
    // The AI Model demo affordance was de-jargoned (§3/§7): "mock runtime"/"Demo-Runtime"
    // is developer-speak. The button + diagnostics label now say "demo mode" / „Demo-Modus".
    'Start mock runtime',
    'Demo-Runtime'
  ])('no string literal says %j', (phrase) => {
    expect(literalOccurrences(phrase)).toEqual([])
  })
})
