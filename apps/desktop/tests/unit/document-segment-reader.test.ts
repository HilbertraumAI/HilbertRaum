import { describe, it, expect, vi, beforeEach } from 'vitest'

// The shared segment reader (`documentSegments.ts`) both skill entry points use — the chat analysis
// IPC (`registerRagIpc`) and the run-bar "Extract transactions" button (`registerSkillsIpc`). This
// pins the exact regression that made the two disagree: the button's reader once DROPPED the `layout`
// flag, so it re-read a columnar bank statement in plain reading order (fewer, scrambled rows) while
// the chat answer used geometry-aware layout reconstruction. The single factory must thread `layout`
// (with the page cap) when — and only when — asked.

const calls = vi.hoisted(() => ({ preview: [] as unknown[][] }))

vi.mock('../../src/main/services/ingestion', () => ({
  documentsDir: (workspacePath: string) => `${workspacePath}/store`,
  extractDocumentPreview: async (...args: unknown[]) => {
    calls.preview.push(args)
    return { segments: [{ text: 'row one', pageNumber: 3 }] }
  }
}))
vi.mock('../../src/main/services/ingestion/limits', () => ({
  resolveIngestionLimits: () => ({ pdfMaxPages: 42 })
}))

import { buildDocumentSegmentReader } from '../../src/main/ipc/documentSegments'
import type { AppContext } from '../../src/main/services/context'

const ctx = {
  db: { marker: 'db' },
  paths: { workspacePath: '/ws' },
  workspace: { documentCipher: () => 'cipher' },
  ocrEngine: 'ocr'
} as unknown as AppContext

// The ExtractPreviewOptions is the 5th positional arg to extractDocumentPreview.
const optsOf = (call: unknown[]): unknown => call[4]

beforeEach(() => {
  calls.preview.length = 0
})

describe('buildDocumentSegmentReader', () => {
  it('requests layout reconstruction + the page cap ONLY when layout is asked for', async () => {
    const read = buildDocumentSegmentReader(ctx)
    await read('doc-layout', { layout: true })
    await read('doc-plain') // no opts → reading-order text
    await read('doc-explicit-false', { layout: false })
    expect(optsOf(calls.preview[0])).toEqual({ layout: true, maxPages: 42 })
    expect(optsOf(calls.preview[1])).toEqual({})
    expect(optsOf(calls.preview[2])).toEqual({})
  })

  it('passes the resolved store dir, db, cipher and OCR engine through', async () => {
    const read = buildDocumentSegmentReader(ctx)
    await read('doc-1', { layout: true })
    const [db, storeDir, documentId, deps] = calls.preview[0]
    expect(db).toBe(ctx.db)
    expect(storeDir).toBe('/ws/store')
    expect(documentId).toBe('doc-1')
    expect(deps).toEqual({ cipher: 'cipher', ocrEngine: 'ocr' })
  })

  it('maps preview segments to DocumentChunkRead (text/page/index)', async () => {
    const read = buildDocumentSegmentReader(ctx)
    const segments = await read('doc-1', { layout: true })
    expect(segments).toEqual([{ text: 'row one', page: 3, index: 0 }])
  })
})
