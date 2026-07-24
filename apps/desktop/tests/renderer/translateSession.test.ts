// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  acknowledgeError,
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
import type { PreloadApi } from '../../src/preload'
import { stubApi } from '../helpers/renderer'

// F-41 (audit-2026-07-16): stub payloads are typed against the real PreloadApi bridge contract
// (no `as never` erasure) — a rename of any mocked method or of TranslateJob reddens typecheck.
// The one intentional exception (a malformed `translateStart` resolve, L6b) is expressed as a
// narrow `as unknown as TranslateJob` at exactly the violating field, not a blanket erasure.

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
    })

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
    stubApi({ getActiveTranslateJob: vi.fn(async () => null) })
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
    })

    const first = await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    expect(first).toBe('started')
    const second = await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    expect(second).toBe('busy')
  })

  it('translate() no-ops on empty text', async () => {
    stubApi({})
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
    })

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
    })

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
    })

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
      // Deliberately contract-violating: the bridge type promises a TranslateJob but this
      // malformed resolve yields undefined (the L6b defensive-handling case under test).
      translateStart: vi.fn(async () => undefined as unknown as TranslateJob),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    })

    const outcome = await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    expect(outcome).toBe('started')
    const snap = getTranslateSession()
    expect(snap.state).toBe('failed')
    expect(snap.error).toBe('runtimeFailed')
    expect(snap.translating).toBe(false) // not wedged: Stop is no longer dead
  })

  it('adoptActiveJob still adopts after the store was cleared — reload recovery is not broken', async () => {
    // CONTROL for the "must not clobber a held session" block below: the ONLY store shape the adopt
    // is meant for is an EMPTY one (that is exactly what a renderer reload leaves behind), and it
    // must keep working there. Clear the store first so the emptiness is the real post-reload shape,
    // then assert the full recovery: seed + resume the live stream.
    const token: { fn?: (t: string) => void } = {}
    stubApi({
      getActiveTranslateJob: vi.fn(async (): Promise<TranslateJob> => ({ jobId: 'j7', state: 'queued', text: 'Teil ' })),
      onTranslateToken: vi.fn((_id: string, cb: (t: string) => void) => {
        token.fn = cb
        return () => {}
      }),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    })
    clearTranslateSession()
    expect(getTranslateSession().state).toBe('idle')
    expect(getTranslateSession().output).toBe('')

    await adoptActiveJob()
    const snap = getTranslateSession()
    expect(snap.activeJobId).toBe('j7')
    expect(snap.output).toBe('Teil ')
    expect(snap.state).toBe('translating')
    expect(snap.translating).toBe(true) // Stop is live again
    token.fn?.('zwei')
    expect(getTranslateSession().output).toBe('Teil zwei') // polling/streaming resumed
  })

  it('clearTranslateSession drops resident content (workspace lock)', async () => {
    stubApi({
      getActiveTranslateJob: vi.fn(async (): Promise<TranslateJob> => ({ jobId: 'j9', state: 'translating', text: 'geheim' })),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    })
    await adoptActiveJob()
    expect(getTranslateSession().output).toBe('geheim')

    clearTranslateSession()
    expect(getTranslateSession().output).toBe('')
    expect(getTranslateSession().activeJobId).toBeNull()
    expect(getTranslateSession().state).toBe('idle')
  })
})

// ---- The mount adopt runs on EVERY Translate mount, not only after a renderer reload ----
//
// `adoptActiveJob` used to gate on `activeJobId` alone, and that id is NULL in every TERMINAL state
// (the done/error stream handlers and `stopActive` all clear it) — so the guard read "nothing here"
// on a panel that was showing a finished / failed / just-cancelled translation, and the adopt then
// replaced the held text with `job.text ?? ''` and flipped the panel back to "translating". These
// tests pin the corrected rule: adopt only into a GENUINELY EMPTY store.

describe('translateSession — adoptActiveJob must not clobber a held session', () => {
  /** Stream stubs that hand the per-job token/done/error callbacks back to the test. */
  function streamStubs(): {
    api: Partial<PreloadApi>
    token: { fn?: (t: string) => void }
    done: { fn?: (j: TranslateJob) => void }
    error: { fn?: (j: TranslateJob) => void }
    cancel: ReturnType<typeof vi.fn>
  } {
    const token: { fn?: (t: string) => void } = {}
    const done: { fn?: (j: TranslateJob) => void } = {}
    const error: { fn?: (j: TranslateJob) => void } = {}
    const cancel = vi.fn(async () => ({ jobId: 'j1', state: 'cancelled' }) as TranslateJob)
    return {
      token,
      done,
      error,
      cancel,
      api: {
        getActiveTranslateJob: vi.fn(async (): Promise<TranslateJob | null> => null),
        translateStart: vi.fn(async () => ({ jobId: 'j1', state: 'translating', text: '' }) as TranslateJob),
        translateCancel: cancel,
        onTranslateToken: vi.fn((_id: string, cb: (t: string) => void) => {
          token.fn = cb
          return () => {}
        }),
        onTranslateDone: vi.fn((_id: string, cb: (j: TranslateJob) => void) => {
          done.fn = cb
          return () => {}
        }),
        onTranslateError: vi.fn((_id: string, cb: (j: TranslateJob) => void) => {
          error.fn = cb
          return () => {}
        })
      }
    }
  }

  it('does NOT wipe a CANCELLED translation the user stopped, when the panel is re-entered', async () => {
    // The reachable path. Stop cancels main-side via `translateCancel(...)`, whose rejection is
    // deliberately swallowed so a failed cancel can never break the UI — so main can keep the job in
    // `translating` while this store shows `cancelled` with the partial output the user chose to
    // keep. `activeJobId` is null there, so the old id-only guard let the next mount adopt that
    // still-"running" job straight over the held result.
    const s = streamStubs()
    stubApi(s.api)
    await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo Welt' })
    s.token.fn?.('Hello ')
    s.token.fn?.('world')
    stopActive()

    expect(s.cancel).toHaveBeenCalledWith('j1') // the cancel WAS issued — its outcome is unobservable

    const held = getTranslateSession()
    expect(held.state).toBe('cancelled')
    expect(held.output).toBe('Hello world')
    expect(held.activeJobId).toBeNull() // ← what the old guard mistook for "this store is empty"
    expect(held.translating).toBe(false)

    // Back on the Translate screen: the mount effect re-runs the adopt while main — never having
    // processed the cancel — still reports the job as running.
    const adoptApi = {
      getActiveTranslateJob: vi.fn(async (): Promise<TranslateJob> => ({ jobId: 'j1', state: 'translating', text: 'Hello wo' })),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    }
    stubApi(adoptApi)
    await adoptActiveJob()

    const snap = getTranslateSession()
    expect(snap.state).toBe('cancelled') // not flipped back to 'translating'
    expect(snap.output).toBe('Hello world') // not replaced by the job's shorter accumulated text
    expect(snap.activeJobId).toBeNull()
    expect(snap.translating).toBe(false)
    expect(snap).toBe(held) // nothing was written at all (same snapshot object)
    expect(adoptApi.onTranslateToken).not.toHaveBeenCalled() // no stream wired over the held result
  })

  it('does NOT wipe a DONE translation the user is still reading', async () => {
    // Same invariant on the other terminal state: `done` also clears `activeJobId`, and the panel
    // then renders the finished text with a Copy action. Whatever main reports afterwards, a mount
    // must not replace a completed result with a fresh "translating" frame.
    const s = streamStubs()
    stubApi(s.api)
    await translate({ sourceLang: 'de', targetLang: 'en', text: 'Guten Tag' })
    s.done.fn?.({ jobId: 'j1', state: 'done', text: 'Good day.' })

    const finished = getTranslateSession()
    expect(finished.state).toBe('done')
    expect(finished.output).toBe('Good day.')
    expect(finished.activeJobId).toBeNull()

    const adoptApi = {
      getActiveTranslateJob: vi.fn(async (): Promise<TranslateJob> => ({ jobId: 'j1', state: 'translating', text: 'Good' })),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    }
    stubApi(adoptApi)
    await adoptActiveJob()

    const snap = getTranslateSession()
    expect(snap.state).toBe('done')
    expect(snap.output).toBe('Good day.')
    expect(snap.translating).toBe(false)
    expect(snap).toBe(finished)
    expect(adoptApi.onTranslateToken).not.toHaveBeenCalled()
  })

  it('does NOT wipe the partial output kept after a failed banner was dismissed', async () => {
    // `acknowledgeError` parks the store at `idle` while deliberately KEEPING the partial text (the
    // panel still renders it, with Copy) — so `idle` alone does not mean empty in this store, and
    // the emptiness gate checks the output too.
    const s = streamStubs()
    stubApi(s.api)
    await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo Welt' })
    s.token.fn?.('Half a ')
    s.token.fn?.('translation')
    s.error.fn?.({ jobId: 'j1', state: 'failed', error: 'runtimeFailed' })
    expect(getTranslateSession().state).toBe('failed')
    acknowledgeError() // the user dismisses the banner; the partial text stays on screen

    const kept = getTranslateSession()
    expect(kept.state).toBe('idle')
    expect(kept.output).toBe('Half a translation')

    const adoptApi = {
      getActiveTranslateJob: vi.fn(async (): Promise<TranslateJob> => ({ jobId: 'j2', state: 'translating', text: '' })),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    }
    stubApi(adoptApi)
    await adoptActiveJob()

    const snap = getTranslateSession()
    expect(snap.output).toBe('Half a translation')
    expect(snap.state).toBe('idle')
    expect(snap).toBe(kept)
    expect(adoptApi.onTranslateToken).not.toHaveBeenCalled()
  })

  it('bails when a translate STARTED while the active-job read was in flight (post-await re-check)', async () => {
    // The re-check must enforce the SAME emptiness rule as the entry guard, or the no-op is true
    // only at function entry and not at the moment of the destructive `set`. `translate()` flips the
    // store to `translating` SYNCHRONOUSLY, before its own round-trip resolves and sets
    // `activeJobId` — so an id-only re-check sailed straight past a translation the user had just
    // started: it seeded the older job's text AND bumped `startGen`, which made the in-flight
    // start cancel the user's brand-new job as an orphan.
    let resolveActive!: (j: TranslateJob) => void
    const activeP = new Promise<TranslateJob>((r) => (resolveActive = r))
    let resolveStart!: (j: TranslateJob) => void
    const startP = new Promise<TranslateJob>((r) => (resolveStart = r))
    const wired: string[] = []
    const cancel = vi.fn(async () => ({ jobId: 'fresh', state: 'cancelled' }) as TranslateJob)
    const api = {
      getActiveTranslateJob: vi.fn(() => activeP),
      translateStart: vi.fn(() => startP),
      translateCancel: cancel,
      onTranslateToken: vi.fn((id: string) => {
        wired.push(id)
        return () => {}
      }),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    }
    stubApi(api)

    // The mount adopt is parked on the active-job read.
    const adoptPromise = adoptActiveJob()
    await vi.waitFor(() => expect(api.getActiveTranslateJob).toHaveBeenCalled(), { timeout: 3000 })

    // The user hits Translate in that window: translating, no job id yet.
    const translatePromise = translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    expect(getTranslateSession().state).toBe('translating')
    expect(getTranslateSession().activeJobId).toBeNull()

    resolveActive({ jobId: 'stale', state: 'translating', text: 'alte Übersetzung' })
    await adoptPromise

    // The adopt bailed: it neither seeded the older job nor superseded the in-flight start.
    expect(getTranslateSession().output).toBe('')
    expect(getTranslateSession().activeJobId).toBeNull()

    resolveStart({ jobId: 'fresh', state: 'translating', text: '' })
    expect(await translatePromise).toBe('started')
    expect(getTranslateSession().activeJobId).toBe('fresh') // the user's own job owns the panel
    expect(cancel).not.toHaveBeenCalled() // it was not cancelled as a supposed orphan
    expect(wired).toEqual(['fresh']) // exactly one stream, on the new job
  })
})

// ---- The adopt's await window must be guarded by the GENERATION, not by emptiness alone ----
//
// Emptiness answers "is anything on screen right now?", which is the wrong question for work that
// happened DURING the active-job read. A workspace lock is the case that breaks the emptiness rule
// outright: the lock purge resets this store to EMPTY, so a store that was legitimately invalidated
// mid-read looks identical to the post-reload store the adopt exists for. Only a generation token
// captured BEFORE the await — and re-checked after it — can tell the two apart.

describe('translateSession — adoptActiveJob must not re-seed content a lock purge dropped', () => {
  it('bails when a workspace LOCK purged the store while the active-job read was in flight', async () => {
    // `App.lockNow` purges every session store AFTER main aborted the job, purged its job map and
    // re-encrypted the vault. If the `getActiveTranslateJob` read resolved with a still-running job
    // just before that purge landed, an emptiness-only guard reads the freshly-EMPTIED store as
    // "safe to adopt" and writes `job.text` straight back in — plus a live stream subscription —
    // leaving plaintext translation content resident in renderer memory for the whole locked period
    // (it is not rendered, the lock unmounts the screen, but it is resident until the next purge).
    let resolveActive!: (j: TranslateJob) => void
    const activeP = new Promise<TranslateJob>((r) => (resolveActive = r))
    const api = {
      getActiveTranslateJob: vi.fn(() => activeP),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    }
    stubApi(api)

    // The mount adopt is parked on the active-job read.
    const adoptPromise = adoptActiveJob()
    await vi.waitFor(() => expect(api.getActiveTranslateJob).toHaveBeenCalled(), { timeout: 3000 })

    clearTranslateSession() // the workspace locks in that window (the renderer lock seam)
    const purged = getTranslateSession()

    resolveActive({ jobId: 'j-locked', state: 'translating', text: 'vertraulicher Text' })
    await adoptPromise

    const snap = getTranslateSession()
    expect(snap.output).toBe('') // no plaintext re-seeded behind the lock
    expect(snap.state).toBe('idle')
    expect(snap.activeJobId).toBeNull()
    expect(snap.translating).toBe(false)
    expect(snap).toBe(purged) // nothing was written at all (same snapshot object)
    expect(api.onTranslateToken).not.toHaveBeenCalled() // no stream wired over the locked workspace
  })

  it('bails when the user STOPPED a translation while the active-job read was in flight', async () => {
    // The other invalidation that must reach a parked adopt. Stop leaves the store at `cancelled`
    // (non-empty) AND bumps the generation, so the adopt refuses under either rule — pinned so a
    // change to one of them cannot quietly re-open the window.
    let resolveActive!: (j: TranslateJob) => void
    const activeP = new Promise<TranslateJob>((r) => (resolveActive = r))
    const api = {
      getActiveTranslateJob: vi.fn(() => activeP),
      translateStart: vi.fn(async () => ({ jobId: 'j1', state: 'translating', text: '' }) as TranslateJob),
      translateCancel: vi.fn(async () => ({ jobId: 'j1', state: 'cancelled' }) as TranslateJob),
      onTranslateToken: vi.fn(() => () => {}),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    }
    stubApi(api)

    const adoptPromise = adoptActiveJob()
    await vi.waitFor(() => expect(api.getActiveTranslateJob).toHaveBeenCalled(), { timeout: 3000 })

    // The user runs their own translation and stops it while the adopt is still parked.
    await translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })
    stopActive()
    const stopped = getTranslateSession()
    expect(stopped.state).toBe('cancelled')

    resolveActive({ jobId: 'stale', state: 'translating', text: 'alte Übersetzung' })
    await adoptPromise

    expect(getTranslateSession()).toBe(stopped) // the stopped session was left exactly as it was
    expect(getTranslateSession().output).toBe('')
  })

  it('CONTROL: still adopts when nothing invalidates the store during a slow active-job read', async () => {
    // The guard must not cost the case the adopt exists for. A renderer reload leaves an EMPTY store
    // and a job still running in main; a slow read with no intervening action must still seed the
    // accumulated text and resubscribe. The earlier lock is deliberate: the generation is a running
    // counter, so the token has to be READ at entry, never assumed to start at zero.
    clearTranslateSession() // a previous lock already moved the generation on
    let resolveActive!: (j: TranslateJob) => void
    const activeP = new Promise<TranslateJob>((r) => (resolveActive = r))
    const token: { fn?: (t: string) => void } = {}
    const api = {
      getActiveTranslateJob: vi.fn(() => activeP),
      onTranslateToken: vi.fn((_id: string, cb: (t: string) => void) => {
        token.fn = cb
        return () => {}
      }),
      onTranslateDone: vi.fn(() => () => {}),
      onTranslateError: vi.fn(() => () => {})
    }
    stubApi(api)

    const adoptPromise = adoptActiveJob()
    await vi.waitFor(() => expect(api.getActiveTranslateJob).toHaveBeenCalled(), { timeout: 3000 })
    resolveActive({ jobId: 'j5', state: 'translating', text: 'Teil ' })
    await adoptPromise

    const snap = getTranslateSession()
    expect(snap.activeJobId).toBe('j5')
    expect(snap.output).toBe('Teil ')
    expect(snap.state).toBe('translating')
    expect(snap.translating).toBe(true) // Stop is live again
    token.fn?.('zwei')
    expect(getTranslateSession().output).toBe('Teil zwei') // the live stream really is wired
  })
})
