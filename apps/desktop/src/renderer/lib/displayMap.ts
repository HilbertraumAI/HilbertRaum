import { en, type MessageKey, type MessageParams } from '@shared/i18n'

// The D-L4 display map (i18n record §3.3 rule 1): persisted main-process strings
// are stored as canonical ENGLISH (documents.error_message, the fixed RAG answers in
// messages.content, benchmark warnings in settings.lastBenchmark) so the data
// contracts — most importantly the `scanDetected` exact-match — never move. The
// renderer translates them at display time via this exact-match reverse lookup from
// the known English constants to their MessageKeys. Unknown strings (raw library
// errors) render as-is. Messages that carry an interpolated value (the offending file
// extension) are handled separately below — they can't be exact-matched.
//
// Because the English catalog values are byte-identical to the pre-i18n literals
// (D-L8), rows persisted BEFORE the i18n wave match too — switching language
// retroactively re-translates old failure rows and old "couldn't find it in your
// documents" answers. In an English UI the lookup is the identity.

/** Every persist-canonical key the map recognizes (keep in step with the en.ts set —
 * exported so the catalog hygiene test can pin the two sets to each other). */
export const DISPLAY_MAP_KEYS: readonly MessageKey[] = [
  'main.ingest.pdfScanDetected',
  'main.ingest.audioNeedsTranscriber',
  'main.ingest.audioUnreadable',
  'main.ingest.audioTranscriptionFailed',
  'main.ingest.imageNeedsOcr',
  'main.ingest.imageNoText',
  'main.ingest.imageOcrFailed',
  'main.ingest.sourceMissing',
  'main.ingest.interrupted',
  'main.ingest.fileTooLarge',
  'main.ingest.tooManyChunks',
  'main.ingest.parseTimeout',
  'main.rag.noContext',
  'main.rag.reindexNeeded',
  'main.chat.docTaskBusy',
  'main.chat.defaultTitle',
  'main.benchmark.warnTiny',
  'main.benchmark.warnUnknown',
  'main.benchmark.warnDriveProbe',
  'main.benchmark.warnSlowDrive'
]

const KEY_BY_ENGLISH: ReadonlyMap<string, MessageKey> = new Map(
  DISPLAY_MAP_KEYS.map((key) => [en[key], key])
)

/** A bound translator (what `useT().t` returns, or `(k) => t(lang, k)`). */
export type BoundT = (key: MessageKey, params?: MessageParams) => string

// ---- Interpolated persist-canonical messages -------------------------------------------
// Some persisted error messages carry an interpolated value (the offending file extension),
// so they cannot be reverse-matched by the exact-match map above. Each is reverse-matched by
// a regex derived from its English template (the param becomes a capture group) and
// re-rendered in the target language with the param re-interpolated. These keys are
// persist-canonical but deliberately NOT in DISPLAY_MAP_KEYS (which is the exact-match set).

/** Persist-canonical keys handled via the interpolated matcher (not exact-match). Exported
 *  so the catalog-hygiene test can pin this set too. */
export const INTERPOLATED_MAP_KEYS: readonly MessageKey[] = ['main.ingest.unsupportedType']

/** Build a `^…$` regex from an English template by escaping it and turning its single
 *  `{param}` placeholder into a capture group. */
function templateToRegex(template: string, param: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(`\\{${param}\\}`, '(.+?)')}$`)
}

const UNSUPPORTED_TYPE_RE = templateToRegex(en['main.ingest.unsupportedType'], 'ext')
// Legacy pattern for rows persisted by Phase-4-era ingestion (before this message was
// localized): the old raw English form ended with the offending extension. Matched here so an
// already-failed row still localizes after this change instead of leaking raw English into a
// German UI. Written as a regex (not the quoted literal) so the copy-tone guard stays clean.
const LEGACY_UNSUPPORTED_TYPE_RE = /^Unsupported file type: (.+)$/

/**
 * Recover the offending extension when `raw` is the unsupported-file-type failure (current
 * OR legacy wording), else null. Exported so a failed row can branch on it: "Try again"
 * (re-index) is offered only for retryable failures, and an unsupported type is not one.
 */
export function unsupportedTypeExt(raw: string): string | null {
  const m = UNSUPPORTED_TYPE_RE.exec(raw) ?? LEGACY_UNSUPPORTED_TYPE_RE.exec(raw)
  return m ? m[1] : null
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
// Transcript.tsx (even split indices are prose, odd are code; an unclosed trailing fence swallows
// to end-of-text and lands on an odd index, so a mid-stream buffer inside a fence is left alone).
const CITE_CODE_SPLIT_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/
const CITE_MARKER_RE = /\[S(\d+)\]/g

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

/**
 * Translate a server-origin string for display: exact-match against the known
 * persisted English constants, else pass through unchanged. DOC_TASK_BUSY_MESSAGE is
 * additionally matched as a substring — the chat banner recognizes it via
 * `error.includes` (transport prefixes may survive), so its display mapping must
 * tolerate the same embedding.
 *
 * The persisted-constant branches carry no citation markers; a real model answer (the only text
 * that carries `[S{n}]`) falls through to the final return, where the marker is localized (D68).
 */
export function localizeServerCopy(t: BoundT, raw: string): string {
  const key = KEY_BY_ENGLISH.get(raw)
  if (key) return t(key)
  const ext = unsupportedTypeExt(raw)
  if (ext != null) return t('main.ingest.unsupportedType', { ext })
  const busy = en['main.chat.docTaskBusy']
  if (raw.includes(busy)) return raw.replace(busy, t('main.chat.docTaskBusy'))
  return localizeCitationMarkers(t, raw)
}
