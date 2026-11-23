import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeFileSync, type ReadStream } from 'node:fs'
import { join } from 'node:path'
import { tempRoot } from '../helpers/db-fixtures'
import { sha256 } from '../helpers/manifest-fixtures'

// #1033: `sha256File` settles only once its read stream has CLOSED the file. It used to resolve on `end`, and the
// stream closes its descriptor after that, through the libuv thread pool: under load a caller that renamed the file's
// folder right after the hash (an engine swap after a check of the same copy, the engine-swap suite's own rename after
// `verifyBinaryBeforeSpawn`) still found the file open, and Windows refused the rename (EPERM). Measured on Windows
// with the thread pool busy: 1,000 of 1,000 folder renames right after the hash refused, none once the hash settled
// on `close`. The slow close is simulated deterministically here: the next read stream's `close` goes through the
// stream's own `fs` option, via the pass-through `node:fs` mock (the repo's fault-injection rule, as #410's
// download-fail-close.test.ts). Every other stream, and every other call, is the real one.

type NextStream =
  | { mode: 'hold'; reached: (release: () => void, stream: ReadStream) => void }
  | { mode: 'closeFails' }
  | { mode: 'destroyedEarly' }

/** How the NEXT read stream closes its file; taken (and cleared) when that stream is made. */
const probe = vi.hoisted(() => ({ next: null as NextStream | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  type ReadOptions = Exclude<Parameters<typeof actual.createReadStream>[1], string | undefined>
  const createReadStream = (path: string, options?: ReadOptions): ReadStream => {
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

import { sha256File } from '../../src/main/services/models'

describe('sha256File settles only once the file is closed (#1033)', () => {
  afterEach(() => {
    probe.next = null
  })

  /** Arms the next read stream: its file stays open until the row calls `release`. */
  function holdNextClose(): Promise<{ release: () => void; stream: ReadStream }> {
    return new Promise((resolve) => {
      probe.next = { mode: 'hold', reached: (release, stream) => resolve({ release, stream }) }
    })
  }

  function engineFile(): string {
    const file = join(tempRoot('hash-close'), 'llama-server.exe')
    writeFileSync(file, 'engine b200')
    return file
  }

  // A cancel while the file is read still rejects as cancelled, once the file is closed. An abort from the final
  // progress call, inside `end` (a cancel between two weights fires there, models.test.ts #420), is too late to stop
  // anything: the finished hash stands, as when it resolved at `end`, and is handed over once the file is closed.
  it.each([
    ['a hash', 'never', true, null],
    ['a hash whose signal fires at its final progress call', 'finalProgress', true, null],
    ['a hash cancelled while it reads', 'whileReading', false, /cancelled/i]
  ] as const)('%s settles only after its file is closed', async (_title, abort, readWhole, rejects) => {
    const file = engineFile()
    const closing = holdNextClose()
    const controller = new AbortController()
    let settled = false
    const onProgress = abort === 'finalProgress' ? () => controller.abort() : undefined
    const hashed = sha256File(file, onProgress, controller.signal)
    hashed.then(
      () => (settled = true),
      () => (settled = true)
    )
    if (abort === 'whileReading') controller.abort()
    const { release, stream } = await closing
    // The premise: whether the stream read the whole file (`end`), and that the abort landed; the file is still open.
    expect(stream.readableEnded).toBe(readWhole)
    expect(controller.signal.aborted).toBe(abort !== 'never')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    release()
    if (rejects) await expect(hashed).rejects.toThrow(rejects)
    else await expect(hashed).resolves.toBe(sha256('engine b200'))
  })

  it.each([
    ['closes before it read the file', 'destroyedEarly' as const, /closed before it finished/],
    ['cannot close the file after reading it', 'closeFails' as const, /EIO/]
  ])('a stream that %s rejects', async (_title, mode, message) => {
    const file = engineFile()
    probe.next = { mode }
    await expect(sha256File(file)).rejects.toThrow(message)
  })
})
