import { describe, it, expect } from 'vitest'
import {
  badgeFor,
  formatSize,
  friendlyMimeLabel,
  isRetryableFailure,
  metaLine,
  rowChips
} from '../../src/renderer/screens/documents/format'
import { t as translate, tCount } from '../../src/shared/i18n'
import { makeDocumentInfo } from '../helpers/chat-fixtures'
import { nameCompare } from '../../src/renderer/lib/collation'
import { ocrRemedyKind } from '../../src/renderer/lib/ocrRemedy'
import { PROJECT_ORDER_CASES, inLanguageOrder } from '../helpers/project-order-fixtures'

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

  // T2.12 (F-26, D-7): a newer version may store the failure as the code `hr:<key>`. The offer goes by the key, so a
  // coded intrinsic failure is not offered either; one this version cannot read is, since a re-index here writes a
  // message this version can show.
  it.each([
    ['hr:main.ingest.unsupportedType?ext=.xyz', false],
    ['hr:main.ingest.fileTooLarge', false],
    ['hr:main.ingest.tooManyChunks', false],
    ['hr:main.ingest.pdfScanDetected', false],
    ['hr:main.ingest.imageNeedsOcr', true],
    // A key this version does not know.
    ['hr:main.ingest.someFutureFailure', true]
  ] as const)('a failure stored as %s: retry offered %s', (raw, offered) => {
    expect(isRetryableFailure(raw)).toBe(offered)
  })
})

// #410 + T2.12 (F-26): the photo row's in-app OCR remedy goes by the stored message's key, so a newer version's coded
// form gets it too; a code this version cannot read gets none.
describe('ocrRemedyKind reads a coded photo failure by its key', () => {
  it.each([
    ['hr:main.ingest.imageNeedsOcr', 'photo'],
    ['hr:main.ingest.someFutureFailure', null]
  ] as const)('%s → %s', (errorMessage, kind) => {
    expect(ocrRemedyKind({ status: 'failed', scanDetected: false, errorMessage })).toBe(kind)
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
  // English keeps "Transcribing… 42%" (DocumentsScreen.test.tsx). German and French write U+00A0
  // before the sign, Turkish the sign first, as each catalog's `common.percent` does.
  it.each([
    ['de', '15<nbsp>%'],
    ['fr', '15<nbsp>%'],
    ['tr', '%15']
  ] as const)('%s reads %s', (lang, percent) => {
    const doc = makeDocumentInfo({ mimeType: 'audio/mpeg', status: 'extracting', transcriptionProgress: 15 })
    const { label } = badgeFor(doc, (key, params) => translate(lang, key, params))
    expect(shown(label)).toBe(`${translate(lang, 'docs.status.transcribing')} ${percent}`)
  })
})

// #828: a row's project chips come in the language's name order, built-ins first; main's join returns the
// order the document was added to each project.
describe.each(PROJECT_ORDER_CASES)('rowChips project order (%s)', (lang, sqlOrder) => {
  const member = (id: string, name: string, type: 'project' | 'library' | 'temporary') => ({
    id,
    name,
    type,
    role: 'source' as const
  })

  it('puts the built-ins first, then the projects in the language order', () => {
    const d = makeDocumentInfo({
      collections: [
        ...sqlOrder.map((n, i) => member(`p${i}`, n, 'project')),
        member('lib', 'Library', 'library')
      ]
    })
    const chips = rowChips(d, (key, params) => translate(lang, key, params), nameCompare(lang))
    expect(chips).toEqual([translate(lang, 'docs.chip.library'), ...inLanguageOrder(lang, sqlOrder)])
    expect(inLanguageOrder(lang, sqlOrder)).not.toEqual(sqlOrder)
  })

  it('does not follow the order the document was added to the projects', () => {
    const reversed = [...sqlOrder].reverse()
    const d = makeDocumentInfo({ collections: reversed.map((n, i) => member(`p${i}`, n, 'project')) })
    const chips = rowChips(d, (key, params) => translate(lang, key, params), nameCompare(lang))
    expect(chips).toEqual(inLanguageOrder(lang, sqlOrder))
  })
})
