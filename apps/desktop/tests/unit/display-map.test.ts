import { describe, it, expect } from 'vitest'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import { DISPLAY_MAP_KEYS, localizeServerCopy } from '../../src/renderer/lib/displayMap'
import { NO_DOCUMENT_CONTEXT_ANSWER, REINDEX_NEEDED_ANSWER } from '../../src/main/services/rag'
import { DOC_TASK_BUSY_MESSAGE } from '../../src/shared/types'

// Phase 41 — the D-L4 display map: persisted main-process strings are canonical
// English in the DB; the renderer translates the KNOWN finite set at display time by
// exact match. Unknown strings (raw library errors, interpolated copy) pass through.

const tDe = (key: MessageKey, params?: MessageParams): string => t('de', key, params)
const tEn = (key: MessageKey, params?: MessageParams): string => t('en', key, params)

describe('localizeServerCopy (D-L4)', () => {
  it('translates a known persisted constant to German', () => {
    expect(localizeServerCopy(tDe, NO_DOCUMENT_CONTEXT_ANSWER)).toBe(t('de', 'main.rag.noContext'))
    expect(localizeServerCopy(tDe, REINDEX_NEEDED_ANSWER)).toBe(t('de', 'main.rag.reindexNeeded'))
  })

  it('matches an old pre-i18n row byte-for-byte (the re-typed literal, not the catalog)', () => {
    // The exact string Phase-4-era ingestion persisted — typed out, NOT derived from
    // the catalog. If an en.ts edit ever moves the value, this stops matching and
    // fails loudly (the catalog comment declares the set part of the data contract).
    const preI18nRow = 'This PDF looks like a scan — it has no readable text yet.'
    expect(localizeServerCopy(tDe, preI18nRow)).toBe(t('de', 'main.ingest.pdfScanDetected'))
  })

  it('renders unknown strings as-is', () => {
    const raw = 'SQLITE_IOERR: disk I/O error'
    expect(localizeServerCopy(tDe, raw)).toBe(raw)
    const interpolated = 'Unsupported file type: .xyz'
    expect(localizeServerCopy(tDe, interpolated)).toBe(interpolated)
  })

  it('is the identity in an English UI', () => {
    expect(localizeServerCopy(tEn, NO_DOCUMENT_CONTEXT_ANSWER)).toBe(NO_DOCUMENT_CONTEXT_ANSWER)
    expect(localizeServerCopy(tEn, 'anything else')).toBe('anything else')
  })

  it('localizes DOC_TASK_BUSY_MESSAGE even when embedded in transport prose (the includes contract)', () => {
    expect(localizeServerCopy(tDe, DOC_TASK_BUSY_MESSAGE)).toBe(t('de', 'main.chat.docTaskBusy'))
    const wrapped = `Error: ${DOC_TASK_BUSY_MESSAGE}`
    expect(localizeServerCopy(tDe, wrapped)).toBe(`Error: ${t('de', 'main.chat.docTaskBusy')}`)
  })

  it('translates the persisted benchmark warnings', () => {
    const warning =
      'This drive is on the slower side. Models will still work, but loading them may take longer.'
    expect(localizeServerCopy(tDe, warning)).toBe(t('de', 'main.benchmark.warnSlowDrive'))
  })

  it('translates the persisted default conversation title; real user titles pass through', () => {
    expect(localizeServerCopy(tDe, 'New chat')).toBe(t('de', 'main.chat.defaultTitle'))
    expect(localizeServerCopy(tDe, 'Summarize this contract please')).toBe(
      'Summarize this contract please'
    )
  })

  it('covers exactly the en.ts persist-canonical section (catalog hygiene, Phase 42)', () => {
    // This list mirrors the PERSIST-CANONICAL section of en.ts (the data-contract
    // comment there). A new persisted constant must land in BOTH places — here and in
    // DISPLAY_MAP_KEYS — or this fails loudly.
    const persistCanonical: MessageKey[] = [
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
    expect([...DISPLAY_MAP_KEYS].sort()).toEqual(persistCanonical.sort())
    // Every mapped English value must round-trip to its German catalog value.
    for (const key of persistCanonical) {
      expect(localizeServerCopy(tDe, t('en', key)), key).toBe(t('de', key))
    }
  })
})
