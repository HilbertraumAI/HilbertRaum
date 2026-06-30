import { describe, it, expect, vi } from 'vitest'

// rasterizer.ts imports `electron` (BrowserWindow/ipcMain) at module load — stub it so the pure
// RasterReplySlot (the hidden-window request/reply waiter) is unit-testable with no Electron.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { on: () => undefined, removeListener: () => undefined }
}))

import { RasterReplySlot } from '../../src/main/services/ocr/rasterizer'

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('RasterReplySlot — OCR rasterizer reply waiter (R6)', () => {
  // R6 (full-audit-2026-06-30, Phase C): a fresh expect() while a prior waiter is still unsettled
  // must REJECT the prior ('superseded') rather than silently overwrite it — an orphaned waiter
  // would otherwise hang to its 60 s withTimeout (a duplicate reply frame / future refactor).
  it('rejects a superseded prior waiter instead of orphaning it (R6)', async () => {
    const slot = new RasterReplySlot()
    let firstErr: Error | null = null
    const first = slot.expect('opened')
    first.catch((e: Error) => {
      firstErr = e
    })

    const second = slot.expect('page') // supersedes the still-pending 'opened' waiter
    await tick()
    // Reds (firstErr stays null) without the supersede guard.
    expect((firstErr as Error | null)?.message).toBe('superseded')

    // The current waiter still resolves normally — supersede only affected the orphaned prior.
    let secondMsg: unknown = null
    second.then((m) => {
      secondMsg = m
    })
    expect(slot.awaits('page')).toBe(true)
    slot.deliver({ ok: true })
    await tick()
    expect(secondMsg).toEqual({ ok: true })
  })

  it('delivers/fails the current waiter and reports whether one was pending', async () => {
    const slot = new RasterReplySlot()
    expect(slot.fail(new Error('none'))).toBe(false) // nothing armed yet

    const p = slot.expect('opened')
    let msg: unknown = null
    p.then((m) => {
      msg = m
    })
    expect(slot.awaits('opened')).toBe(true)
    expect(slot.awaits('page')).toBe(false)
    slot.deliver({ pageCount: 3 })
    await tick()
    expect(msg).toEqual({ pageCount: 3 })
    // The slot is empty after a delivery: a later error frame has no waiter to fail.
    expect(slot.fail(new Error('late'))).toBe(false)
  })

  it('fail() rejects the current waiter (error frame / abort) and returns true', async () => {
    const slot = new RasterReplySlot()
    let err: Error | null = null
    const p = slot.expect('page')
    p.catch((e: Error) => {
      err = e
    })
    expect(slot.fail(new Error('render failed'))).toBe(true)
    await tick()
    expect((err as Error | null)?.message).toBe('render failed')
  })
})
