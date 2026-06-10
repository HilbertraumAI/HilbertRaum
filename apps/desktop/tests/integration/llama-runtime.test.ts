import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { LlamaRuntime, readChatSSE } from '../../src/main/services/runtime/llama'
import { createSelectingRuntimeFactory } from '../../src/main/services/runtime/factory'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'

class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 7
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}

/** Build a web ReadableStream emitting the given SSE text frames. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    }
  })
}

function chatChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

/** A fetch stub that routes /health (ok) and /v1/chat/completions (an SSE body). */
function chatFetch(opts: {
  frames: string[]
  onChat?: (url: string, init?: RequestInit) => void
  chatOk?: boolean
}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
    if (u.endsWith('/v1/chat/completions')) {
      opts.onChat?.(u, init)
      if (opts.chatOk === false) return { ok: false, status: 500, body: null } as unknown as Response
      return { ok: true, status: 200, body: sseStream(opts.frames) } as unknown as Response
    }
    throw new Error(`unexpected url ${u}`)
  }) as typeof fetch
}

function fakeSpawn() {
  const calls: Array<{ command: string; args: string[] }> = []
  const child = new FakeChild()
  const spawn = (command: string, args: string[]): ChildProcessLike => {
    calls.push({ command, args })
    return child
  }
  return { spawn, calls, child }
}

describe('readChatSSE', () => {
  it('yields each delta, splits across reads, and stops on [DONE]', async () => {
    const stream = sseStream([
      chatChunk('Hello'),
      'data: {"choices":[{"delta":{"content":" wor', // a partial JSON frame split mid-line
      'ld"}}]}\n\n',
      ': keep-alive comment\n\n',
      chatChunk('!'),
      'data: [DONE]\n\n',
      chatChunk('IGNORED AFTER DONE')
    ])
    const out: string[] = []
    for await (const t of readChatSSE(stream)) out.push(t)
    expect(out.join('')).toBe('Hello world!')
  })

  it('flushes a final data: line that has no trailing newline before close', async () => {
    // Server closes the stream right after the last delta with no terminating "\n".
    const stream = sseStream([chatChunk('Hello'), 'data: {"choices":[{"delta":{"content":" end"}}]}'])
    const out: string[] = []
    for await (const t of readChatSSE(stream)) out.push(t)
    expect(out.join('')).toBe('Hello end')
  })

  it('stops promptly when the signal is aborted', async () => {
    const controller = new AbortController()
    const stream = sseStream([chatChunk('a'), chatChunk('b'), chatChunk('c')])
    const out: string[] = []
    for await (const t of readChatSSE(stream, controller.signal)) {
      out.push(t)
      controller.abort()
    }
    expect(out).toEqual(['a'])
  })
})

describe('LlamaRuntime', () => {
  const startOpts: RuntimeStartOptions = {
    modelId: 'qwen3-4b-instruct-q4',
    modelPath: '/models/x.gguf',
    contextTokens: 4096
  }

  it('starts the loopback sidecar and streams tokens from /v1/chat/completions', async () => {
    const { spawn, calls } = fakeSpawn()
    let chatUrl = ''
    let chatBody: unknown
    const fetchImpl = chatFetch({
      frames: [chatChunk('Privacy'), chatChunk(' first'), 'data: [DONE]\n\n'],
      onChat: (url, init) => {
        chatUrl = url
        chatBody = JSON.parse(String(init?.body))
      }
    })
    const runtime = new LlamaRuntime(startOpts, {
      binPath: '/bin/llama-server',
      spawn,
      fetchImpl,
      findPort: async () => 51000,
      healthIntervalMs: 1
    })
    await runtime.start()

    const out: string[] = []
    for await (const t of runtime.chatStream([{ role: 'user', content: 'hi' }], { maxTokens: 32 }))
      out.push(t)
    expect(out.join('')).toBe('Privacy first')

    // Localhost-only: the spawn binds 127.0.0.1 and the chat request targets loopback.
    expect(calls[0].args.join(' ')).toContain('--host 127.0.0.1')
    expect(calls[0].args.join(' ')).not.toContain('0.0.0.0')
    expect(chatUrl).toBe('http://127.0.0.1:51000/v1/chat/completions')
    // Messages are sent as plain role/content (server applies the chat template);
    // options map to the OpenAI request fields.
    expect(chatBody).toMatchObject({
      stream: true,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }]
    })

    const h = await runtime.health()
    expect(h.healthy).toBe(true)
    expect(h.port).toBe(51000)
    await runtime.stop()
  })

  it('throws when the chat request fails (non-ok HTTP)', async () => {
    const { spawn } = fakeSpawn()
    const runtime = new LlamaRuntime(startOpts, {
      binPath: '/bin/s',
      spawn,
      fetchImpl: chatFetch({ frames: [], chatOk: false }),
      findPort: async () => 51001,
      healthIntervalMs: 1
    })
    await runtime.start()
    await expect(async () => {
      for await (const _t of runtime.chatStream([{ role: 'user', content: 'hi' }])) void _t
    }).rejects.toThrow(/HTTP 500/)
    await runtime.stop()
  })
})

// ---- Factory selector -----------------------------------------------------------

describe('createSelectingRuntimeFactory', () => {
  const opts: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 2048 }

  function mkMock(): ModelRuntime {
    return { modelId: 'mock', start: async () => {}, stop: async () => {}, health: async () => ({ healthy: true, message: '', port: null }), chatStream: async function* () {} }
  }
  function mkLlama(): ModelRuntime {
    return { modelId: 'llama', start: async () => {}, stop: async () => {}, health: async () => ({ healthy: true, message: '', port: 1 }), chatStream: async function* () {} }
  }

  it('falls back to the mock when no binary is on the drive', () => {
    const selected: string[] = []
    const factory = createSelectingRuntimeFactory({
      rootPath: '/root',
      resolveBin: () => null,
      modelExists: () => true,
      makeMock: mkMock,
      makeLlama: mkLlama,
      onSelect: (kind) => selected.push(kind)
    })
    expect(factory(opts).modelId).toBe('mock')
    expect(selected).toEqual(['mock'])
  })

  it('falls back to the mock when the binary exists but weights are absent', () => {
    const factory = createSelectingRuntimeFactory({
      rootPath: '/root',
      resolveBin: () => '/bin/llama-server',
      modelExists: () => false,
      makeMock: mkMock,
      makeLlama: mkLlama
    })
    expect(factory(opts).modelId).toBe('mock')
  })

  it('selects the real llama runtime only when binary AND weights are present', async () => {
    let binSeenPath = ''
    let llamaMade = false
    const factory = createSelectingRuntimeFactory({
      rootPath: '/root',
      resolveBin: () => '/bin/llama-server',
      modelExists: (p) => {
        binSeenPath = p
        return true
      },
      makeMock: mkMock,
      makeLlama: () => {
        llamaMade = true
        return mkLlama()
      },
      // Keep this Phase-10 selection test GPU-free (the ladder is covered in
      // tests/unit/runtime-ladder.test.ts); the probe seam avoids a real spawn.
      gpu: { probeDevices: async () => [] }
    })
    // Since Phase 15 the factory returns the LADDER runtime (the caller's modelId);
    // the real llama runtime is built lazily inside start().
    const runtime = factory(opts)
    expect(runtime.modelId).toBe('m')
    expect(binSeenPath).toBe('/w.gguf')
    expect(llamaMade).toBe(false)
    await runtime.start()
    expect(llamaMade).toBe(true)
    await runtime.stop()
  })
})
