import { vi } from 'vitest'
import type { PreloadApi } from '../../src/preload'
import { appStatus } from './status'

// The Documents screen's mount reads, calm by default (#832). Seven suites mount DocumentsScreen
// (DocumentsScreen, DocumentsScreenPolish, DocumentSummary, DocumentTranslate, DocumentCompare, Coverage,
// DocumentsImportRecovery) and each used to stub only the data its rows assert on, so the reads below
// resolved to `undefined` and the screen took its empty path without anyone noticing.
//
// Rules, as for `chatScreenStubs` (`chat-screen.tsx`):
//  - Install `stubApi(documentsScreenStubs({ … }))`; `over` spreads last, so a row's own stub wins.
//  - A method the screen starts calling at mount must be added here, or every adopter goes red at once
//    (the point: the suites end on `assertNoUnexpectedApiCalls()`).
//  - A method a row reaches only after an action (document preview, coverage, the packs panel, Retry all,
//    the OCR install status) belongs in that row's own stubs.

/**
 * What an idle mounted DocumentsScreen reads: the app status, no projects, no documents, no import job
 * running and no re-index running. Each stub is a `vi.fn` minted per call, so a row can assert on it.
 */
export function documentsScreenStubs(over: Partial<PreloadApi> = {}): Partial<PreloadApi> {
  return {
    getAppStatus: vi.fn<PreloadApi['getAppStatus']>(async () => appStatus()),
    listCollections: vi.fn<PreloadApi['listCollections']>(async () => []),
    listDocuments: vi.fn<PreloadApi['listDocuments']>(async () => []),
    getActiveImportJob: vi.fn<PreloadApi['getActiveImportJob']>(async () => null),
    getReindexAllJob: vi.fn<PreloadApi['getReindexAllJob']>(async () => null),
    ...over
  }
}
