import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  DOCUMENT_REDACTION_INSTALL_ID,
  documentRedactionAnalysisHandler
} from '../../src/main/services/skills/analysis/redaction'
import {
  clearSkillAnalysisHandlers,
  getSkillAnalysisHandler
} from '../../src/main/services/skills/analysis/registry'
import { registerBuiltinSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import type { SkillAnalysisContext } from '../../src/main/services/skills/analysis/types'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { AuditEventType, RetrievalScope } from '../../src/shared/types'

// Redaction-routing handler (skills redaction-routing fix). Driven directly (no IPC). Unlike the
// invoice/bank EXHAUSTIVE handlers, this is a `routing` handler for an ACTION skill: on a
// redaction-shaped request over a selected document it returns a short, localized answer pointing the
// user at the run button — it READS NO content, runs NO tool, makes NO breadth claim (no
// citations/coverage ⇒ no "relevant passages" badge). These tests pin that contract so the old
// lecture/refusal + misleading footer can't regress.

const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)
const trDe = (key: MessageKey, params?: MessageParams): string => t('de', key, params)

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-redaction-analysis-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

/** Seed one indexed document with a single chunk so it counts as in-scope/answerable. */
function seedDoc(db: Db, text = 'Dear Jane, call me at +49 170 1234567.'): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, fully_chunked, created_at, updated_at)
     VALUES (?, 'Letter', 'indexed', 'application/pdf', NULL, ?, ?)`
  ).run(docId, now, now)
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
     VALUES (?, ?, 0, ?, 'Letter', 1, ?)`
  ).run(randomUUID(), docId, text, now)
  return docId
}

function ctxFor(db: Db, scope: RetrievalScope, question: string, locale: 'en' | 'de' = 'en'): SkillAnalysisContext & {
  events: Array<{ type: string; meta?: Record<string, unknown> }>
} {
  const events: Array<{ type: string; meta?: Record<string, unknown> }> = []
  const audit = (type: AuditEventType, meta?: Record<string, unknown>): void => {
    events.push({ type, meta })
  }
  return {
    db,
    scope,
    question,
    skillInstallId: DOCUMENT_REDACTION_INSTALL_ID,
    conversationId: null,
    audit,
    tr: locale === 'de' ? trDe : tr,
    events
  }
}

describe('redaction routing handler — applies() pre-flight', () => {
  it('applies on a redaction-shaped request over a single in-scope document', () => {
    const db = freshDb()
    const id = seedDoc(db)
    expect(
      documentRedactionAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question: 'Can you anonymize this doc?' })
    ).toBe(true)
  })

  it('applies on the German verb "schwärzen"', () => {
    const db = freshDb()
    const id = seedDoc(db)
    expect(
      documentRedactionAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question: 'Bitte die personenbezogenen Daten schwärzen' })
    ).toBe(true)
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

  it('does not apply to an off-topic question (keeps the relevance path)', () => {
    const db = freshDb()
    const id = seedDoc(db)
    expect(
      documentRedactionAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question: 'what is this letter about?' })
    ).toBe(false)
  })
})

describe('redaction routing handler — run()', () => {
  it('is a routing handler (mode = routing) so the chat path skips the fully-chunked refusal', () => {
    expect(documentRedactionAnalysisHandler.mode).toBe('routing')
  })

  it('returns the localized routing answer naming the run button, with NO citations/coverage', async () => {
    const db = freshDb()
    const id = seedDoc(db)
    const res = await documentRedactionAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'anonymize this'))

    // Names the SkillRunBar's own button label, so the wording matches the affordance shown.
    expect(res.answer).toContain(tr('chat.skill.tool.redactDocument'))
    // No breadth claim: empty citations ⇒ the renderer shows no coverage meter (no "relevant
    // passages" footer); no coverage object is set.
    expect(res.citations).toEqual([])
    expect(res.coverage).toBeUndefined()
  })

  it('answers in the user’s language (German)', async () => {
    const db = freshDb()
    const id = seedDoc(db)
    const res = await documentRedactionAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'schwärzen', 'de'))
    expect(res.answer).toContain(trDe('chat.skill.tool.redactDocument'))
    expect(res.answer).toContain('schwärzen')
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

  it('runs NO tool and emits NO audit event (the write tool stays user-initiated)', async () => {
    const db = freshDb()
    const id = seedDoc(db)
    const ctx = ctxFor(db, { documentIds: [id] }, 'anonymize this')
    await documentRedactionAnalysisHandler.run!(ctx)

    expect(ctx.events).toEqual([])
    const runs = db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }
    expect(runs.n).toBe(0)
  })
})

// U2 dry-run (audit §3.4): an INFORMATIONAL "which personal data is in here?" ask — which the
// deterministic detectors can answer — gets the offline per-category COUNTS (never a detected value)
// instead of the button deflection. An ACTION ask keeps the deflection; a multi-doc scope falls back.
describe('redaction routing handler — informational dry-run (U2)', () => {
  it('applies() on a German informational PII ask (declined "personenbezogenen") the route vocab misses', () => {
    const db = freshDb()
    const id = seedDoc(db)
    expect(
      documentRedactionAnalysisHandler.applies({
        db,
        scope: { documentIds: [id] },
        question: 'Welche personenbezogenen Daten enthält das Dokument?'
      })
    ).toBe(true)
  })

  it('reports the per-category counts (COUNTS only, no PII content) and names the button', async () => {
    const db = freshDb()
    const id = seedDoc(db) // chunk holds one phone number: "+49 170 1234567"
    const res = await documentRedactionAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'what personal data does this document contain?')
    )
    const button = tr('chat.skill.tool.redactDocument')
    expect(res.answer).toBe(
      tr('skills.redactionRouting.scan', { button, email: 0, phone: 1, iban: 0, card: 0, date: 0, url: 0 })
    )
    // The dry-run is NOT the button deflection, names the button, makes no breadth claim…
    expect(res.answer).not.toBe(tr('skills.redactionRouting.answer', { button }))
    expect(res.answer).toContain(button)
    expect(res.citations).toEqual([])
    expect(res.coverage).toBeUndefined()
    // …and leaks no detected value — the raw phone number never appears (only its count does).
    expect(res.answer).not.toContain('+49 170 1234567')
  })

  it('answers the dry-run in German (du-form)', async () => {
    const db = freshDb()
    const id = seedDoc(db)
    const res = await documentRedactionAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'Welche personenbezogenen Daten sind enthalten?', 'de')
    )
    expect(res.answer).toBe(
      trDe('skills.redactionRouting.scan', {
        button: trDe('chat.skill.tool.redactDocument'),
        email: 0,
        phone: 1,
        iban: 0,
        card: 0,
        date: 0,
        url: 0
      })
    )
  })

  it('SKA-3 R8: the dry-run counts the Unicode print variants (NBSP IBAN, U+2011 phone) too', async () => {
    // Before R8 this document scanned as iban 0 / phone 0 — the share-safe/dry-run counts asserted a
    // typographically-set document was clean while it carried both identifiers verbatim. The counts
    // come from the same shadowed pipeline the real redaction uses, so they stay identical to a run.
    // Special characters as \u escapes (the T1 convention).
    const db = freshDb()
    const id = seedDoc(db, 'IBAN AT61\u00a01904\u00a03002\u00a03457\u00a03201, Tel +43 664\u20111234567.')
    const res = await documentRedactionAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'what personal data does this document contain?')
    )
    const button = tr('chat.skill.tool.redactDocument')
    expect(res.answer).toBe(
      tr('skills.redactionRouting.scan', { button, email: 0, phone: 1, iban: 1, card: 0, date: 0, url: 0 })
    )
    // Counts only — neither Unicode-set value leaks into the answer.
    expect(res.answer).not.toContain('3457')
    expect(res.answer).not.toContain('1234567')
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

  it('the dry-run runs NO tool and emits NO audit event (read-only count)', async () => {
    const db = freshDb()
    const id = seedDoc(db)
    const ctx = ctxFor(db, { documentIds: [id] }, 'welche personenbezogenen daten enthält das dokument?')
    await documentRedactionAnalysisHandler.run!(ctx)
    expect(ctx.events).toEqual([])
    const runs = db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }
    expect(runs.n).toBe(0)
  })
})

describe('analysis-handler registry — document-redaction', () => {
  it('registerBuiltinSkillAnalysisHandlers wires the redaction routing handler', () => {
    clearSkillAnalysisHandlers()
    expect(getSkillAnalysisHandler(DOCUMENT_REDACTION_INSTALL_ID)).toBeUndefined()
    registerBuiltinSkillAnalysisHandlers()
    expect(getSkillAnalysisHandler(DOCUMENT_REDACTION_INSTALL_ID)).toBe(documentRedactionAnalysisHandler)
  })
})
