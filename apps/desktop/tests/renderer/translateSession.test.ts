// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  adoptActiveJob,
  clearTranslateSession,
  getTranslateSession,
  resetTranslateSessionForTests,
  translate
} from '../../src/renderer/lib/translateSession'
import type { TranslateJob } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Unit test for the Translate-view module store (TG-4, plan §2 D6): the remount recovery
// (`adoptActiveJob`), the one-at-a-time guard, and the lock-time content purge. The TranslateScreen
// renderer suite covers the happy translate→stream→copy path through this store; this file targets
// the recovery/guard edges directly.

afterEach(() => {
  resetTranslateSessionForTests()
})

describe('translateSession — remount recovery + guards', () => {
  it('adoptActiveJob re-adopts a still-running job from main and seeds its partial text', async () => {
    const token: { fn?: (t: string) => void } = {}
    const running: TranslateJob = { jobId: 'j9', state: 'translating', text: 'Halb ' }
    stubApi({
      getActiveTranslateJob: vi.fn(async () => running),
      onTranslateToken: vi.fn((_id: string, cb: (t: string) => void) => {
        token.fn = cb
        return () => {}
      }),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    } as never)

    await adoptActiveJob()
    let snap = getTranslateSession()
    expect(snap.activeJobId).toBe('j9')
    expect(snap.output).toBe('Halb ')
    expect(snap.translating).toBe(true)

    // Newly streamed tokens append onto the seeded text.
    token.fn?.('fertig')
    snap = getTranslateSession()
    expect(snap.output).toBe('Halb fertig')
  })

  it('adoptActiveJob is a no-op when main reports no running job', async () => {
    stubApi({ getActiveTranslateJob: vi.fn(async () => null) } as never)
    await adoptActiveJob()
    expect(getTranslateSession().activeJobId).toBeNull()
    expect(getTranslateSession().state).toBe('idle')
  })

  it('translate() busy-guards a second run while one is active', async () => {
    stubApi({
      getActiveTranslateJob: vi.fn(async () => null),
      translateStart: vi.fn(async () => ({ jobId: 'j1', state: 'queued', text: '' }) as TranslateJob),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    } as never)

    const first = await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    expect(first).toBe('started')
    const second = await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    expect(second).toBe('busy')
  })

  it('translate() no-ops on empty text', async () => {
    stubApi({} as never)
    expect(await translate({ sourceLang: 'de', targetLang: 'en', text: '   ' })).toBe('noop')
  })

  it('cancels the orphan job and does not wire a stream when superseded during the start round-trip', async () => {
    // The generation guard (invariant 6): a clear/lock/new-translate that lands WHILE translateStart
    // is in flight must bump startGen so the slow resolve bails — cancelling its now-orphan job —
    // instead of wiring a zombie stream a stale done/error would tear down over a newer job.
    let resolveStart!: (j: TranslateJob) => void
    const startPromise = new Promise<TranslateJob>((r) => (resolveStart = r))
    const cancel = vi.fn(async () => ({ jobId: 'orph', state: 'cancelled' }) as TranslateJob)
    stubApi({
      getActiveTranslateJob: vi.fn(async () => null),
      translateStart: vi.fn(() => startPromise),
      translateCancel: cancel,
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    } as never)

    const p = translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    clearTranslateSession() // supersede while the start round-trip is in flight
    resolveStart({ jobId: 'orph', state: 'queued', text: '' })
    expect(await p).toBe('started')

    expect(cancel).toHaveBeenCalledWith('orph') // the orphan job was cancelled main-side
    expect(getTranslateSession().activeJobId).toBeNull() // no zombie stream wired
    expect(getTranslateSession().state).toBe('idle') // stayed cleared, not 'translating'
  })

  it('clearTranslateSession drops resident content (workspace lock)', async () => {
    stubApi({
      getActiveTranslateJob: vi.fn(async () => ({ jobId: 'j9', state: 'translating', text: 'geheim' })),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    } as never)
    await adoptActiveJob()
    expect(getTranslateSession().output).toBe('geheim')

    clearTranslateSession()
    expect(getTranslateSession().output).toBe('')
    expect(getTranslateSession().activeJobId).toBeNull()
    expect(getTranslateSession().state).toBe('idle')
  })
})
