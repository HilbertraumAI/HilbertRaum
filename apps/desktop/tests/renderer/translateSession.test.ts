// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  adoptActiveJob,
  clearTranslateSession,
  getTranslateSession,
  resetTranslateSessionForTests,
  stopActive,
  translate
} from '../../src/renderer/lib/translateSession'
import { resetFileTranslateSessionForTests } from '../../src/renderer/lib/fileTranslateSession'
import { resetDocTaskStoreForTests } from '../../src/renderer/lib/doctasks'
import type { TranslateJob } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Unit test for the Translate-view module store (TG-4, plan §2 D6): the remount recovery
// (`adoptActiveJob`), the one-at-a-time guard, and the lock-time content purge. The TranslateScreen
// renderer suite covers the happy translate→stream→copy path through this store; this file targets
// the recovery/guard edges directly.

afterEach(() => {
  resetTranslateSessionForTests()
  // translate()'s cross-session start guard (L6a) reads the file + doc-task stores — reset them too.
  resetFileTranslateSessionForTests()
  resetDocTaskStoreForTests()
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

  it('Stop during the start round-trip supersedes and cancels the just-started job (L5)', async () => {
    // Stop shows as soon as `translating` is true — before translateStart resolves and sets
    // activeJobId. stopActive() must bump the generation so the in-flight start's post-await branch
    // sees itself superseded and cancels the orphan; otherwise Stop is silently swallowed.
    let resolveStart!: (j: TranslateJob) => void
    const startPromise = new Promise<TranslateJob>((r) => (resolveStart = r))
    const cancel = vi.fn(async () => ({ jobId: 'j1', state: 'cancelled' }) as TranslateJob)
    stubApi({
      getActiveTranslateJob: vi.fn(async () => null),
      translateStart: vi.fn(() => startPromise),
      translateCancel: cancel,
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    } as never)

    const p = translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    // Mid start round-trip: translating true, no job id yet.
    expect(getTranslateSession().translating).toBe(true)
    expect(getTranslateSession().activeJobId).toBeNull()

    stopActive() // Stop with no activeJobId yet — must still supersede.
    expect(getTranslateSession().state).toBe('cancelled')
    expect(getTranslateSession().translating).toBe(false)

    resolveStart({ jobId: 'j1', state: 'queued', text: '' })
    expect(await p).toBe('started')
    expect(cancel).toHaveBeenCalledWith('j1') // the just-started job was cancelled main-side
    expect(getTranslateSession().activeJobId).toBeNull() // no zombie stream wired
  })

  it('busy-guards a second translate during the start round-trip (L6a translating gap)', async () => {
    // The old entry guard checked only activeJobId, so a second click WHILE the first start round-trip
    // was in flight (translating, no id yet) slipped through and started a second job.
    let resolveStart!: (j: TranslateJob) => void
    const startPromise = new Promise<TranslateJob>((r) => (resolveStart = r))
    const translateStart = vi.fn(() => startPromise)
    stubApi({
      getActiveTranslateJob: vi.fn(async () => null),
      translateStart,
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    } as never)

    const first = translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    const second = await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    expect(second).toBe('busy')
    expect(translateStart).toHaveBeenCalledTimes(1)

    resolveStart({ jobId: 'j1', state: 'queued', text: '' })
    await first
  })

  it('a malformed translateStart resolve does not wedge the store stuck translating (L6b)', async () => {
    // job.error was dereferenced outside any try; an undefined/malformed bridge resolve threw OUT of
    // translate() (whose .then caller has no .catch), leaving the store stuck translating. The
    // defensive resolve handling now treats it as a runtime failure and resets translating.
    stubApi({
      getActiveTranslateJob: vi.fn(async () => null),
      translateStart: vi.fn(async () => undefined),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    } as never)

    const outcome = await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    expect(outcome).toBe('started')
    const snap = getTranslateSession()
    expect(snap.state).toBe('failed')
    expect(snap.error).toBe('runtimeFailed')
    expect(snap.translating).toBe(false) // not wedged: Stop is no longer dead
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
