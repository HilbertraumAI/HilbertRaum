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
