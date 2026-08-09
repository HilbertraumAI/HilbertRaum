import { describe, it, expect, vi, beforeEach } from 'vitest'

// IPC-layer tests for registerTranslateIpc + TranslateJobService (TranslateGemma plan §2 D6,
// TG-4): the translate:* handlers return the right DTOs and stream on the per-job channels, a
// second start is busy-REJECTED, a document task holds the lane (docTaskBusy), no-model / bad
// language / same-language / empty are refused with a code, cancel + the lock/quit stop() abort an
// in-flight job, and getActiveTranslateJob recovers a running job. No real binary/model is used —
// the sidecar is a scripted `Translator`. The window planner is the REAL shared one.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { registerTranslateIpc } from '../../src/main/ipc/registerTranslateIpc'
import { TranslateJobService } from '../../src/main/services/translation/jobs'
import type { Translator } from '../../src/main/services/translation'
import { TRANSLATION_STOP_TOKEN, TranslationStartError } from '../../src/main/services/translation'
import { planTranslationWindows } from '../../src/main/services/doctasks/translation'
import { IPC, STREAM } from '../../src/shared/ipc'
import { TRANSLATE_MAX_TEXT_CHARS } from '../../src/shared/types'
import type { TranslateJob, TranslateRequest } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, invokeWithEvent, makeEvent, type FakeIpcEvent, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

function ctxFor(unlocked = true, locking = false): AppContext {
  // #163 (T-1): carry BOTH halves of `workspaceAdmitsWork` — the production guard is
  // `isUnlocked() && isLocking?.() !== true` (AUD-02), and stubbing only `isUnlocked` left a
  // regression back to a bare isUnlocked() check green across the whole suite.
  return {
    workspace: { isUnlocked: () => unlocked, isLocking: () => locking }
  } as unknown as AppContext
}

const goodReq = (over: Partial<TranslateRequest> = {}): TranslateRequest => ({
  sourceLang: 'de',
  targetLang: 'en',
  text: 'Hallo Welt.',
  ...over
})

/** A scripted translator: streams `reply(text)` as ONE token and resolves with it, honoring abort.
 *  Reports a CLEAN stop via `onFinal` (TA-5 M6 — the view now requires it to accept the window). */
function scriptedTranslator(opts: { ctx?: number; reply?: (text: string) => string } = {}): Translator {
  const reply = opts.reply ?? ((t: string) => `TR<${t}>`)
  return {
    modelId: 'translategemma-12b-it-q4',
    contextWindow: () => opts.ctx ?? 4096,
    async translate(o) {
      if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const out = reply(o.text)
      o.onToken?.(out)
      o.onFinal?.({ stoppingWord: TRANSLATION_STOP_TOKEN })
      return out
    },
    async stop() {},
    async suspend() {}
  }
}

/** A translator whose translate() streams one token then blocks until `release()` (or aborts). */
function gatedTranslator(): { translator: Translator; release: () => void; sawSignal: () => AbortSignal | undefined } {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let signal: AbortSignal | undefined
  return {
    release,
    sawSignal: () => signal,
    translator: {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => 4096,
      async translate(o) {
        signal = o.signal
        o.onToken?.('partial ')
        await Promise.race([
          gate,
          new Promise<void>((_res, rej) =>
            o.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
          )
        ])
        o.onFinal?.({ stoppingWord: TRANSLATION_STOP_TOKEN })
        return 'partial done'
      },
      async stop() {},
      async suspend() {}
    }
  }
}

function service(deps: {
  translator?: Translator | null
  hasDocTask?: boolean
}): TranslateJobService {
  return new TranslateJobService({
    getTranslator: () => deps.translator ?? null,
    hasActiveDocTask: () => deps.hasDocTask ?? false
  })
}

async function waitForTerminal(event: FakeIpcEvent, jobId: string): Promise<TranslateJob> {
  for (let i = 0; i < 300; i++) {
    const done = event.sender.send.mock.calls.find((c: unknown[]) => c[0] === STREAM.trDone(jobId))
    const err = event.sender.send.mock.calls.find((c: unknown[]) => c[0] === STREAM.trError(jobId))
    if (done) return done[1] as TranslateJob
    if (err) return err[1] as TranslateJob
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('translate job never reached a terminal state')
}

beforeEach(() => {
  ipcState.handlers.clear()
})

describe('registerTranslateIpc — translate job contract', () => {
  it('start returns a queued job and streams a single window to done', async () => {
    registerTranslateIpc(ctxFor(), service({ translator: scriptedTranslator() }))
    const event = makeEvent()
    const initial = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    expect(initial.state).toBe('queued')
    expect(typeof initial.jobId).toBe('string')

    const done = await waitForTerminal(event, initial.jobId)
    expect(done.state).toBe('done')
    expect(done.text).toBe('TR<Hallo Welt.>')
    expect(done.windowsTotal).toBe(1)
    // The delta reached the renderer on the per-job token channel.
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.trToken(initial.jobId), 'TR<Hallo Welt.>')
    expect(event.sender.send).toHaveBeenCalledWith(
      STREAM.trDone(initial.jobId),
      expect.objectContaining({ state: 'done' })
    )
  })

  it('splits a multi-paragraph paste on blank lines, plans >1 window, and streams them blank-line-joined', async () => {
    // Several paragraphs separated by blank lines; a small launched context forces >1 window. The
    // service splits on blank lines FIRST (so cuts fall on paragraph boundaries, not mid-sentence),
    // so the expected plan is computed the SAME way the service does.
    const paras = Array.from({ length: 6 }, (_v, p) =>
      Array.from({ length: 60 }, (_w, i) => `p${p}w${i}`).join(' ')
    )
    const long = paras.join('\n\n')
    const segments = long.split(/\n\s*\n+/).map((s) => s.trim()).filter((s) => s.length > 0)
    const plan = planTranslationWindows(segments, 1024)
    expect(plan.windows.length).toBeGreaterThan(1) // the fixture must actually split
    const expected = plan.windows.map((w) => `TR<${w}>`).join('\n\n')

    registerTranslateIpc(ctxFor(), service({ translator: scriptedTranslator({ ctx: 1024 }) }))
    const event = makeEvent()
    const initial = (await invokeWithEvent(
      handlers,
      IPC.translateStart,
      event,
      goodReq({ text: long })
    )) as TranslateJob
    const done = await waitForTerminal(event, initial.jobId)
    expect(done.state).toBe('done')
    expect(done.windowsTotal).toBe(plan.windows.length)
    // The final text equals the concatenation of the streamed windows — no spurious mid-sentence break.
    expect(done.text).toBe(expected)
    // The '\n\n' window separator was streamed live too (so the live panel matches the final text).
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.trToken(initial.jobId), '\n\n')
  })

  it('retries an empty window once, then fails the job runtimeFailed (M7)', async () => {
    // A window that stops CLEANLY but produces no text — a transiently empty window. The view
    // must not complete "done" with a missing paragraph: retry once, then fail visibly.
    let calls = 0
    const translator: Translator = {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => 4096,
      async translate(o) {
        calls += 1
        o.onFinal?.({ stoppingWord: TRANSLATION_STOP_TOKEN })
        return ''
      },
      async stop() {},
      async suspend() {}
    }
    registerTranslateIpc(ctxFor(), service({ translator }))
    const event = makeEvent()
    const initial = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    const terminal = await waitForTerminal(event, initial.jobId)
    expect(terminal.state).toBe('failed')
    expect(terminal.error).toBe('runtimeFailed')
    expect(calls).toBe(2) // one retry, then the job fails
  })

  it('a TRUNCATED window (no clean stop) fails the job IMMEDIATELY — no futile retry (M6/FA-2 F-2)', async () => {
    // A window that streams text but hits the output cap (no `stopping_word`/eos in the final
    // frame) is a DETERMINISTIC temperature-0 truncation — greedy decode reproduces it identically
    // on retry, so the view fails the window on the FIRST attempt rather than burning a second
    // ~30-min decode for the same outcome (F-2). Contrast the empty-window test above, which retries.
    let calls = 0
    const translator: Translator = {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => 4096,
      async translate(o) {
        calls += 1
        o.onToken?.('partial cut off')
        o.onFinal?.({}) // LIMIT stop — neither a stopping word nor eos
        return 'partial cut off'
      },
      async stop() {},
      async suspend() {}
    }
    registerTranslateIpc(ctxFor(), service({ translator }))
    const event = makeEvent()
    const initial = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    const terminal = await waitForTerminal(event, initial.jobId)
    expect(terminal.state).toBe('failed')
    expect(terminal.error).toBe('runtimeFailed')
    expect(calls).toBe(1) // limit-stop is deterministic → marked immediately, no retry
  })

  it('a LATCHED sidecar start failure surfaces the distinct startFailed code — no futile retry (F-7)', async () => {
    // translate() rejects with a TranslationStartError (the runtime's latched start fault — most
    // likely transient memory pressure from the co-resident chat model). The view must surface the
    // DISTINCT `startFailed` code (the UI then shows "restart / free memory"), NOT `runtimeFailed`,
    // and must not burn a second decode — the latch would re-throw the same error identically.
    let calls = 0
    const translator: Translator = {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => 4096,
      async translate() {
        calls += 1
        throw new TranslationStartError(
          new Error('llama-server exited before becoming healthy (code 3221226505)')
        )
      },
      async stop() {},
      async suspend() {}
    }
    registerTranslateIpc(ctxFor(), service({ translator }))
    const event = makeEvent()
    const initial = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    const terminal = await waitForTerminal(event, initial.jobId)
    expect(terminal.state).toBe('failed')
    expect(terminal.error).toBe('startFailed')
    expect(calls).toBe(1) // start failure → distinct code immediately, no retry
  })

  it('a retry after a transiently-failed attempt does NOT duplicate the streamed text (F-1)', async () => {
    // Attempt 1 streams a partial delta then THROWS (a server-side close / IncompleteStreamError);
    // attempt 2 succeeds. The failed attempt's deltas were already appended to job.text AND
    // forwarded to the renderer — without the FA-1 checkpoint/rollback they would survive into the
    // terminal `done` text (silent output corruption). The terminal text must carry the window ONCE.
    let calls = 0
    const translator: Translator = {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => 4096,
      async translate(o) {
        calls += 1
        if (calls === 1) {
          o.onToken?.('PARTIAL-DUP ') // streamed into job.text, then a transient failure
          throw new Error('IncompleteStreamError')
        }
        const out = `TR<${o.text}>`
        o.onToken?.(out)
        o.onFinal?.({ stoppingWord: TRANSLATION_STOP_TOKEN })
        return out
      },
      async stop() {},
      async suspend() {}
    }
    registerTranslateIpc(ctxFor(), service({ translator }))
    const event = makeEvent()
    const initial = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    const done = await waitForTerminal(event, initial.jobId)
    expect(done.state).toBe('done')
    expect(calls).toBe(2) // one retry (unchanged retry policy)
    // The failed attempt's 'PARTIAL-DUP ' delta was rolled back; the window appears exactly once.
    expect(done.text).toBe('TR<Hallo Welt.>')
  })

  it('a retry inside a multi-window job rolls back the failed attempt and keeps the \\n\\n joins (F-1)', async () => {
    // A multi-window paste where the FIRST window's first attempt streams partial text then THROWS
    // transiently (a server-side close / IncompleteStreamError → retried), and every later call is
    // clean. FA-2 F-2 note: the trigger is a THROW, not a limit stop — a limit stop no longer
    // retries, so this keeps exercising the F-1 rollback while respecting the new retry policy.
    // The rollback must drop the failed attempt's deltas while preserving the '\n\n' separators.
    const paras = Array.from({ length: 6 }, (_v, p) =>
      Array.from({ length: 60 }, (_w, i) => `p${p}w${i}`).join(' ')
    )
    const long = paras.join('\n\n')
    const segments = long.split(/\n\s*\n+/).map((s) => s.trim()).filter((s) => s.length > 0)
    const plan = planTranslationWindows(segments, 1024)
    expect(plan.windows.length).toBeGreaterThan(1)
    const expected = plan.windows.map((w) => `TR<${w}>`).join('\n\n')

    let calls = 0
    const translator: Translator = {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => 1024,
      async translate(o) {
        calls += 1
        if (calls === 1) {
          o.onToken?.('DUP ')
          o.onToken?.(`TR<${o.text}>`)
          throw new Error('IncompleteStreamError') // transient throw → retried once (F-2)
        }
        const out = `TR<${o.text}>`
        o.onToken?.(out)
        o.onFinal?.({ stoppingWord: TRANSLATION_STOP_TOKEN })
        return out
      },
      async stop() {},
      async suspend() {}
    }
    registerTranslateIpc(ctxFor(), service({ translator }))
    const event = makeEvent()
    const initial = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq({ text: long }))) as TranslateJob
    const done = await waitForTerminal(event, initial.jobId)
    expect(done.state).toBe('done')
    expect(calls).toBe(plan.windows.length + 1) // one retry on the first window only
    // No 'DUP' residue and every '\n\n' join intact — the rollback restored post-separator text.
    expect(done.text).toBe(expected)
  })

  it('busy-REJECTS a second start while one is in flight (never queued)', async () => {
    const gated = gatedTranslator()
    const svc = service({ translator: gated.translator })
    registerTranslateIpc(ctxFor(), svc)
    const first = (await invoke(handlers, IPC.translateStart, goodReq())).result as TranslateJob
    expect(first.state).toBe('queued')
    const second = (await invoke(handlers, IPC.translateStart, goodReq())).result as TranslateJob
    expect(second.state).toBe('failed')
    expect(second.error).toBe('busy')
    // #163 (T-9): don't leave the first job running past test end — release the gate AND
    // await its settle so no stray async work bleeds into later tests.
    gated.release()
    await vi.waitFor(() => expect(svc.getActiveJob()).toBeNull())
  })

  it('refuses while a document task holds the lane (docTaskBusy, D9)', async () => {
    registerTranslateIpc(ctxFor(), service({ translator: scriptedTranslator(), hasDocTask: true }))
    const job = (await invoke(handlers, IPC.translateStart, goodReq())).result as TranslateJob
    expect(job.state).toBe('failed')
    expect(job.error).toBe('docTaskBusy')
  })

  it('refuses with noModel when no translation model is installed (no fabricated output)', async () => {
    registerTranslateIpc(ctxFor(), service({ translator: null }))
    const job = (await invoke(handlers, IPC.translateStart, goodReq())).result as TranslateJob
    expect(job.state).toBe('failed')
    expect(job.error).toBe('noModel')
  })

  it('refuses bad/unknown/same languages and empty text with badRequest', async () => {
    registerTranslateIpc(ctxFor(), service({ translator: scriptedTranslator() }))
    const same = (await invoke(handlers, IPC.translateStart, goodReq({ sourceLang: 'en', targetLang: 'en' })))
      .result as TranslateJob
    expect(same.error).toBe('badRequest')
    const bad = (await invoke(handlers, IPC.translateStart, { sourceLang: 'de', targetLang: 'xx', text: 'hi' }))
      .result as TranslateJob
    expect(bad.error).toBe('badRequest')
    const empty = (await invoke(handlers, IPC.translateStart, goodReq({ text: '   ' }))).result as TranslateJob
    expect(empty.error).toBe('badRequest')
  })

  it('cancel marks an in-flight job cancelled and aborts the sidecar call', async () => {
    const gated = gatedTranslator()
    registerTranslateIpc(ctxFor(), service({ translator: gated.translator }))
    const job = (await invoke(handlers, IPC.translateStart, goodReq())).result as TranslateJob
    while (!gated.sawSignal()) await new Promise((r) => setTimeout(r, 1)) // now in flight
    const cancelled = (await invoke(handlers, IPC.translateCancel, job.jobId)).result as TranslateJob
    expect(cancelled.state).toBe('cancelled')
    expect(gated.sawSignal()?.aborted).toBe(true)
  })

  it('getActiveTranslateJob returns the running job (with partial text), then null once idle', async () => {
    const gated = gatedTranslator()
    const svc = service({ translator: gated.translator })
    registerTranslateIpc(ctxFor(), svc)
    const event = makeEvent()
    const job = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    while (!gated.sawSignal()) await new Promise((r) => setTimeout(r, 1))
    const active = (await invoke(handlers, IPC.translateGetActive)).result as TranslateJob | null
    expect(active?.jobId).toBe(job.jobId)
    expect(active?.state).toBe('translating')
    expect(active?.text).toBe('partial ') // the streamed-so-far text, for remount recovery
    gated.release()
    await waitForTerminal(event, job.jobId)
    expect((await invoke(handlers, IPC.translateGetActive)).result).toBeNull()
  })

  it('stop() aborts the in-flight job and purges the map (lock/quit path)', async () => {
    const gated = gatedTranslator()
    const svc = service({ translator: gated.translator })
    registerTranslateIpc(ctxFor(), svc)
    const job = (await invoke(handlers, IPC.translateStart, goodReq())).result as TranslateJob
    while (!gated.sawSignal()) await new Promise((r) => setTimeout(r, 1))

    await svc.stop()
    expect(gated.sawSignal()?.aborted).toBe(true)
    // The job map is purged — nothing queryable, no source/translation text lingering past a lock.
    expect((await invoke(handlers, IPC.translateGetActive)).result).toBeNull()
    expect(svc.getJob(job.jobId).state).toBe('failed')
  })

  it('cancels the active job when the starting window is destroyed (L3, multi-window safety)', async () => {
    const gated = gatedTranslator()
    const svc = service({ translator: gated.translator })
    registerTranslateIpc(ctxFor(), svc)
    const event = makeEvent()
    const job = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    while (!gated.sawSignal()) await new Promise((r) => setTimeout(r, 1)) // in flight
    event.sender.destroy() // the window goes away mid-decode
    expect(gated.sawSignal()?.aborted).toBe(true) // the sidecar fetch was aborted
    expect(svc.getJob(job.jobId).state).toBe('cancelled') // the busy lane is freed
  })

  it('a completed job detaches its destroyed listener (no per-translate listener pile-up, L3)', async () => {
    const svc = service({ translator: scriptedTranslator() })
    registerTranslateIpc(ctxFor(), svc)
    const event = makeEvent()
    const initial = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    await waitForTerminal(event, initial.jobId)
    // The job finished; a later window-destroy must NOT try to cancel a long-gone job (the listener
    // was detached on `done`). getJob still reports the terminal `done`, unchanged by the destroy.
    event.sender.destroy()
    expect(svc.getJob(initial.jobId).state).toBe('done')
  })

  it('a cancelled job detaches its destroyed listener too (F-4, parity with done-detach)', async () => {
    // A cancelled job emits neither done nor error, so the destroyed listener wired at start would
    // leak without the FA-1 cancel-terminal detach. The translateCancel handler must detach it —
    // even though cancel is invoked with a fresh event, the jobId→detach map reaches the original.
    const gated = gatedTranslator()
    const svc = service({ translator: gated.translator })
    registerTranslateIpc(ctxFor(), svc)
    const event = makeEvent()
    const job = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    while (!gated.sawSignal()) await new Promise((r) => setTimeout(r, 1)) // in flight
    expect(event.sender.listenerCount('destroyed')).toBe(1) // wired at start
    const cancelled = (await invoke(handlers, IPC.translateCancel, job.jobId)).result as TranslateJob
    expect(cancelled.state).toBe('cancelled')
    expect(event.sender.listenerCount('destroyed')).toBe(0) // detached on the cancel terminal
  })

  it('stop() (lock/quit purge) detaches every job destroyed listener too (F-25, the third terminal)', async () => {
    // A stop()-purged job emits neither trDone nor trError, and lock does NOT destroy the window —
    // so the F-4 detach (done/error/cancel only) never ran and each 'Lock now' pressed mid-translate
    // leaked one 'destroyed' listener + one detachers entry (MaxListenersExceededWarning after ~11).
    // The purge hook on the service must run the detach path here.
    const gated = gatedTranslator()
    const svc = service({ translator: gated.translator })
    registerTranslateIpc(ctxFor(), svc)
    const event = makeEvent()
    await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())
    while (!gated.sawSignal()) await new Promise((r) => setTimeout(r, 1)) // in flight
    expect(event.sender.listenerCount('destroyed')).toBe(1) // wired at start
    await svc.stop() // the lock/quit terminal — no trDone/trError, window not destroyed
    expect(event.sender.listenerCount('destroyed')).toBe(0) // detached via the F-25 purge hook
  })

  it('translateStart refuses a locked workspace (never respawns the suspended sidecar)', async () => {
    registerTranslateIpc(ctxFor(false), service({ translator: scriptedTranslator() }))
    await expect(invoke(handlers, IPC.translateStart, goodReq())).rejects.toThrow()
  })

  it('#163 (T-1): translateStart refuses an UNLOCKED workspace whose lock teardown is under way (AUD-02)', async () => {
    // The exact AUD-02 hole: the DB stays open (isUnlocked TRUE) for the whole multi-second
    // teardown, so a bare isUnlocked() check admits a translate that lazily respawns the ~10 GB
    // sidecar the teardown just suspended — with the pasted plaintext in its KV cache while the
    // vault re-encrypts. The guard must be `workspaceAdmitsWork` (isLocking wins).
    const translator = scriptedTranslator()
    const spy = vi.spyOn(translator, 'translate')
    registerTranslateIpc(ctxFor(true, /* locking */ true), service({ translator }))
    await expect(invoke(handlers, IPC.translateStart, goodReq())).rejects.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('#163 (T-1): the SERVICE-level isWorkspaceLocking refusal (the non-IPC callers\' guard)', async () => {
    // jobs.ts:105 — never constructed in any test before. The production wiring
    // (main/index.ts) passes isWorkspaceLocking; a start during the teardown must come back
    // terminal without touching the sidecar.
    const translator = scriptedTranslator()
    const spy = vi.spyOn(translator, 'translate')
    const svc = new TranslateJobService({
      getTranslator: () => translator,
      hasActiveDocTask: () => false,
      isWorkspaceLocking: () => true
    })
    const job = svc.start(goodReq(), { token: () => {}, done: () => {}, error: () => {} })
    expect(job.state).toBe('failed')
    expect(job.error).toBe('cancelled') // the documented honest code for the lock terminal
    expect(spy).not.toHaveBeenCalled()
    expect(svc.getActiveJob()).toBeNull() // untracked — no slot taken
  })
})

// ---- #160: backend hardening (BE-2 timeout classification, BE-3 input cap, BE-4 sync terminal) ----

describe('#160 — TranslateJobService hardening', () => {
  it('BE-3: a paste over TRANSLATE_MAX_TEXT_CHARS is refused tooLong, takes no slot, never reaches the sidecar', async () => {
    const translator = scriptedTranslator()
    const spy = vi.spyOn(translator, 'translate')
    registerTranslateIpc(ctxFor(), service({ translator }))
    const event = makeEvent()
    const big = 'a '.repeat(TRANSLATE_MAX_TEXT_CHARS / 2 + 8) // just past the cap
    const job = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq({ text: big }))) as TranslateJob
    expect(job.state).toBe('failed')
    expect(job.error).toBe('tooLong')
    expect(spy).not.toHaveBeenCalled() // refused before any planning/sidecar work

    // The refusal is untracked (no slot): an ordinary start right after runs to done.
    const ok = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    expect(ok.state).toBe('queued')
    const terminal = await waitForTerminal(event, ok.jobId)
    expect(terminal.state).toBe('done')
  })

  it('BE-3 control: a paste AT the cap is admitted (the bound is exclusive)', async () => {
    registerTranslateIpc(ctxFor(), service({ translator: scriptedTranslator() }))
    const event = makeEvent()
    const atCap = 'a '.repeat(TRANSLATE_MAX_TEXT_CHARS / 2) // exactly the cap
    expect(atCap.length).toBe(TRANSLATE_MAX_TEXT_CHARS)
    const job = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq({ text: atCap }))) as TranslateJob
    expect(job.state).toBe('queued')
    // Don't decode ~140 windows in a unit test — cancel the admitted job immediately.
    await invoke(handlers, IPC.translateCancel, job.jobId)
  })

  it('BE-2: a per-request timeout DURING a live decode (tokens flowed) fails the window without a retry', async () => {
    let calls = 0
    const translator: Translator = {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => 4096,
      async translate(o) {
        calls += 1
        o.onToken?.('slow ') // the decode was LIVE — tokens flowed until the bound
        throw new DOMException('The operation timed out.', 'TimeoutError')
      },
      async stop() {},
      async suspend() {}
    }
    registerTranslateIpc(ctxFor(), service({ translator }))
    const event = makeEvent()
    const job = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    const terminal = await waitForTerminal(event, job.jobId)
    expect(terminal.state).toBe('failed')
    expect(terminal.error).toBe('runtimeFailed')
    // Deterministic (temperature-0, same hardware): retrying reproduces the same too-slow
    // decode and doubles the worst case — exactly one attempt (pre-fix: two).
    expect(calls).toBe(1)
  })

  it('BE-2 control: a timeout with NO tokens (wedged server) keeps its one transient retry', async () => {
    let calls = 0
    const translator: Translator = {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => 4096,
      async translate() {
        calls += 1
        throw new DOMException('The operation timed out.', 'TimeoutError')
      },
      async stop() {},
      async suspend() {}
    }
    registerTranslateIpc(ctxFor(), service({ translator }))
    const event = makeEvent()
    const job = (await invokeWithEvent(handlers, IPC.translateStart, event, goodReq())) as TranslateJob
    const terminal = await waitForTerminal(event, job.jobId)
    expect(terminal.state).toBe('failed')
    expect(calls).toBe(2) // a fresh request against a wedged server IS a reasonable bet
  })

  it('BE-4: a terminal from run()\'s synchronous prefix emits strictly AFTER start() returned', async () => {
    // Force a SYNCHRONOUS fault in run()'s prefix: contextWindow() is called before the first
    // await used to run, so the catch → emit.error fired inside start()'s own call stack — the
    // renderer would miss trError against its stale 'queued' snapshot. The microtask deferral
    // makes every terminal strictly-after-return by construction.
    const translator: Translator = {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => {
        throw new Error('sync boom')
      },
      async translate() {
        return ''
      },
      async stop() {},
      async suspend() {}
    }
    const svc = service({ translator })
    let returned = false
    let emittedAfterReturn: boolean | null = null
    const job = svc.start(goodReq(), {
      token: () => {},
      done: () => {},
      error: () => {
        emittedAfterReturn = returned
      }
    })
    returned = true
    expect(job.state).toBe('queued')
    await vi.waitFor(() => expect(emittedAfterReturn).not.toBe(null))
    expect(emittedAfterReturn).toBe(true) // pre-fix: false (emitted synchronously inside start)
  })
})

// ---- #163 (T-5): TranslateJobService edges — the 'empty' terminal, history eviction, ----
// ---- and a cancel landing BETWEEN the windows of a multi-window job                  ----

describe('#163 (T-5) — TranslateJobService edges', () => {
  const silentEmit = () => ({ token: () => {}, done: () => {}, error: () => {} })

  /** Await one job's terminal state via emitter promises (no IPC layer needed). */
  function startAndWait(
    svc: TranslateJobService,
    req: TranslateRequest
  ): { initial: TranslateJob; terminal: Promise<TranslateJob> } {
    let resolve!: (j: TranslateJob) => void
    const terminal = new Promise<TranslateJob>((r) => (resolve = r))
    const initial = svc.start(req, {
      token: () => {},
      done: (_id, job) => resolve(job),
      error: (_id, job) => resolve(job)
    })
    if (initial.state !== 'queued') resolve(initial)
    return { initial, terminal }
  }

  it("the 'empty' terminal: windows resolve clean but stream nothing — the job fails 'empty'", async () => {
    // A translator that RESOLVES non-empty with a clean stop but never calls onToken: every
    // window passes the clean check while the accumulated job text stays '' — the exact path
    // the screen's translate.err.empty copy exists for, never driven before.
    const translator: Translator = {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => 4096,
      async translate(o) {
        o.onFinal?.({ stoppingWord: TRANSLATION_STOP_TOKEN })
        return 'resolved but never streamed'
      },
      async stop() {},
      async suspend() {}
    }
    const svc = service({ translator })
    const { terminal } = startAndWait(svc, goodReq())
    const job = await terminal
    expect(job.state).toBe('failed')
    expect(job.error).toBe('empty')
  })

  it('history eviction: the job map is bounded at 8 — the oldest terminal job reports the unknown-id shape', async () => {
    const svc = service({ translator: scriptedTranslator() })
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const { initial, terminal } = startAndWait(svc, goodReq({ text: `Satz ${i}.` }))
      ids.push(initial.jobId)
      const done = await terminal
      expect(done.state).toBe('done')
    }
    // TRANSLATE_MAX_JOB_HISTORY = 8: the two oldest jobs were evicted — their poll now returns
    // the unknown-id terminal shape (failed, error null), while a recent job still reads done.
    expect(svc.getJob(ids[0])).toEqual({ jobId: ids[0], state: 'failed', error: null })
    expect(svc.getJob(ids[1])).toEqual({ jobId: ids[1], state: 'failed', error: null })
    expect(svc.getJob(ids[9]).state).toBe('done')
  })

  it('a cancel landing BETWEEN windows never starts the next window', async () => {
    // Two-window paste (two paragraphs over the ctx-1024 budget). The first window cancels the
    // job as its last act — run()'s post-window abort check must stop the loop before window 2
    // touches the sidecar (post-suspend that lazy restart would respawn a ~10 GB child).
    const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ')
    const text = `${words(120, 'a')}\n\n${words(120, 'b')}`
    let calls = 0
    let cancelSelf: () => void = () => {}
    const translator: Translator = {
      modelId: 'translategemma-12b-it-q4',
      contextWindow: () => 1024,
      async translate(o) {
        calls += 1
        o.onToken?.('uebersetzt ')
        o.onFinal?.({ stoppingWord: TRANSLATION_STOP_TOKEN })
        cancelSelf() // Stop lands while the lane sits between window 1 and window 2
        return 'uebersetzt '
      },
      async stop() {},
      async suspend() {}
    }
    const svc = service({ translator })
    let sawTerminal = false
    const job = svc.start(goodReq({ text }), {
      token: () => {},
      done: () => {
        sawTerminal = true
      },
      error: () => {
        sawTerminal = true
      }
    })
    cancelSelf = () => svc.cancel(job.jobId)
    await vi.waitFor(() => expect(svc.getJob(job.jobId).state).toBe('cancelled'))
    expect(calls).toBe(1) // window 2 never started
    expect(sawTerminal).toBe(false) // a user cancel emits neither done nor error
    expect(svc.getActiveJob()).toBeNull() // the slot was released
    void silentEmit
  })
})
