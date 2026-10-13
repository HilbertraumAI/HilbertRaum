import { describe, it, expect } from 'vitest'
import { formatSize, friendlyMimeLabel, isRetryableFailure } from '../../src/renderer/screens/documents/format'
import { t as translate } from '../../src/shared/i18n'

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
    expect(friendlyMimeLabel('application/pdf')).toBe('PDF')
    expect(friendlyMimeLabel('text/markdown')).toBe('Markdown')
    expect(friendlyMimeLabel('text/csv')).toBe('CSV')
    expect(friendlyMimeLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('Word')
    expect(friendlyMimeLabel('audio/mpeg')).toBe('MP3')
    expect(friendlyMimeLabel('image/png')).toBe('PNG')
    expect(friendlyMimeLabel('audio/aac')).toBe('Audio')
    expect(friendlyMimeLabel('application/zip')).toBe('ZIP')
    expect(friendlyMimeLabel(null)).toBe('—')
  })
})

describe('formatSize — DR-9 GB tier', () => {
  it('formats GB-scale sizes with the locale decimal', () => {
    // TEETH: without the GB tier these return "2048.0 MB" / "1536,0 MB".
    expect(formatSize(2 * 1024 ** 3, 'en')).toBe('2.0 GB')
    expect(formatSize(1.5 * 1024 ** 3, 'de')).toBe('1,5 GB')
    // The lower tiers are unchanged.
    expect(formatSize(2048, 'en')).toBe('2.0 KB')
    expect(formatSize(5 * 1024 * 1024, 'en')).toBe('5.0 MB')
  })
})
