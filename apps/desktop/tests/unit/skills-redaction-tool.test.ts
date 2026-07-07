import { describe, it, expect } from 'vitest'
import {
  detectionShadow,
  maskEmails,
  maskUrls,
  maskIbans,
  maskPhones,
  maskCards,
  maskDates,
  redactText,
  scanRedactionCandidates,
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

  it('maskDates masks supported printed forms in EITHER order (U2) and leaves an impossible date alone', () => {
    // U2 (audit §5.7): redaction masks a candidate that parses in EITHER field order — the US-ordered
    // 03/15/2026 (month 3, day 15) now masks alongside the ISO + EU-ordered forms (was the BL-N6 leak).
    expect(maskDates('on 2026-03-15 and 15.03.2026 and 03/15/2026').count).toBe(3)
    expect(maskDates('on 2026-03-15 and 15.03.2026 and 03/15/2026').text).toBe(
      'on [DATE] and [DATE] and [DATE]'
    )
    // 2-digit-year birthdates now mask too (U2 — they used to pass).
    expect(maskDates('born 01/02/26 here').text).toBe('born [DATE] here')
    // Near-miss: an impossible date parses in NEITHER order → not masked.
    expect(maskDates('the code 99.99.9999 here')).toEqual({ text: 'the code 99.99.9999 here', count: 0 })
  })

  it('maskCards masks Luhn-valid PANs (compact / spaced / dashed) and leaves non-cards alone (U2)', () => {
    // 4111 1111 1111 1111 is a canonical Luhn-valid test PAN.
    expect(maskCards('pay 4111 1111 1111 1111 today').text).toBe('pay [CARD] today')
    expect(maskCards('card 4111-1111-1111-1111 ok').text).toBe('card [CARD] ok')
    expect(maskCards('compact 4111111111111111 end').count).toBe(1)
    // Luhn FAILS: a 16-digit run that is not a valid card is left alone (conservative).
    expect(maskCards('ref 4111 1111 1111 1112 here')).toEqual({ text: 'ref 4111 1111 1111 1112 here', count: 0 })
    // A 20+ digit account number is out of the 13–19 card window → not masked.
    expect(maskCards('acct 12345678901234567890 x')).toEqual({ text: 'acct 12345678901234567890 x', count: 0 })
  })

  it('maskPhones: a separator-less ≥9-digit 0-leading run is a reference number, not a phone (U2)', () => {
    // audit §5.7: a bare 0-leading reference number used to be masked as [PHONE], corrupting invoices in
    // the share flow. It is now left alone; a 0-leading number WITH a separator still masks.
    expect(maskPhones('reference 0001234567 here')).toEqual({ text: 'reference 0001234567 here', count: 0 })
    expect(maskPhones('call 0664 1234567 now').text).toBe('call [PHONE] now') // separated ⇒ still a phone
    // A short compact 0-leading run (≤8 digits) is still treated as a phone (unchanged).
    expect(maskPhones('dial 0123456 please').text).toBe('dial [PHONE] please')
  })
})

const PII_TEXT = [
  'Reach Jane at jane.doe@example.com or call +43 660 1234567.',
  'Account IBAN AT61 1904 3002 3457 3201, opened on 2026-03-15.',
  'Card on file 4111 1111 1111 1111.',
  'More at https://example.com/profile.'
].join('\n')

describe('redactText (the full deterministic pass)', () => {
  it('masks every planted value, counts per category, and leaks none of the originals', () => {
    const { text, counts, totalRedactions } = redactText(PII_TEXT)
    expect(counts).toEqual({ email: 1, phone: 1, iban: 1, card: 1, date: 1, url: 1 })
    expect(totalRedactions).toBe(6)
    // Every original PII value is gone, replaced by its fixed token.
    for (const secret of [
      'jane.doe@example.com',
      '+43 660 1234567',
      'AT61 1904 3002 3457 3201',
      '2026-03-15',
      '4111 1111 1111 1111',
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
    expect(counts).toEqual({ email: 0, phone: 0, iban: 0, card: 0, date: 0, url: 0 })
    expect(text).toBe(plain)
  })

  it('is idempotent — re-running over masked text masks nothing more', () => {
    const once = redactText(PII_TEXT)
    const twice = redactText(once.text)
    expect(twice.totalRedactions).toBe(0)
    expect(twice.text).toBe(once.text)
  })

  it('ReDoS regression: a giant `a.a.a…` run is scanned linearly (no main-process freeze)', () => {
    // vuln-scan-2026-06-21: EMAIL_RE used to backtrack quadratically (O(N²)) on a long `a.a.a.…`
    // run with no `@` — `.` is both a `\b`-restart point and a local-part char, so every offset
    // re-scanned the whole run. redactText joins ALL chunks into one string, so a hostile document
    // could freeze the main process. The length-bounded class makes the scan linear.
    const giant = 'a.'.repeat(100_000) // 200k chars, no '@' anywhere
    const start = Date.now()
    const { totalRedactions } = redactText(giant)
    expect(totalRedactions).toBe(0) // nothing is a real e-mail — and importantly, fast
    expect(Date.now() - start).toBeLessThan(1000)
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
      expect(out.totalRedactions).toBe(6)
      expect(out.redactedText).not.toContain('jane.doe@example.com')
      expect(validateToolOutput(redactDocumentTool, result.output)).toEqual([])
    }
    // TEST-N5: assert the OUTCOME (a successful run records start + done, and never a failure)
    // via membership rather than an exact, order-pinned array that a benign new lifecycle event
    // would break while still passing if `done` silently stopped firing.
    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).toContain('skill_run_started')
    expect(eventTypes).toContain('skill_run_done')
    expect(eventTypes).not.toContain('skill_run_failed')
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

// full-audit-2026-06-28 Phase 1 (financial correctness wave): redaction under-masking (BL-N4) +
// characterization of the accepted limitations (TEST-N6 / BL-N6). Detection stays conservative.
describe('redaction coverage (full-audit-2026-06-28 Phase 1)', () => {
  it('BL-N4: masks common US/national phone formats (punctuated, with optional leading 1)', () => {
    expect(maskPhones('call 555-123-4567 today').text).toBe('call [PHONE] today') // BEFORE: unmatched
    expect(maskPhones('toll free 1-800-555-1234 now').text).toBe('toll free [PHONE] now') // BEFORE: unmatched
    expect(maskPhones('dotted 555.123.4567 here').text).toBe('dotted [PHONE] here')
    // Still conservative: a bare 10-digit run with no separators is NOT a phone (account/ID numbers).
    expect(maskPhones('id 5551234567 end')).toEqual({ text: 'id 5551234567 end', count: 0 })
  })

  it('BL-N4: masks a lowercase / fully-lower compact IBAN (case-insensitive detection)', () => {
    expect(maskIbans('iban de89370400440532013000 ok').count).toBe(1) // BEFORE: 0 (case-sensitive)
    expect(maskIbans('konto at611904300234573201 bitte').count).toBe(1) // AT length 20, lowercased
    // The space-grouped uppercase form still does not eat a trailing lowercase prose word.
    expect(maskIbans('IBAN AT61 1904 3002 3457 3201 please')).toEqual({
      text: 'IBAN [IBAN] please',
      count: 1
    })
  })

  it('TEST-N6: documented under-detection is pinned — names/addresses unmasked, US-ordered date leaks', () => {
    // No name/address detection (best-effort posture; known-limitations.md "Document redaction").
    const r = redactText('Jane Doe, 42 Main Street, Springfield, signed the contract.')
    expect(r.totalRedactions).toBe(0)
    expect(r.text).toContain('Jane Doe') // names are NOT masked (accepted limitation)
    expect(r.text).toContain('42 Main Street') // postal addresses are NOT masked (accepted limitation)
    // U2 (audit §5.7): the BL-N6 locale asymmetry is CLOSED — redaction now masks a date that parses in
    // EITHER order, so both the EU-ordered and the US-ordered form mask (over-masking is fine here).
    expect(maskDates('signed 31/12/2026').text).toBe('signed [DATE]')
    expect(maskDates('signed 12/31/2026').text).toBe('signed [DATE]') // was the documented US-order leak
  })
})

// U2 (audit §5.7 redaction bullet / §3.4): card PANs, the 0-leading phone false positive, either-order
// dates, and the read-only counts scan. Detection stays conservative (Luhn-gated cards; reference numbers
// left intact) — but the accepted BL-N6 date leak is now closed.
describe('redaction U2 additions', () => {
  it('redactText masks a card in the fixed order (card before phone) and counts it', () => {
    const { text, counts, totalRedactions } = redactText('Pay card 4111 1111 1111 1111 or call +43 660 1234567.')
    expect(counts.card).toBe(1)
    expect(counts.phone).toBe(1)
    expect(totalRedactions).toBe(2)
    expect(text).toContain('[CARD]')
    expect(text).toContain('[PHONE]')
    expect(text).not.toContain('4111')
  })

  it('scanRedactionCandidates returns the same counts as a real redaction, leaking no text', () => {
    const input = 'Mail jane@example.com, card 4111 1111 1111 1111, IBAN AT61 1904 3002 3457 3201.'
    expect(scanRedactionCandidates(input)).toEqual(redactText(input).counts)
    // The scan reports counts only (email 1, card 1, iban 1) — the return type carries no text field.
    expect(scanRedactionCandidates(input)).toEqual({ email: 1, phone: 0, iban: 1, card: 1, date: 0, url: 0 })
  })

  it('SKA-3 R8: masks the Unicode print variants of exactly the identifiers it exists to mask', () => {
    // Verified failures from the audit (each yielded ZERO candidates / no match before R8). Special
    // characters as \u escapes (the T1 convention) so a git/editor normalization can't silently
    // defeat the fixtures.

    // IBAN grouped by NBSP / narrow NBSP / figure space (typographically-set PDFs).
    expect(maskIbans('IBAN AT61\u00a01904\u00a03002\u00a03457\u00a03201 bitte')).toEqual({
      text: 'IBAN [IBAN] bitte',
      count: 1
    })
    expect(maskIbans('IBAN AT61\u202f1904\u202f3002\u202f3457\u202f3201 bitte').count).toBe(1)
    expect(maskIbans('IBAN DE89\u20073704\u20070044\u20070532\u20070130\u200700 ok').count).toBe(1)

    // Card PAN grouped by NBSP / figure space / en dash — masked as ONE card.
    expect(maskCards('Karte 4111\u00a01111\u00a01111\u00a01111 ok')).toEqual({
      text: 'Karte [CARD] ok',
      count: 1
    })
    expect(maskCards('Karte 4111\u20071111\u20071111\u20071111 ok').count).toBe(1)
    // Non-breaking hyphen (U+2011) is genuine card/phone typography and masks; the en dash is NOT \u2014
    // it is range typography and is refused (see the negative controls below; R8 review).
    expect(maskCards('Karte 4111\u20111111\u20111111\u20111111 ok').count).toBe(1)

    // Phone with the non-breaking hyphen Word auto-inserts (U+2011) and the en dash (U+2013).
    // (\s already covered the NBSP family — phones failed only on the hyphen variants.)
    expect(maskPhones('call +43 664\u20111234567 now')).toEqual({ text: 'call [PHONE] now', count: 1 })
    expect(maskPhones('call +43 664\u20131234567 now').count).toBe(1)
    // A 0-leading number whose ONLY separator is the Unicode hyphen counts as SEPARATED (a printed
    // phone), not as a bare reference number — the U2 guard reads the shadow.
    expect(maskPhones('oder 0664\u20111234567 bitte').text).toBe('oder [PHONE] bitte')

    // The parenthesized US print form — the most common US layout had no branch at all.
    expect(maskPhones('call (555) 123-4567 today')).toEqual({ text: 'call [PHONE] today', count: 1 })
    expect(maskPhones('or (555)123.4567 instead').count).toBe(1)
  })

  it('SKA-3 R8: the conservative negative controls survive the widened detection', () => {
    // A prose digit triple stays unmasked — spaces (ASCII or NBSP) are not phone punctuation.
    expect(maskPhones('totals 100 200 3000 here')).toEqual({ text: 'totals 100 200 3000 here', count: 0 })
    expect(maskPhones('totals 100\u00a0200\u00a03000 here').count).toBe(0)
    // The parenthesized branch stays punctuation-anchored: a space-separated tail is NOT a phone.
    expect(maskPhones('lot (555) 123 4567 series').count).toBe(0)
    // The U2 0-leading bare-reference guard is untouched.
    expect(maskPhones('reference 0001234567 here').count).toBe(0)
    // A Luhn-FAILING Unicode-grouped 16-digit run is left alone (same guard as its ASCII twin).
    expect(maskCards('ref 4111\u00a01111\u00a01111\u00a01112 here').count).toBe(0)
    // A >19-digit compact account number still has no \b-terminated 13..19 subrun.
    expect(maskCards('acct 12345678901234567890 x').count).toBe(0)
  })

  it('SKA-3 R8 review: en dash / minus are RANGE typography \u2014 never phone/card punctuation', () => {
    // The review found the naive en-dash\u2192'-' mapping fed PHONE_RE's 0-leading branch, deterministically
    // eating correctly-typeset German prose. Each input below was a verified false positive; all must
    // stay byte-untouched (the miss-over-eating posture).
    for (const prose of [
      'Budget 10.000\u201315.000 EUR', // round-thousands amount range
      'Abrechnungszeitraum 05.2025\u201306.2026', // month.year billing period
      'Zeitraum 01/2025\u201312/2025', // slashed billing period
      'PLZ 01067\u201301099', // 0-leading postal-code range
      'Ge\u00f6ffnet 08.00\u201317.00 Uhr', // dotted time range
      'Bereich 100\u2013200\u20133000 St\u00fcck', // range chain that shadows into the US 3-3-4 shape
      '10.000\u22122.500 ergibt 7.500' // minus-sign subtraction
    ]) {
      expect(redactText(prose)).toEqual({
        text: prose,
        counts: { email: 0, phone: 0, iban: 0, card: 0, date: 0, url: 0 },
        totalRedactions: 0
      })
    }
    // A Luhn-PASSING en-dash invoice-number range (8+8 digits concatenate to a Luhn-valid 16) must NOT
    // mask as a card \u2014 the sub-range refusal has teeth precisely because plain Luhn would accept it.
    expect(maskCards('Rechnungen 12345678\u201390345014 hier').count).toBe(0)
    // The cost, pinned: an en-dash-set 0-leading phone is MISSED (documented residual) \u2026
    expect(maskPhones('Tel. 0664\u20131234567').count).toBe(0)
    // \u2026 while the unambiguous anchors keep masking: '+'-led and parenthesized en-dash forms.
    expect(maskPhones('call +43 664\u20131234567 now').count).toBe(1)
    expect(maskPhones('US (555) 123\u20134567 ok').count).toBe(1)
  })

  it('SKA-3 R8 review: a shadow-joined neighbour cannot UN-mask the identifier inside the candidate', () => {
    // Review F1/F2: the shadow joins the identifier's neighbour (one NBSP away \u2014 exactly the typeset-PDF
    // layout SKA-3 targets) into one greedy candidate; whole-span validation then fails and the OLD
    // all-or-nothing accept leaked the identifier verbatim. The accept now narrows to the valid sub-span.
    // Grouped IBAN + NBSP + BIC token:
    expect(redactText('Konto DE89 3704 0044 0532 0130 00\u00a0COBADEFF Ende').text).toBe(
      'Konto [IBAN]\u00a0COBADEFF Ende'
    )
    // Compact IBAN + NBSP + currency word:
    expect(redactText('Konto DE89370400440532013000\u00a0EUR 100').text).toBe('Konto [IBAN]\u00a0EUR 100')
    // Card + NBSP + 3-digit tail (19 digits joined, Luhn fails whole, PAN sub-range masks):
    expect(redactText('Karte 4111 1111 1111 1111\u00a0123.').text).toBe('Karte [CARD]\u00a0123.')
    // Head-side: row number + NBSP + card (19 digits joined, Luhn fails whole \u2014 verified):
    const head = redactText('Nr. 123\u00a04111 1111 1111 1111 Ende')
    expect(head.counts.card).toBe(1)
    expect(head.text).not.toContain('4111')
  })

  it('SKA-3 R8: detection is shadowed, masking is byte-faithful — unmasked text stays byte-identical', () => {
    // Mechanism (a): the detectors run on a same-length ASCII shadow, the masks land on the ORIGINAL
    // bytes. So the redacted output differs from the input ONLY in the masked spans — the NBSP and
    // narrow NBSP in the surrounding prose survive verbatim (D58's byte-unchanged posture).
    const input =
      'Zahlung\u00a0fällig. IBAN AT61\u00a01904\u00a03002\u00a03457\u00a03201. Danke\u202fsehr.'
    const { text, counts, totalRedactions } = redactText(input)
    expect(text).toBe('Zahlung\u00a0fällig. IBAN [IBAN]. Danke\u202fsehr.')
    expect(counts.iban).toBe(1)
    expect(totalRedactions).toBe(1)

    // The shadow itself is 1:1 — every mapped character is a single BMP code unit.
    const allMapped = '\u00a0\u202f\u2007\u2011\u2013\u2212'
    expect(detectionShadow(allMapped)).toBe('   ---')
    expect(detectionShadow(allMapped).length).toBe(allMapped.length)
    expect(detectionShadow('plain ascii-text 123')).toBe('plain ascii-text 123')

    // U+2212 end-to-end through a masking detector (not just the map): a minus-set ISO date masks.
    expect(maskDates('am 2026\u221203\u221215 hier')).toEqual({ text: 'am [DATE] hier', count: 1 })
  })

  it('SKA-3 R8: a Unicode-grouped card masks as ONE card through the full pipeline (order guard)', () => {
    // Cards are masked before dates/phones — the NBSP-grouped PAN must not be split by either.
    const { counts, text } = redactText('Karte 4111\u00a01111\u00a01111\u00a01111, Tel +43 664\u20111234567.')
    expect(counts).toEqual({ email: 0, phone: 1, iban: 0, card: 1, date: 0, url: 0 })
    expect(text).toBe('Karte [CARD], Tel [PHONE].')
  })

  it('SKA-3 R8: scanRedactionCandidates counts the Unicode variants identically to a real run', () => {
    // The dry-run/share-safe invariant: the pre-scan and the real redaction share ONE pipeline, so a
    // typographically-set document can no longer scan as "0 IBANs / 0 phones" while containing both.
    const input =
      'IBAN AT61\u00a01904\u00a03002\u00a03457\u00a03201, Karte 4111\u20071111\u20071111\u20071111, Tel (555) 123-4567.'
    expect(scanRedactionCandidates(input)).toEqual(redactText(input).counts)
    expect(scanRedactionCandidates(input)).toEqual({ email: 0, phone: 1, iban: 1, card: 1, date: 0, url: 0 })
  })

  it('SKA-3 R8: redaction stays idempotent over a Unicode-variant document', () => {
    const once = redactText('IBAN AT61\u00a01904\u00a03002\u00a03457\u00a03201, Tel +43 664\u20111234567.')
    const twice = redactText(once.text)
    expect(twice.totalRedactions).toBe(0)
    expect(twice.text).toBe(once.text)
  })

  it('Phase 6 (D74): the perChar strategy plumbs through the gate to █ masks, counts unchanged', async () => {
    const { ctx } = makeCtx([chunk(PII_TEXT, 1)])
    const result = await runSkillTool(redactDocumentTool, {
      skillId: 'app:document-redaction',
      input: { documentId: 'd1', strategy: 'perChar' },
      ctx,
      confirmed: true
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as RedactDocumentOutput
      // Length-preserving masks, no fixed tokens, and no leaked secret.
      expect(out.redactedText).toContain('█')
      expect(out.redactedText).not.toContain('[EMAIL]')
      expect(out.redactedText).not.toContain('jane.doe@example.com')
      // The counts are strategy-independent — the same six categories are found either way.
      expect(out.totalRedactions).toBe(6)
      expect(validateToolOutput(redactDocumentTool, result.output)).toEqual([])
    }
  })

  it('Phase 6 (D74): the default (no strategy) is byte-for-byte the token output', async () => {
    const mk = () => makeCtx([chunk(PII_TEXT, 1)]).ctx
    const [def, tok] = await Promise.all([
      runSkillTool(redactDocumentTool, { skillId: 'app:document-redaction', input: { documentId: 'd1' }, ctx: mk(), confirmed: true }),
      runSkillTool(redactDocumentTool, { skillId: 'app:document-redaction', input: { documentId: 'd1', strategy: 'token' }, ctx: mk(), confirmed: true })
    ])
    expect(def.ok && tok.ok).toBe(true)
    if (def.ok && tok.ok) {
      expect((def.output as RedactDocumentOutput).redactedText).toBe((tok.output as RedactDocumentOutput).redactedText)
      expect((def.output as RedactDocumentOutput).redactedText).toContain('[EMAIL]')
    }
  })

  it('Phase 6 (D74): the gate refuses an unknown strategy value (enum-validated input)', async () => {
    const { ctx } = makeCtx([chunk(PII_TEXT, 1)])
    const refused = await runSkillTool(redactDocumentTool, {
      skillId: 'app:document-redaction',
      input: { documentId: 'd1', strategy: 'rot13' },
      ctx,
      confirmed: true
    })
    expect(refused.ok).toBe(false) // input validation fails before the tool runs
  })

  it('the card category rides through the tool output schema', async () => {
    const { ctx } = makeCtx([chunk('Card on file 4111 1111 1111 1111.', 1)])
    const result = await runSkillTool(redactDocumentTool, {
      skillId: 'app:document-redaction',
      input: { documentId: 'd1' },
      ctx,
      confirmed: true
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as RedactDocumentOutput
      expect(out.counts.card).toBe(1)
      expect(out.redactedText).toContain('[CARD]')
      expect(validateToolOutput(redactDocumentTool, result.output)).toEqual([])
    }
  })
})
