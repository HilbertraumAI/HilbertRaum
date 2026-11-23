import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeFileSync, type ReadStream } from 'node:fs'
import { join } from 'node:path'
import { tempRoot } from '../helpers/db-fixtures'
import { sha256 } from '../helpers/manifest-fixtures'

// #1033: an unaborted `sha256File` settles only once its read stream has CLOSED the file. It used to resolve on
// `end`, and the stream closes its descriptor after that, through the libuv thread pool: under load a caller that
// renamed the file's folder right after the hash (an engine swap after a check of the same copy, the engine-swap
// suite's own rename after `verifyBinaryBeforeSpawn`) still found the file open, and Windows refused the rename
// (EPERM). Measured on Windows with the thread pool busy: 1,000 of 1,000 folder renames right after the hash refused,
// none once the hash settled on `close`. The slow close is simulated deterministically here: the next read stream's
// `close` goes through the stream's own `fs` option, via the pass-through `node:fs` mock (the repo's fault-injection
// rule, as #410's download-fail-close.test.ts). Every other stream, and every other call, is the real one.

type NextStream =
  | { mode: 'hold'; reached: (release: () => void, stream: ReadStream) => void }
  | { mode: 'closeFails' }
  | { mode: 'destroyedEarly' }

/** How the NEXT read stream closes its file (taken, and cleared, when that stream is made), and every path opened. */
const probe = vi.hoisted(() => ({ next: null as NextStream | null, opened: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  type ReadOptions = Exclude<Parameters<typeof actual.createReadStream>[1], string | undefined>
  const createReadStream = (path: string, options?: ReadOptions): ReadStream => {
    probe.opened.push(path)
    const next = probe.next
    if (!next) return actual.createReadStream(path, options)
    probe.next = null
    if (next.mode === 'destroyedEarly') {
      // Destroyed with no error before it read anything: a `close` with no `end` and no `error`.
      const stream = actual.createReadStream(path, options)
      stream.destroy()
      return stream
    }
    let stream: ReadStream | null = null
    const close = (fd: number, done: (err: NodeJS.ErrnoException | null) => void): void => {
      if (next.mode === 'hold') next.reached(() => actual.close(fd, done), stream as ReadStream)
      else actual.close(fd, () => done(Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' })))
    }
    stream = actual.createReadStream(path, {
      ...(options ?? {}),
      fs: { open: actual.open, read: actual.read, close }
    } as ReadOptions)
    return stream
  }
  const mocked = { ...actual, createReadStream }
  return { ...mocked, default: mocked }
})

import { sha256File, verifyChecksum } from '../../src/main/services/models'

describe('sha256File settles only once the file is closed (#1033)', () => {
  /** A held close a failed row never released: released after it, so no descriptor outlives the row. */
  let unreleased: (() => void) | null = null
  afterEach(() => {
    probe.next = null
    probe.opened = []
    unreleased?.()
    unreleased = null
  })

  /** Arms the next read stream: its file stays open until the row calls `release` (once). */
  function holdNextClose(): Promise<{ release: () => void; stream: ReadStream }> {
    return new Promise((resolve) => {
      probe.next = {
        mode: 'hold',
        reached: (closeFile, stream) => {
          let done = false
          const release = (): void => {
            if (done) return
            done = true
            unreleased = null
            closeFile()
          }
          unreleased = release
          resolve({ release, stream })
        }
      }
    })
  }

  function engineFile(): string {
    const file = join(tempRoot('hash-close'), 'llama-server.exe')
    writeFileSync(file, 'engine b200')
    return file
  }

  /** Records when `promise` settles, without ever leaving a rejection unhandled. */
  function settles(promise: Promise<unknown>): () => boolean {
    let settled = false
    promise.then(
      () => (settled = true),
      () => (settled = true)
    )
    return () => settled
  }

  const nextTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

  // An unaborted hash hands its digest over once the file is closed, and a cancel while the file is read still
  // rejects as cancelled once the file is closed (the abort destroys the stream with an error, #420).
  it.each([
    ['a hash', 'never', true, null],
    ['a hash cancelled while it reads', 'whileReading', false, /cancelled/i]
  ] as const)('%s settles only after its file is closed', async (_title, abort, readWhole, rejects) => {
    const file = engineFile()
    const closing = holdNextClose()
    const controller = new AbortController()
    const hashed = sha256File(file, undefined, controller.signal)
    const settled = settles(hashed)
    if (abort === 'whileReading') controller.abort()
    const { release, stream } = await closing
    // The premise: whether the stream read the whole file (`end`); its file is still open.
    expect(stream.readableEnded).toBe(readWhole)
    await nextTurn()
    expect(settled()).toBe(false)
    release()
    if (rejects) await expect(hashed).rejects.toThrow(rejects)
    else await expect(hashed).resolves.toBe(sha256('engine b200'))
  })

  // #1033 review: an abort from the final progress call, inside `end` (a cancel between two weights fires there,
  // models.test.ts #420), stops nothing, and must not wait for the close either (#420: a hash never simply stops
  // settling, and a saturated pool can hold that close): it resolves the finished hash at once, as before #1033.
  it('a hash whose signal fires at its final progress call resolves at once, while its file is still closing', async () => {
    const file = engineFile()
    const closing = holdNextClose()
    const controller = new AbortController()
    const hashed = sha256File(file, () => controller.abort(), controller.signal)
    const settled = settles(hashed)
    const { stream } = await closing
    expect(stream.readableEnded).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    await nextTurn()
    expect(settled()).toBe(true)
    await expect(hashed).resolves.toBe(sha256('engine b200'))
  })

  // …so the cached read is not dropped half-way: the last waiter's cancel retires the shared read, and a caller that
  // comes after it must find the finished hash cached, not start a second full read of a multi-GB weight.
  it('a cancel from the final progress call leaves the finished hash cached: a newcomer reads nothing', async () => {
    const file = engineFile()
    const closing = holdNextClose()
    const controller = new AbortController()
    await expect(
      verifyChecksum(file, sha256('engine b200'), undefined, () => controller.abort(), undefined, controller.signal)
    ).rejects.toThrow(/cancelled/i)
    await closing // the first read's file is still closing
    expect(probe.opened).toEqual([file])
    await expect(verifyChecksum(file, sha256('engine b200'))).resolves.toEqual({
      exists: true,
      matched: true,
      actual: sha256('engine b200')
    })
    expect(probe.opened).toEqual([file])
  })

  it('a stream that closes before it read the file rejects', async () => {
    const file = engineFile()
    probe.next = { mode: 'destroyedEarly' }
    await expect(sha256File(file)).rejects.toThrow(/closed before it finished/)
  })

  // #1033 review: a close that fails once the whole file was read does not undo the hash, as before #1033 (an import
  // from a flaky share whose bytes hashed fine still imports).
  it('a stream that cannot close the file after reading it still resolves the digest', async () => {
    const file = engineFile()
    probe.next = { mode: 'closeFails' }
    await expect(sha256File(file)).resolves.toBe(sha256('engine b200'))
  })
})
