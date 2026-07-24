import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// AUD-17 — two concurrent PDF exports to the SAME destination must not print each other's
// pack.
//
// The transient print source used to be named from the DESTINATION alone
// (`${destPath}.print.tmp.html`), so two exports saving to the same file wrote, loaded and
// printed ONE shared file. `loadFile` resolving is not the point at which Chromium has
// finished with the document: an overwrite that lands in a later main-process turn is
// picked up and printed successfully (measured on the installed Electron: 12 of 12 runs).
// The loser therefore does not "fail cleanly" as the module comment claimed — both exports
// SUCCEED, and one of them writes a file whose bytes are the other review's pack while the
// `evidence_exports` row it records names its own review. That is provenance corruption of
// a signed-off artifact, with no error anywhere.
//
// What this harness reproduces and what it cannot: the electron BOUNDARY is faked (a
// constructible hidden-window class), but everything above it is the shipped code — the
// real `printEvidencePackHtmlToPdf` lifecycle, the real export pipeline, real SQLite, real
// files on disk. The fake window models the one Chromium behaviour the incident turns on:
// `printToPDF` renders whatever is at the loaded PATH at PRINT time, not a snapshot taken
// when `loadFile` resolved. Chromium's own timing is not reproduced here — that is the
// env-gated real-Electron smoke's territory — so this suite proves the file-level race and
// its removal, not the browser internals.

const electron = vi.hoisted(() => ({
  windows: [] as Array<{ loadedPath: string | null; printedContent: string | null }>,
  /** Called when a window enters `loadFile`; the returned promise parks the load. */
  onLoad: null as ((index: number) => Promise<void>) | null
}))

// The SECOND shared transient (AUD-17, `writePackFileAtomic`'s tmp sibling) is on the tail
// of EVERY export, HTML included — the print-source fix cannot reach it because an HTML
// export renders no print source at all. Reproducing its race needs the write tail itself
// interleaved, so these two hooks park an export at the exact points that matter: after its
// bytes are fsynced and closed but BEFORE the read-back that produces the recorded hash,
// and just before the rename that commits the file. Both default to null (plain
// pass-through) so the PDF tests in this file are untouched; everything still hits the real
// filesystem, the hooks only decide WHEN each step runs.
const fsGate = vi.hoisted(() => ({
  beforeReadFile: null as ((path: string) => Promise<void>) | null,
  beforeRename: null as ((from: string) => Promise<void>) | null
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  // Pass-through wrappers in the shape the async-fs suite already uses (`Parameters<…>`
  // spread — `readFile` is overloaded, so a single annotated arrow cannot stand in for it).
  const readFile = async (...args: Parameters<typeof actual.readFile>) => {
    await fsGate.beforeReadFile?.(String(args[0]))
    return actual.readFile(...args)
  }
  const rename = async (...args: Parameters<typeof actual.rename>) => {
    await fsGate.beforeRename?.(String(args[0]))
    return actual.rename(...args)
  }
  return { ...actual, readFile, rename }
})

vi.mock('electron', async () => {
  const { existsSync, readFileSync } = await import('node:fs')
  class BrowserWindow {
    static getFocusedWindow(): null {
      return null
    }
    private readonly index: number
    destroyed = false
    webContents: Record<string, unknown>
    constructor() {
      this.index = electron.windows.length
      electron.windows.push({ loadedPath: null, printedContent: null })
      const slot = electron.windows[this.index]!
      this.webContents = {
        setWindowOpenHandler: (): void => {},
        on: (): void => {},
        executeJavaScript: async (): Promise<boolean> => true,
        // The load-bearing detail: the document is read from the loaded PATH at print
        // time. A later overwrite of that path is what gets printed.
        printToPDF: async (): Promise<Uint8Array> => {
          const path = slot.loadedPath!
          slot.printedContent = existsSync(path)
            ? readFileSync(path, 'utf8')
            : '<<print-source-missing>>'
          return new TextEncoder().encode(slot.printedContent)
        }
      }
    }
    async loadFile(path: string): Promise<void> {
      electron.windows[this.index]!.loadedPath = path
      await electron.onLoad?.(this.index)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
  }
  return {
    BrowserWindow,
    app: { getVersion: () => '0.0.0-test', once: (): void => {}, removeListener: (): void => {} }
  }
})

import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { createEvidenceReviewFromMessage } from '../../src/main/services/evidence-pack/snapshot'
import {
  exportEvidencePackToFile,
  packTmpPath,
  printSourcePath
} from '../../src/main/services/evidence-pack/export'
import { printEvidencePackHtmlToPdf } from '../../src/main/services/evidence-pack/print-pdf'
import { sha256Of } from '../../src/main/services/assets'

const PACK_ID_A = '11111111-1111-4111-8111-111111111111'
const PACK_ID_B = '22222222-2222-4222-8222-222222222222'
const NOW = '2026-07-18T12:00:00.000Z'

let root = ''
let db: Db

beforeEach(() => {
  electron.windows = []
  electron.onLoad = null
  fsGate.beforeReadFile = null
  fsGate.beforeRename = null
  root = mkdtempSync(join(tmpdir(), 'hilbertraum-epconc-'))
  db = openDatabase(join(root, 'test.sqlite'))
})

/** A promise plus its resolver — the gate primitive these interleavings are built from. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** One review whose title and answer text are unmistakable in a rendered pack. */
function seedReview(marker: string): string {
  const conv = createConversation(db, { title: `${marker}-REVIEW`, modelId: 'test-model-q4' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: `${marker} question?` })
  const msg = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: `${marker}-ANSWER-BODY.`,
    coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
  })
  return createEvidenceReviewFromMessage(db, msg.id, {}).id
}

describe('concurrent same-destination PDF exports (AUD-17)', () => {
  it('each export prints ITS OWN pack and cleans up only its own print source', async () => {
    const reviewA = seedReview('ALPHA')
    const reviewB = seedReview('BRAVO')
    const dest = join(root, 'pack.pdf')

    // Every load parks until the test releases it, so the interleaving is driven by
    // observable state (a load was entered) rather than by timing.
    const entered: number[] = []
    const release: Array<(() => void) | undefined> = []
    electron.onLoad = (index) => {
      entered.push(index)
      return new Promise<void>((resolve) => {
        release[index] = resolve
      })
    }

    const startExport = (reviewId: string, packId: string): Promise<unknown> =>
      exportEvidencePackToFile(
        db,
        reviewId,
        { format: 'pdf' },
        {
          chooseDestination: async () => dest,
          renderPdf: printEvidencePackHtmlToPdf,
          newPackId: () => packId,
          now: () => NOW
        }
      )

    // A reaches its (parked) load first, so window 0 is A's…
    const exportA = startExport(reviewA, PACK_ID_A)
    await vi.waitFor(() => expect(entered).toContain(0))
    // …then B writes its own print source and parks too. This is the exact window in which
    // the shared-name build had already replaced the bytes A was about to print.
    const exportB = startExport(reviewB, PACK_ID_B)
    await vi.waitFor(() => expect(entered).toContain(1))

    release[0]!()
    const recordA = (await exportA) as { reviewId: string; fileSha256: string; format: string }
    release[1]!()
    const recordB = (await exportB) as { reviewId: string; fileSha256: string; format: string }

    // Whose pack did each export actually print? Asserted as one object so a swap reads
    // directly off the failure ("printed the OTHER review's answer").
    const whatWasPrinted = (index: number): Record<string, boolean> => {
      const printed = electron.windows[index]!.printedContent ?? ''
      return {
        alpha: printed.includes('ALPHA-ANSWER-BODY.'),
        bravo: printed.includes('BRAVO-ANSWER-BODY.'),
        // With a shared print-source name, A's cleanup removed the file B was about to
        // print — the second export could not even find its own source.
        sourceMissing: printed === '<<print-source-missing>>'
      }
    }
    expect(whatWasPrinted(0)).toEqual({ alpha: true, bravo: false, sourceMissing: false })
    expect(whatWasPrinted(1)).toEqual({ alpha: false, bravo: true, sourceMissing: false })

    // The two exports never shared a file.
    const paths = electron.windows.map((w) => w.loadedPath)
    expect(new Set(paths).size).toBe(2)
    for (const path of paths) {
      expect(path!.endsWith('.print.tmp.html')).toBe(true)
      expect(path!.startsWith(`${dest}.`)).toBe(true)
      // Both transient sources were removed; neither export deleted the other's.
      expect(existsSync(path!)).toBe(false)
    }

    // Provenance: each recorded row describes the bytes that export actually wrote.
    expect(recordA.reviewId).toBe(reviewA)
    expect(recordA.format).toBe('pdf')
    expect(recordA.fileSha256).toBe(
      sha256Of(Buffer.from(electron.windows[0]!.printedContent!, 'utf8'))
    )
    expect(recordB.reviewId).toBe(reviewB)
    expect(recordB.fileSha256).toBe(
      sha256Of(Buffer.from(electron.windows[1]!.printedContent!, 'utf8'))
    )
    // The destination holds the LAST writer's bytes (unchanged, accepted behaviour: the
    // second save overwrites the first), and that file is the one B recorded.
    expect(sha256Of(readFileSync(dest))).toBe(recordB.fileSha256)
  })

  it('the print-source name carries the pack id and no review content', async () => {
    const reviewId = seedReview('CHARLIE')
    const dest = join(root, 'CHARLIE-REVIEW.pdf')
    electron.onLoad = null

    await exportEvidencePackToFile(
      db,
      reviewId,
      { format: 'pdf' },
      {
        chooseDestination: async () => dest,
        renderPdf: printEvidencePackHtmlToPdf,
        newPackId: () => PACK_ID_A,
        now: () => NOW
      }
    )

    const path = electron.windows[0]!.loadedPath!
    // The uniqueness token is the pack id's alphanumerics — a random UUID, no content.
    expect(path).toBe(`${dest}.${PACK_ID_A.replace(/-/g, '')}.print.tmp.html`)
    // Whatever else the name contains comes from the destination the USER chose; the
    // uniqueness suffix itself adds nothing but hex.
    expect(path.slice(dest.length)).toMatch(/^\.[0-9a-f]{32}\.print\.tmp\.html$/)
    // …and it is the naming rule the pipeline documents, not an incidental string.
    expect(path).toBe(printSourcePath(dest, PACK_ID_A))
  })

  it('the naming rule keeps a hostile pack id out of the file system', () => {
    const dest = join(root, 'pack.pdf')
    // Distinct ids never collide…
    expect(printSourcePath(dest, PACK_ID_A)).not.toBe(printSourcePath(dest, PACK_ID_B))
    // …separators and traversal characters are dropped, not passed through…
    expect(printSourcePath(dest, '../../etc/passwd')).toBe(`${dest}.etcpasswd.print.tmp.html`)
    expect(printSourcePath(dest, 'a b/c\\d:e')).toBe(`${dest}.abcde.print.tmp.html`)
    // …an id that sanitises away entirely (only reachable through an injected mint) still
    // yields a usable unique name rather than a bare dot…
    const empty = printSourcePath(dest, '///')
    expect(empty.slice(dest.length)).toMatch(/^\.[0-9a-f]{32}\.print\.tmp\.html$/)
    expect(printSourcePath(dest, '///')).not.toBe(empty)
    // …and an over-long id cannot grow the path without bound.
    expect(printSourcePath(dest, 'z'.repeat(500))).toBe(`${dest}.${'z'.repeat(32)}.print.tmp.html`)
    // The atomic writer's scratch sibling is minted by the SAME rule — one helper, so the
    // two transients cannot drift apart in naming or sanitising.
    expect(packTmpPath(dest, PACK_ID_A)).toBe(`${dest}.${PACK_ID_A.replace(/-/g, '')}.tmp`)
    expect(packTmpPath(dest, PACK_ID_A)).not.toBe(packTmpPath(dest, PACK_ID_B))
    expect(packTmpPath(dest, '../../etc/passwd')).toBe(`${dest}.etcpasswd.tmp`)
    expect(packTmpPath(dest, 'z'.repeat(500))).toBe(`${dest}.${'z'.repeat(32)}.tmp`)
  })
})

describe('concurrent same-destination HTML exports — the atomic writer (AUD-17, tmp seam)', () => {
  it('each export records the hash of the bytes IT wrote', async () => {
    const reviewA = seedReview('ALPHA')
    const reviewB = seedReview('BRAVO')
    const dest = join(root, 'pack.html')

    // HTML exports render no print source at all, so the harness above is irrelevant here
    // and this stub doubles as proof that no print ever happens on this path.
    const NEVER_PDF = async (): Promise<Buffer> => {
      throw new Error('renderPdf must not be called for an HTML export')
    }

    // The interleaving, driven entirely by observable state:
    //   A writes + fsyncs + closes its tmp, then PARKS before the read-back that produces
    //   its recorded hash. B then runs its whole write tail into (pre-fix) the SAME tmp
    //   path — truncating A's bytes — and parks just before its rename. A is released: it
    //   reads back whatever is at the tmp path now and renames it onto the destination.
    let readBacks = 0
    let renames = 0
    let aOwnBytes: Buffer | null = null
    let bOwnBytes: Buffer | null = null
    const tmpPathsSeen: string[] = []
    const aParked = deferred()
    const bParked = deferred()
    const releaseA = deferred()
    const releaseB = deferred()

    fsGate.beforeReadFile = async (path) => {
      readBacks += 1
      tmpPathsSeen.push(path)
      // Captured BEFORE parking, while the export that just wrote this file is still the
      // only one to have touched it: this is provably that export's own output.
      const own = readFileSync(path)
      if (readBacks === 1) {
        aOwnBytes = own
        aParked.resolve()
        await releaseA.promise
      } else {
        bOwnBytes = own
      }
    }
    fsGate.beforeRename = async () => {
      renames += 1
      if (renames === 1) {
        bParked.resolve()
        await releaseB.promise
      }
    }

    const startExport = (reviewId: string, packId: string): Promise<unknown> =>
      exportEvidencePackToFile(
        db,
        reviewId,
        {},
        {
          chooseDestination: async () => dest,
          renderPdf: NEVER_PDF,
          newPackId: () => packId,
          now: () => NOW
        }
      )

    const exportA = startExport(reviewA, PACK_ID_A).then(
      (record) => ({ ok: true as const, record }),
      (error: unknown) => ({ ok: false as const, error })
    )
    await aParked.promise
    const exportB = startExport(reviewB, PACK_ID_B).then(
      (record) => ({ ok: true as const, record }),
      (error: unknown) => ({ ok: false as const, error })
    )
    await bParked.promise

    releaseA.resolve()
    const resultA = await exportA
    // Snapshot the destination while A's rename is the ONLY one that has happened — this
    // is the file A committed and recorded, before B's later save replaces it.
    const destAfterA = readFileSync(dest).toString('utf8')
    releaseB.resolve()
    const resultB = await exportB

    // Both exports produced a real pack, and each captured pair of bytes is the right one.
    expect(aOwnBytes!.toString('utf8')).toContain('ALPHA-ANSWER-BODY.')
    expect(bOwnBytes!.toString('utf8')).toContain('BRAVO-ANSWER-BODY.')
    expect(aOwnBytes!.equals(bOwnBytes!)).toBe(false)

    /** Whose pack a recorded hash actually describes — the whole finding in one word. */
    const describes = (sha: string): string =>
      sha === sha256Of(aOwnBytes!)
        ? 'ALPHA bytes'
        : sha === sha256Of(bOwnBytes!)
          ? 'BRAVO bytes'
          : 'neither'

    // THE ASSERTION: export A succeeds, and the row it writes under review A's id records
    // the hash of the pack A itself produced. Sharing the tmp name made A read back, hash,
    // and rename B's pack instead — a green export whose provenance row is a lie.
    expect(resultA.ok).toBe(true)
    const recordA = (resultA as { record: { reviewId: string; fileSha256: string } }).record
    expect({ row: recordA.reviewId === reviewA ? 'ALPHA row' : 'other row', describes: describes(recordA.fileSha256) }).toEqual(
      { row: 'ALPHA row', describes: 'ALPHA bytes' }
    )
    // …and the file A actually committed to the destination is A's pack, not B's.
    expect(destAfterA).toContain('ALPHA-ANSWER-BODY.')
    expect(destAfterA).not.toContain('BRAVO-ANSWER-BODY.')

    // B completes too. Sharing the name also broke B outright: A had renamed the one
    // scratch file away, so B's own rename failed with ENOENT — a real export lost to a
    // collision the module documented as harmless.
    expect(resultB.ok).toBe(true)
    const recordB = (resultB as { record: { reviewId: string; fileSha256: string } }).record
    expect({ row: recordB.reviewId === reviewB ? 'BRAVO row' : 'other row', describes: describes(recordB.fileSha256) }).toEqual(
      { row: 'BRAVO row', describes: 'BRAVO bytes' }
    )

    // The two exports never shared a scratch file in the first place.
    expect(new Set(tmpPathsSeen).size).toBe(2)
    expect(tmpPathsSeen).toContain(packTmpPath(dest, PACK_ID_A))
    expect(tmpPathsSeen).toContain(packTmpPath(dest, PACK_ID_B))

    // The destination itself is still last-writer-wins — two saves to one path, which is
    // the user's own instruction and unchanged behaviour. B renamed last here.
    expect(readFileSync(dest).equals(bOwnBytes!)).toBe(true)
    // No scratch sibling survives, under any name.
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
