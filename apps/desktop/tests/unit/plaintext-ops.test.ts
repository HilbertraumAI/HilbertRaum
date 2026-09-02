import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlaintextOps } from '../../src/main/services/ingestion/plaintext-ops'

// #237 — the registry every plaintext-materialising operation (preview / re-index / import
// prepare / dictation / export) joins before it writes a `.parse*` transient. Lock and quit
// abort it, await its settle within a bound and shred whatever is still registered. These are
// the registry's own contracts; the lock/quit wiring is proven end-to-end in
// `tests/integration/lock-admission-race.test.ts`.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-plaintext-ops-'))
}

describe('plaintext operation registry (#237)', () => {
  it('register → release: counts live operations; release is idempotent', () => {
    const ops = createPlaintextOps()
    expect(ops.size()).toBe(0)
    const a = ops.register('preview')
    const b = ops.register('export')
    expect(ops.size()).toBe(2)
    expect(a.id).not.toBe(b.id)
    expect(a.kind).toBe('preview')
    a.release()
    a.release()
    expect(ops.size()).toBe(1)
    b.release()
    expect(ops.size()).toBe(0)
  })

  it('abortAll aborts every live operation, leaves released ones alone, and is idempotent', () => {
    const ops = createPlaintextOps()
    const live = ops.register('reindex')
    const done = ops.register('import-prepare')
    done.release()
    expect(live.signal.aborted).toBe(false)
    ops.abortAll()
    expect(live.signal.aborted).toBe(true)
    expect(done.signal.aborted).toBe(false)
    ops.abortAll() // nothing to re-abort, nothing thrown
    expect(live.signal.aborted).toBe(true)
  })

  it('a parent signal aborts the operation too; a parent already aborted yields an aborted op', () => {
    const ops = createPlaintextOps()
    const parent = new AbortController()
    const op = ops.register('dictation', parent.signal)
    expect(op.signal.aborted).toBe(false)
    parent.abort(new Error('timed out'))
    expect(op.signal.aborted).toBe(true)
    expect((op.signal.reason as Error).message).toBe('timed out')

    const gone = new AbortController()
    gone.abort()
    expect(ops.register('dictation', gone.signal).signal.aborted).toBe(true)
  })

  it('awaitSettled resolves true at once when nothing is live', async () => {
    const ops = createPlaintextOps()
    expect(await ops.awaitSettled(1)).toBe(true)
  })

  it('awaitSettled resolves false once the bound elapses with an operation still live', async () => {
    const ops = createPlaintextOps()
    ops.register('preview')
    expect(await ops.awaitSettled(20)).toBe(false)
    expect(ops.size()).toBe(1) // the bound does not release anything
  })

  it('awaitSettled resolves true as soon as the last live operation releases', async () => {
    const ops = createPlaintextOps()
    const op = ops.register('preview')
    const settled = ops.awaitSettled(5_000)
    setTimeout(() => op.release(), 5)
    expect(await settled).toBe(true)
  })

  it('sweepRegistered shreds only the tracked transients (and their .tmp stage) of LIVE operations', () => {
    const dir = scratch()
    const ops = createPlaintextOps()
    const op = ops.register('preview')
    const transient = join(dir, 'doc-1.parse-preview-abc.pdf')
    const stage = `${transient}.tmp`
    const stored = join(dir, 'doc-1.pdf.enc')
    const neighbour = join(dir, 'doc-2.parse-preview-def.pdf') // a transient nobody registered
    for (const p of [transient, stage, stored, neighbour]) writeFileSync(p, 'x'.repeat(64))
    op.track(transient)
    // A tracked path that never materialised is simply skipped.
    op.track(join(dir, 'never-written.parse.txt'))

    expect(ops.sweepRegistered()).toBe(2)
    expect(existsSync(transient)).toBe(false)
    expect(existsSync(stage)).toBe(false)
    expect(existsSync(stored)).toBe(true)
    expect(existsSync(neighbour)).toBe(true)
    // Idempotent: a second sweep finds nothing.
    expect(ops.sweepRegistered()).toBe(0)
  })

  it('a released operation is out of the sweep (its own finally already shredded)', () => {
    const dir = scratch()
    const ops = createPlaintextOps()
    const op = ops.register('export')
    const transient = join(dir, 'doc-3.parse-export-xyz.txt')
    writeFileSync(transient, 'plaintext')
    op.track(transient)
    op.release()
    expect(ops.sweepRegistered()).toBe(0)
    expect(existsSync(transient)).toBe(true)
  })
})
