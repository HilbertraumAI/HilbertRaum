import { describe, it, expect, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { answerSpeedFrom, setAnswerSpeedObserver, withChatStream } from '../../src/main/ipc/chat-stream'
import {
  ChatRequestError,
  ChatStreamError,
  RuntimeConnectionLostError,
  RuntimeUnresponsiveError
} from '../../src/main/services/runtime/llama'
import { EmptyCompletionError } from '../../src/main/services/chat'
import { EmbedderError } from '../../src/main/services/embeddings/errors'
import { EngineCannotRunError } from '../../src/main/services/runtime/engine-load'
import { ModelSlotArbiter, RESUME_AFTER_CHAT_DELAY_MS } from '../../src/main/services/analysis/model-slot-arbiter'
import { inFlightStreams, streamBuffers, streamSettled } from '../../src/main/ipc/inflight'
import { t } from '../../src/shared/i18n'
import { type Message } from '../../src/shared/types'
import { deferred } from '../helpers/deferred'
import { within } from '../helpers/hang-budget'
import { slotClock } from '../helpers/slot-clock'

// `assertChatStreamReady`'s guard preamble (unknown conversation, no runtime, doc-task
// busy, stream-in-flight) reads a real DB + ctx and is exercised end-to-end by the
// chat-ipc / rag-scope integration tests; here we pin the safety-sensitive stream
// lifecycle that both handlers now share.

// M-A2 (audit-2026-06-13): the shared stream lifecycle that registerChatIpc and
// registerRagIpc both delegate to — the most safety-sensitive path in the app.

function fakeEvent(): {
  event: IpcMainInvokeEvent
  sent: Array<{ channel: string; args: unknown[] }>
  destroy: () => void
} {
  const sent: Array<{ channel: string; args: unknown[] }> = []
  let destroyed = false
  const event = {
    sender: {
      isDestroyed: () => destroyed,
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args })
    }
  } as unknown as IpcMainInvokeEvent
  return { event, sent, destroy: () => (destroyed = true) }
}

function msg(content: string): Message {
  return {
    id: 'a1',
    conversationId: 'c1',
    role: 'assistant',
    content,
    createdAt: '2026-01-01T00:00:00Z',
    tokenCount: null
  } as Message
}

describe('withChatStream (M-A2)', () => {
  beforeEach(() => {
    inFlightStreams.clear()
    streamBuffers.clear()
    streamSettled.clear()
  })

  it('registers an in-flight controller, streams tokens, emits done, and clears the entry', async () => {
    const { event, sent } = fakeEvent()
    const result = await withChatStream(event, 'c1', 'label', async (signal, sendToken) => {
      // The controller is registered for the duration of the run.
      expect(inFlightStreams.has('c1')).toBe(true)
      expect(signal.aborted).toBe(false)
      sendToken('hello')
      sendToken(' world')
      return msg('hello world')
    })

    expect(result.content).toBe('hello world')
    // token×2 then done, on the per-conversation channels.
    expect(sent.map((s) => s.channel)).toEqual([
      'chat:token:c1',
      'chat:token:c1',
      'chat:done:c1'
    ])
    expect(sent[2].args[0]).toMatchObject({ content: 'hello world' })
    // The registry entry is cleared on completion.
    expect(inFlightStreams.has('c1')).toBe(false)
  })

  // #290: ONE ephemeral `chat:speed:<id>` payload per FINISHED answer, keyed to the persisted
  // message id, before `done` — and nothing at all when the runtime sent no timings, the reply
  // is empty, or the stream never produced a first token.
  describe('per-answer speed payload (#290)', () => {
    const timings = { prompt_n: 20, predicted_n: 615, predicted_ms: 14_640, predicted_per_second: 42 }

    it('emits chat:speed with the message id, tok/s, TTFT and token count right before done', async () => {
      const { event, sent } = fakeEvent()
      await withChatStream(event, 'c1', 'label', async (_s, sendToken, _r, _c, _u, sendTimings) => {
        sendToken('hello')
        sendTimings(timings)
        return msg('hello')
      })
      expect(sent.map((s) => s.channel)).toEqual(['chat:token:c1', 'chat:speed:c1', 'chat:done:c1'])
      const speed = sent[1].args[0] as { messageId: string; tokensPerSecond: number; ttftMs: number; tokens: number }
      expect(speed.messageId).toBe('a1')
      expect(speed.tokensPerSecond).toBe(42)
      expect(speed.tokens).toBe(615)
      // TTFT is measured on the stream clock (registration → first token): non-negative, finite.
      expect(Number.isFinite(speed.ttftMs)).toBe(true)
      expect(speed.ttftMs).toBeGreaterThanOrEqual(0)
      // Ephemeral (R14): nothing of it in the recovery buffers or the message.
      expect(sent[2].args[0]).not.toHaveProperty('tokensPerSecond')
    })

    it('hands the same payload to the answer-speed observer (the Performance screen latch), which can never fail the answer', async () => {
      const seen: unknown[] = []
      setAnswerSpeedObserver((speed) => {
        seen.push(speed)
        throw new Error('observer bug')
      })
      try {
        const { event, sent } = fakeEvent()
        await withChatStream(event, 'c1', 'label', async (_s, sendToken, _r, _c, _u, sendTimings) => {
          sendToken('hello')
          sendTimings(timings)
          return msg('hello')
        })
        expect(seen).toHaveLength(1)
        expect(seen[0]).toEqual(sent[1].args[0])
        // The throwing observer changed nothing on the wire.
        expect(sent.map((s) => s.channel)).toEqual(['chat:token:c1', 'chat:speed:c1', 'chat:done:c1'])
      } finally {
        setAnswerSpeedObserver(null)
      }
    })

    it('emits nothing when the run never hands timings up (the mock runtime, document answers)', async () => {
      const { event, sent } = fakeEvent()
      await withChatStream(event, 'c1', 'label', async (_s, sendToken) => {
        sendToken('hello')
        return msg('hello')
      })
      expect(sent.map((s) => s.channel)).toEqual(['chat:token:c1', 'chat:done:c1'])
    })

    it('answerSpeedFrom is the single rule: null without timings, TTFT, content or positive figures', () => {
      expect(answerSpeedFrom(msg('x'), null, 5)).toBeNull()
      expect(answerSpeedFrom(msg('x'), timings, null)).toBeNull()
      expect(answerSpeedFrom(msg(''), timings, 5)).toBeNull()
      expect(answerSpeedFrom(msg('x'), { prompt_n: 3 }, 5)).toBeNull()
      expect(answerSpeedFrom(msg('x'), { predicted_per_second: 0, predicted_n: 5 }, 5)).toBeNull()
      expect(answerSpeedFrom(msg('x'), { predicted_per_second: 12, predicted_n: 0 }, 5)).toBeNull()
      expect(answerSpeedFrom(msg('x'), { predicted_per_second: 12.4, predicted_n: 7.6 }, 1800)).toEqual({
        messageId: 'a1',
        tokensPerSecond: 12.4,
        ttftMs: 1800,
        tokens: 8
      })
    })
  })

  it('emits error and clears the entry when the run throws, then rethrows', async () => {
    const { event, sent } = fakeEvent()
    await expect(
      withChatStream(event, 'c1', 'label', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(sent).toEqual([{ channel: 'chat:error:c1', args: ['boom'] }])
    expect(inFlightStreams.has('c1')).toBe(false)
    expect(streamBuffers.has('c1')).toBe(false)
    expect(streamSettled.has('c1')).toBe(false)
  })

  it('maps a context-overflow HTTP 400 to the friendly copy on BOTH the error event and the rejection', async () => {
    const { event, sent } = fakeEvent()
    // The exact llama-server overflow the runtime now surfaces as a typed ChatRequestError.
    const overflow = new ChatRequestError(
      400,
      'request (9600 tokens) exceeds the available context size (8192 tokens), try increasing it',
      'exceed_context_size_error'
    )
    const friendly = t('en', 'main.model.contextExceeded')

    const rejection = await withChatStream(event, 'c1', 'label', async () => {
      throw overflow
    }).catch((e: Error) => e.message)

    // The renderer surfaces the invoke REJECTION — it must be the friendly copy, not the
    // raw "Chat request failed: HTTP 400 — …" string (the bug this fixes).
    expect(rejection).toBe(friendly)
    expect(rejection).not.toMatch(/HTTP 400|9600/)
    // The stream channel carries the same friendly text.
    expect(sent).toEqual([{ channel: 'chat:error:c1', args: [friendly] }])
    expect(inFlightStreams.has('c1')).toBe(false)
  })

  // CB-4: a genuine empty completion (EmptyCompletionError) maps to the friendly retry copy on BOTH
  // the error event and the invoke rejection — same rethrow-friendly posture as the overflow mapping.
  it('maps EmptyCompletionError to the friendly emptyCompletion copy on the error event AND the rejection', async () => {
    const { event, sent } = fakeEvent()
    const friendly = t('en', 'main.chat.emptyCompletion')
    const rejection = await withChatStream(event, 'c1', 'label', async () => {
      throw new EmptyCompletionError()
    }).catch((e: Error) => e.message)
    expect(rejection).toBe(friendly)
    expect(sent).toEqual([{ channel: 'chat:error:c1', args: [friendly] }])
    expect(inFlightStreams.has('c1')).toBe(false)
  })

  // CB-5: a hung sidecar (RuntimeUnresponsiveError) maps to the friendly "stopped responding" copy on
  // both channels — the most-specific link in the runtimeUnresponsive → emptyCompletion → overflow
  // → raw chain.
  it('maps RuntimeUnresponsiveError to the friendly runtimeUnresponsive copy on the error event AND the rejection', async () => {
    const { event, sent } = fakeEvent()
    const friendly = t('en', 'main.chat.runtimeUnresponsive')
    const rejection = await withChatStream(event, 'c1', 'label', async () => {
      throw new RuntimeUnresponsiveError(30_000)
    }).catch((e: Error) => e.message)
    expect(rejection).toBe(friendly)
    expect(rejection).not.toMatch(/30000|responding \(/) // the raw diagnostic never reaches the user
    expect(sent).toEqual([{ channel: 'chat:error:c1', args: [friendly] }])
    expect(inFlightStreams.has('c1')).toBe(false)
  })

  // #600: the sidecar died under the turn (a crash, an OS kill). The runtime's typed error maps to the
  // friendly connectionLost copy on both channels — before #600 the user saw undici's raw "terminated".
  it('maps RuntimeConnectionLostError to the friendly connectionLost copy on the error event AND the rejection (#600)', async () => {
    const { event, sent } = fakeEvent()
    const friendly = t('en', 'main.chat.connectionLost')
    const rejection = await withChatStream(event, 'c1', 'label', async () => {
      throw new RuntimeConnectionLostError()
    }).catch((e: Error) => e.message)
    expect(rejection).toBe(friendly)
    expect(sent).toEqual([{ channel: 'chat:error:c1', args: [friendly] }])
    expect(inFlightStreams.has('c1')).toBe(false)
  })

  // F-02 (audit 2026-07-16): an in-band mid-stream SSE error frame (ChatStreamError from the
  // hardened readChatSSE) maps to the friendly `main.chat.streamError` copy on BOTH channels —
  // a new link in the runtimeUnresponsive → emptyCompletion → streamError → overflow → raw
  // chain. The structural server reason (message/type) must never reach the user (content-free
  // surface; the raw reason goes to the local log only).
  it('maps ChatStreamError to the friendly streamError copy on the error event AND the rejection (F-02)', async () => {
    const { event, sent } = fakeEvent()
    const friendly = t('en', 'main.chat.streamError')
    const rejection = await withChatStream(event, 'c1', 'label', async () => {
      throw new ChatStreamError('slot error: kv cache full', 'server_error')
    }).catch((e: Error) => e.message)
    expect(rejection).toBe(friendly)
    expect(rejection).not.toMatch(/kv cache|server_error|Chat stream failed/) // structural reason stays local
    expect(sent).toEqual([{ channel: 'chat:error:c1', args: [friendly] }])
    expect(inFlightStreams.has('c1')).toBe(false)
  })

  // #634: a document question's search step failed. Before #634 the banner showed the raw reason —
  // "The operation timed out." in any UI language, or llama-server's stderr tail with the weight
  // file's absolute path. Each kind maps to copy that names the search model, on both channels.
  // #530 (#737): the link just before them — the OS refused to start the engine the question needs —
  // maps to the engine copy; the loader's diagnostic (the missing library, the exit code) stays local.
  const searchFailure = (kind: 'timeout' | 'start' | 'failed' | 'interrupted') => () =>
    new EmbedderError(kind, 'The search model could not start (exit:code 1)')
  it.each([
    { label: 'a timeout search-model failure', cause: searchFailure('timeout'), key: 'main.chat.searchModelTimeout' },
    { label: 'a start search-model failure', cause: searchFailure('start'), key: 'main.chat.searchModelCannotStart' },
    { label: 'a failed search-model failure', cause: searchFailure('failed'), key: 'main.chat.searchModelFailed' },
    { label: 'an interrupted search-model failure', cause: searchFailure('interrupted'), key: 'main.chat.searchModelFailed' },
    {
      label: 'an engine the OS refuses to start',
      cause: () => new EngineCannotRunError('llama-server', {
        family: 'llama_cpp', reason: 'library-missing', os: 'linux', name: 'libgomp.so.1', exit: 'exit code 127'
      }),
      key: 'main.engine.cannotRun'
    }
  ] as const)('maps $label to $key on the error event AND the rejection (#634, #530)', async ({ cause, key }) => {
    const { event, sent } = fakeEvent()
    const friendly = t('en', key)
    const rejection = await withChatStream(event, 'c1', 'label', async () => {
      throw cause()
    }).catch((e: Error) => e.message)
    expect(rejection).toBe(friendly)
    expect(rejection).not.toMatch(/libgomp|exit/) // the raw diagnostic never reaches the user
    expect(sent).toEqual([{ channel: 'chat:error:c1', args: [friendly] }])
    expect(inFlightStreams.has('c1')).toBe(false)
  })

  it('does not send to a destroyed renderer (window closed mid-stream)', async () => {
    const { event, sent, destroy } = fakeEvent()
    await withChatStream(event, 'c1', 'label', async (_signal, sendToken) => {
      destroy()
      sendToken('dropped') // renderer gone — must be a no-op
      return msg('done')
    })
    // No token and no done event were sent after the renderer was destroyed.
    expect(sent).toEqual([])
    expect(inFlightStreams.has('c1')).toBe(false)
  })

  it('only clears its OWN entry — a later stream that reused the key survives', async () => {
    const { event } = fakeEvent()
    const later = new AbortController()
    await withChatStream(event, 'c1', 'label', async () => {
      // Simulate a second stream taking over the key before this one's finally runs.
      inFlightStreams.set('c1', later)
      return msg('x')
    })
    // The finally must not have deleted the later controller.
    expect(inFlightStreams.get('c1')).toBe(later)
  })

  // Stream recovery (navigate-away-and-back): the wrapper buffers the accumulated answer +
  // reasoning so a remounted Chat screen can resume the live view via getActiveStream.
  it('buffers accumulated content + reasoning, then clears it on completion', async () => {
    const { event, sent } = fakeEvent()
    let midContent = ''
    let midReasoning = ''
    await withChatStream(event, 'c1', 'label', async (_signal, sendToken, sendReasoning) => {
      sendToken('Hel')
      sendReasoning('think ')
      sendToken('lo')
      const buf = streamBuffers.get('c1')! // live snapshot mid-stream
      midContent = buf.content
      midReasoning = buf.reasoning
      return msg('Hello')
    })
    expect(midContent).toBe('Hello')
    expect(midReasoning).toBe('think ')
    // Reasoning rides its own channel; both buffer + clear in lockstep with the registry.
    expect(sent.map((s) => s.channel)).toEqual([
      'chat:token:c1',
      'chat:reasoning:c1',
      'chat:token:c1',
      'chat:done:c1'
    ])
    expect(streamBuffers.has('c1')).toBe(false)
    expect(inFlightStreams.has('c1')).toBe(false)
  })

  // REL-3: a user Stop can land while withChatStream is still WAITING to acquire the model
  // slot from a yielding deep-index build (the acquire parks until the builder hands off).
  // The controller's signal is now threaded into the acquire, so Stop rejects the wait — and
  // withChatStream must treat that like an in-generation Stop that produced no token: resolve
  // cleanly via `done` with an empty message, NOT emit chat:error (the renderer shows a toast
  // on any invoke rejection). `runFn` must never run.
  it('resolves cleanly (no chat:error) when a user Stop lands during the slot acquire (REL-3)', async () => {
    const { event, sent } = fakeEvent()
    let runFnReached = false
    const parked = deferred()
    // acquireSlot parks until its threaded signal aborts, then rejects (what the arbiter does).
    const acquireSlot = (signal: AbortSignal): Promise<() => void> =>
      new Promise<() => void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Chat slot acquire aborted')), {
          once: true
        })
        parked.resolve()
      })
    const promise = withChatStream(
      event,
      'c1',
      'label',
      async () => {
        runFnReached = true
        return msg('should not happen')
      },
      acquireSlot
    )
    await within(parked.promise, 'the turn parking on the model slot')
    // Simulate Stop: abort the registered in-flight controller (what stopGeneration does).
    inFlightStreams.get('c1')!.abort()
    const result = await promise
    expect(runFnReached).toBe(false) // generation never started
    expect(result.content).toBe('') // clean empty-stop message
    // A `done` was emitted; NO chat:error.
    expect(sent.map((s) => s.channel)).toEqual(['chat:done:c1'])
    expect(inFlightStreams.has('c1')).toBe(false)
    expect(streamBuffers.has('c1')).toBe(false)
  })

  // #737: a turn that DID get the slot gives it back in `finally`, whether its run resolved or threw, so a
  // deep-index build is never left parked behind a finished turn. The real arbiter on the fake clock: the release
  // arms the post-chat resume. The throw is a plain Error, not an abort — on an abort the arbiter's own listener
  // gives the slot back and would hide a missing release.
  it.each([
    ['resolves', async (): Promise<Message> => msg('done')],
    ['throws', async (): Promise<Message> => {
      throw new Error('boom')
    }]
  ] as const)('gives the model slot back when the run %s, so the paused build resumes (#737)', async (_label, run) => {
    const { event } = fakeEvent()
    const clock = slotClock()
    const arbiter = new ModelSlotArbiter(clock.deps)
    arbiter.registerBuild('job1')
    const stream = withChatStream(event, 'c1', 'label', run, (signal) => arbiter.acquireForChat(signal))
    expect(arbiter.shouldYield()).toBe(true) // the turn asked the build to pause
    const parked = arbiter.reacquire('job1') // the build parks at its node boundary, handing the slot over
    await stream.catch(() => undefined)
    expect(clock.pending()).toBe(1) // the release armed the resume
    clock.advance(RESUME_AFTER_CHAT_DELAY_MS)
    await within(parked, 'the paused build resuming after the turn gave the slot back')
  })

  // R1 (full-audit-2026-06-30, Phase C): the wrapper publishes a per-stream "settled" promise the
  // lock/quit teardown can await so a partial reply persists BEFORE the DB closes. It is registered
  // alongside the controller and resolved (in the finally) only AFTER the run — and thus its
  // abort-driven appendMessage — has fully unwound.
  it('registers a per-stream settled promise and resolves it after the run unwinds (R1)', async () => {
    const { event } = fakeEvent()
    let settled: Promise<void> | undefined
    let midRun = ''
    await withChatStream(event, 'c1', 'label', async () => {
      settled = streamSettled.get('c1')
      expect(settled).toBeInstanceOf(Promise) // registered for the duration of the run
      // One macrotask hop (justified: it lets an already-resolved settle's .then run first), so 'pending' wins
      // only if the settle is really still open.
      midRun = await Promise.race([
        settled!.then(() => 'settled'),
        new Promise<string>((r) => setImmediate(() => r('pending')))
      ])
      return msg('done')
    })
    expect(midRun).toBe('pending') // not resolved while the run was in flight
    await within(settled!, 'the settle resolving after the run unwound')
    expect(streamSettled.has('c1')).toBe(false) // cleared in lockstep with the controller
  })

  it('resolves the settled promise even when the run throws (teardown never hangs) (R1)', async () => {
    const { event } = fakeEvent()
    let settled: Promise<void> | undefined
    await withChatStream(event, 'c1', 'label', async () => {
      settled = streamSettled.get('c1')
      throw new Error('boom')
    }).catch(() => undefined)
    // Resolved, never rejected, so allSettled can't hang teardown.
    await within(settled!, 'the settle resolving after the run threw')
  })
})
