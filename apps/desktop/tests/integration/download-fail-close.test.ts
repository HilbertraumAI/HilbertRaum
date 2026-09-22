import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #410: `downloadToFile` settles a FAILED download only once its write stream has closed. The file
// is opened asynchronously (the libuv thread pool), so under load a body that failed before the
// open completed used to reject first: a caller deleting the partial on failure (the OCR
// installer's `.part` cleanup on cancel) ran before the file existed, and the late open then left
// an orphan behind a settled job — seen once as a full-suite flake of the installer's cancel test.
// The load is simulated deterministically here: every write stream's open is delayed through the
// stream's own `fs` option, via the pass-through `node:fs` mock (the repo's fault-injection rule).

const OPEN_DELAY_MS = 60

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const slowOpenFs = {
    open: (...args: unknown[]): void => {
      setTimeout(() => (actual.open as (...a: unknown[]) => void)(...args), OPEN_DELAY_MS)
    },
    write: actual.write,
    writev: actual.writev,
    close: actual.close
  }
  type StreamOptions = Exclude<Parameters<typeof actual.createWriteStream>[1], string | undefined>
  const createWriteStream = (path: string, options?: StreamOptions) =>
    actual.createWriteStream(path, { ...(options ?? {}), fs: slowOpenFs } as StreamOptions)
  const mocked = { ...actual, createWriteStream }
  return { ...mocked, default: mocked }
})

import { downloadToFile, type FetchFn } from '../../src/main/services/assets'

describe('downloadToFile — a failure settles after the partial file is closed (#410)', () => {
  it('a body that fails before the slow open completed rejects only once the file exists and is closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-dl-close-'))
    const dest = join(root, 'deu.traineddata.gz.part')
    const failing = new ReadableStream({
      start(controller) {
        controller.error(new Error('connection reset'))
      }
    })
    const fetchImpl = (async () => new Response(failing)) as unknown as FetchFn
    await expect(downloadToFile('https://example.test/deu.gz', dest, { fetchImpl })).rejects.toThrow()
    // The stream opened (creating the file) and closed BEFORE the rejection — not after it…
    expect(existsSync(dest)).toBe(true)
    rmSync(dest)
    // …so a caller's delete on failure is final: nothing re-creates the file later.
    await new Promise((r) => setTimeout(r, OPEN_DELAY_MS * 3))
    expect(existsSync(dest)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('an abort that lands before the slow open completed leaves nothing behind once the caller deletes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-dl-close-'))
    const dest = join(root, 'eng.traineddata.gz.part')
    const controller = new AbortController()
    const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('partial'))
            init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
          }
        })
      )) as unknown as FetchFn
    const pending = downloadToFile('https://example.test/eng.gz', dest, { fetchImpl, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
    rmSync(dest, { force: true })
    await new Promise((r) => setTimeout(r, OPEN_DELAY_MS * 3))
    expect(existsSync(dest)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})
