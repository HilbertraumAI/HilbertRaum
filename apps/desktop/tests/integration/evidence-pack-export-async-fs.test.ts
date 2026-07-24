import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// AUD-15 — the evidence-pack export tail runs OFF the synchronous fs API.
//
// The atomic-write contract (tmp sibling -> fsync -> hash the bytes read back off disk ->
// rename) was correct but SYNCHRONOUS, and it runs on the Electron main thread: a
// multi-megabyte pack froze the entire process — every window, every pending IPC reply —
// for the whole tail, worst on the slow USB drives this app targets. The port mirrors the
// one the image-history store/open path already took (`fs.promises` + a FileHandle whose
// `sync()` replaces `fsyncSync`).
//
// This is REAL instrumentation, not a source-text grep: BOTH `node:fs` and `node:fs/promises`
// are mocked with pass-through `vi.fn` wrappers (the download-durability idiom — everything
// still hits the real filesystem, the mock only RECORDS), and the returned FileHandle is
// wrapped too so the fsync-before-rename ORDER is observable. The assertions are therefore
// about what the pipeline DID, not about how it is spelled:
//   1. not one synchronous fs call touches the destination directory during an export;
//   2. the durability contract is intact on the async path — the tmp sibling is fsynced
//      through its own handle BEFORE the rename, and the recorded hash is the hash of the
//      bytes read back OFF DISK;
//   3. the handle is closed on every path, including failure (an unclosed handle keeps the
//      tmp file locked on Windows and would defeat the cleanup).

const calls = vi.hoisted(() => ({
  sync: [] as Array<{ fn: string; path: string }>,
  order: [] as string[]
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const record = <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    ((...args: A): R => {
      calls.sync.push({ fn: name, path: String(args[0]) })
      return fn(...args)
    }) as (...args: A) => R
  const mocked = {
    ...actual,
    openSync: record('openSync', actual.openSync),
    writeSync: vi.fn(actual.writeSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
    readFileSync: record('readFileSync', actual.readFileSync),
    writeFileSync: record('writeFileSync', actual.writeFileSync),
    renameSync: record('renameSync', actual.renameSync),
    rmSync: record('rmSync', actual.rmSync),
    unlinkSync: record('unlinkSync', actual.unlinkSync)
  }
  return { ...mocked, default: mocked }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const mocked = {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      calls.order.push(`open:${String(args[0])}`)
      return new Proxy(handle, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (typeof value !== 'function') return value
          if (prop === 'sync' || prop === 'close' || prop === 'write') {
            return (...inner: unknown[]) => {
              calls.order.push(`${String(prop)}:${String(args[0])}`)
              return (value as (...a: unknown[]) => unknown).apply(target, inner)
            }
          }
          return (value as (...a: unknown[]) => unknown).bind(target)
        }
      })
    }),
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      calls.order.push(`readFile:${String(args[0])}`)
      return actual.readFile(...args)
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      calls.order.push(`rename:${String(args[0])}`)
      return actual.rename(...args)
    }),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      calls.order.push(`rm:${String(args[0])}`)
      return actual.rm(...args)
    })
  }
  return { ...mocked, default: mocked }
})

// Imported AFTER the mocks are registered so the service modules bind the wrapped fns.
const { exportEvidencePackToFile, writePackFileAtomic } = await import(
  '../../src/main/services/evidence-pack/export'
)
const { openDatabase } = await import('../../src/main/services/db')
const { appendMessage, createConversation } = await import('../../src/main/services/chat')
const { createEvidenceReviewFromMessage } = await import(
  '../../src/main/services/evidence-pack/snapshot'
)
const { listEvidenceExports } = await import('../../src/main/services/evidence-reviews')
const { sha256Of } = await import('../../src/main/services/assets')
import type { Db } from '../../src/main/services/db'
import type { Citation } from '../../src/shared/types'

const NEVER_PDF = async (): Promise<Buffer> => {
  throw new Error('renderPdf must not be called for an HTML export')
}

function freshWorkspace(): { db: Db; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-epasync-'))
  return { db: openDatabase(join(root, 'test.sqlite')), root }
}

/** A review over an answer padded to ~1 MB, so the tail this test is about is a real one. */
function seedBigReview(db: Db): string {
  const now = new Date().toISOString()
  const docId = 'doc-async-fs'
  db.prepare(
    `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
     VALUES (?, 'contract.pdf', 'application/pdf', ?, 'indexed', ?, ?)`
  ).run(docId, 'ab'.repeat(32), now, now)
  const conv = createConversation(db, { title: 'Async tail', modelId: 'm1' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'What does it say?' })
  const citations: Citation[] = [
    { label: 'S1', sourceTitle: 'contract.pdf', documentId: docId, snippet: 'Either party…' } as Citation
  ]
  const paragraphs: string[] = []
  for (let i = 0; i < 400; i++) {
    paragraphs.push(`Claim ${i}: ${'padding to make the rendered pack genuinely large. '.repeat(40)} [S1]`)
  }
  const msg = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: paragraphs.join('\n\n'),
    citations,
    coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 4 }
  })
  return createEvidenceReviewFromMessage(db, msg.id, {}).id
}

/** Recorded synchronous fs calls whose target sits inside `root` — the export's own I/O,
 *  ignoring anything the harness itself did before the window was cleared. */
function syncCallsUnder(root: string): Array<{ fn: string; path: string }> {
  return calls.sync.filter((c) => c.path.startsWith(root))
}

describe('AUD-15 — the evidence-pack export tail is async fs, not sync fs on the main thread', () => {
  it('a ~1 MB HTML export makes ZERO synchronous fs calls in the destination directory', async () => {
    const { db, root } = freshWorkspace()
    const reviewId = seedBigReview(db)
    const dest = join(root, 'big-pack.html')

    calls.sync.length = 0
    calls.order.length = 0
    const record = await exportEvidencePackToFile(db, reviewId, {}, {
      chooseDestination: async () => dest,
      renderPdf: NEVER_PDF
    })
    // Snapshot the recorded sync calls BEFORE this test does any reading of its own.
    const syncDuringExport = syncCallsUnder(root)
    expect(record).not.toBeNull()

    // (1) THE ASSERTION: nothing synchronous touched the export directory.
    expect(syncDuringExport).toEqual([])

    // The file is real and big enough for the stall this finding is about to be measurable.
    const bytes = readFileSync(dest)
    expect(bytes.byteLength).toBeGreaterThan(500_000)

    // (2) …and the async path really ran the durability contract, in order: write the tmp
    // sibling, fsync it through its OWN handle, close it, read the bytes BACK off disk,
    // and only then rename. The recorded hash is the hash of those on-disk bytes.
    const tmp = `${dest}.tmp`
    const relevant = calls.order.filter((step) => step.endsWith(tmp) || step.endsWith(dest))
    expect(relevant).toEqual([
      `open:${tmp}`,
      `write:${tmp}`,
      `sync:${tmp}`,
      `close:${tmp}`,
      `readFile:${tmp}`,
      `rename:${tmp}`
    ])
    expect(record!.fileSha256).toBe(sha256Of(bytes))
  })

  it('the same holds for the PDF tail — the printed bytes take the identical async writer', async () => {
    const { db, root } = freshWorkspace()
    const reviewId = seedBigReview(db)
    const dest = join(root, 'big-pack.pdf')
    const pdfBytes = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'utf8'),
      Buffer.alloc(700_000, 0x41),
      Buffer.from('\n%%EOF', 'utf8')
    ])

    calls.sync.length = 0
    calls.order.length = 0
    const record = await exportEvidencePackToFile(db, reviewId, { format: 'pdf' }, {
      chooseDestination: async () => dest,
      // The print harness is injected, so its own (also-ported) I/O is out of scope here;
      // this test is about the writer the bytes then go through.
      renderPdf: async () => pdfBytes
    })
    const syncDuringExport = syncCallsUnder(root)
    expect(record!.format).toBe('pdf')
    expect(syncDuringExport).toEqual([])
    expect(readFileSync(dest)).toEqual(pdfBytes)
  })

  it('a FAILING write closes the handle and removes the tmp sibling — still no sync fs', async () => {
    const { db, root } = freshWorkspace()
    const reviewId = seedBigReview(db)
    // A destination whose parent does not exist: the tmp open rejects.
    const dest = join(root, 'no-such-dir', 'pack.html')

    calls.sync.length = 0
    calls.order.length = 0
    await expect(
      exportEvidencePackToFile(db, reviewId, {}, {
        chooseDestination: async () => dest,
        renderPdf: NEVER_PDF
      })
    ).rejects.toThrow()
    expect(syncCallsUnder(root)).toEqual([])
    // The cleanup ran on the async API, and nothing was recorded (spec §28.9 intact).
    expect(calls.order).toContain(`rm:${dest}.tmp`)
    expect(listEvidenceExports(db, reviewId)).toEqual([])
  })

  it('a rename that fails AFTER the fsync closes the handle first, so the tmp can be removed', async () => {
    const { db, root } = freshWorkspace()
    const reviewId = seedBigReview(db)
    // The destination IS an existing non-empty directory → the rename rejects after the
    // bytes are already durable in the tmp sibling.
    const dest = join(root, 'occupied')
    const { mkdirSync, existsSync, readdirSync } = await import('node:fs')
    mkdirSync(join(dest, 'child'), { recursive: true })

    calls.order.length = 0
    await expect(
      exportEvidencePackToFile(db, reviewId, {}, {
        chooseDestination: async () => dest,
        renderPdf: NEVER_PDF
      })
    ).rejects.toThrow()
    // The handle was closed BEFORE the cleanup, which is what lets the removal succeed on
    // Windows (an open handle keeps the file locked).
    const closeAt = calls.order.indexOf(`close:${dest}.tmp`)
    const rmAt = calls.order.indexOf(`rm:${dest}.tmp`)
    expect(closeAt).toBeGreaterThanOrEqual(0)
    expect(rmAt).toBeGreaterThan(closeAt)
    expect(existsSync(`${dest}.tmp`)).toBe(false)
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(listEvidenceExports(db, reviewId)).toEqual([])
  })

  it('writePackFileAtomic still hashes the ON-DISK bytes, string and Buffer alike', async () => {
    const { root } = freshWorkspace()
    const asText = join(root, 'atomic.html')
    expect(await writePackFileAtomic(asText, 'content-ä')).toBe(sha256Of(readFileSync(asText)))
    expect(readFileSync(asText, 'utf8')).toBe('content-ä')

    const asBytes = join(root, 'atomic.pdf')
    const raw = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80])
    expect(await writePackFileAtomic(asBytes, raw)).toBe(sha256Of(raw))
    expect(readFileSync(asBytes)).toEqual(raw)
  })
})
