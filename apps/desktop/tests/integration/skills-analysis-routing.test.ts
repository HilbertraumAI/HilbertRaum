import { describe, it, expect } from 'vitest'
import type { Db } from '../../src/main/services/db'
import {
  DOCUMENT_EDIT_INSTALL_ID,
  documentEditAnalysisHandler
} from '../../src/main/services/skills/analysis/document-edit'
import type { SkillAnalysisHandler } from '../../src/main/services/skills/analysis/types'
import {
  DOCUMENT_REDACTION_INSTALL_ID,
  documentRedactionAnalysisHandler
} from '../../src/main/services/skills/analysis/redaction'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { RetrievalScope } from '../../src/shared/types'
import { openFreshDb } from '../helpers/db-fixtures'
import { seedLineChunkDoc } from '../helpers/doc-fixtures'
import { makeAnalysisCtx } from '../helpers/skill-contexts'

// The routing handlers of the ACTION skills (redaction-routing fix; document-edit joined in #583), driven
// directly (no IPC). Unlike the invoice/bank EXHAUSTIVE handlers, a `routing` handler answers a
// redaction- or edit-shaped request over a selected document with a short, localized answer pointing the
// user at the run button — it READS NO content, runs NO tool, makes NO breadth claim (no
// citations/coverage ⇒ no "relevant passages" badge). These tests pin that contract so the old
// lecture/refusal + misleading footer can't regress.

const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)
const trDe = (key: MessageKey, params?: MessageParams): string => t('de', key, params)

const freshDb = (): Db => openFreshDb('analysis-routing')

/** Seed one indexed document with a single chunk so it counts as in-scope/answerable. */
const seedDoc = (db: Db, text = 'Dear Jane, call me at +49 170 1234567.'): string =>
  seedLineChunkDoc(db, [text], { title: 'Letter' })

const ctxFor = (db: Db, scope: RetrievalScope, question: string, locale: 'en' | 'de' = 'en') =>
  makeAnalysisCtx(db, scope, question, { skillInstallId: DOCUMENT_REDACTION_INSTALL_ID, locale })

// The two ROUTING handlers (document-redaction, document-edit) share one contract, so the pre-flight and
// the multi-document copy are table-driven over both (#583: document-edit had only one positive row in
// rag-skill-analysis.test.ts). Expected strings come from the i18n catalog, never from the handlers.
interface RoutingCase {
  name: string
  handler: SkillAnalysisHandler
  installId: string
  /** [question, applies()] over ONE in-scope document */
  applies: Array<[string, boolean]>
  /** an action-shaped ask (EN) the handler routes */
  action: string
  buttonKey: MessageKey
  answerKey: MessageKey
  answerMultiKey: MessageKey
}

const ROUTING_CASES: RoutingCase[] = [
  {
    name: 'document-redaction',
    handler: documentRedactionAnalysisHandler,
    installId: DOCUMENT_REDACTION_INSTALL_ID,
    // EN + DE action verbs apply; a German informational PII ask the route vocab misses
    // ("personenbezogenen", U2 dry-run) applies too; an off-topic question keeps the relevance path.
    applies: [
      ['Can you anonymize this doc?', true],
      ['Bitte die personenbezogenen Daten schwärzen', true],
      ['Welche personenbezogenen Daten enthält das Dokument?', true],
      ['what is this letter about?', false]
    ],
    action: 'redact these',
    buttonKey: 'chat.skill.tool.redactDocument',
    answerKey: 'skills.redactionRouting.answer',
    answerMultiKey: 'skills.redactionRouting.answerMulti'
  },
  {
    name: 'document-edit',
    handler: documentEditAnalysisHandler,
    installId: DOCUMENT_EDIT_INSTALL_ID,
    applies: [
      ['find and replace Acme with Beta', true],
      ['Ersetze Acme durch Beta', true],
      ['what is this letter about?', false]
    ],
    action: 'find and replace Acme with Beta',
    buttonKey: 'chat.skill.tool.applyDocumentEdits',
    answerKey: 'skills.editRouting.answer',
    answerMultiKey: 'skills.editRouting.answerMulti'
  }
]

describe.each(ROUTING_CASES)('$name routing handler — applies() pre-flight', (c) => {
  it.each(c.applies)('single in-scope document, %j: applies() is %s', (question, expected) => {
    const db = freshDb()
    const id = seedDoc(db)
    expect(c.handler.applies({ db, scope: { documentIds: [id] }, question })).toBe(expected)
  })

  it('applies over a multi-document scope (the run UI is per-document)', () => {
    const db = freshDb()
    const a = seedDoc(db)
    const b = seedDoc(db)
    expect(c.handler.applies({ db, scope: { documentIds: [a, b] }, question: c.action })).toBe(true)
  })

  it('does not apply when no document is in scope (nothing to act on)', () => {
    const db = freshDb()
    seedDoc(db)
    expect(c.handler.applies({ db, scope: { documentIds: ['does-not-exist'] }, question: c.action })).toBe(false)
  })
})

describe.each(ROUTING_CASES)('$name routing handler — run() copy (#583)', (c) => {
  it('single document: the localized routing answer names the run button, no citations/coverage (EN + DE)', async () => {
    for (const locale of ['en', 'de'] as const) {
      const trL = locale === 'de' ? trDe : tr
      const db = freshDb()
      const id = seedDoc(db)
      const res = await c.handler.run!(
        makeAnalysisCtx(db, { documentIds: [id] }, c.action, { skillInstallId: c.installId, locale })
      )
      expect(res.answer, locale).toBe(trL(c.answerKey, { button: trL(c.buttonKey) }))
      expect(res.citations).toEqual([])
      expect(res.coverage).toBeUndefined()
    }
  })

  it('is count-honest over a MULTI-document scope (U-1): tells the user to pick which document', async () => {
    const db = freshDb()
    const a = seedDoc(db)
    const b = seedDoc(db)
    const res = await c.handler.run!(
      makeAnalysisCtx(db, { documentIds: [a, b] }, c.action, { skillInstallId: c.installId })
    )
    // The single-doc tool targets one document, so the multi-doc copy is used (and it differs from
    // the single-doc answer) — still naming the button, still content-free (no titles in the copy).
    const button = tr(c.buttonKey)
    expect(res.answer).toBe(tr(c.answerMultiKey, { button }))
    expect(res.answer).not.toBe(tr(c.answerKey, { button }))
    expect(res.citations).toEqual([])
  })

  it('runs NO tool and emits NO audit event (the write tool stays user-initiated)', async () => {
    const db = freshDb()
    const id = seedDoc(db)
    const ctx = makeAnalysisCtx(db, { documentIds: [id] }, c.action, { skillInstallId: c.installId })
    await c.handler.run!(ctx)
    expect(ctx.events).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }).n).toBe(0)
  })
})

describe('redaction routing handler — run()', () => {
  // The localized single-document answer is pinned per handler above; the routing-mode exemption from
  // the fully-chunked refusal is proven through askDocuments in rag-skill-analysis.test.ts. The
  // read-only dry-run (U2) stays tool-free and audit-free too.
  it.each(['welche personenbezogenen daten enthält das dokument?'])(
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
