import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  candidates,
  germanCapitalizedNounTokens,
  norm,
  resolveHeadNoun
} from '../../src/main/services/zim/head-noun'

// Phase 4 PR-A — the ported step 1a-i head-noun rule (`head-noun-rule.mjs`, frozen v1),
// `docs/rag-design.md` §17 "Discovery port (Phase 4 PR-A)". `candidates(w)` is pure; the
// worked examples below are the rule's own documented cases (its header comment) plus one
// real DEV49-de case from `steps/1a-i-title-grounding/artifacts/head-noun-reads.json`
// ("Wärme"/"Raum" -> zero candidates, both too short for the prefix floor).

describe('candidates — pure candidate generation, priority order', () => {
  it('hyphen split: the LAST component first (the compound head)', () => {
    expect(candidates('Vierer-Curling')[0]).toBe('Curling')
    expect(candidates('Vierer-Curling')).toContain('Vierer')
  })

  it('inflection strip: the longest matching suffix, one candidate', () => {
    expect(candidates('Nepals')).toContain('Nepal')
  })

  it('the longest-suffix rule prevents a redundant pair: "es" wins over "s"', () => {
    // "Bikes" ends in BOTH "es" and, trivially, "s" — only the longest match fires.
    expect(candidates('Bikes')).toEqual(['Bik'])
  })

  it('prefix strip: the brief\'s five keep-first-component examples', () => {
    expect(candidates('Gezeitenberg')).toContain('Gezeiten')
    expect(candidates('Keilschriftzeichen')).toContain('Keilschrift')
    expect(candidates('Tischtennisball')).toContain('Tischtennis')
    expect(candidates('Vanillepflanze')).toContain('Vanille')
    expect(candidates('Korkeiche')).toContain('Kork')
  })

  it('the prefix+redirect example: Dezibelwerte reaches "Dezibel" among its candidates', () => {
    expect(candidates('Dezibelwerte')).toContain('Dezibel')
  })

  it('the Fugenelement shortcut respects the length-4 floor on BOTH variants (v1 fix)', () => {
    // "Erdseite" -> prefix "Erdse" (Fugenelement 'e', floor ok) -> "Erds" (Fugenelement 's',
    // but stripping it would leave "Erd" at only 3 chars — the floor refuses it).
    const result = candidates('Erdseite')
    expect(result).toEqual(['Erdse', 'Erds'])
    expect(result).not.toContain('Erd')
  })

  it('too short for the prefix floor and no matching suffix: zero candidates (real case: "Wärme"/"Raum")', () => {
    expect(candidates('Wärme')).toEqual([])
    expect(candidates('Raum')).toEqual([])
  })

  it('candidates below MIN_CANDIDATE_LEN are never produced', () => {
    for (const c of candidates('Autos')) expect(c.length).toBeGreaterThanOrEqual(3)
  })

  it('is pure and order-stable across repeated calls', () => {
    expect(candidates('Tischtennisball')).toEqual(candidates('Tischtennisball'))
  })
})

describe('norm — the harness-compatible title normaliser', () => {
  it('folds diacritics, case, ß, underscores and whitespace', () => {
    expect(norm('Straße')).toBe('strasse')
    expect(norm('Kork_(Material)')).toBe(norm('Kork (Material)'))
    expect(norm('  Café   Wien  ')).toBe('cafe wien')
  })
})

describe('germanCapitalizedNounTokens — candidate words from a German question', () => {
  it('keeps capitalised content words, in order, deduplicated case-insensitively', () => {
    expect(germanCapitalizedNounTokens('Was sind Autos und Autos?')).toEqual(['Autos'])
    expect(germanCapitalizedNounTokens('Welche Rolle spielt das Treibhausgas?')).toEqual(['Treibhausgas'])
  })

  it('drops stop words and frame words even when capitalised (sentence-initial position)', () => {
    // "Was"/"Welche" are stop words; "Rolle" is a frame word — none is a content word.
    expect(germanCapitalizedNounTokens('Was ist das?')).toEqual([])
    expect(germanCapitalizedNounTokens('Welche Rolle spielt Photosynthese?')).toEqual(['Photosynthese'])
  })

  it('drops tokens of length <= 2', () => {
    expect(germanCapitalizedNounTokens('Ist CO groß?')).not.toContain('CO')
  })

  it('an all-lowercase question yields nothing', () => {
    expect(germanCapitalizedNounTokens('wie viel kostet das?')).toEqual([])
  })
})

describe('resolveHeadNoun — probing the title index (/suggest)', () => {
  let server: http.Server
  let port = 0
  const suggestCalls: Array<{ name: string; term: string }> = []
  /** Terms this fixture confirms with an EXACT match. */
  const confirmed = new Set(['Gezeiten', 'Bik'])

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/suggest') {
        const name = url.searchParams.get('content') ?? ''
        const term = url.searchParams.get('term') ?? ''
        suggestCalls.push({ name, term })
        if (term === 'timeout-me') return // never answered — the caller's own timeout applies
        // "Gezeitenberg"'s own first candidate (the prefix strip's k=9) — errors so the
        // fail-soft leg below can prove probing continues to "Gezeiten" (k=8) next.
        if (term === 'Gezeitenb') {
          res.writeHead(500)
          res.end('boom')
          return
        }
        if (confirmed.has(term)) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify([{ value: term, kind: 'path', path: term }]))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('[]')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('accepts the first candidate the title index confirms EXACTLY, in priority order', async () => {
    suggestCalls.length = 0
    const res = await resolveHeadNoun(port, 'book', 'Gezeitenberg', undefined)
    expect(res.accepted).toMatchObject({ title: 'Gezeiten' })
    expect(res.candidate).toBe('Gezeiten')
    // The prefix sweep starts at "Gezeitenb" (k=9) and only reaches "Gezeiten" (k=8) second.
    expect(suggestCalls.map((c) => c.term)).toEqual(['Gezeitenb', 'Gezeiten'])
  })

  it('a candidate the index does not confirm is skipped, fail-soft', async () => {
    suggestCalls.length = 0
    const res = await resolveHeadNoun(port, 'book', 'Bikes', undefined)
    expect(res.accepted).toMatchObject({ title: 'Bik' })
    expect(res.probes).toBe(1) // "Bikes" has exactly one candidate ("Bik")
  })

  it('never accepts a non-exact (prefix) suggest hit', async () => {
    suggestCalls.length = 0
    const res = await resolveHeadNoun(port, 'book', 'Nichtsvorhanden', undefined, { maxProbes: 6 })
    expect(res.accepted).toBeNull()
    expect(res.candidate).toBeNull()
  })

  it('respects maxProbes — never asks past the cap even when more candidates exist', async () => {
    suggestCalls.length = 0
    const full = candidates('Geschirrspülmaschine')
    expect(full.length).toBeGreaterThan(3)
    const res = await resolveHeadNoun(port, 'book', 'Geschirrspülmaschine', undefined, { maxProbes: 3 })
    expect(res.probes).toBe(3)
    expect(suggestCalls).toHaveLength(3)
    expect(suggestCalls.map((c) => c.term)).toEqual(full.slice(0, 3))
  })

  it('a word with zero candidates never calls /suggest at all', async () => {
    suggestCalls.length = 0
    const res = await resolveHeadNoun(port, 'book', 'Wärme', undefined)
    expect(res.probes).toBe(0)
    expect(res.candidatesTotal).toBe(0)
    expect(suggestCalls).toHaveLength(0)
    expect(res.accepted).toBeNull()
  })

  it('a probe that errors (non-abort, e.g. HTTP 500) is skipped, fail-soft — probing continues to the next candidate', async () => {
    // "Gezeitenberg"'s first candidate ("Gezeitenb", the prefix strip's k=9) 500s in this
    // fixture; resolveHeadNoun must still reach and accept "Gezeiten" (k=8) next — the same
    // outcome as the ordinary-404 leg above, proving a transport ERROR is no different.
    suggestCalls.length = 0
    const res = await resolveHeadNoun(port, 'book', 'Gezeitenberg', undefined)
    expect(res.accepted).toMatchObject({ title: 'Gezeiten' })
    expect(suggestCalls.map((c) => c.term)).toEqual(['Gezeitenb', 'Gezeiten'])
    expect(res.tried[0]).toMatchObject({ candidate: 'Gezeitenb', ok: false })
  })

  it('an already-aborted signal rejects, with zero calls', async () => {
    suggestCalls.length = 0
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(resolveHeadNoun(port, 'book', 'Gezeitenberg', ctrl.signal)).rejects.toBeTruthy()
  })
})
