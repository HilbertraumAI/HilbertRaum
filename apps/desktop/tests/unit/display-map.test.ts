import { describe, it, expect } from 'vitest'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import {
  DISPLAY_MAP_KEYS,
  INTERPOLATED_MAP_KEYS,
  formatCitationLabel,
  localizeServerCopy,
  unsupportedTypeExt
} from '../../src/renderer/lib/displayMap'
import {
  GROUNDED_SYSTEM_PROMPT,
  NO_DOCUMENT_CONTEXT_ANSWER,
  REINDEX_NEEDED_ANSWER
} from '../../src/main/services/rag'
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
  })

  it('localizes the interpolated unsupported-file-type failure, keeping the extension', () => {
    // The current persist-canonical English (interpolated) round-trips to German with {ext}.
    const persisted = tEn('main.ingest.unsupportedType', { ext: '.xyz' })
    const localized = localizeServerCopy(tDe, persisted)
    expect(localized).toBe(tDe('main.ingest.unsupportedType', { ext: '.xyz' }))
    expect(localized).toContain('.xyz')
    expect(localized).not.toBe(persisted) // genuinely translated, not passed through
    // English UI re-renders the same friendly English (identity round-trip).
    expect(localizeServerCopy(tEn, persisted)).toBe(persisted)
  })

  it('localizes an OLD pre-i18n unsupported-type row (legacy literal), keeping the extension', () => {
    const legacy = 'Unsupported file type: .heic'
    expect(localizeServerCopy(tDe, legacy)).toBe(tDe('main.ingest.unsupportedType', { ext: '.heic' }))
    expect(unsupportedTypeExt(legacy)).toBe('.heic')
  })

  it('unsupportedTypeExt returns null for an unrelated failure', () => {
    expect(unsupportedTypeExt('SQLITE_IOERR: disk I/O error')).toBeNull()
    expect(unsupportedTypeExt(tEn('main.ingest.fileTooLarge'))).toBeNull()
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
      // EP-1 Phase 1: the fallback review title (evidence_reviews.title when a
      // conversation title trims empty) — persist-canonical English, like defaultTitle.
      'main.evidenceReviews.defaultTitle',
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

  // ---- Citation markers (#28 / beta-feedback plan Phase 1, D68) ----
  // The inline `[S{n}]` marker is a machine contract (baked into the prompt, persisted in
  // citations_json). It is relabelled at DISPLAY time only: DE shows [Q{n}] ("Quelle"), EN keeps
  // [S{n}] byte-identically. A literal marker inside code stays verbatim (mirrors the math guard).

  it('rewrites inline [S{n}] body markers to [Q{n}] in a German UI', () => {
    expect(localizeServerCopy(tDe, 'See [S1] and [S2] for the clause.')).toBe(
      'See [Q1] and [Q2] for the clause.'
    )
  })

  it('leaves inline citation markers byte-identical in an English UI', () => {
    const raw = 'See [S1] and [S2] for the clause.'
    expect(localizeServerCopy(tEn, raw)).toBe(raw)
  })

  it('keeps a literal [S1] inside an inline code span verbatim in a German UI', () => {
    // The code span is not prose — its `[S1]` is a literal, not a citation, so it must not move.
    const raw = 'Prose cites [S1], but the token `[S1]` in code stays literal.'
    expect(localizeServerCopy(tDe, raw)).toBe(
      'Prose cites [Q1], but the token `[S1]` in code stays literal.'
    )
  })

  it('keeps a literal [S1] inside a fenced code block verbatim in a German UI', () => {
    const raw = 'Real cite [S2].\n```\nlog[S1] = value\n```\nAfter [S3].'
    expect(localizeServerCopy(tDe, raw)).toBe('Real cite [Q2].\n```\nlog[S1] = value\n```\nAfter [Q3].')
  })

  it('does not touch bracketed prose that is not an S-marker (needs digits)', () => {
    expect(localizeServerCopy(tDe, 'The [START] tag and [Section] head.')).toBe(
      'The [START] tag and [Section] head.'
    )
  })

  it('formatCitationLabel maps the stored S{n} label per language; identity in EN', () => {
    expect(formatCitationLabel(tDe, 'S1')).toBe('Q1')
    expect(formatCitationLabel(tDe, 'S12')).toBe('Q12')
    expect(formatCitationLabel(tEn, 'S1')).toBe('S1')
    // A non-standard label passes through unchanged (defensive).
    expect(formatCitationLabel(tDe, 'weird')).toBe('weird')
  })

  it('D68 machine contract: the grounded system prompt still instructs the model to emit [S1]', () => {
    // The display rename must NOT leak into the prompt — the model still emits the S-marker, and
    // the renderer relabels it. This pins that GROUNDING_RULES is untouched by Phase 1.
    expect(GROUNDED_SYSTEM_PROMPT).toContain('[S1]')
    expect(GROUNDED_SYSTEM_PROMPT).not.toContain('[Q1]')
  })

  it('covers the interpolated persist-canonical set (handled by regex, not exact match)', () => {
    // Interpolated messages carry a value in the persisted string, so they live in
    // INTERPOLATED_MAP_KEYS (reverse-matched by a template regex) rather than DISPLAY_MAP_KEYS.
    // A new interpolated constant must land here with its params — or this fails loudly.
    const params: Partial<Record<MessageKey, MessageParams>> = {
      'main.ingest.unsupportedType': { ext: '.xyz' },
      'main.benchmark.warnVeryLowTokens': { model: 'qwen3-30b-a3b-q4' }
    }
    expect([...INTERPOLATED_MAP_KEYS].sort()).toEqual(Object.keys(params).sort())
    for (const key of INTERPOLATED_MAP_KEYS) {
      const persisted = t('en', key, params[key])
      // German UI: genuinely translated with the param carried over.
      expect(localizeServerCopy(tDe, persisted), key).toBe(t('de', key, params[key]))
      // English UI: identity round-trip.
      expect(localizeServerCopy(tEn, persisted), key).toBe(persisted)
    }
  })

  it('keeps the measured-model id verbatim inside the localized very-low-tokens warning (issue #52)', () => {
    const persisted = tEn('main.benchmark.warnVeryLowTokens', { model: 'qwen3.5-4b-ud-q4kxl' })
    const localized = localizeServerCopy(tDe, persisted)
    expect(localized).toBe(tDe('main.benchmark.warnVeryLowTokens', { model: 'qwen3.5-4b-ud-q4kxl' }))
    expect(localized).toContain('qwen3.5-4b-ud-q4kxl')
    expect(localized).not.toBe(persisted)
  })
})
