import { describe, it, expect, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { withChatStream } from '../../src/main/ipc/chat-stream'
import { ChatRequestError } from '../../src/main/services/runtime/llama'
import { inFlightStreams, streamBuffers } from '../../src/main/ipc/inflight'
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
      // Simulate a second stream taking over the key before this one`s finally runs.
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

  it('clears the buffer when the run throws', async () => {
    const { event } = fakeEvent()
    await expect(
      withChatStream(event, 'c1', 'label', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(streamBuffers.has('c1')).toBe(false)
  })
})
