import { describe, it, expect } from 'vitest'
import {
  badgeFor,
  formatSize,
  friendlyMimeLabel,
  isRetryableFailure,
  metaLine
} from '../../src/renderer/screens/documents/format'
import { t as translate, tCount } from '../../src/shared/i18n'
import { makeDocumentInfo } from '../helpers/chat-fixtures'

/** `s` with each U+00A0 spelled out, so a row compares code points and a failure shows which space. */
const NBSP = String.fromCharCode(0xa0)
const shown = (s: string): string => s.split(NBSP).join('<nbsp>')

// The Documents screen's pure formatters (screens/documents/format.tsx, DX-3 split). Moved here from the
// renderer suites (DocumentsScreen / DocumentsScreenPolish) so the screens test what the user sees.

describe('isRetryableFailure', () => {
  it('isRetryableFailure: intrinsic failures are not retryable, transient ones are', () => {
    // Unsupported type (current + legacy wording) and size-cap failures are intrinsic → no retry.
    expect(isRetryableFailure(translate('en', 'main.ingest.unsupportedType', { ext: '.xyz' }))).toBe(false)
    expect(isRetryableFailure('Unsupported file type: .heic')).toBe(false)
    expect(isRetryableFailure(translate('en', 'main.ingest.fileTooLarge'))).toBe(false)
    expect(isRetryableFailure(translate('en', 'main.ingest.tooManyChunks'))).toBe(false)
    // #572: a detected scan fails the same way until OCR runs; a photo that needed the OCR files
    // DOES read after their download, so it stays retryable.
    expect(isRetryableFailure(translate('en', 'main.ingest.pdfScanDetected'))).toBe(false)
    expect(isRetryableFailure(translate('en', 'main.ingest.imageNeedsOcr'))).toBe(true)
    // A read/parse error or an unknown cause → retryable.
    expect(isRetryableFailure('EIO: i/o error, read')).toBe(true)
    expect(isRetryableFailure(null)).toBe(true)
  })
})

describe('friendlyMimeLabel', () => {
  it('friendlyMimeLabel maps known MIME types to friendly labels', () => {
    expect(friendlyMimeLabel('application/pdf', 'en')).toBe('PDF')
    expect(friendlyMimeLabel('text/markdown', 'en')).toBe('Markdown')
    expect(friendlyMimeLabel('text/csv', 'en')).toBe('CSV')
    expect(friendlyMimeLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'en')).toBe('Word')
    expect(friendlyMimeLabel('audio/mpeg', 'en')).toBe('MP3')
    expect(friendlyMimeLabel('image/png', 'en')).toBe('PNG')
    expect(friendlyMimeLabel('audio/aac', 'en')).toBe('Audio')
    expect(friendlyMimeLabel('application/zip', 'en')).toBe('ZIP')
    expect(friendlyMimeLabel(null, 'en')).toBe('—')
  })

  // A .txt row once read "Text · 158 B · 1 раздел" in every new language. The generic kinds
  // are words, so they follow the UI language; format names (PDF, MP3, the upper-cased subtype)
  // and the dash do not. One row per registered language: plain text, then the audio / image /
  // text fallbacks for a type that has no format name.
  it.each([
    ['en', 'Text', 'Audio', 'Image'],
    ['de', 'Text', 'Audio', 'Bild'],
    ['es', 'Texto', 'Audio', 'Imagen'],
    ['fr', 'Texte', 'Audio', 'Image'],
    ['it', 'Testo', 'Audio', 'Immagine'],
    ['ru', 'Текст', 'Аудио', 'Изображение']
  ] as const)('%s names the generic file kinds in its own language', (lang, text, audio, image) => {
    expect(friendlyMimeLabel('text/plain', lang)).toBe(text)
    expect(friendlyMimeLabel('text/html', lang)).toBe(text)
    expect(friendlyMimeLabel('audio/aac', lang)).toBe(audio)
    expect(friendlyMimeLabel('image/webp', lang)).toBe(image)
    expect(friendlyMimeLabel('application/pdf', lang)).toBe('PDF')
    expect(friendlyMimeLabel('application/zip', lang)).toBe('ZIP')
    expect(friendlyMimeLabel(null, lang)).toBe('—')
  })

  it('metaLine leads with the file kind in the row language', () => {
    const doc = makeDocumentInfo({ mimeType: 'text/plain', sizeBytes: 158, chunkCount: 1 })
    // The size's unit after U+00A0, as the Spanish catalog writes it (#804).
    expect(shown(metaLine(doc, 'es', (key, count) => tCount('es', key, count)))).toBe(
      'Texto · 158<nbsp>B · 1 sección'
    )
  })
})

describe('formatSize — decimal units (#768) and the DR-9 GB tier', () => {
  // Decimal like every disk size in the app: in 1024 steps these would read 2.0 KB, 4.1 MB, 2.3 GB, 1,4 GB.
  // Without the GB tier the last two would read "2500.0 MB" / "1500,0 MB" (DR-9).
  it.each([
    [512, 'en', '512 B'],
    [2_048, 'en', '2.0 KB'],
    [4_285_975, 'en', '4.3 MB'],
    [2_500_000_000, 'en', '2.5 GB'],
    [1_500_000_000, 'de', '1,5 GB'],
    // A size that rounds to the next unit reads in it, never "1000.0 KB" / "1000.0 MB".
    [999_960, 'en', '1.0 MB'],
    [999_960_000, 'en', '1.0 GB']
  ] as const)('%d bytes read %s as %s', (bytes, lang, shown) => {
    expect(formatSize(bytes, lang)).toBe(shown)
  })
})

describe('badgeFor — the transcribing percent in the language’s own pattern (#804)', () => {
  // English keeps "Transcribing… 42%" (DocumentsScreen.test.tsx). German writes a space before the
  // sign, French U+00A0, Turkish the sign first, as each catalog's `common.percent` does.
  it.each([
    ['de', '15 %'],
    ['fr', '15<nbsp>%'],
    ['tr', '%15']
  ] as const)('%s reads %s', (lang, percent) => {
    const doc = makeDocumentInfo({ mimeType: 'audio/mpeg', status: 'extracting', transcriptionProgress: 15 })
    const { label } = badgeFor(doc, (key, params) => translate(lang, key, params))
    expect(shown(label)).toBe(`${translate(lang, 'docs.status.transcribing')} ${percent}`)
  })
})
