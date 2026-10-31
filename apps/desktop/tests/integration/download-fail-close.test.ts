import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tempRoot } from '../helpers/db-fixtures'
import { hangingFetch } from '../helpers/download-fixtures'

// #410: `downloadToFile` settles a FAILED download only once its write stream has closed. The file
// is opened asynchronously (the libuv thread pool), so under load a body that failed before the
// open completed used to reject first: a caller deleting the partial on failure (the OCR
// installer's `.part` cleanup on cancel) ran before the file existed, and the late open then left
// an orphan behind a settled job — seen once as a full-suite flake of the installer's cancel test.
// The load is simulated deterministically here: every write stream's open is delayed through the
// stream's own `fs` option, via the pass-through `node:fs` mock (the repo's fault-injection rule).

const OPEN_DELAY_MS = 60

const probe = vi.hoisted(() => ({ issuedOpens: 0, pendingOpens: 0, closes: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // Fault injection, not a wait: holds every open so the failure arrives first.
  const slowOpenFs = {
    open: (
      path: string,
      flags: string,
      mode: number,
      done: (err: NodeJS.ErrnoException | null, fd: number) => void
    ): void => {
      probe.issuedOpens++
      probe.pendingOpens++
      setTimeout(
        () =>
          actual.open(path, flags, mode, (err, fd) => {
            probe.pendingOpens--
            done(err, fd)
          }),
        OPEN_DELAY_MS
      )
    },
    write: actual.write,
    writev: actual.writev,
    close: (fd: number, done: (err: NodeJS.ErrnoException | null) => void): void =>
      actual.close(fd, (err) => {
        probe.closes++
        done(err)
      })
  }
  type StreamOptions = Exclude<Parameters<typeof actual.createWriteStream>[1], string | undefined>
  const createWriteStream = (path: string, options?: StreamOptions) =>
    actual.createWriteStream(path, { ...(options ?? {}), fs: slowOpenFs } as StreamOptions)
  const mocked = { ...actual, createWriteStream }
  return { ...mocked, default: mocked }
})

import { downloadToFile, type FetchFn } from '../../src/main/services/assets'

describe('downloadToFile — a failure settles after the partial file is closed (#410)', () => {
  beforeEach(() => {
    probe.issuedOpens = 0
    probe.pendingOpens = 0
    probe.closes = 0
  })

  const failingBody: FetchFn = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error('connection reset'))
        }
      })
    )

  it.each<[string, { fetchImpl: FetchFn; abort: boolean; message: RegExp }]>([
    ['a body that fails', { fetchImpl: failingBody, abort: false, message: /connection reset/ }],
    ['an abort that lands', { fetchImpl: hangingFetch('partial'), abort: true, message: /aborted/ }]
  ])('%s before the slow open completed rejects only once the file is open and closed', async (_title, row) => {
    const dest = join(tempRoot('dl-close'), 'deu.traineddata.gz.part')
    const controller = new AbortController()
    const pending = downloadToFile('https://example.test/deu.gz', dest, {
      fetchImpl: row.fetchImpl,
      signal: controller.signal
    })
    if (row.abort) controller.abort()
    await expect(pending).rejects.toThrow(row.message)
    // Premise: the delayed open really ran. Contract: nothing pending can re-create the file, and it is closed.
    expect(probe.issuedOpens).toBe(1)
    expect(probe.pendingOpens).toBe(0)
    expect(probe.closes).toBe(1)
    expect(existsSync(dest)).toBe(true)
    rmSync(dest) // not forced: throws if the file is absent or still held, so a caller's delete is final
  })
})
