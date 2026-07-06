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
import { TRANSLATION_STOP_TOKEN } from '../../src/main/services/translation'
import { planTranslationWindows } from '../../src/main/services/doctasks/translation'
import { IPC, STREAM } from '../../src/shared/ipc'
import type { TranslateJob, TranslateRequest } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, invokeWithEvent, makeEvent, type FakeIpcEvent, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

function ctxFor(unlocked = true): AppContext {
  return { workspace: { isUnlocked: () => unlocked } } as unknown as AppContext
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

  it('retries a TRUNCATED window (no clean stop) once, then fails the job — M6 in the view', async () => {
    // A window that streams text but hits the output cap (no `stopping_word`/eos in the final
    // frame) is a silent mid-sentence truncation — the view treats it as a failed window.
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
    expect(calls).toBe(2)
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
    // A multi-window paste where the FIRST window's first attempt streams partial text then hits a
    // limit stop (no clean stop → retried), and every later call is clean. The rollback must drop
    // the failed attempt's deltas while preserving the '\n\n' window separators between windows.
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
          o.onFinal?.({}) // limit stop (no clean stop) → retried once
          return `DUP TR<${o.text}>`
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
    registerTranslateIpc(ctxFor(), service({ translator: gated.translator }))
    const first = (await invoke(handlers, IPC.translateStart, goodReq())).result as TranslateJob
    expect(first.state).toBe('queued')
    const second = (await invoke(handlers, IPC.translateStart, goodReq())).result as TranslateJob
    expect(second.state).toBe('failed')
    expect(second.error).toBe('busy')
    gated.release()
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

  it('translateStart refuses a locked workspace (never respawns the suspended sidecar)', async () => {
    registerTranslateIpc(ctxFor(false), service({ translator: scriptedTranslator() }))
    await expect(invoke(handlers, IPC.translateStart, goodReq())).rejects.toThrow()
  })
})
