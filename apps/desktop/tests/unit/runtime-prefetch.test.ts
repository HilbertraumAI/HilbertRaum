import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startModelPrefetch } from '../../src/main/services/runtime/prefetch'

// #114: the sequential prefetch reader itself, against real (small) files. The ladder
// wiring — first-rung-only, skip-when-hashed, CODE-2 abort — is pinned in
// runtime-ladder.test.ts; here only the reader's own contract: reads to EOF, honors
// abort, and NEVER rejects (a failure is an outcome, not an error — the start must
// stay untouchable by prefetch trouble).

let dir: string
let fileA: string
let fileB: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hr-prefetch-'))
  fileA = join(dir, 'a.bin')
  fileB = join(dir, 'b.bin')
  await writeFile(fileA, Buffer.alloc(256 * 1024, 1))
  await writeFile(fileB, Buffer.alloc(64 * 1024, 2))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('startModelPrefetch (#114)', () => {
  it('reads every file to EOF and settles done', async () => {
    const p = startModelPrefetch([fileA, fileB])
    await expect(p.done).resolves.toBe('done')
  })

  it('an immediate abort settles aborted without reading', async () => {
    const p = startModelPrefetch([fileA, fileB])
    p.abort()
    await expect(p.done).resolves.toBe('aborted')
  })

  it('abort after completion leaves the done outcome (idempotent)', async () => {
    const p = startModelPrefetch([fileA])
    await expect(p.done).resolves.toBe('done')
    p.abort() // late abort (the ladder always aborts at window end) must not rewrite history
    await expect(p.done).resolves.toBe('done')
  })

  it('a missing file settles failed — never rejects', async () => {
    const p = startModelPrefetch([join(dir, 'no-such-file.bin')])
    await expect(p.done).resolves.toBe('failed')
  })

  it('a missing file after a good one still settles failed (partial prefetch is harmless)', async () => {
    const p = startModelPrefetch([fileA, join(dir, 'no-such-file.bin')])
    await expect(p.done).resolves.toBe('failed')
  })
})
