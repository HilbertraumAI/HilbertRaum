import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
// Two knobs on the same pass-throughs reach the failure paths a real disk rarely shows:
// `shortWrite` makes the handle's write store one byte short, `tamper` runs just before the
// read-back (so the bytes on disk can differ from the buffer that was written).

const calls = vi.hoisted(() => ({
  sync: [] as Array<{ fn: string; path: string }>,
  order: [] as string[],
  shortWrite: false,
  tamper: null as null | ((path: string) => void)
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
              if (prop === 'write' && calls.shortWrite) {
                // One byte short of what was asked: the POSIX short write the tail must refuse.
                return (value as (...a: unknown[]) => unknown).apply(target, [
                  inner[0],
                  inner[1],
                  (inner[2] as number) - 1,
                  inner[3]
                ])
              }
              return (value as (...a: unknown[]) => unknown).apply(target, inner)
            }
          }
          return (value as (...a: unknown[]) => unknown).bind(target)
        }
      })
    }),
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      calls.order.push(`readFile:${String(args[0])}`)
      calls.tamper?.(String(args[0]))
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
// The shared fixtures too: their seeds and temp roots go through the same wrapped modules.
const { freshWorkspaceDb, tempRoot } = await import('../helpers/db-fixtures')
const { exportDeps, seedAssistantAnswer, seedEvidenceReview, seedSourceDocument, useOfflineGuard } =
  await import('../helpers/evidence-fixtures')

/**
 * The tmp sibling THIS export actually used, read off the recorded calls.
 *
 * AUD-17: the scratch file is named from the export's own pack id, not from the destination
 * — two concurrent exports to one destination must not write the same file — and the id is
 * a randomUUID here, so the path cannot be guessed. Reading it back also keeps these
 * assertions honest: a writer that silently stopped using a sibling would fail here instead
 * of passing a `${dest}.tmp` existence check vacuously.
 */
function tmpSiblingUsed(dest: string): string {
  const paths = calls.order.map((step) => step.slice(step.indexOf(':') + 1))
  const tmp = paths.find((p) => p.startsWith(`${dest}.`) && p.endsWith('.tmp'))
  if (!tmp) throw new Error(`no tmp sibling of ${dest} in ${JSON.stringify(calls.order)}`)
  return tmp
}
const { listEvidenceExports } = await import('../../src/main/services/evidence-reviews')
const { sha256Of } = await import('../../src/main/services/assets')
import type { Db } from '../../src/main/services/db'
import type { Citation } from '../../src/shared/types'

// Every export test runs under the REAL offline guard (security-model "asserted silent across every export test").
useOfflineGuard()

/** A review over an answer padded to ~1 MB, so the tail this test is about is a real one. */
function seedBigReview(db: Db): string {
  const docId = seedSourceDocument(db, { title: 'contract.pdf', sha256: 'ab'.repeat(32), mime: 'application/pdf' })
  const citations: Citation[] = [
    { label: 'S1', sourceTitle: 'contract.pdf', documentId: docId, snippet: 'Either party…' } as Citation
  ]
  const paragraphs: string[] = []
  for (let i = 0; i < 400; i++) {
    paragraphs.push(`Claim ${i}: ${'padding to make the rendered pack genuinely large. '.repeat(40)} [S1]`)
  }
  const answer = seedAssistantAnswer(db, {
    title: 'Async tail',
    modelId: 'm1',
    question: 'What does it say?',
    content: paragraphs.join('\n\n'),
    citations,
    coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 4 }
  })
  return seedEvidenceReview(db, answer).id
}

/** The printed-PDF stand-in for the PDF leg: ~700 KB, so its tail is as real as the HTML one. */
const BIG_PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'utf8'),
  Buffer.alloc(700_000, 0x41),
  Buffer.from('\n%%EOF', 'utf8')
])

/** Recorded synchronous fs calls whose target sits inside `root` — the export's own I/O,
 *  ignoring anything the harness itself did before the window was cleared. */
function syncCallsUnder(root: string): Array<{ fn: string; path: string }> {
  return calls.sync.filter((c) => c.path.startsWith(root))
}

describe('AUD-15 — the evidence-pack export tail is async fs, not sync fs on the main thread', () => {
  // The PDF leg: the printed bytes take the identical async writer. The print harness is injected, so its own
  // (also-ported) I/O is out of scope here; this row is about the writer the bytes then go through.
  it.each([
    ['HTML', { ext: 'html', request: {}, pdf: null }],
    ['PDF', { ext: 'pdf', request: { format: 'pdf' }, pdf: BIG_PDF }]
  ] as const)('a ~1 MB %s export makes ZERO synchronous fs calls in the destination directory', async (_label, row) => {
    const { db, root } = freshWorkspaceDb('epasync')
    const reviewId = seedBigReview(db)
    const dest = join(root, `big-pack.${row.ext}`)
    const pdf = row.pdf

    calls.sync.length = 0
    calls.order.length = 0
    const record = await exportEvidencePackToFile(
      db,
      reviewId,
      row.request,
      exportDeps(dest, pdf ? { renderPdf: async () => pdf } : {})
    )
    // Snapshot the recorded sync calls BEFORE this test does any reading of its own.
    const syncDuringExport = syncCallsUnder(root)
    expect(record).not.toBeNull()
    expect(record!.format).toBe(row.ext)

    // (1) THE ASSERTION: nothing synchronous touched the export directory.
    expect(syncDuringExport).toEqual([])

    // The file is real and big enough for the stall this finding is about to be measurable.
    const bytes = readFileSync(dest)
    // Positive control: the recorder DOES see a synchronous read of the destination (this test's own), so the
    // empty list above is the pipeline's silence, not a recorder that stopped intercepting.
    expect(syncCallsUnder(root).some((c) => c.fn === 'readFileSync' && c.path === dest)).toBe(true)
    expect(bytes.byteLength).toBeGreaterThan(500_000)
    if (pdf) expect(bytes).toEqual(pdf)

    // (2) …and the async path really ran the durability contract, in order: write the tmp
    // sibling, fsync it through its OWN handle, close it, read the bytes BACK off disk,
    // and only then rename. The recorded hash is the hash of those on-disk bytes.
    const tmp = tmpSiblingUsed(dest)
    // Per-export name (AUD-17), still a SIBLING so the rename stays same-volume/atomic.
    expect(tmp.slice(dest.length)).toMatch(/^\.[0-9a-f]{32}\.tmp$/)
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

  it('a FAILING write closes the handle and removes the tmp sibling — still no sync fs', async () => {
    const { db, root } = freshWorkspaceDb('epasync')
    const reviewId = seedBigReview(db)
    // A destination whose parent does not exist: the tmp open rejects.
    const dest = join(root, 'no-such-dir', 'pack.html')

    calls.sync.length = 0
    calls.order.length = 0
    await expect(exportEvidencePackToFile(db, reviewId, {}, exportDeps(dest))).rejects.toThrow()
    expect(syncCallsUnder(root)).toEqual([])
    // The cleanup ran on the async API, and nothing was recorded (spec §28.9 intact).
    expect(calls.order).toContain(`rm:${tmpSiblingUsed(dest)}`)
    expect(listEvidenceExports(db, reviewId)).toEqual([])

    // A write that fails AFTER the open: a short write (the handle stored one byte less than asked) is refused,
    // the handle is closed before the tmp is removed, and nothing is left or recorded.
    const dest2 = join(root, 'short.html')
    calls.sync.length = 0
    calls.order.length = 0
    calls.shortWrite = true
    try {
      await expect(exportEvidencePackToFile(db, reviewId, {}, exportDeps(dest2))).rejects.toThrow(/short write/)
    } finally {
      calls.shortWrite = false
    }
    const tmp = tmpSiblingUsed(dest2)
    const closeAt = calls.order.indexOf(`close:${tmp}`)
    const rmAt = calls.order.indexOf(`rm:${tmp}`)
    expect(calls.order).toContain(`write:${tmp}`)
    expect(closeAt).toBeGreaterThanOrEqual(0)
    expect(rmAt).toBeGreaterThan(closeAt)
    // `existsSync` is not a recorded call, so these reads do not pollute the sync list.
    expect(existsSync(tmp)).toBe(false)
    expect(existsSync(dest2)).toBe(false)
    expect(syncCallsUnder(root)).toEqual([])
    expect(listEvidenceExports(db, reviewId)).toEqual([])
  })

  it('a rename that fails AFTER the fsync closes the handle first, so the tmp can be removed', async () => {
    const { db, root } = freshWorkspaceDb('epasync')
    const reviewId = seedBigReview(db)
    // The destination IS an existing non-empty directory → the rename rejects after the
    // bytes are already durable in the tmp sibling.
    const dest = join(root, 'occupied')
    const { mkdirSync, readdirSync } = await import('node:fs')
    mkdirSync(join(dest, 'child'), { recursive: true })

    calls.order.length = 0
    await expect(exportEvidencePackToFile(db, reviewId, {}, exportDeps(dest))).rejects.toThrow()
    // The handle was closed BEFORE the cleanup, which is what lets the removal succeed on
    // Windows (an open handle keeps the file locked).
    const tmp = tmpSiblingUsed(dest)
    const closeAt = calls.order.indexOf(`close:${tmp}`)
    const rmAt = calls.order.indexOf(`rm:${tmp}`)
    expect(closeAt).toBeGreaterThanOrEqual(0)
    expect(rmAt).toBeGreaterThan(closeAt)
    expect(existsSync(tmp)).toBe(false)
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(listEvidenceExports(db, reviewId)).toEqual([])
  })

  it('writePackFileAtomic hashes the bytes READ BACK off disk, not the buffer it wrote (AUD-15)', async () => {
    const asText = join(tempRoot('epasync'), 'atomic.html')
    // The tmp sibling's bytes change between the fsync and the read-back: the recorded hash must describe the
    // file that lands, never the in-memory buffer.
    calls.tamper = (p) => {
      if (p.endsWith('.tmp')) writeFileSync(p, 'tampered-on-disk')
    }
    let hash: string
    try {
      hash = await writePackFileAtomic(asText, 'content-ä', '33333333-3333-4333-8333-333333333333')
    } finally {
      calls.tamper = null
    }
    expect(readFileSync(asText, 'utf8')).toBe('tampered-on-disk')
    expect(hash).toBe(sha256Of(readFileSync(asText)))
    expect(hash).not.toBe(sha256Of(Buffer.from('content-ä', 'utf8')))
  })
})
