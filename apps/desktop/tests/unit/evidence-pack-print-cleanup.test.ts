import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// AUD-16 — the PDF print-source cleanup must never fail SILENTLY.
//
// The print source is a transient `.print.tmp.html` sibling of the user-chosen destination:
// a PLAINTEXT copy of already-rendered pack content, deliberately written into the directory
// the user sanctioned for that content. It is removed in the print harness's `finally`. On
// Windows an antivirus scanner or the search indexer routinely opens a freshly written HTML
// file, and a handle held WITHOUT FILE_SHARE_DELETE makes the unlink throw (EBUSY/EPERM);
// the scanner releases it a moment later. The removal used to sit in a `try` whose `catch`
// body was a bare comment, in a module that imported no logger at all — so the failure left
// an extra decrypted copy of the pack on disk with NO trace anywhere.
//
// Reproducing the real handle in-process is not possible: libuv opens files with
// FILE_SHARE_DELETE, so a Node-held handle does not block the unlink. The unlink itself is
// therefore the injected boundary — it fails a programmed number of times with a real
// EBUSY-shaped error and then behaves normally. Everything else is real: a real temp
// directory, a real file written by the harness, and the real removal on the retry.

const fsState = vi.hoisted(() => ({
  /** How many upcoming `rm` calls throw EBUSY before the real removal runs. */
  failRmTimes: 0,
  rmCalls: [] as string[]
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  // Typed AS the real `rm`, so the fake cannot drift from the signature it stands in for.
  const rm: typeof actual.rm = async (path, options) => {
    fsState.rmCalls.push(String(path))
    if (fsState.failRmTimes > 0) {
      fsState.failRmTimes -= 1
      // Shaped like the real thing, PATH INCLUDED in the message — the point of the
      // no-path assertions below is that this never reaches the log.
      throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${String(path)}'`), {
        code: 'EBUSY'
      })
    }
    return actual.rm(path, options)
  }
  return { ...actual, rm }
})

vi.mock('electron', () => {
  class BrowserWindow {
    destroyed = false
    webContents = {
      setWindowOpenHandler: (): void => {},
      on: (): void => {},
      executeJavaScript: async (): Promise<boolean> => true,
      printToPDF: async (): Promise<Uint8Array> => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
    }
    async loadFile(): Promise<void> {}
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
  }
  return {
    BrowserWindow,
    app: { once: (): void => {}, removeListener: (): void => {} }
  }
})

import { printEvidencePackHtmlToPdf } from '../../src/main/services/evidence-pack/print-pdf'
import { log } from '../../src/main/services/logging'

/** The body carries a sentinel: no fragment of rendered pack content may reach the log. */
const HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>SENTINEL-PACK-BODY</body></html>'
const PACK_ID = '00000000-0000-4000-8000-00000000e9a1'

let root = ''
let sourceHtmlPath = ''
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fsState.failRmTimes = 0
  fsState.rmCalls = []
  root = mkdtempSync(join(tmpdir(), 'hilbertraum-printclean-'))
  // The real destination shape: a sibling of a user-chosen file whose NAME comes from the
  // review title, i.e. content. Nothing about it may appear in a log line.
  sourceHtmlPath = join(root, 'Quarterly supplier audit.pdf.print.tmp.html')
  warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  rmSync(root, { recursive: true, force: true })
})

describe('print-source cleanup (AUD-16)', () => {
  it('a locked print source is retried once — the residue is removed and the attempt is logged', async () => {
    fsState.failRmTimes = 1

    const bytes = await printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID, sourceHtmlPath })

    // The print itself still succeeds: cleanup trouble never fails an exported pack.
    expect(bytes.length).toBeGreaterThan(0)
    // No plaintext residue survives a transient lock…
    expect(existsSync(sourceHtmlPath)).toBe(false)
    // …because the removal was attempted twice, the second time successfully.
    expect(fsState.rmCalls).toEqual([sourceHtmlPath, sourceHtmlPath])

    // Exactly one warning, and it is IDS ONLY: the pack id (a random UUID) plus the OS error
    // code. No path — the file name is seeded from the review title — and no pack content.
    expect(warn).toHaveBeenCalledTimes(1)
    const [message, meta] = warn.mock.calls[0]! as [string, unknown]
    expect(meta).toEqual({ packId: PACK_ID, code: 'EBUSY' })
    const logged = `${message} ${JSON.stringify(meta)}`
    expect(logged).not.toContain(sourceHtmlPath)
    expect(logged).not.toContain(root)
    expect(logged).not.toContain('Quarterly supplier audit')
    expect(logged).not.toContain('SENTINEL-PACK-BODY') // no rendered content, not a fragment
  })

  it('a still-locked source after the retry is reported as remaining residue (never silent)', async () => {
    fsState.failRmTimes = 2

    const bytes = await printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID, sourceHtmlPath })

    expect(bytes.length).toBeGreaterThan(0)
    // The plaintext residue really is still there — and now it is on the record instead of
    // being swallowed by an empty catch.
    expect(existsSync(sourceHtmlPath)).toBe(true)
    expect(readFileSync(sourceHtmlPath, 'utf8')).toBe(HTML)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(fsState.rmCalls).toHaveLength(2)
    for (const call of warn.mock.calls as Array<[string, unknown]>) {
      const logged = `${call[0]} ${JSON.stringify(call[1])}`
      expect(call[1]).toEqual({ packId: PACK_ID, code: 'EBUSY' })
      expect(logged).not.toContain(sourceHtmlPath)
      expect(logged).not.toContain(root)
      expect(logged).not.toContain('Quarterly supplier audit')
      expect(logged).not.toContain('SENTINEL-PACK-BODY')
    }
  })

  it('the ordinary path stays quiet: one removal, no log line', async () => {
    await printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID, sourceHtmlPath })
    expect(fsState.rmCalls).toEqual([sourceHtmlPath])
    expect(existsSync(sourceHtmlPath)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })
})
