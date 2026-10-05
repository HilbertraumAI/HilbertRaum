import { describe, expect, it } from 'vitest'
import { t } from '../../src/shared/i18n'
import type { MessageParams } from '../../src/shared/i18n'
import type { DocumentOcrInfo } from '../../src/shared/types'
import { ocrUnsureLine } from '../../src/renderer/screens/documents/ocrNotes'

// #538 — the "unsure" sentence names the right scope. ocrNotes.ts is the one wording owner shared
// by the row caption and the preview (design-guidelines §11.19); the DocumentsScreen tests cover
// the wiring, this table the sentence choice.

const en = (key: Parameters<typeof t>[1], params?: MessageParams): string => t('en', key, params)

function ocr(pageCount: number, textPageCount: number, lowConfidencePageCount: number): DocumentOcrInfo {
  return { pageCount, textPageCount, lowConfidencePageCount, languages: ['deu'], engineId: 'e', createdAt: '' }
}

describe('ocrUnsureLine (#538)', () => {
  it.each([
    ['a one-page scan', ocr(1, 1, 1), {}, en('docs.ocr.unsure.page')],
    // review L4: a multi-page document with one recognized page must not read "this page"
    ['a 5-page scan with one page of text', ocr(5, 1, 1), {}, en('docs.ocr.unsure.onlyRecognized')],
    ['one scanned page read in a 12-page text PDF', ocr(1, 1, 1), { documentPages: 12 }, en('docs.ocr.unsure.onlyRecognized')],
    ['some of several pages', ocr(4, 3, 1), {}, en('docs.ocr.unsure.some', { count: 1, total: 3 })],
    ['every recognized page', ocr(3, 3, 3), {}, en('docs.ocr.unsure.all', { count: 3 })],
    ['a photo', ocr(1, 1, 1), { photo: true }, en('docs.ocr.unsure.photo')],
    ['nothing unsure', ocr(3, 3, 0), {}, null]
  ] as const)('%s', (_what, info, opts, expected) => {
    expect(ocrUnsureLine(info, en, opts)).toBe(expected)
  })
})
