import type {
  DocumentChunkRead,
  JsonSchema,
  SkillTool,
  ToolResult
} from '../../../../shared/types'
import { parseDate, type DateAnchor } from './money'

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
// data (e-mail, phone, IBAN, payment-card number, date, URL) and deliberately MISSES anything without a recognisable
// pattern (most names, addresses, unusual formats) rather than corrupting text by over-matching. The
// SKILL.md body and docs/known-limitations.md say so plainly; we never imply "fully anonymized".
//
// PRIVACY: the detected personal-data VALUES are content. They NEVER appear in any log/audit/run
// metadata — the tool returns only the redacted text (written solely to the user-chosen file) plus the
// per-category COUNTS (which are counts, not content, and are safe to surface).

// ---- Categories + the fixed mask tokens ----

export type RedactionCategory = 'email' | 'phone' | 'iban' | 'card' | 'date' | 'url'

/** The fixed token each category is replaced with. Tokens carry no digit/@/scheme, so masking is
 *  idempotent — re-running over already-masked text matches nothing and adds no further redactions. */
export const MASK_TOKENS: Record<RedactionCategory, string> = {
  email: '[EMAIL]',
  phone: '[PHONE]',
  iban: '[IBAN]',
  card: '[CARD]',
  date: '[DATE]',
  url: '[URL]'
}

export interface RedactionCounts {
  email: number
  phone: number
  iban: number
  /** Payment-card PANs (13–19 digits, Luhn-validated) — U2, audit §5.7 redaction bullet. */
  card: number
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
//
// UNICODE PRINT VARIANTS (SKA-3, skills-audit-2026-07-03 §3.1): R1's `normalizeExtractionText` runs at
// every MONEY extractor entry, but redaction (and the U2 share-safe pre-scan / dry-run counts, which
// reach here via `scanRedactionCandidates` → `redactText`) stayed on the raw joined text — D58
// deliberately keeps redaction byte-verbatim — so a typographically-set PDF's NBSP-grouped IBAN/card,
// or a phone with the non-breaking hyphen Word auto-inserts, reached the ASCII separator classes below
// unmodified and was NEVER masked (verified by execution during the audit). The fix keeps BOTH
// postures: every detector runs over a same-length detection SHADOW of the text in which each common
// Unicode print separator is replaced 1:1 by its ASCII equivalent, and the masks are applied to the
// ORIGINAL text at the matched offsets (`maskViaShadow`). Every replacement maps ONE BMP code unit to
// ONE BMP code unit, so shadow offsets address the original text directly — and unmasked text stays
// byte-identical to the source (the D58 verbatim posture holds).

// The shadow map (SKA-3): NBSP / narrow NBSP / figure space → space; non-breaking hyphen / en dash /
// minus sign → '-'. Deliberately ONLY the print variants a PDF/Word pipeline actually emits around
// numbers — exotic Unicode separators stay unmapped (documented best-effort limit, known-limitations).
// Characters as \u escapes (the T1 convention) so a git/editor normalization cannot silently
// defeat the mapping.
const DETECTION_SHADOW_RE = /[\u00a0\u202f\u2007\u2011\u2013\u2212]/g
const SHADOW_ASCII: Record<string, string> = {
  '\u00a0': ' ', // no-break space
  '\u202f': ' ', // narrow no-break space
  '\u2007': ' ', // figure space
  '\u2011': '-', // non-breaking hyphen
  '\u2013': '-', // en dash
  '\u2212': '-' // minus sign
}

/** The same-length detection shadow of `text` (SKA-3): common Unicode print separators replaced 1:1
 *  by their ASCII equivalents so the detectors below see a Unicode-set value exactly like its ASCII
 *  print twin. `shadow.length === text.length` always (every mapping is one BMP code unit). */
export function detectionShadow(text: string): string {
  return text.replace(DETECTION_SHADOW_RE, (ch) => SHADOW_ASCII[ch])
}

/** A sub-span of a shadow match to mask, relative to the match start. The R8 review's F1/F2: the
 *  shadow can JOIN an identifier's neighbour (a currency word / BIC / row number one NBSP away — the
 *  typeset-PDF layout SKA-3 targets) into one greedy candidate that then FAILS validation as a whole;
 *  an all-or-nothing accept would silently UN-mask the identifier inside it. So an accept callback may
 *  narrow the mask to the valid sub-span instead of discarding the whole match. */
interface MaskSpan {
  start: number
  length: number
}

/** The state one detector pass hands to the next: the (partially masked) text plus its detection
 *  shadow. INVARIANT: `shadow === detectionShadow(text)` — maskStep preserves it by splicing the mask
 *  token into BOTH strings at the same offsets (tokens are pure ASCII containing no shadow-mapped
 *  character), so `redactText` computes the shadow ONCE instead of once per detector (the R8 perf
 *  review: six per-pass recomputations made an NBSP-dense multi-MB hostile document cross the 1 s
 *  main-process bar; threading the shadow removes the amplifier). */
interface MaskState {
  text: string
  shadow: string
}

/** Run `re` over the detection SHADOW and replace each accepted match's span in the ORIGINAL text
 *  with `token` (SKA-3). `accept` sees the SHADOW match (ASCII separators) plus the ORIGINAL slice
 *  (so range/math typography like an en dash can be told apart from a mapped phone hyphen), and may
 *  return a MaskSpan to narrow the mask to a valid sub-span (see MaskSpan). The shadow is same-length,
 *  so all offsets address both strings — unmasked bytes are copied through verbatim. */
function maskStep(
  state: MaskState,
  re: RegExp,
  token: string,
  accept: (shadowMatch: string, original: string) => boolean | MaskSpan = () => true
): { state: MaskState; count: number } {
  const { text, shadow } = state
  let outText = ''
  let outShadow = ''
  let last = 0
  let count = 0
  for (const m of shadow.matchAll(re)) {
    const start = m.index ?? 0
    const verdict = accept(m[0], text.slice(start, start + m[0].length))
    if (verdict === false) continue
    const span = verdict === true ? { start: 0, length: m[0].length } : verdict
    if (span.length <= 0 || span.start < 0 || span.start + span.length > m[0].length) continue
    const from = start + span.start
    outText += text.slice(last, from) + token
    outShadow += shadow.slice(last, from) + token
    last = from + span.length
    count++
  }
  return {
    state: { text: outText + text.slice(last), shadow: outShadow + shadow.slice(last) },
    count
  }
}

/** One-shot wrapper for the exported per-detector functions: compute the shadow, run one pass. */
function maskViaShadow(
  text: string,
  re: RegExp,
  token: string,
  accept?: (shadowMatch: string, original: string) => boolean | MaskSpan
): { text: string; count: number } {
  const r = maskStep({ text, shadow: detectionShadow(text) }, re, token, accept)
  return { text: r.state.text, count: r.count }
}

// En dash / minus sign in the ORIGINAL bytes are RANGE/MATH typography ("10.000–15.000",
// "05.2025–06.2026", "10.000−2.500"), never real phone/card punctuation — the R8 review showed the
// shadow's `–`→`-` mapping otherwise feeds them to PHONE_RE's 0-leading branch (deterministically
// eating German amount ranges, billing periods, postal-code ranges and time ranges as [PHONE]) and
// lets a Luhn-lucky invoice-number range mask as [CARD]. The non-breaking hyphen U+2011 is NOT in
// this class: it IS genuine phone/card typography (the character Word auto-inserts).
const RANGE_TYPOGRAPHY_RE = /[\u2013\u2212]/

// E-mail: the conventional local@domain.tld shape. The local-part and domain runs are length-BOUNDED
// (RFC limits: local ≤ 64, domain ≤ 255) so the scan is provably linear. The earlier unbounded
// `[..]+@[..]+` form backtracked quadratically (O(N²)) on a long `a.a.a.…` run with no `@`/no final
// `.tld` — because `.` is both a non-word char (so `\b` permits a restart at every letter) and a
// class member, every start position re-scanned the whole run. On a hostile imported document this
// froze the main process (vuln-scan 2026-06-21). Bounding the two runs makes each attempt O(1); a
// real address never exceeds these limits, so detection is unchanged.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}\b/g

// URL: http(s):// or www. forms, stopping at whitespace or a sentence separator so trailing prose is
// left alone. (Case-insensitive scheme.)
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s,;<>()]+/gi

// IBAN candidate — TWO alternatives so a lowercase / mixed-case IBAN is detected WITHOUT re-introducing
// the "trailing prose word eaten" hazard (full-audit-2026-06-28 BL-N4):
//   (1) space-GROUPED, UPPERCASE-only: a 2-letter country code + 2 check digits, then uppercase BBAN
//       chars in groups of up to four (the common space-grouped print form). Uppercase-only on purpose —
//       a following lowercase prose word ("…3201 please") cannot be mis-read as another group and eaten.
//   (2) COMPACT, ANY-CASE: a contiguous (space-less) 2-letter + 2-digit + 11–30 alphanumeric run; it
//       cannot span a space, so a lowercase compact IBAN like "de89370400440532013000" is caught while
//       prose (which has spaces, or lacks the 2-letter+2-digit lead) is not.
// `maskIbans` uppercases each candidate before validating, and re-validates after compacting (length +
// per-country length where known), so a loose candidate never masks more than a real IBAN.
const IBAN_CANDIDATE_RE =
  /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{1,4}){2,8}\b|\b[A-Za-z]{2}\d{2}[A-Za-z0-9]{11,30}\b/g

// Per-country IBAN lengths (the common European set). A known country must match its exact total
// length; an unknown country falls back to the generic 15–34 range (a documented best-effort limit).
const IBAN_LENGTHS: Record<string, number> = {
  AT: 20, BE: 16, CH: 21, CZ: 24, DE: 22, DK: 18, ES: 24, FI: 18, FR: 27, GB: 22,
  HU: 28, IE: 22, IT: 27, LI: 21, LU: 20, NL: 18, NO: 15, PL: 28, PT: 25, SE: 24, SI: 19, SK: 24
}

// Payment-card PAN (U2, audit §5.7 redaction bullet): a 13–19 digit run in the common print groupings —
// compact, or in groups separated by SINGLE spaces or dashes (`4111 1111 1111 1111`, `4111-1111-…`);
// matched against the detection SHADOW, so the Unicode print twins (NBSP/figure-space-grouped,
// non-breaking-hyphen-grouped) hit the same `[ -]` class (SKA-3). The
// candidate is Luhn-validated in `maskCards`, so a random 13–19 digit account/ID number is left alone
// (over-masking a real non-card number would still be a privacy-safe redaction, but Luhn keeps the false
// positives low). Linear by construction: each `(?:[ -]?\d)` iteration consumes exactly one digit plus an
// optional single separator (no nested unbounded quantifier ⇒ no ReDoS). A run of >19 digits has its `\b`
// only at the ends, so no 13–19 subrun is `\b`-terminated ⇒ a long account number is NOT masked as a card.
// Cards are masked BEFORE dates and phones (see redactText) so a 13–19 digit run is never split by them.
const CARD_CANDIDATE_RE = /\b\d(?:[ -]?\d){12,18}\b/g

// Phone: conservative international/German/US shapes only — (a) a `+`-prefixed country code, (b) a
// leading `0`, then 7–15 digits with optional single separators, (c) a US/national 3-3-4 number that
// is PUNCTUATED ("555-123-4567", "1-800-555-1234", "555.123.4567"), optional leading "1" country code
// (full-audit-2026-06-28 BL-N4), OR (d) the parenthesized US print form "(555) 123-4567" — the most
// common US layout had NO matching branch (SKA-3). Punctuation is REQUIRED on (c), and (d) is anchored
// by the area-code parentheses plus a punctuated last separator: a bare 10-digit run with no separators
// is NOT matched (it would mask account/ID numbers), and `[.\-]` excludes spaces and slashes so a prose
// triple ("100 200 3000") and a slashed date are left alone. Plain numbers (amounts, years, account
// numbers without a leading 0) are intentionally NOT matched. The separator classes are matched against
// the detection SHADOW (SKA-3): `\s` already covered the NBSP family, but the hyphen variants (the
// non-breaking hyphen U+2011 Word auto-inserts into phone numbers, the en dash) only exist as '-' in the
// shadow — a "+43 664<U+2011>1234567" print form used to reach this regex unmatched. Dates are masked BEFORE phones (see
// redactText) so a dotted date like "01.02.2026" can never be eaten here.
//
// The 0-leading branch is post-validated in `maskPhones` (U2, audit §5.7): a SEPARATOR-LESS run of ≥9
// digits that begins with `0` is a reference/account number (a 0-leading invoice reference), NOT a phone —
// masking it corrupted invoices in the share flow. Such a bare run is therefore left unmasked; a 0-leading
// number that carries a separator (a printed phone) still masks, and the `+`/US branches are unaffected.
const PHONE_RE =
  /(?<!\d)(?:\+\d{1,3}[\s.\-/]?\d(?:[\s.\-/]?\d){5,13}|0\d(?:[\s.\-/]?\d){5,12}|(?:1[.\-])?\d{3}[.\-]\d{3}[.\-]\d{4}|\(\d{3}\)[ ]?\d{3}[.\-]\d{4})(?!\d)/g

// Date candidate: ISO plus dotted/slashed forms with a 4- OR 2-digit year (U2, audit §5.7 — 2-digit-year
// birthdates used to pass). Each is re-validated in `maskDates`, which masks a candidate that parses in
// EITHER field order (over-masking a date is fine for redaction — unlike extraction, which stays day-first).
const DATE_CANDIDATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./](?:\d{4}|\d{2})\b/g

// A fixed anchor so `parseDate` accepts a 2-digit year (it needs a document century, R5). Redaction masks
// date-SHAPE, never the value, so any century works — the anchor month is irrelevant (candidates always
// carry a year, so the bare-date month-rollover path is never taken).
const REDACTION_DATE_ANCHOR: DateAnchor = { year: 2000, month: 1 }

/** Luhn (mod-10) check for a bare digit string, plus the card length window (13–19). */
function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

// ---- The per-category accept validators (shared by the exported one-shot detectors and redactText) ----

/** IBAN accept: a candidate is masked only when, with its print spaces removed and uppercased, it is a
 *  real IBAN shape (2 letters + 2 check digits + 11–30 alphanumerics ⇒ 15–34 chars) with the exact
 *  per-country length where known. Uppercasing keeps detection case-insensitive (BL-N4). R8 review F1:
 *  the shadow can join the IBAN's right-hand neighbour (a currency word / BIC one NBSP away) into the
 *  greedy grouped candidate, and validating only the WHOLE span would then LEAK the IBAN — so trailing
 *  space-separated tokens are trimmed until a prefix validates, and only that prefix is masked. */
function acceptIban(m: string): boolean | MaskSpan {
  const tokens = m.split(' ')
  for (let keep = tokens.length; keep >= 1; keep--) {
    const candidate = tokens.slice(0, keep).join(' ')
    const compact = candidate.replace(/ /g, '').toUpperCase()
    if (compact.length < 15) break // dropping more tokens only shortens — nothing left to validate
    // Structural shape first (2 letters + 2 check digits + 11–30 BBAN chars ⇒ 15–34 total)…
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) continue
    // …then the exact per-country length where known (an unknown country keeps the generic shape).
    const expected = IBAN_LENGTHS[compact.slice(0, 2)]
    if (expected !== undefined && compact.length !== expected) continue
    return { start: 0, length: candidate.length }
  }
  return false
}

/** Card accept: Luhn over the separator-stripped digits, on the best token-aligned sub-range. R8
 *  review F2: the shadow can join neighbouring digit groups (a row number / amount cell one NBSP away)
 *  into a 17–19-digit candidate that fails Luhn as a whole while a real PAN sits inside — so search the
 *  separator-aligned sub-ranges longest-first, leftmost-first, and mask the first that Luhn-validates.
 *  Token alignment means a mid-group split can never manufacture a PAN out of a Luhn-failing compact
 *  run (the existing negative controls hold). A sub-range whose ORIGINAL bytes carry range/math
 *  typography (en dash / minus — see RANGE_TYPOGRAPHY_RE) is refused: a real PAN is never set with
 *  them, while a Luhn-lucky invoice-number range would otherwise mask. */
function acceptCard(m: string, original: string): boolean | MaskSpan {
  const bounds: Array<{ start: number; end: number }> = []
  let pos = 0
  for (const part of m.split(/[ -]/)) {
    bounds.push({ start: pos, end: pos + part.length })
    pos += part.length + 1
  }
  for (let width = bounds.length; width >= 1; width--) {
    for (let i = 0; i + width <= bounds.length; i++) {
      const from = bounds[i].start
      const to = bounds[i + width - 1].end
      if (RANGE_TYPOGRAPHY_RE.test(original.slice(from, to))) continue
      const digits = m.slice(from, to).replace(/[ -]/g, '')
      if (digits.length < 13 || digits.length > 19) continue
      if (!luhnValid(digits)) continue
      return { start: from, length: to - from }
    }
  }
  return false
}

/** Phone accept — two guards. (1) U2 (audit §5.7): a SEPARATOR-LESS run of ≥9 digits beginning with
 *  `0` is a reference/account number, not a phone (the share-flow invoice-corruption false positive);
 *  the test reads the SHADOW match, so a 0-leading number whose only separator is the non-breaking
 *  hyphen counts as separated — a printed phone, masked. (2) R8 review: a match whose ORIGINAL bytes
 *  carry range/math typography (en dash / minus) is refused UNLESS it is `+`-led or parenthesized —
 *  those anchors are unambiguous, so "+43 664–…" (an en-dash print form of a real phone) still masks,
 *  while "10.000–15.000", "05.2025–06.2026" and "100–200–3000" stay prose. The cost is a missed
 *  en-dash-set bare/0-leading phone — the documented miss-over-eating posture. */
function acceptPhone(m: string, original: string): boolean {
  const hasSeparator = /[\s.\-/]/.test(m)
  if (m.startsWith('0') && !hasSeparator && m.replace(/\D/g, '').length >= 9) return false
  if (!m.startsWith('+') && !m.startsWith('(') && RANGE_TYPOGRAPHY_RE.test(original)) return false
  return true
}

/** Date accept: for REDACTION a candidate masks when it parses in EITHER field order (day-first OR
 *  month-first) with a 2- or 4-digit year (U2, audit §5.7) — over-masking a date is privacy-favouring,
 *  unlike extraction, which stays day-first. An impossible date (`99.99.9999`) parses in neither order. */
function acceptDate(m: string): boolean {
  return (
    parseDate(m, 'dmy', REDACTION_DATE_ANCHOR) !== null ||
    parseDate(m, 'mdy', REDACTION_DATE_ANCHOR) !== null
  )
}

// ---- The exported one-shot detectors ----

/** Mask every e-mail address; returns the new text and the match count. */
export function maskEmails(text: string): { text: string; count: number } {
  return maskViaShadow(text, EMAIL_RE, MASK_TOKENS.email)
}

/** Mask every http(s):// or www. link. */
export function maskUrls(text: string): { text: string; count: number } {
  return maskViaShadow(text, URL_RE, MASK_TOKENS.url)
}

/** Mask every IBAN (see acceptIban). The candidate comes from the detection shadow (SKA-3), so an
 *  NBSP/narrow-NBSP/figure-space-grouped print IBAN validates exactly like the ASCII space-grouped form. */
export function maskIbans(text: string): { text: string; count: number } {
  return maskViaShadow(text, IBAN_CANDIDATE_RE, MASK_TOKENS.iban, acceptIban)
}

/** Mask every payment-card PAN (see acceptCard) — a 13–19 digit candidate (compact / space- /
 *  dash-grouped, incl. the Unicode print twins via the shadow — SKA-3) that passes the Luhn check.
 *  A non-card number (fails Luhn, or a 20+-digit compact run) is left alone (U2, audit §5.7). Masked
 *  BEFORE dates/phones so a 13–19 digit run is never split by them. */
export function maskCards(text: string): { text: string; count: number } {
  return maskViaShadow(text, CARD_CANDIDATE_RE, MASK_TOKENS.card, acceptCard)
}

/** Mask every phone number (conservative shapes only — see PHONE_RE and acceptPhone). */
export function maskPhones(text: string): { text: string; count: number } {
  return maskViaShadow(text, PHONE_RE, MASK_TOKENS.phone, acceptPhone)
}

/** Mask every date in a supported printed form (see acceptDate). */
export function maskDates(text: string): { text: string; count: number } {
  return maskViaShadow(text, DATE_CANDIDATE_RE, MASK_TOKENS.date, acceptDate)
}

/**
 * Redact a whole text deterministically. The detectors run in a FIXED order so masks never overlap:
 *   email → url → iban → card → date → phone.
 * Rationale for the order: URLs may embed numbers/dates, so they are masked whole first; IBANs are
 * masked before the pure-digit card scan so an IBAN's BBAN digits aren't re-read as a card; CARDS are
 * masked before dates and phones so a 13–19 digit PAN is never split by them; DATES are masked before
 * PHONES so a dotted date (`01.02.2026`, which a 0-leading phone pattern would otherwise match) is gone
 * first. Each mask token contains no digit/`@`/scheme, so later detectors never match inside an inserted
 * token — which also makes redaction IDEMPOTENT (re-running adds nothing).
 *
 * Every detector DETECTS on the same-length Unicode shadow and MASKS the original bytes (SKA-3, see
 * `maskViaShadow`) — so this one pipeline fixes BOTH entry points at once: the real redaction run and
 * `scanRedactionCandidates` (the U2 share-safe pre-scan / dry-run counts) cannot disagree, and the
 * unmasked remainder of the text stays byte-identical to the source (D58's verbatim posture).
 */
export function redactText(input: string): {
  text: string
  counts: RedactionCounts
  totalRedactions: number
} {
  // The shadow is computed ONCE and threaded through the passes (maskStep preserves the
  // shadow===detectionShadow(text) invariant — see MaskState); recomputing it per detector made an
  // NBSP-dense multi-MB hostile document a >1 s synchronous main-process stall (R8 perf review).
  let state: MaskState = { text: input, shadow: detectionShadow(input) }
  const counts: RedactionCounts = { email: 0, phone: 0, iban: 0, card: 0, date: 0, url: 0 }
  const step = (
    re: RegExp,
    token: string,
    accept?: (shadowMatch: string, original: string) => boolean | MaskSpan
  ): number => {
    const r = maskStep(state, re, token, accept)
    state = r.state
    return r.count
  }

  counts.email = step(EMAIL_RE, MASK_TOKENS.email)
  counts.url = step(URL_RE, MASK_TOKENS.url)
  counts.iban = step(IBAN_CANDIDATE_RE, MASK_TOKENS.iban, acceptIban)
  counts.card = step(CARD_CANDIDATE_RE, MASK_TOKENS.card, acceptCard)
  counts.date = step(DATE_CANDIDATE_RE, MASK_TOKENS.date, acceptDate)
  counts.phone = step(PHONE_RE, MASK_TOKENS.phone, acceptPhone)

  const totalRedactions =
    counts.email + counts.phone + counts.iban + counts.card + counts.date + counts.url
  return { text: state.text, counts, totalRedactions }
}

/**
 * Read-only PII scan (U2, audit §3.4/§3.5): the per-category COUNTS a redaction WOULD produce, without
 * exposing the redacted text. It runs the full `redactText` pipeline (same detector order, so the counts
 * are identical to a real run — dates masked before phones etc.) and returns only the counts. Used by the
 * redaction handler's informational dry-run answer and by the share-safe-review whole-document pre-scan;
 * both surface COUNTS only — never a detected value (§6 content boundary). */
export function scanRedactionCandidates(text: string): RedactionCounts {
  return redactText(text).counts
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
      required: ['email', 'phone', 'iban', 'card', 'date', 'url'],
      properties: {
        email: { type: 'integer', minimum: 0 },
        phone: { type: 'integer', minimum: 0 },
        iban: { type: 'integer', minimum: 0 },
        card: { type: 'integer', minimum: 0 },
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
    'Read the selected document and produce a copy with detectable personal data (e-mails, phone numbers, IBANs, payment-card numbers, dates, links) masked, for you to save. Deterministic, offline, best-effort — not a guarantee. Requires your confirmation; you choose where the file is written.',
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
