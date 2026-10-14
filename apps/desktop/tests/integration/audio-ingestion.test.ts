import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  createQueuedDocument,
  extractDocumentPreview,
  processDocument,
  reindexDocument,
  summarizeImportPaths,
  ENCRYPTED_DOC_SUFFIX
} from '../../src/main/services/ingestion'
import { createPlaintextOps } from '../../src/main/services/ingestion/plaintext-ops'
import type { Transcriber, TranscriptSegment } from '../../src/main/services/transcriber'
import { t } from '../../src/shared/i18n'
import { docTaskWorld, type DocTaskWorld } from '../helpers/doctask-fixtures'
import { until, within } from '../helpers/hang-budget'
import { testCipher } from '../helpers/test-cipher'

// Phase 36 — audio ingestion end-to-end with a FAKE transcriber behind the
// IngestionDeps injection seam (the embedder precedent): a "recording" becomes a
// normal corpus document; citations get time-range sections (D29); encrypted
// workspaces keep only the .enc on disk; absent transcriber = a friendly per-file
// failure naming the missing piece (#527) through the documents-table error path.

const SECRET_SPEECH = 'vertrauliche Besprechung über das Projekt Einhorn'

const SEGMENTS: TranscriptSegment[] = [
  { startMs: 0, endMs: 4_000, text: `Erstens: ${SECRET_SPEECH}.` },
  { startMs: 4_000, endMs: 9_500, text: 'Zweitens: das Budget steigt um dreizehn Prozent.' },
  { startMs: 9_500, endMs: 70_000, text: 'Drittens: die nächste Sitzung ist im April.' }
]

function fakeTranscriber(
  segments: TranscriptSegment[] = SEGMENTS
): Transcriber & { calls: string[]; inputs: Buffer[]; workDirs: string[] } {
  const calls: string[] = []
  const inputs: Buffer[] = []
  const workDirs: string[] = []
  return {
    id: 'fake-whisper',
    calls,
    inputs,
    workDirs,
    transcribe: async (filePath, opts) => {
      calls.push(filePath)
      // whisper-cli decodes the file it is handed; a pipeline that skipped decryption would hand it ciphertext.
      inputs.push(readFileSync(filePath))
      workDirs.push(opts.workDir)
      opts?.onProgress?.(50)
      opts?.onProgress?.(100)
      return segments
    }
  }
}

function writeAudioSource(w: DocTaskWorld, name = 'meeting.mp3'): string {
  const p = join(w.root, name)
  // Real bytes are irrelevant — the fake transcriber never decodes them.
  writeFileSync(p, randomBytes(2048))
  return p
}

describe('audio ingestion (Phase 36)', () => {
  it('imports an mp3 into an indexed document with time-range section labels (D29)', async () => {
    const w = docTaskWorld('audio')
    const t = fakeTranscriber()
    const progress: Array<[string, number]> = []

    const doc = createQueuedDocument(w.db, writeAudioSource(w))
    const info = await processDocument(w.db, w.storeDir, doc.id, {
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
    const rows = w.db
      .prepare('SELECT text, page_number, section_label FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(doc.id) as unknown as Array<{ text: string; page_number: number | null; section_label: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].text).toContain(SECRET_SPEECH)
    expect(rows[0].page_number).toBeNull() // page-less → the txt/md chunk-dedup rule
    expect(rows[0].section_label).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/)
  })

  it('fails the FILE friendly, naming the missing piece (#527), when no transcriber is available — never a throw', async () => {
    const w = docTaskWorld('audio')
    const doc = createQueuedDocument(w.db, writeAudioSource(w))
    const info = await processDocument(w.db, w.storeDir, doc.id, { transcriberMissing: 'engine' }) // no transcriber injected
    expect(info.status).toBe('failed')
    // processDocument threads deps.transcriberMissing into the ParseContext: the row names the ENGINE, not the model.
    expect(info.errorMessage).toBe(t('en', 'main.ingest.audioNeedsEngine'))
  })

  it('previews the transcript from STORED CHUNKS — no re-transcription', async () => {
    const w = docTaskWorld('audio')
    const t = fakeTranscriber()
    const doc = createQueuedDocument(w.db, writeAudioSource(w))
    await processDocument(w.db, w.storeDir, doc.id, { transcriber: t })
    expect(t.calls).toHaveLength(1)

    const preview = await extractDocumentPreview(w.db, w.storeDir, doc.id, {})
    expect(preview.segments.map((s) => s.text).join('\n')).toContain(SECRET_SPEECH)
    expect(preview.segments[0].sectionLabel).toMatch(/–/)
    // The load-bearing assertion: preview did NOT call the transcriber again.
    expect(t.calls).toHaveLength(1)
  })

  // RAG-N1 (the user-visible bug): a CJK/Thai transcript packed by the OLD whitespace-word cap
  // stayed one over-the-window packed segment, the chunker WINDOWED it (with 80-token overlap),
  // and `audioSegmentsFromChunks` then rebuilt the transcript with DUPLICATED spans at every
  // overlap boundary. Token-based packing keeps each segment under the window, so the chunker
  // emits one chunk per segment and the round-trip is lossless. Teeth: reverting
  // `packTranscriptSegments` to a word cap makes this fail (markers appear twice).
  it('round-trips a long Japanese transcript through chunks with NO duplicated spans (RAG-N1)', async () => {
    const w = docTaskWorld('audio')
    // 40 space-less whisper segments, each opening with a UNIQUE fixed-width marker (章000…章039)
    // so a duplicated overlap span is detectable. ~28 space-less tokens each ⇒ ~1100 tokens total,
    // far past the 500-token chunk window when (wrongly) packed as one segment.
    const marker = (i: number): string => `章${String(i).padStart(3, '0')}`
    const segments: TranscriptSegment[] = Array.from({ length: 40 }, (_, i) => ({
      startMs: i * 5000,
      endMs: i * 5000 + 5000,
      text: `${marker(i)}${'の'.repeat(24)}`
    }))
    const t = fakeTranscriber(segments)
    const doc = createQueuedDocument(w.db, writeAudioSource(w))
    await processDocument(w.db, w.storeDir, doc.id, { transcriber: t })

    const preview = await extractDocumentPreview(w.db, w.storeDir, doc.id, {})
    // It actually split into several packed segments (not one over-the-window blob).
    expect(preview.segments.length).toBeGreaterThan(1)
    const joined = preview.segments.map((s) => s.text).join('\n')
    // Every marker present exactly once: no span lost, none duplicated by chunk overlap. Pre-fix
    // the overlap re-included whole segments, so the boundary markers appeared twice.
    for (let i = 0; i < 40; i += 1) {
      expect(joined.split(marker(i)).length - 1).toBe(1)
    }
  })

  it('preview of a failed (chunkless) audio document fails friendly', async () => {
    const w = docTaskWorld('audio')
    const doc = createQueuedDocument(w.db, writeAudioSource(w))
    await processDocument(w.db, w.storeDir, doc.id, {}) // failed: no transcriber
    await expect(extractDocumentPreview(w.db, w.storeDir, doc.id, {})).rejects.toThrow(/Re-index/)
  })

  it('re-index IS a full re-transcription of the stored copy (D35)', async () => {
    const w = docTaskWorld('audio')
    const t = fakeTranscriber()
    const source = writeAudioSource(w)
    const doc = createQueuedDocument(w.db, source)
    await processDocument(w.db, w.storeDir, doc.id, { transcriber: t })
    rmSync(source) // self-contained: re-index must come from the stored copy

    const info = await reindexDocument(w.db, w.storeDir, doc.id, { transcriber: t })
    expect(info.status).toBe('indexed')
    expect(t.calls).toHaveLength(2)
    // The second call parsed the STORED copy, not the (deleted) original.
    expect(t.calls[1].startsWith(w.storeDir)).toBe(true)
  })

  it('encrypted workspace: only the .enc rests on disk; the transcriber reads the DECRYPTED .parse transient, working inside the store', async () => {
    const w = docTaskWorld('audio')
    const cipher = testCipher()
    const t = fakeTranscriber()
    const source = writeAudioSource(w)
    const sourceBytes = readFileSync(source)

    const doc = createQueuedDocument(w.db, source)
    const info = await processDocument(w.db, w.storeDir, doc.id, { cipher, transcriber: t })
    expect(info.status).toBe('indexed')

    // The stored copy is the .enc artifact; nothing else remains in the store.
    const stored = readdirSync(w.storeDir)
    expect(stored).toHaveLength(1)
    expect(stored[0].endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)
    expect(readFileSync(join(w.storeDir, stored[0])).includes(sourceBytes)).toBe(false) // the recording rests encrypted, never as plaintext

    // Re-index with the original gone: decrypts to the `.parse<ext>` transient, hands
    // THAT to the transcriber, and shreds it after (the existing pattern, D35).
    rmSync(source)
    const reinfo = await reindexDocument(w.db, w.storeDir, doc.id, { cipher, transcriber: t })
    expect(reinfo.status).toBe('indexed')
    expect(t.calls[1]).toContain('.parse')
    const after = readdirSync(w.storeDir)
    expect(after).toHaveLength(1)
    expect(after[0].endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)
    // The transient it was handed holds the DECRYPTED recording (a pipeline that skipped decryption hands it ciphertext)…
    expect(t.inputs[1].equals(sourceBytes)).toBe(true)
    // …and whisper's own transient transcript lands in the store, inside the startup crash sweep (REL-6) — never next
    // to the user's original (the first import parses the original directly).
    expect(t.workDirs).toEqual([w.storeDir, w.storeDir])
  })

  it('aborting an import kills the in-flight transcription — task ends failed, signal threaded (REL-1)', async () => {
    const w = docTaskWorld('audio')
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

    const doc = createQueuedDocument(w.db, writeAudioSource(w))
    const p = processDocument(w.db, w.storeDir, doc.id, { transcriber: t, signal: controller.signal })
    await within(reached, 'transcribe() reached') // transcribe() is now in flight
    controller.abort()
    const info = await within(p, 'the aborted import settling')

    // The cancelled transcription fails the FILE (processDocument never throws).
    expect(info.status).toBe('failed')
    // The load-bearing assertion: the signal reached `transcribe` (was threaded
    // deps.signal → ParseContext.signal → AudioParser → transcribe) and is aborted.
    expect(sawSignal).toBe(controller.signal)
    expect(sawSignal?.aborted).toBe(true)
  })

  // #237 / #687: a re-index registers with `plaintextOps`, so "Lock now" / quit reach the plaintext it puts on the
  // drive: the registry's abort is the whisper child's signal, and its sweep shreds the file the child is reading. An
  // encrypted copy decrypts to `<id>.parse<ext>`, tracked BEFORE the write. A LEGACY plaintext copy is encrypted in
  // place and parsed one last time as `<id><ext>`: no `.parse` in that name, so the startup crash sweep never catches
  // it and only the registry can. Abort and sweep run in one tick, before prepare's own `finally` can shred — the
  // state a transcription that outlives the settle bound leaves.
  it.each([
    { copy: 'an encrypted stored copy', legacy: false, transient: '.parse.mp3' }, // its decrypted transient
    { copy: 'a legacy plaintext stored copy', legacy: true, transient: '.mp3' } // the plaintext copy itself
  ])('a lock reaches a re-index of $copy: the registry aborts the transcription and sweeps the plaintext it reads (#687)', async ({ legacy, transient }) => {
    const w = docTaskWorld('audio')
    const cipher = testCipher()
    const source = writeAudioSource(w)
    const sourceBytes = readFileSync(source)
    const doc = createQueuedDocument(w.db, source)
    const first = await processDocument(w.db, w.storeDir, doc.id, {
      cipher: legacy ? null : cipher,
      transcriber: fakeTranscriber()
    })
    expect(first.status).toBe('indexed')
    rmSync(source)

    const ops = createPlaintextOps()
    let handed: string | null = null
    let signal: AbortSignal | undefined
    const parked: Transcriber = {
      id: 'parked',
      transcribe: (filePath, opts) =>
        new Promise<never>((_resolve, reject) => {
          handed = filePath
          signal = opts.signal
          const cancelled = (): void => reject(new Error('Transcription was cancelled.'))
          if (opts.signal?.aborted) cancelled()
          else opts.signal?.addEventListener('abort', cancelled, { once: true })
        })
    }
    const run = reindexDocument(w.db, w.storeDir, doc.id, { cipher, transcriber: parked, plaintextOps: ops })
    await until(() => handed !== null, 'the re-index reaching transcribe')
    expect(handed).toBe(join(w.storeDir, `${doc.id}${transient}`))
    expect(readFileSync(handed!).equals(sourceBytes)).toBe(true) // the recording, in plaintext, on the drive

    ops.abortAll()
    expect(signal!.aborted).toBe(true) // the lock reached the whisper child's signal
    expect(ops.sweepRegistered()).toBe(1) // the file was tracked, so the lock sweep shreds it
    expect(existsSync(handed!)).toBe(false)

    const info = await within(run, 'the aborted re-index settling')
    expect(info.status).toBe('failed')
    expect(ops.size()).toBe(0) // released in prepare's finally
    // Never half-written: the row names the one copy left in the store, and that copy is the encrypted one.
    const { stored_name } = w.db.prepare('SELECT stored_name FROM documents WHERE id = ?').get(doc.id) as {
      stored_name: string
    }
    expect(stored_name).toBe(`${doc.id}.mp3${ENCRYPTED_DOC_SUFFIX}`)
    expect(readdirSync(w.storeDir)).toEqual([stored_name])
  })

  it('summarizeImportPaths counts audio files + bytes for the D35 size confirm', async () => {
    const w = docTaskWorld('audio')
    const audio = writeAudioSource(w, 'big.wav')
    const txt = join(w.root, 'note.txt')
    writeFileSync(txt, 'text')
    const pre = await summarizeImportPaths([audio, txt])
    expect(pre.fileCount).toBe(2)
    expect(pre.audioFileCount).toBe(1)
    expect(pre.audioBytes).toBe(2048)
    // Unsupported/missing paths do not blow up the preflight.
    expect(await summarizeImportPaths([join(w.root, 'missing.mp3')])).toEqual({
      fileCount: 0,
      audioFileCount: 0,
      audioBytes: 0
    })
  })
})
