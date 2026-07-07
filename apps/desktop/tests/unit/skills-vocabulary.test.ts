import { describe, it, expect } from 'vitest'
import { countKeywordHits } from '../../src/main/services/skills/selector'
import {
  APP_VOCAB_SKILL_IDS,
  SKILL_VOCABULARY,
  deriveMatch,
  entryMatches,
  isNeedleShaped,
  isSmallTalk,
  routeEntries,
  routeMatch,
  suggestTerms,
  type SkillVocabId,
  type VocabEntry
} from '../../src/main/services/skills/vocabulary'

// W5 (audit §3.2/§4.1/§4.2/§8.3) — the ONE canonical trigger vocabulary is the single source both the
// SUGGESTION scorer and the ROUTING gates read. These tests pin its INTERNAL invariants (so the two
// consumers can never disagree) and its MATCHING semantics (word-boundary vs substring), and prove the
// handler-vocab DRIFT guard: every routing term actually routes.

describe('vocabulary — structural invariants', () => {
  it('covers exactly the nine app skills, each with a non-empty vocabulary', () => {
    expect(APP_VOCAB_SKILL_IDS.length).toBe(9)
    for (const id of APP_VOCAB_SKILL_IDS) {
      expect(SKILL_VOCABULARY[id]?.length ?? 0).toBeGreaterThan(0)
    }
    // No stray keys beyond the declared eight.
    expect(Object.keys(SKILL_VOCABULARY).sort()).toEqual([...APP_VOCAB_SKILL_IDS].sort())
  })

  it('every entry is well-formed (whitespace ⟺ phrase, no dupes) and every offer term is scorer-matchable', () => {
    for (const id of APP_VOCAB_SKILL_IDS) {
      const seen = new Set<string>()
      for (const e of SKILL_VOCABULARY[id]) {
        const term = e.term.trim().toLowerCase()
        expect(term.length, `${id}: empty term`).toBeGreaterThan(0)
        expect(e.term, `${id}: term not trimmed`).toBe(e.term.trim())
        // No duplicate term within a skill (case-insensitive).
        expect(seen.has(term), `${id}: duplicate term "${term}"`).toBe(false)
        seen.add(term)
        // The ONE structural rule: a multi-word term MUST be a phrase, and a single token must NOT be
        // (it is 'word' for boundary matching or 'stem' for German compound substring). `match` drives
        // ROUTE only — the suggestion scorer word/phrase-infers from the term shape itself, independently.
        const hasSpace = /\s/.test(e.term)
        expect(e.match === 'phrase', `${id}: "${term}" phrase⇔whitespace mismatch`).toBe(hasSpace)
        expect(deriveMatch(e.term), `${id}: deriveMatch sanity`).toBe(hasSpace ? 'phrase' : 'word')
        // A `suggest|both` term must be matchable by the SCORER when it appears as a standalone token —
        // otherwise it is a dead offer keyword. (`countKeywordHits` word/phrase-infers exactly as the
        // scorer does, so this is the offer-side liveness guard the parity/route tests don't cover.)
        if (e.use === 'suggest' || e.use === 'both') {
          expect(countKeywordHits([e.term], `bitte ${e.term} jetzt`), `${id}: "${term}" never offers`).toBe(1)
        }
      }
    }
  })
})

describe('entryMatches / routeMatch — word-boundary vs substring', () => {
  const wordEntry = (term: string): VocabEntry => ({ term, lang: 'en', match: 'word', use: 'route' })
  const phraseEntry = (term: string): VocabEntry => ({ term, lang: 'en', match: 'phrase', use: 'route' })
  const stemEntry = (term: string): VocabEntry => ({ term, lang: 'de', match: 'stem', use: 'route' })

  it('a WORD entry is boundary-matched (never a substring inside a longer word)', () => {
    expect(entryMatches(wordEntry('net'), 'what is my net income')).toBe(true)
    expect(entryMatches(wordEntry('net'), 'cancel my netflix abo')).toBe(false)
    expect(entryMatches(wordEntry('tax'), 'the tax is due')).toBe(true)
    expect(entryMatches(wordEntry('tax'), 'the syntax of this')).toBe(false)
  })

  it('a PHRASE entry is substring-matched', () => {
    expect(entryMatches(phraseEntry('safe to share'), 'is this safe to share?')).toBe(true)
    expect(entryMatches(phraseEntry('safe to share'), 'is this safe?')).toBe(false)
  })

  it('a STEM entry is substring-matched (German inflections/compounds)', () => {
    expect(entryMatches(stemEntry('transaktion'), 'zeig mir die transaktionen')).toBe(true)
    expect(entryMatches(stemEntry('zusammenfass'), 'bitte zusammenfassen')).toBe(true)
  })

  it('the known substring reproductions do NOT route (Netflix→net, syntax→tax)', () => {
    expect(routeMatch('bank-statement', 'Wie kündige ich mein Netflix-Abo?')).toBe(false)
    expect(routeMatch('invoice', 'Explain the syntax of this formula')).toBe(false)
    // …and the flagship under-fire now DOES route.
    expect(routeMatch('meeting-protocol', 'Summarize this meeting')).toBe(true)
    // off-topic stays off.
    expect(routeMatch('bank-statement', 'what is the weather today?')).toBe(false)
    expect(routeMatch('invoice', 'tell me a joke')).toBe(false)
  })
})

describe('route-term liveness — every declared routing term self-matches', () => {
  // For every skill, EACH `route|both` term, a synthetic question embedding it matches `routeMatch`. This
  // is a LIVENESS check (no dead/typo'd route term, and the word/phrase/stem match type actually fires on
  // the term) — NOT an end-to-end handler test: the two OTHER guards cover wiring. (1) The routing gates
  // call `routeMatch(skillId: SkillVocabId, …)`, so a handler wired to the WRONG skill id is a COMPILE
  // error. (2) The per-handler integration tests (`skills-analysis-{bank,invoice,redaction,whole-doc}.test.ts`)
  // drive the REAL `applies()`/`intends()` with representative EN+DE questions, so a mis-wired gate reddens
  // there (verified: mutating redaction's gate to another skill fails those). Here we only pin term liveness.
  for (const id of APP_VOCAB_SKILL_IDS) {
    it(`${id}: all ${routeEntries(id).length} route terms match a question containing them`, () => {
      for (const e of routeEntries(id)) {
        const q = `bitte ${e.term} jetzt` // wrap so a word entry sees clean boundaries
        expect(routeMatch(id, q), `${id}: route term "${e.term}" did not route`).toBe(true)
      }
    })
  }
})

describe('suggest↔route derivation', () => {
  it('suggestTerms are exactly the `suggest|both` terms (the manifest parity contract source)', () => {
    for (const id of APP_VOCAB_SKILL_IDS) {
      const expected = SKILL_VOCABULARY[id]
        .filter((e) => e.use === 'suggest' || e.use === 'both')
        .map((e) => e.term)
      expect(suggestTerms(id)).toEqual(expected)
    }
  })

  it('unknown skill ids yield empty term/entry lists (never throw)', () => {
    expect(suggestTerms('no-such-skill')).toEqual([])
    expect(routeEntries('no-such-skill')).toEqual([])
    // `routeMatch` is compile-guarded to `SkillVocabId`; the cast checks the runtime stays robust (false,
    // not a throw) if an out-of-union id ever reaches it defensively.
    expect(routeMatch('no-such-skill' as SkillVocabId, 'anything at all')).toBe(false)
  })
})

// A3 (audit §6.3/§8.2) — the SKILL-INDEPENDENT shape classifiers driving the inverted whole-doc gate.
describe('isSmallTalk — off-topic opt-out (A3)', () => {
  it('fires on pure chatter: greetings, thanks, closings, assistant-meta (EN + DE)', () => {
    for (const q of [
      'hi', 'Hello there!', 'hey', 'thanks', 'Thanks!', 'thank you', 'thank you :)', 'ok danke',
      'bye', 'cheers', 'how are you?', 'How are you doing?', "how's it going", 'who are you?',
      'what can you do?', 'tell me a joke', 'hallo', 'servus', 'danke', 'tschüss', 'wie gehts?',
      'wie geht es dir?', 'wer bist du?', 'was kannst du?'
    ]) {
      expect(isSmallTalk(q)).toBe(true)
    }
  })

  it('NEVER fires on a real document question (the inversion default → whole-doc)', () => {
    for (const q of [
      'summarize this contract', 'what colour is the sky?', 'what are the deadlines?',
      'how much did I spend?', 'write the meeting minutes', 'wann ist die frist?',
      'thank you, now summarize the contract', 'hi, can you list the obligations?',
      'what does the document say about termination?', 'is there a renewal clause?'
    ]) {
      expect(isSmallTalk(q)).toBe(false)
    }
  })

  it('empty / whitespace-only is not small talk (nothing to opt out of)', () => {
    expect(isSmallTalk('')).toBe(false)
    expect(isSmallTalk('   ')).toBe(false)
  })
})

describe('isNeedleShaped — needle-vs-deliverable classify (A3)', () => {
  it('fires on a targeted single-fact lookup (EN + DE)', () => {
    for (const q of [
      'how much did I spend on groceries?', 'how many transactions were there?',
      'when is the renewal date?', 'what is the invoice number?', "what's the total due?",
      'is there a termination clause?', 'find the payment date', 'where is the signature?',
      'wie viel kostet das?', 'wie viele positionen gibt es?', 'wann ist die frist?',
      'wo ist die unterschrift?', 'gibt es eine kündigungsklausel?'
    ]) {
      expect(isNeedleShaped(q)).toBe(true)
    }
  })

  it('a DELIVERABLE verb vetoes the needle (never downgraded to top-k)', () => {
    for (const q of [
      'summarize the contract', 'give me an overview', 'write the minutes',
      'list all the obligations', 'what changed between these?', 'review this document',
      'what is the main point?', 'zusammenfassung des vertrags', 'überblick über alle fristen',
      'was hat sich geändert?'
    ]) {
      expect(isNeedleShaped(q)).toBe(false)
    }
  })

  it('a "what is the <synthesis-noun>" ask is a DELIVERABLE, not a needle (whole-doc synthesis, EN+DE)', () => {
    // Guards against downgrading a whole-document synthesis question to ~5 top-k passages — the exact
    // incident A3's inversion exists to kill (a false needle is worse than a false deliverable).
    for (const q of [
      'what is the takeaway of this contract?', 'what is the bottom line?',
      'what is the conclusion of the report?', 'what is the upshot?', 'what is this about?',
      'was ist das Fazit?', 'was ist die Kernaussage?', 'was ist der Inhalt des Dokuments?'
    ]) {
      expect(isNeedleShaped(q)).toBe(false)
    }
  })

  it('a non-needle, non-deliverable question is NOT a needle (defaults to whole-doc)', () => {
    // No lookup interrogative → not a needle → the whole-doc engine stays the default.
    expect(isNeedleShaped('tell me about the parties')).toBe(false)
    expect(isNeedleShaped('explain the agreement')).toBe(false)
  })
})

// W7 (audit §3.2/§3.3/§3.4) — answer-shape + classifier vocabulary tuning. Each probe from the findings
// gets an assertion on its INTENDED shape; teeth-check by reverting the W7 change → the probe flips.
describe('W7 — SKA-7 bank/invoice German money routing (route-only; §3.2/§8.2)', () => {
  it('bank: the German money phrasings that used to fall to raw top-k now ROUTE', () => {
    // Probe-verified misses from the finding — with the bank skill ACTIVE these must reach the handler.
    for (const q of [
      'Wie viel habe ich für Lebensmittel ausgegeben?',
      'Wer hat die höchste Zahlung bekommen?',
      'Wofür habe ich am meisten bezahlt?',
      'what was my biggest payment?',
      'Wie viele Buchungen gab es?' // 'wie viele' + 'buchung'
    ]) {
      expect(routeMatch('bank-statement', q), q).toBe(true)
    }
  })

  it('invoice: a due-date ask reaches the invoice handler (fällig / due)', () => {
    expect(routeMatch('invoice', 'Wann ist sie fällig?')).toBe(true)
    expect(routeMatch('invoice', 'Was ist die Fälligkeit?')).toBe(true)
    expect(routeMatch('invoice', 'when is this invoice due?')).toBe(true)
  })

  it('the bare separable imperatives reach BOTH tool handlers (the A4 rider)', () => {
    expect(routeMatch('bank-statement', 'Fasse das zusammen')).toBe(true)
    expect(routeMatch('bank-statement', 'Liste das auf')).toBe(true)
    expect(routeMatch('invoice', 'Fasse die Rechnung zusammen')).toBe(true)
    expect(routeMatch('invoice', 'Liste die Positionen auf')).toBe(true)
  })

  it('these route-only additions still do NOT hit an off-topic question', () => {
    expect(routeMatch('bank-statement', 'what is the weather today?')).toBe(false)
    expect(routeMatch('invoice', 'tell me a joke')).toBe(false)
  })
})

describe('W7 — SKA-11 small-talk thanks/ack variants + the never-fires guard (§3.3)', () => {
  it('fires on the top-frequency thanks/ack variants the detector used to miss', () => {
    for (const q of [
      'thank you very much', 'thanks a lot!', 'danke dir!', 'danke schön', 'vielen lieben dank',
      'perfect, thanks', 'sounds good', 'all good, thanks!', 'perfekt danke', 'sehr gut, danke'
    ]) {
      expect(isSmallTalk(q), q).toBe(true)
    }
  })

  it('STILL never fires on a real document question (adversarial near-misses)', () => {
    // A real ask always carries a non-filler content word — the module's safety invariant. The new
    // fillers must not swallow one: "ist das gut?" (is that good?) is a real question, NOT small talk.
    for (const q of [
      'ist das gut?', 'is this a good summary?', 'how much did I spend?', 'sind alle Fristen aufgeführt?',
      'is the invoice all paid?', 'sounds like a penalty — is it?', 'was ist das Fazit?'
    ]) {
      expect(isSmallTalk(q), q).toBe(false)
    }
  })
})

describe('W7 — SKA-19 synthesis asks veto the needle (§3.3)', () => {
  it('the extended deliverable synonyms keep a "what is the …" synthesis ask on the whole-doc engine', () => {
    for (const q of [
      'what is the most important point?', 'what is the key insight?', 'what is the verdict of the report?',
      'what is the overall picture?', 'was ist das Wichtigste?', 'was ist die Schlussfolgerung?',
      'was ist die zentrale Erkenntnis?', 'wie ist das Gesamtbild?'
    ]) {
      expect(isNeedleShaped(q), q).toBe(false)
    }
  })
})

describe('W7 — SKA-45 word-anchored needle/deliverable shapes (§3.4)', () => {
  it('the German imperative "finde" is a needle even at END of question (was dead as "finde ")', () => {
    expect(isNeedleShaped('wo ich das finde')).toBe(true) // 'finde' is the last token
    expect(isNeedleShaped('finde die Kündigungsfrist')).toBe(true)
    // …but the word boundary keeps it off inflections/compounds (over-fire control).
    expect(isNeedleShaped('was findest du am Vertrag gut?')).toBe(false) // 'findest', not 'finde'
  })

  it('the German "alle" vetoes a needle even at END of question (was dead as "alle ")', () => {
    // "wie viele" would classify this as a needle; the \balle\b deliverable veto keeps it whole-doc.
    expect(isNeedleShaped('wie viele sind das — alle')).toBe(false)
    expect(isNeedleShaped('sind das wirklich alle')).toBe(false)
    // …and does not fire inside 'alles' (word boundary before the 's').
    expect(isNeedleShaped('wie viele Positionen sind es')).toBe(true) // no 'alle' → stays a needle
  })
})
