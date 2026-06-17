import { describe, it, expect } from 'vitest'
import {
  maskEmails,
  maskUrls,
  maskIbans,
  maskPhones,
  maskDates,
  redactText,
  redactDocumentTool,
  MASK_TOKENS,
  type RedactDocumentOutput
} from '../../src/main/services/skills/tools/redaction'
import { runSkillTool, validateToolOutput } from '../../src/main/services/skills/tool-registry'
import type { AuditEventType, DocumentChunkRead, SkillToolContext } from '../../src/shared/types'

// architecture.md "Skills — design record" §8 — the document-redaction Tier-2 tool, the
// read-transform-export shape, proven in isolation: each deterministic detector masks a clearly-shaped
// value and leaves a near-miss alone; the full run masks every planted value and counts match; a
// no-PII document is unchanged; redaction is idempotent; and the tool honours cancellation. No DB, no
// Electron. The honesty posture (best-effort, conservative — prefer a miss over corrupting text) is
// pinned by the near-miss cases below.

interface CapturedEvent {
  type: AuditEventType
  meta?: Record<string, unknown>
}

function makeCtx(
  chunks: DocumentChunkRead[],
  over: Partial<SkillToolContext> = {}
): { ctx: SkillToolContext; events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  const ctx: SkillToolContext = {
    documentIds: ['d1'],
    readDocumentChunks: (id) => (id === 'd1' ? chunks : []),
    signal: new AbortController().signal,
    audit: (type, meta) => events.push({ type, meta }),
    ...over
  }
  return { ctx, events }
}

function chunk(text: string, page: number | null = 1, index = 0): DocumentChunkRead {
  return { text, page, index }
}

describe('redaction detectors (each in isolation)', () => {
  it('maskEmails masks an address and leaves a non-address @ alone', () => {
    expect(maskEmails('write to jane.doe@example.com today')).toEqual({
      text: 'write to [EMAIL] today',
      count: 1
    })
    // Near-miss: a bare "@handle" with no domain.tld is not an e-mail.
    expect(maskEmails('mention @handle in the post')).toEqual({ text: 'mention @handle in the post', count: 0 })
  })

  it('maskUrls masks http(s):// and www. forms, leaving a bare domain alone', () => {
    expect(maskUrls('see https://example.com/path and www.example.org').text).toBe('see [URL] and [URL]')
    expect(maskUrls('see https://example.com/path and www.example.org').count).toBe(2)
    // Near-miss: a bare domain without a scheme or www. is left alone (conservative).
    expect(maskUrls('the file example.com.txt')).toEqual({ text: 'the file example.com.txt', count: 0 })
  })

  it('maskIbans masks a real IBAN (incl. the space-grouped print form) and leaves a non-IBAN alone', () => {
    expect(maskIbans('IBAN AT61 1904 3002 3457 3201 please')).toEqual({
      text: 'IBAN [IBAN] please',
      count: 1
    })
    expect(maskIbans('compact DE89370400440532013000 ok').count).toBe(1)
    // Near-miss: too short to be an IBAN.
    expect(maskIbans('code AT12 ok')).toEqual({ text: 'code AT12 ok', count: 0 })
  })

  it('maskPhones masks +country / 0-leading numbers and leaves plain numbers alone', () => {
    expect(maskPhones('call +43 660 1234567 now').text).toBe('call [PHONE] now')
    expect(maskPhones('or 0664 1234567 instead').text).toBe('or [PHONE] instead')
    // Near-miss: a plain integer (amount/year) with no + and no leading 0 is not a phone.
    expect(maskPhones('it cost 12345 in 2026')).toEqual({ text: 'it cost 12345 in 2026', count: 0 })
  })

  it('maskDates masks supported printed forms (validated) and leaves an impossible date alone', () => {
    expect(maskDates('on 2026-03-15 and 15.03.2026 and 03/15/2026').count).toBe(2) // ISO + dotted day-first
    // 03/15/2026 is day-first → day 15? no, "03/15" parses as day 3, month 15 → invalid → left alone.
    expect(maskDates('on 2026-03-15 and 15.03.2026 and 03/15/2026').text).toBe(
      'on [DATE] and [DATE] and 03/15/2026'
    )
    // Near-miss: an impossible date is not masked.
    expect(maskDates('the code 99.99.9999 here')).toEqual({ text: 'the code 99.99.9999 here', count: 0 })
  })
})

const PII_TEXT = [
  'Reach Jane at jane.doe@example.com or call +43 660 1234567.',
  'Account IBAN AT61 1904 3002 3457 3201, opened on 2026-03-15.',
  'More at https://example.com/profile.'
].join('\n')

describe('redactText (the full deterministic pass)', () => {
  it('masks every planted value, counts per category, and leaks none of the originals', () => {
    const { text, counts, totalRedactions } = redactText(PII_TEXT)
    expect(counts).toEqual({ email: 1, phone: 1, iban: 1, date: 1, url: 1 })
    expect(totalRedactions).toBe(5)
    // Every original PII value is gone, replaced by its fixed token.
    for (const secret of [
      'jane.doe@example.com',
      '+43 660 1234567',
      'AT61 1904 3002 3457 3201',
      '2026-03-15',
      'https://example.com/profile'
    ]) {
      expect(text).not.toContain(secret)
    }
    for (const token of Object.values(MASK_TOKENS)) expect(text).toContain(token)
  })

  it('a no-PII document yields zero redactions and unchanged text', () => {
    const plain = 'This memo discusses the quarterly roadmap and team morale. Nothing sensitive here.'
    const { text, counts, totalRedactions } = redactText(plain)
    expect(totalRedactions).toBe(0)
    expect(counts).toEqual({ email: 0, phone: 0, iban: 0, date: 0, url: 0 })
    expect(text).toBe(plain)
  })

  it('is idempotent — re-running over masked text masks nothing more', () => {
    const once = redactText(PII_TEXT)
    const twice = redactText(once.text)
    expect(twice.totalRedactions).toBe(0)
    expect(twice.text).toBe(once.text)
  })
})

describe('redact_document through the gate', () => {
  it('returns schema-valid output that passes its own outputSchema (confirm-gated)', async () => {
    const { ctx, events } = makeCtx([chunk(PII_TEXT, 1)])
    const result = await runSkillTool(redactDocumentTool, {
      skillId: 'app:document-redaction',
      input: { documentId: 'd1' },
      ctx,
      confirmed: true
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as RedactDocumentOutput
      expect(out.totalRedactions).toBe(5)
      expect(out.redactedText).not.toContain('jane.doe@example.com')
      expect(validateToolOutput(redactDocumentTool, result.output)).toEqual([])
    }
    expect(events.map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_done'])
  })

  it('is confirm-gated: the gate refuses it without confirmation', async () => {
    const { ctx } = makeCtx([chunk(PII_TEXT, 1)])
    const refused = await runSkillTool(redactDocumentTool, {
      skillId: 'app:document-redaction',
      input: { documentId: 'd1' },
      ctx
    })
    expect(refused.ok).toBe(false)
  })

  it('refuses invalid input (no documentId) without running', async () => {
    const { ctx } = makeCtx([])
    const result = await runSkillTool(redactDocumentTool, {
      skillId: 'app:document-redaction',
      input: {},
      ctx,
      confirmed: true
    })
    expect(result.ok).toBe(false)
  })

  it('reads only via readDocumentChunks — an out-of-scope id yields an empty, clean result', async () => {
    const { ctx } = makeCtx([], { readDocumentChunks: () => [] })
    const result = await runSkillTool(redactDocumentTool, {
      skillId: 'app:document-redaction',
      input: { documentId: 'd1' },
      ctx,
      confirmed: true
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.output as RedactDocumentOutput).totalRedactions).toBe(0)
  })

  it('cancellation: an aborted signal returns a content-free cancelled result, no work done', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx } = makeCtx([chunk(PII_TEXT, 1)], { signal: controller.signal })
    const result = await redactDocumentTool.run({ documentId: 'd1' }, ctx)
    expect(result.ok).toBe(false)
  })
})
