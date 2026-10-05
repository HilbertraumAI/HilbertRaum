import { describe, it, expect } from 'vitest'
import type { Db } from '../../src/main/services/db'
import {
  DOCUMENT_REDACTION_INSTALL_ID,
  documentRedactionAnalysisHandler
} from '../../src/main/services/skills/analysis/redaction'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { RetrievalScope } from '../../src/shared/types'
import { openFreshDb } from '../helpers/db-fixtures'
import { seedLineChunkDoc } from '../helpers/doc-fixtures'
import { makeAnalysisCtx } from '../helpers/skill-contexts'

// Redaction-routing handler (skills redaction-routing fix). Driven directly (no IPC). Unlike the
// invoice/bank EXHAUSTIVE handlers, this is a `routing` handler for an ACTION skill: on a
// redaction-shaped request over a selected document it returns a short, localized answer pointing the
// user at the run button — it READS NO content, runs NO tool, makes NO breadth claim (no
// citations/coverage ⇒ no "relevant passages" badge). These tests pin that contract so the old
// lecture/refusal + misleading footer can't regress.

const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)
const trDe = (key: MessageKey, params?: MessageParams): string => t('de', key, params)

const freshDb = (): Db => openFreshDb('redaction-analysis')

/** Seed one indexed document with a single chunk so it counts as in-scope/answerable. */
const seedDoc = (db: Db, text = 'Dear Jane, call me at +49 170 1234567.'): string =>
  seedLineChunkDoc(db, [text], { title: 'Letter' })

const ctxFor = (db: Db, scope: RetrievalScope, question: string, locale: 'en' | 'de' = 'en') =>
  makeAnalysisCtx(db, scope, question, { skillInstallId: DOCUMENT_REDACTION_INSTALL_ID, locale })

describe('redaction routing handler — applies() pre-flight', () => {
  // Single in-scope document: EN + DE action verbs apply; a German informational PII ask the route vocab
  // misses ("personenbezogenen", U2 dry-run) applies too; an off-topic question keeps the relevance path.
  it.each([
    ['Can you anonymize this doc?', true],
    ['Bitte die personenbezogenen Daten schwärzen', true],
    ['Welche personenbezogenen Daten enthält das Dokument?', true],
    ['what is this letter about?', false]
  ])('single in-scope document, %j: applies() is %s', (question, expected) => {
    const db = freshDb()
    const id = seedDoc(db)
    expect(documentRedactionAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question })).toBe(expected)
  })

  it('applies over a multi-document scope (the run UI is per-document)', () => {
    const db = freshDb()
    const a = seedDoc(db)
    const b = seedDoc(db)
    expect(
      documentRedactionAnalysisHandler.applies({ db, scope: { documentIds: [a, b] }, question: 'redact these' })
    ).toBe(true)
  })

  it('does not apply when no document is in scope (nothing to redact)', () => {
    const db = freshDb()
    seedDoc(db)
    expect(
      documentRedactionAnalysisHandler.applies({ db, scope: { documentIds: ['does-not-exist'] }, question: 'anonymize this' })
    ).toBe(false)
  })
})

describe('redaction routing handler — run()', () => {
  // The routing-mode exemption from the fully-chunked refusal is proven through askDocuments in
  // rag-skill-analysis.test.ts (routing skills on a not-fully-chunked document).
  it.each([
    { locale: 'en' as const, question: 'anonymize this', verb: undefined },
    { locale: 'de' as const, question: 'schwärzen', verb: 'schwärzen' } // answers in the user’s language
  ])('returns the localized routing answer ($locale) naming the run button, with NO citations/coverage', async ({ locale, question, verb }) => {
    const db = freshDb()
    const id = seedDoc(db)
    const res = await documentRedactionAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, question, locale))

    // Names the SkillRunBar's own button label, so the wording matches the affordance shown.
    expect(res.answer).toContain((locale === 'de' ? trDe : tr)('chat.skill.tool.redactDocument'))
    if (verb) expect(res.answer).toContain(verb)
    // No breadth claim: empty citations ⇒ the renderer shows no coverage meter (no "relevant
    // passages" footer); no coverage object is set.
    expect(res.citations).toEqual([])
    expect(res.coverage).toBeUndefined()
  })

  it('is count-honest over a MULTI-document scope (U-1): tells the user to pick which document', async () => {
    const db = freshDb()
    const a = seedDoc(db)
    const b = seedDoc(db)
    const res = await documentRedactionAnalysisHandler.run!(ctxFor(db, { documentIds: [a, b] }, 'redact these'))
    // The single-doc tool targets one document, so the multi-doc copy is used (and it differs from
    // the single-doc answer) — still naming the button, still content-free (no titles in the copy).
    expect(res.answer).toBe(tr('skills.redactionRouting.answerMulti', { button: tr('chat.skill.tool.redactDocument') }))
    expect(res.answer).not.toBe(tr('skills.redactionRouting.answer', { button: tr('chat.skill.tool.redactDocument') }))
    expect(res.citations).toEqual([])
  })

  // The action deflection AND the read-only dry-run (U2) both stay tool-free and audit-free.
  it.each(['anonymize this', 'welche personenbezogenen daten enthält das dokument?'])(
    'runs NO tool and emits NO audit event for %j (the write tool stays user-initiated)',
    async (question) => {
      const db = freshDb()
      const id = seedDoc(db)
      const ctx = ctxFor(db, { documentIds: [id] }, question)
      await documentRedactionAnalysisHandler.run!(ctx)

      expect(ctx.events).toEqual([])
      const runs = db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }
      expect(runs.n).toBe(0)
    }
  )
})

// U2 dry-run (audit §3.4): an INFORMATIONAL "which personal data is in here?" ask — which the
// deterministic detectors can answer — gets the offline per-category COUNTS (never a detected value)
// instead of the button deflection. An ACTION ask keeps the deflection; a multi-doc scope falls back.
describe('redaction routing handler — informational dry-run (U2)', () => {
  // Rows: the ASCII phone document (EN + German du-form) and the Unicode print variants (SKA-3 R8). Before R8
  // the Unicode document scanned as iban 0 / phone 0 — the dry-run asserted a typographically-set document was
  // clean while it carried both identifiers verbatim. The counts come from the same shadowed pipeline the real
  // redaction uses, so they stay identical to a run. Special characters as \u escapes (the T1 convention).
  it.each([
    {
      title: 'EN, one phone number',
      locale: 'en' as const,
      text: undefined, // default chunk holds one phone number: "+49 170 1234567"
      question: 'what personal data does this document contain?',
      counts: { email: 0, phone: 1, iban: 0, card: 0, date: 0, url: 0 },
      leaks: ['+49 170 1234567']
    },
    {
      title: 'DE (du-form), one phone number',
      locale: 'de' as const,
      text: undefined,
      question: 'Welche personenbezogenen Daten sind enthalten?',
      counts: { email: 0, phone: 1, iban: 0, card: 0, date: 0, url: 0 },
      leaks: ['+49 170 1234567']
    },
    {
      title: 'SKA-3 R8: Unicode print variants (NBSP IBAN, U+2011 phone)',
      locale: 'en' as const,
      text: 'IBAN AT61\u00a01904\u00a03002\u00a03457\u00a03201, Tel +43 664\u20111234567.',
      question: 'what personal data does this document contain?',
      counts: { email: 0, phone: 1, iban: 1, card: 0, date: 0, url: 0 },
      leaks: ['3457', '1234567']
    }
  ])('reports the per-category counts, $title (COUNTS only, no PII content) and names the button', async ({ locale, text, question, counts, leaks }) => {
    const db = freshDb()
    const id = seedDoc(db, text)
    const res = await documentRedactionAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, question, locale))
    const trL = locale === 'de' ? trDe : tr
    const button = trL('chat.skill.tool.redactDocument')
    expect(res.answer).toBe(trL('skills.redactionRouting.scan', { button, ...counts }))
    // The dry-run is NOT the button deflection, names the button, makes no breadth claim…
    expect(res.answer).not.toBe(trL('skills.redactionRouting.answer', { button }))
    expect(res.answer).toContain(button)
    expect(res.citations).toEqual([])
    expect(res.coverage).toBeUndefined()
    // …and leaks no detected value — only the counts appear.
    for (const leak of leaks) expect(res.answer).not.toContain(leak)
  })

  it('an ACTION ask keeps the button deflection (not the dry-run)', async () => {
    const db = freshDb()
    const id = seedDoc(db)
    const res = await documentRedactionAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'anonymize the personal data in this document')
    )
    const button = tr('chat.skill.tool.redactDocument')
    expect(res.answer).toBe(tr('skills.redactionRouting.answer', { button }))
  })

  it('an informational ask over MULTIPLE documents falls back to the deflection (which document?)', async () => {
    const db = freshDb()
    const a = seedDoc(db)
    const b = seedDoc(db)
    const res = await documentRedactionAnalysisHandler.run!(
      ctxFor(db, { documentIds: [a, b] }, 'what personal data is in these documents?')
    )
    const button = tr('chat.skill.tool.redactDocument')
    expect(res.answer).toBe(tr('skills.redactionRouting.answerMulti', { button }))
  })
})
