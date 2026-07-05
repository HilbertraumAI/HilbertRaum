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

/** A scripted translator: streams `reply(text)` as ONE token and resolves with it, honoring abort. */
function scriptedTranslator(opts: { ctx?: number; reply?: (text: string) => string } = {}): Translator {
  const reply = opts.reply ?? ((t: string) => `TR<${t}>`)
  return {
    modelId: 'translategemma-12b-it-q4',
    contextWindow: () => opts.ctx ?? 4096,
    async translate(o) {
      if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const out = reply(o.text)
      o.onToken?.(out)
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

  it('translateStart refuses a locked workspace (never respawns the suspended sidecar)', async () => {
    registerTranslateIpc(ctxFor(false), service({ translator: scriptedTranslator() }))
    await expect(invoke(handlers, IPC.translateStart, goodReq())).rejects.toThrow()
  })
})
