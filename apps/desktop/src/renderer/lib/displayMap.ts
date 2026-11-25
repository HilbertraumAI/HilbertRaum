import { en, type MessageKey, type MessageParams } from '@shared/i18n'
import { CITE_CODE_SPLIT_RE, CITE_MARKER_RE } from '@shared/citation-markers'
import {
  DISPLAY_MAP_KEYS,
  INTERPOLATED_MAP_KEYS,
  parsePersistedMessage,
  persistedMessageKey
} from '@shared/persisted-messages'

// The D-L4 display map (i18n record §3.3 rule 1): persisted main-process strings
// are stored as canonical ENGLISH (documents.error_message, the fixed RAG answers in
// messages.content, benchmark warnings in settings.lastBenchmark) so the data
// contracts — most importantly `scanDetected` — never move. The renderer translates
// them at display time: `@shared/persisted-messages` reads a stored string back to its
// MessageKey (by exact match, or, for a message that carries an interpolated value such
// as the offending file extension, by a pattern built from its English template), and
// this module renders the key in the UI language. Unknown strings (raw library errors)
// render as-is; a failed document row and the chat attach banner show them under a
// translated lead (#807, `classifyServerCopy`).
//
// Because the English catalog values are byte-identical to the pre-i18n literals
// (D-L8), rows persisted BEFORE the i18n wave match too — switching language
// retroactively re-translates old failure rows and old "couldn't find it in your
// documents" answers. In an English UI the lookup is the identity.
//
// F-26 (T2.12): a newer version may store a message in the coded form `hr:<key>`. One this
// version knows renders like its English; one it cannot show renders as C02
// (`common.newerVersionText`), under the same lead.

// The two key sets live in `@shared/persisted-messages` (T2.12): main reads the same set for
// `scanDetected`. Re-exported so the catalog hygiene test's imports stay as they are.
export { DISPLAY_MAP_KEYS, INTERPOLATED_MAP_KEYS }

/**
 * The persist-canonical key a stored string IS (its English, an alias, or a code this version
 * knows: F-26), or null. Lets a row branch on WHICH known failure it carries without comparing
 * raw English at the call site — e.g. the photo row's in-app OCR remedy (#410) keys off
 * `main.ingest.imageNeedsOcr`, whose stored text never changes (the remedy is appended at
 * display time instead).
 */
export function displayMapKey(raw: string | null | undefined): MessageKey | null {
  return persistedMessageKey(raw)
}

/** A bound translator (what `useT().t` returns, or `(k) => t(lang, k)`). */
export type BoundT = (key: MessageKey, params?: MessageParams) => string

// Legacy pattern for rows persisted by Phase-4-era ingestion (before this message was
// localized): the old raw English form ended with the offending extension. Matched here so an
// already-failed row still localizes after this change instead of leaking raw English into a
// German UI. Written as a regex (not the quoted literal) so the copy-tone guard stays clean.
// The one old form outside PERSISTED_ALIASES (F-26), and frozen like it.
const LEGACY_UNSUPPORTED_TYPE_RE = /^Unsupported file type: (.+)$/

/**
 * Recover the offending extension when `raw` is the unsupported-file-type failure (current
 * OR legacy wording, an alias or a code: F-26), else null. Exported so a failed row can branch
 * on it: "Try again" (re-index) is offered only for retryable failures, and an unsupported type
 * is not one.
 */
export function unsupportedTypeExt(raw: string): string | null {
  const message = parsePersistedMessage(raw)
  if (message?.kind === 'message') {
    return message.key === 'main.ingest.unsupportedType' ? (message.params.ext ?? null) : null
  }
  return LEGACY_UNSUPPORTED_TYPE_RE.exec(raw)?.[1] ?? null
}

// ---- Citation markers (#28 / beta-feedback plan Phase 1, D68) ---------------------------
// The grounded RAG prompt bakes the machine-stable inline markers `[S1] [S2] …` into the model
// output (GROUNDING_RULES in rag/index.ts) and persists them in `citations_json` — those NEVER
// change. But "S" reads as "S." = "Seite" (page) to a German user, when it actually indexes a
// SOURCE (Quelle). So at DISPLAY time only, the inline marker is relabelled per the UI language:
// EN keeps `S{n}` (the rewrite is the identity), DE shows `Q{n}`. `formatCitationLabel` does the
// same for SourcesDisclosure's source-card label from the stored `S{n}` string.
//
// Code guard: a literal `[S1]` inside a fenced block or an inline code span must stay verbatim, so
// the rewrite runs only over the PROSE segments — mirrors `normalizeMathDelimiters` in
// AssistantMarkdown.tsx (even split indices are prose, odd are code; an unclosed trailing fence
// swallows to end-of-text as one code part, and the split still ends on a '' prose part, so a
// mid-stream buffer inside a fence is left alone).
// The regexes themselves live in `@shared/citation-markers` (EP-1 plan §6.2): the main-side
// evidence-review marker extraction imports the SAME definitions, so "what is a citation vs
// literal code" can never drift between the chat display and a review's answer_marker links.

/** Rewrite inline `[S{n}]` body markers to the localized marker (DE `[Q{n}]`), skipping code. */
function localizeCitationMarkers(t: BoundT, raw: string): string {
  if (!raw.includes('[S')) return raw
  const parts = raw.split(CITE_CODE_SPLIT_RE)
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]!.replace(CITE_MARKER_RE, (_m, n: string) => `[${t('chat.sources.marker', { n })}]`)
  }
  return parts.join('')
}

/**
 * Localize a stored `S{n}` citation label for the source-card display (EN `S{n}` / DE `Q{n}`,
 * D68). A non-standard label (defensive) passes through unchanged. The stored value is untouched.
 */
export function formatCitationLabel(t: BoundT, label: string): string {
  const m = /^S(\d+)$/.exec(label)
  return m ? t('chat.sources.marker', { n: m[1] }) : label
}

/** A server-origin string as the display map read it (#807). */
export interface ServerCopy {
  /** The display text: what `localizeServerCopy` returns. */
  text: string
  /** Whether `raw` was one of the app's own messages: the exact map, an interpolated family, a
   *  code this version knows, or the doc-task-busy substring. False for the pass-through (a
   *  library's or the OS's own words) and for a code this version cannot show (F-26: the text is
   *  C02), which a failed row shows under the translated `docs.failed.lead` and the chat attach
   *  banner under `chat.attach.failed` (it names the file). */
  recognized: boolean
}

const known = (text: string): ServerCopy => ({ text, recognized: true })

/**
 * Translate a server-origin string for display and say whether the display map knew it:
 * a stored message `@shared/persisted-messages` reads (its English, an alias, or a code: F-26),
 * then the legacy unsupported-type wording, else pass through unchanged (not recognized). A code
 * this version cannot show reads as C02, not recognized. DOC_TASK_BUSY_MESSAGE is additionally
 * matched as a substring — the chat banner recognizes it via `error.includes` (transport prefixes
 * may survive), so its display mapping must tolerate the same embedding.
 *
 * The persisted-constant branches carry no citation markers; a real model answer (the only text
 * that carries `[S{n}]`) falls through to the final return, where the marker is localized (D68).
 */
export function classifyServerCopy(t: BoundT, raw: string): ServerCopy {
  const message = parsePersistedMessage(raw)
  // The copy deck's C02 stands under the lead on a failed row, so it is not recognized.
  if (message?.kind === 'unknownCode') return { text: t('common.newerVersionText'), recognized: false }
  if (message) return known(t(message.key, message.params))
  const ext = LEGACY_UNSUPPORTED_TYPE_RE.exec(raw)?.[1]
  if (ext != null) return known(t('main.ingest.unsupportedType', { ext }))
  const busy = en['main.chat.docTaskBusy']
  if (raw.includes(busy)) return known(raw.replace(busy, t('main.chat.docTaskBusy')))
  return { text: localizeCitationMarkers(t, raw), recognized: false }
}

/** The display text of a server-origin string (`classifyServerCopy` without the verdict). */
export function localizeServerCopy(t: BoundT, raw: string): string {
  return classifyServerCopy(t, raw).text
}
