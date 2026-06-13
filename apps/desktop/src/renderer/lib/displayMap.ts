import { en, type MessageKey, type MessageParams } from '@shared/i18n'

// The D-L4 display map (i18n record §3.3 rule 1): persisted main-process strings
// are stored as canonical ENGLISH (documents.error_message, the fixed RAG answers in
// messages.content, benchmark warnings in settings.lastBenchmark) so the data
// contracts — most importantly the `scanDetected` exact-match — never move. The
// renderer translates them at display time via this exact-match reverse lookup from
// the known English constants to their MessageKeys. Unknown strings (raw library
// errors, interpolated copy like "Unsupported file type: …") render as-is.
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

/**
 * Translate a server-origin string for display: exact-match against the known
 * persisted English constants, else pass through unchanged. DOC_TASK_BUSY_MESSAGE is
 * additionally matched as a substring — the chat banner recognizes it via
 * `error.includes` (transport prefixes may survive), so its display mapping must
 * tolerate the same embedding.
 */
export function localizeServerCopy(t: BoundT, raw: string): string {
  const key = KEY_BY_ENGLISH.get(raw)
  if (key) return t(key)
  const busy = en['main.chat.docTaskBusy']
  if (raw.includes(busy)) return raw.replace(busy, t('main.chat.docTaskBusy'))
  return raw
}
