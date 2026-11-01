import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tempRoot } from '../helpers/db-fixtures'
import { hangingFetch } from '../helpers/download-fixtures'
import { until } from '../helpers/hang-budget'

// #410: `downloadToFile` settles a FAILED download only once its write stream has closed. The file
// is opened asynchronously (the libuv thread pool), so under load a body that failed before the
// open completed used to reject first: a caller deleting the partial on failure (the OCR
// installer's `.part` cleanup on cancel) ran before the file existed, and the late open then left
// an orphan behind a settled job — seen once as a full-suite flake of the installer's cancel test.
// The load is simulated deterministically here: every write stream's open is delayed through the
// stream's own `fs` option, via the pass-through `node:fs` mock (the repo's fault-injection rule).

const OPEN_DELAY_MS = 60
/** The bound that ships, spelled here on purpose (`FAIL_CLOSE_WAIT_MS`): a change to it is a decision, not a refactor. */
const FAIL_CLOSE_WAIT_MS = 5_000

// Keyed by path, so a row's late open or close can never land on the next row's counts: read as one
// shared tally, the first row's close arrived after the reset and stood in for the abort row's own.
const probe = vi.hoisted(() => {
  const files = new Map<string, { issuedOpens: number; pendingOpens: number; closes: number; silentCloses: number }>()
  return {
    pathOfFd: new Map<number, string>(),
    /** Hold every open, so the failure arrives first. */
    delayOpens: true,
    /** The descriptor closes, but the stream never hears of it: only the bound can settle the failure. */
    silentCloses: false,
    file(path: string) {
      let file = files.get(path)
      if (!file) {
        file = { issuedOpens: 0, pendingOpens: 0, closes: 0, silentCloses: 0 }
        files.set(path, file)
      }
      return file
    }
  }
})

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
      const file = probe.file(path)
      file.issuedOpens++
      file.pendingOpens++
      const open = (): void =>
        actual.open(path, flags, mode, (err, fd) => {
          file.pendingOpens--
          probe.pathOfFd.set(fd, path)
          done(err, fd)
        })
      if (probe.delayOpens) setTimeout(open, OPEN_DELAY_MS)
      else open()
    },
    write: actual.write,
    writev: actual.writev,
    close: (fd: number, done: (err: NodeJS.ErrnoException | null) => void): void => {
      const file = probe.file(probe.pathOfFd.get(fd) ?? '')
      actual.close(fd, (err) => {
        if (probe.silentCloses) {
          file.silentCloses++
          return
        }
        file.closes++
        done(err)
      })
    }
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
    probe.delayOpens = true
    probe.silentCloses = false
  })
  afterEach(() => {
    vi.useRealTimers()
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
    const file = probe.file(dest)
    expect(file.issuedOpens).toBe(1)
    expect(file.pendingOpens).toBe(0)
    expect(file.closes).toBe(1)
    expect(existsSync(dest)).toBe(true)
    rmSync(dest) // not forced: throws if the file is absent or still held, so a caller's delete is final
  })

  it('a stream that never reports its close rejects at the bound, so it cannot pin the job forever', async () => {
    probe.delayOpens = false
    probe.silentCloses = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dest = join(tempRoot('dl-close'), 'deu.traineddata.gz.part')
    const controller = new AbortController()
    let rejection: unknown = null
    const pending = downloadToFile('https://example.test/deu.gz', dest, {
      fetchImpl: hangingFetch('partial'),
      signal: controller.signal
    }).catch((err: unknown) => {
      rejection = err
    })
    controller.abort()
    await until(() => probe.file(dest).silentCloses === 1, 'the close reaching the filesystem')
    // No fake time has passed since the failure armed its timer, so these two steps are exact.
    await vi.advanceTimersByTimeAsync(FAIL_CLOSE_WAIT_MS - 1)
    expect(rejection).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(String(rejection)).toMatch(/aborted/)
    await pending
  })
})
