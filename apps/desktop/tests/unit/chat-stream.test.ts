import { describe, it, expect, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { withChatStream } from '../../src/main/ipc/chat-stream'
import {
  ChatRequestError,
  ChatStreamError,
  RuntimeUnresponsiveError
} from '../../src/main/services/runtime/llama'
import { EmptyCompletionError } from '../../src/main/services/chat'
import { inFlightStreams, streamBuffers, streamSettled } from '../../src/main/ipc/inflight'
import { t } from '../../src/shared/i18n'
import { type Message } from '../../src/shared/types'

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

  it('emits error and clears the entry when the run throws, then rethrows', async () => {
    const { event, sent } = fakeEvent()
    await expect(
      withChatStream(event, 'c1', 'label', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(sent).toEqual([{ channel: 'chat:error:c1', args: ['boom'] }])
    expect(inFlightStreams.has('c1')).toBe(false)
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
    // acquireSlot parks until its threaded signal aborts, then rejects (what the arbiter does).
    const acquireSlot = (signal: AbortSignal): Promise<() => void> =>
      new Promise<() => void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Chat slot acquire aborted')), {
          once: true
        })
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
    await new Promise((r) => setImmediate(r))
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

  it('clears the buffer when the run throws', async () => {
    const { event } = fakeEvent()
    await expect(
      withChatStream(event, 'c1', 'label', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(streamBuffers.has('c1')).toBe(false)
  })

  // R1 (full-audit-2026-06-30, Phase C): the wrapper publishes a per-stream "settled" promise the
  // lock/quit teardown can await so a partial reply persists BEFORE the DB closes. It is registered
  // alongside the controller and resolved (in the finally) only AFTER the run — and thus its
  // abort-driven appendMessage — has fully unwound.
  it('registers a per-stream settled promise and resolves it after the run unwinds (R1)', async () => {
    const { event } = fakeEvent()
    let settledResolved = false
    await withChatStream(event, 'c1', 'label', async () => {
      const settled = streamSettled.get('c1')
      expect(settled).toBeInstanceOf(Promise) // registered for the duration of the run
      void settled!.then(() => (settledResolved = true))
      expect(settledResolved).toBe(false) // not resolved while the run is still in flight
      return msg('done')
    })
    await new Promise((r) => setImmediate(r))
    expect(streamSettled.has('c1')).toBe(false) // cleared in lockstep with the controller
    expect(settledResolved).toBe(true) // resolved after the run unwound (the teardown await-point)
  })

  it('resolves the settled promise even when the run throws (teardown never hangs) (R1)', async () => {
    const { event } = fakeEvent()
    let settledResolved = false
    await withChatStream(event, 'c1', 'label', async () => {
      void streamSettled.get('c1')!.then(() => (settledResolved = true))
      throw new Error('boom')
    }).catch(() => undefined)
    await new Promise((r) => setImmediate(r))
    expect(settledResolved).toBe(true) // resolved (never rejected) so allSettled can't hang teardown
  })
})
