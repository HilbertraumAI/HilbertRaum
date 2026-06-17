import type {
  DocumentChunkRead,
  JsonSchema,
  SkillTool,
  ToolResult
} from '../../../../shared/types'
import { parseDate } from './money'

// Document-redaction Tier-2 tool (architecture.md "Skills — design record" §8, Phase S11d). Kept OUT
// of the generic `tool-registry.ts` so redaction specifics never leak into the skills infrastructure
// (skills-plan §13); the registry merely imports the finished `SkillTool` and lists it.
//
// Pure main-side TS: no node:fs, no network, no native deps (CLAUDE.md §0). The tool's WHOLE reach is
// `ctx.readDocumentChunks` over the frozen selected-document scope (it cannot widen scope or touch a
// DB/FS/net handle — §14). It produces the REDACTED text + per-category counts; the orchestration seam
// (`run.ts`) does the MAIN-side, user-chosen file write (the existing export boundary). It persists
// nothing itself — the gate stays content-free.
//
// HONESTY (the privacy-aligned posture): the detection is DETERMINISTIC, OFFLINE, and REGEX-ONLY (no
// ML, no name detection). It is a BEST-EFFORT aid, NOT a guarantee — it masks clearly-shaped personal
// data (e-mail, phone, IBAN, date, URL) and deliberately MISSES anything without a recognisable
// pattern (most names, addresses, unusual formats) rather than corrupting text by over-matching. The
// SKILL.md body and docs/known-limitations.md say so plainly; we never imply "fully anonymized".
//
// PRIVACY: the detected personal-data VALUES are content. They NEVER appear in any log/audit/run
// metadata — the tool returns only the redacted text (written solely to the user-chosen file) plus the
// per-category COUNTS (which are counts, not content, and are safe to surface).

// ---- Categories + the fixed mask tokens ----

export type RedactionCategory = 'email' | 'phone' | 'iban' | 'date' | 'url'

/** The fixed token each category is replaced with. Tokens carry no digit/@/scheme, so masking is
 *  idempotent — re-running over already-masked text matches nothing and adds no further redactions. */
export const MASK_TOKENS: Record<RedactionCategory, string> = {
  email: '[EMAIL]',
  phone: '[PHONE]',
  iban: '[IBAN]',
  date: '[DATE]',
  url: '[URL]'
}

export interface RedactionCounts {
  email: number
  phone: number
  iban: number
  date: number
  url: number
}

export interface RedactDocumentOutput {
  /** The full document text with every detected personal-data match replaced by its category token. */
  redactedText: string
  /** How many matches were masked per category (counts only — never the masked values). */
  counts: RedactionCounts
  /** The sum across categories — the single content-free count the seam/renderer surfaces. */
  totalRedactions: number
}

// ---- Deterministic detectors (each a small pure exported function, unit-testable in isolation) ----
//
// Each returns the text with its category masked plus the number of matches. They are conservative by
// design: a regex that would prefer to MISS a borderline value over EATING ordinary text. The order
// in which `redactText` applies them is fixed so masks never overlap (see redactText).

// E-mail: the conventional local@domain.tld shape.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

// URL: http(s):// or www. forms, stopping at whitespace or a sentence separator so trailing prose is
// left alone. (Case-insensitive scheme.)
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s,;<>()]+/gi

// IBAN candidate: a 2-letter country code + 2 check digits, then UPPERCASE-alphanumeric BBAN chars in
// groups of up to four (the common space-grouped print form). Groups are uppercase-only on purpose —
// IBANs are conventionally printed uppercase, so a following lowercase prose word ("…3201 please")
// cannot be mis-read as another group and eaten. Each candidate is re-validated after compacting
// (length + per-country length where known), so the loose candidate never masks more than a real IBAN.
const IBAN_CANDIDATE_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{1,4}){2,8}\b/g

// Per-country IBAN lengths (the common European set). A known country must match its exact total
// length; an unknown country falls back to the generic 15–34 range (a documented best-effort limit).
const IBAN_LENGTHS: Record<string, number> = {
  AT: 20, BE: 16, CH: 21, CZ: 24, DE: 22, DK: 18, ES: 24, FI: 18, FR: 27, GB: 22,
  HU: 28, IE: 22, IT: 27, LI: 21, LU: 20, NL: 18, NO: 15, PL: 28, PT: 25, SE: 24, SI: 19, SK: 24
}

// Phone: conservative international/German shapes only — a `+`-prefixed country code OR a leading `0`,
// then 7–15 digits with optional single separators. Plain numbers (amounts, years, account numbers
// without a leading 0) are intentionally NOT matched. Dates are masked BEFORE phones (see redactText)
// so a dotted date like "01.02.2026" can never be eaten here.
const PHONE_RE = /(?<!\d)(?:\+\d{1,3}[\s.\-/]?\d(?:[\s.\-/]?\d){5,13}|0\d(?:[\s.\-/]?\d){5,12})(?!\d)/g

// Date candidate: the three supported printed forms; each is re-validated with the shared `parseDate`
// (the bank/invoice date primitive) so an impossible date like 99/99/9999 is left untouched.
const DATE_CANDIDATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g

/** Mask every e-mail address; returns the new text and the match count. */
export function maskEmails(text: string): { text: string; count: number } {
  let count = 0
  const out = text.replace(EMAIL_RE, () => {
    count++
    return MASK_TOKENS.email
  })
  return { text: out, count }
}

/** Mask every http(s):// or www. link. */
export function maskUrls(text: string): { text: string; count: number } {
  let count = 0
  const out = text.replace(URL_RE, () => {
    count++
    return MASK_TOKENS.url
  })
  return { text: out, count }
}

/** Mask every IBAN — a candidate is masked only when, with its print spaces removed, it is a real
 *  IBAN shape (2 letters + 2 check digits + 11–30 alphanumerics ⇒ 15–34 chars). */
export function maskIbans(text: string): { text: string; count: number } {
  let count = 0
  const out = text.replace(IBAN_CANDIDATE_RE, (m) => {
    const compact = m.replace(/\s+/g, '')
    // Structural shape first (2 letters + 2 check digits + 11–30 BBAN chars ⇒ 15–34 total)…
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return m
    // …then the exact per-country length where known (an unknown country keeps the generic shape).
    const expected = IBAN_LENGTHS[compact.slice(0, 2)]
    if (expected !== undefined && compact.length !== expected) return m
    count++
    return MASK_TOKENS.iban
  })
  return { text: out, count }
}

/** Mask every phone number (conservative shapes only — see PHONE_RE). */
export function maskPhones(text: string): { text: string; count: number } {
  let count = 0
  const out = text.replace(PHONE_RE, () => {
    count++
    return MASK_TOKENS.phone
  })
  return { text: out, count }
}

/** Mask every date in a supported printed form, validated with the shared `parseDate`. */
export function maskDates(text: string): { text: string; count: number } {
  let count = 0
  const out = text.replace(DATE_CANDIDATE_RE, (m) => {
    if (parseDate(m) !== null) {
      count++
      return MASK_TOKENS.date
    }
    return m
  })
  return { text: out, count }
}

/**
 * Redact a whole text deterministically. The detectors run in a FIXED order so masks never overlap:
 *   email → url → iban → date → phone.
 * Rationale for the order: URLs may embed numbers/dates, so they are masked whole first; IBANs are
 * masked before phones so a phone pattern can't eat an IBAN's tail; DATES are masked before PHONES so
 * a dotted date (`01.02.2026`, which a 0-leading phone pattern would otherwise match) is gone first.
 * Each mask token contains no digit/`@`/scheme, so later detectors never match inside an inserted
 * token — which also makes redaction IDEMPOTENT (re-running adds nothing).
 */
export function redactText(input: string): {
  text: string
  counts: RedactionCounts
  totalRedactions: number
} {
  let text = input
  const counts: RedactionCounts = { email: 0, phone: 0, iban: 0, date: 0, url: 0 }

  const e = maskEmails(text)
  text = e.text
  counts.email = e.count
  const u = maskUrls(text)
  text = u.text
  counts.url = u.count
  const i = maskIbans(text)
  text = i.text
  counts.iban = i.count
  const d = maskDates(text)
  text = d.text
  counts.date = d.count
  const p = maskPhones(text)
  text = p.text
  counts.phone = p.count

  const totalRedactions = counts.email + counts.phone + counts.iban + counts.date + counts.url
  return { text, counts, totalRedactions }
}

// ---- The output contract (the `JsonSchema` subset) ----

const REDACT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['redactedText', 'counts', 'totalRedactions'],
  properties: {
    redactedText: { type: 'string' },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['email', 'phone', 'iban', 'date', 'url'],
      properties: {
        email: { type: 'integer', minimum: 0 },
        phone: { type: 'integer', minimum: 0 },
        iban: { type: 'integer', minimum: 0 },
        date: { type: 'integer', minimum: 0 },
        url: { type: 'integer', minimum: 0 }
      }
    },
    totalRedactions: { type: 'integer', minimum: 0 }
  }
}

// ---- The tool ----

/**
 * `redact_document` (S11d) — read the selected document's page-addressable chunks via the narrow
 * `ctx.readDocumentChunks`, mask the personal data it can detect deterministically and offline, and
 * return the redacted text + per-category counts. It writes nothing itself; the `run.ts` seam does the
 * confirm-gated, MAIN-side, user-chosen file write. It declares `export-file`, so the gate requires the
 * user's confirmation before it runs. A wrong-shape result fails the run at the gate.
 */
export const redactDocumentTool: SkillTool = {
  name: 'redact_document',
  description:
    'Read the selected document and produce a copy with detectable personal data (e-mails, phone numbers, IBANs, dates, links) masked, for you to save. Deterministic, offline, best-effort — not a guarantee. Requires your confirmation; you choose where the file is written.',
  permissions: ['read-selected-docs', 'export-file'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['documentId'],
    properties: { documentId: { type: 'string', minLength: 1 } }
  },
  outputSchema: REDACT_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const { documentId } = input as { documentId: string }
    let chunks: DocumentChunkRead[]
    try {
      chunks = ctx.readDocumentChunks(documentId)
    } catch {
      // Out-of-scope / unreadable — friendly + content-free; the technical reason is the seam's log.
      return { ok: false, error: 'This document could not be read.' }
    }
    const joined = chunks.map((c) => c.text).join('\n')
    const { text, counts, totalRedactions } = redactText(joined)
    ctx.onProgress?.({ done: chunks.length, total: chunks.length })
    const output: RedactDocumentOutput = { redactedText: text, counts, totalRedactions }
    return { ok: true, output }
  }
}
