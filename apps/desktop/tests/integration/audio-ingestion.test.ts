import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  documentsDir,
  extractDocumentPreview,
  processDocument,
  reindexDocument,
  summarizeImportPaths,
  ENCRYPTED_DOC_SUFFIX
} from '../../src/main/services/ingestion'
import {
  AUDIO_NEEDS_TRANSCRIBER_MESSAGE
} from '../../src/main/services/ingestion/parsers/audio'
import { encryptFile, decryptFile, type DocumentCipher } from '../../src/main/services/workspace-vault'
import type { Transcriber, TranscriptSegment } from '../../src/main/services/transcriber'

// Phase 36 — audio ingestion end-to-end with a FAKE transcriber behind the
// IngestionDeps injection seam (the embedder precedent): a "recording" becomes a
// normal corpus document; citations get time-range sections (D29); encrypted
// workspaces keep only the .enc on disk; absent transcriber = friendly per-file
// failure through the documents-table error path.

const SECRET_SPEECH = 'vertrauliche Besprechung über das Projekt Einhorn'

const SEGMENTS: TranscriptSegment[] = [
  { startMs: 0, endMs: 4_000, text: `Erstens: ${SECRET_SPEECH}.` },
  { startMs: 4_000, endMs: 9_500, text: 'Zweitens: das Budget steigt um dreizehn Prozent.' },
  { startMs: 9_500, endMs: 70_000, text: 'Drittens: die nächste Sitzung ist im April.' }
]

function fakeTranscriber(
  segments: TranscriptSegment[] = SEGMENTS
): Transcriber & { calls: string[] } {
  const calls: string[] = []
  return {
    id: 'fake-whisper',
    calls,
    transcribe: async (filePath, opts) => {
      calls.push(filePath)
      opts?.onProgress?.(50)
      opts?.onProgress?.(100)
      return segments
    }
  }
}

let srcDir: string
beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), 'hilbertraum-audio-src-'))
})

function writeAudioSource(name = 'meeting.mp3'): string {
  const p = join(srcDir, name)
  // Real bytes are irrelevant — the fake transcriber never decodes them.
  writeFileSync(p, randomBytes(2048))
  return p
}

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-audio-db-')), 'test.sqlite'))
}

function freshStore(): string {
  return documentsDir(mkdtempSync(join(tmpdir(), 'hilbertraum-audio-ws-')))
}

function testCipher(): DocumentCipher {
  const key = randomBytes(32)
  return {
    encryptFile: (src, dest) => encryptFile(src, dest, key),
    decryptFile: (src, dest) => decryptFile(src, dest, key)
  }
}

describe('audio ingestion (Phase 36)', () => {
  it('imports an mp3 into an indexed document with time-range section labels (D29)', async () => {
    const db = freshDb()
    const store = freshStore()
    const t = fakeTranscriber()
    const progress: Array<[string, number]> = []

    const doc = createQueuedDocument(db, writeAudioSource())
    const info = await processDocument(db, store, doc.id, {
      transcriber: t,
      onTranscribeProgress: (id, pct) => progress.push([id, pct])
    })

    expect(info.status).toBe('indexed')
    expect(info.mimeType).toBe('audio/mpeg') // per-extension MIME, not the audio/* fallback
    expect(info.chunkCount).toBeGreaterThan(0)
    expect(t.calls).toHaveLength(1)
    expect(progress).toEqual([
      [doc.id, 50],
      [doc.id, 100]
    ])

    // Chunks carry the transcript with the D29 "mm:ss–mm:ss" labels in section_label —
    // the EXISTING column Citation.section reads from (zero citation-path changes).
    const rows = db
      .prepare('SELECT text, page_number, section_label FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(doc.id) as unknown as Array<{ text: string; page_number: number | null; section_label: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].text).toContain(SECRET_SPEECH)
    expect(rows[0].page_number).toBeNull() // page-less → the txt/md chunk-dedup rule
    expect(rows[0].section_label).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/)
  })

  it('fails the FILE friendly when no transcriber is available — never a throw', async () => {
    const db = freshDb()
    const store = freshStore()
    const doc = createQueuedDocument(db, writeAudioSource())

    const info = await processDocument(db, store, doc.id, {}) // no transcriber injected

    expect(info.status).toBe('failed')
    expect(info.errorMessage).toBe(AUDIO_NEEDS_TRANSCRIBER_MESSAGE)
    // A text import in the same run is untouched (graceful-fallback rule).
    const txt = join(srcDir, 'note.txt')
    writeFileSync(txt, 'plain text still works')
    const txtDoc = createQueuedDocument(db, txt)
    const txtInfo = await processDocument(db, store, txtDoc.id, {})
    expect(txtInfo.status).toBe('indexed')
  })

  it('previews the transcript from STORED CHUNKS — no re-transcription', async () => {
    const db = freshDb()
    const store = freshStore()
    const t = fakeTranscriber()
    const doc = createQueuedDocument(db, writeAudioSource())
    await processDocument(db, store, doc.id, { transcriber: t })
    expect(t.calls).toHaveLength(1)

    const preview = await extractDocumentPreview(db, store, doc.id, {})
    expect(preview.segments.map((s) => s.text).join('\n')).toContain(SECRET_SPEECH)
    expect(preview.segments[0].sectionLabel).toMatch(/–/)
    // The load-bearing assertion: preview did NOT call the transcriber again.
    expect(t.calls).toHaveLength(1)
  })

  it('preview of a failed (chunkless) audio document fails friendly', async () => {
    const db = freshDb()
    const store = freshStore()
    const doc = createQueuedDocument(db, writeAudioSource())
    await processDocument(db, store, doc.id, {}) // failed: no transcriber
    await expect(extractDocumentPreview(db, store, doc.id, {})).rejects.toThrow(/Re-index/)
  })

  it('re-index IS a full re-transcription of the stored copy (D35)', async () => {
    const db = freshDb()
    const store = freshStore()
    const t = fakeTranscriber()
    const source = writeAudioSource()
    const doc = createQueuedDocument(db, source)
    await processDocument(db, store, doc.id, { transcriber: t })
    rmSync(source) // self-contained: re-index must come from the stored copy

    const info = await reindexDocument(db, store, doc.id, { transcriber: t })
    expect(info.status).toBe('indexed')
    expect(t.calls).toHaveLength(2)
    // The second call parsed the STORED copy, not the (deleted) original.
    expect(t.calls[1].startsWith(store)).toBe(true)
  })

  it('encrypted workspace: only the .enc rests on disk; transcriber reads a .parse transient', async () => {
    const db = freshDb()
    const store = freshStore()
    const cipher = testCipher()
    const t = fakeTranscriber()
    const source = writeAudioSource()

    const doc = createQueuedDocument(db, source)
    const info = await processDocument(db, store, doc.id, { cipher, transcriber: t })
    expect(info.status).toBe('indexed')

    // The stored copy is the .enc artifact; nothing else remains in the store.
    const stored = readdirSync(store)
    expect(stored).toHaveLength(1)
    expect(stored[0].endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)

    // Re-index with the original gone: decrypts to the `.parse<ext>` transient, hands
    // THAT to the transcriber, and shreds it after (the existing pattern, D35).
    rmSync(source)
    const reinfo = await reindexDocument(db, store, doc.id, { cipher, transcriber: t })
    expect(reinfo.status).toBe('indexed')
    expect(t.calls[1]).toContain('.parse')
    const after = readdirSync(store)
    expect(after).toHaveLength(1)
    expect(after[0].endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)
    // No file in the store leaks the audio "content" marker text.
    for (const name of after) {
      expect(readFileSync(join(store, name)).includes(Buffer.from(SECRET_SPEECH))).toBe(false)
    }
  })

  it('aborting an import kills the in-flight transcription — task ends failed, signal threaded (REL-1)', async () => {
    const db = freshDb()
    const store = freshStore()
    const controller = new AbortController()
    let sawSignal: AbortSignal | undefined
    let started: () => void = () => undefined
    const reached = new Promise<void>((r) => {
      started = r
    })
    // A transcriber that blocks until its signal aborts, then rejects — mimics a real
    // whisper child killed by the abort listener. It records the signal it was handed so
    // the test can prove the signal was threaded all the way from `deps.signal`.
    const t: Transcriber = {
      id: 'blocking',
      transcribe: (_file, opts) => {
        sawSignal = opts.signal
        started()
        return new Promise<never>((_resolve, reject) => {
          opts.signal?.addEventListener(
            'abort',
            () => reject(new Error('Transcription was cancelled.')),
            { once: true }
          )
        })
      }
    }

    const doc = createQueuedDocument(db, writeAudioSource())
    const p = processDocument(db, store, doc.id, { transcriber: t, signal: controller.signal })
    await reached // transcribe() is now in flight
    controller.abort()
    const info = await p

    // The cancelled transcription surfaces as a friendly per-file failure on the row.
    expect(info.status).toBe('failed')
    // The load-bearing assertion: the signal reached `transcribe` (was threaded
    // deps.signal → ParseContext.signal → AudioParser → transcribe) and is aborted.
    expect(sawSignal).toBe(controller.signal)
    expect(sawSignal?.aborted).toBe(true)
    // No transient transcript (.parse-transcript) stranded — only the legitimate stored
    // copy persists for a later re-index.
    expect(readdirSync(store).some((n) => n.includes('.parse-transcript'))).toBe(false)
  })

  it('summarizeImportPaths counts audio files + bytes for the D35 size confirm', () => {
    const audio = writeAudioSource('big.wav')
    const txt = join(srcDir, 'note.txt')
    writeFileSync(txt, 'text')
    const pre = summarizeImportPaths([audio, txt])
    expect(pre.fileCount).toBe(2)
    expect(pre.audioFileCount).toBe(1)
    expect(pre.audioBytes).toBe(2048)
    // Unsupported/missing paths do not blow up the preflight.
    expect(summarizeImportPaths([join(srcDir, 'missing.mp3')])).toEqual({
      fileCount: 0,
      audioFileCount: 0,
      audioBytes: 0
    })
  })
})
