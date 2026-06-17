import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  CHAT_SERVER_ARGS,
  ChatRequestError,
  DEEP_TEMPERATURE,
  FAST_MAX_TOKENS,
  FAST_TEMPERATURE,
  isExceedContextError,
  LlamaRuntime,
  readChatSSE,
  requestParamsForMode
} from '../../src/main/services/runtime/llama'
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

/** A `--reasoning-format deepseek` thinking delta (Phase 20 Deep mode). */
function reasoningChunk(reasoning_content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content } }] })}\n\n`
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

  it('sets --batch-size/--ubatch-size to min(ctx, 2048) on the chat sidecar (RT-1 prefill)', async () => {
    // Without these flags llama-server defaults the physical batch to 512, chunking prompt
    // prefill — the dominant time-to-first-token cost. The reranker raises its batch the same
    // way for the same reason (reranker.test.ts asserts --batch-size 2048). ctx 4096 caps at 2048.
    const { spawn, calls } = fakeSpawn()
    const runtime = new LlamaRuntime(startOpts, {
      binPath: '/bin/llama-server',
      spawn,
      fetchImpl: chatFetch({ frames: ['data: [DONE]\n\n'] }),
      findPort: async () => 51020,
      healthIntervalMs: 1
    })
    await runtime.start()
    const joined = calls[0].args.join(' ')
    expect(joined).toContain('--batch-size 2048')
    expect(joined).toContain('--ubatch-size 2048')
    await runtime.stop()

    // A context BELOW the cap sizes the batch to the context (it is min(ctx, 2048), not a fixed
    // 2048 — the whole prompt can't exceed n_ctx, so a larger physical batch would be wasted).
    const { spawn: spawn2, calls: calls2 } = fakeSpawn()
    const small = new LlamaRuntime(
      { ...startOpts, contextTokens: 1024 },
      {
        binPath: '/bin/llama-server',
        spawn: spawn2,
        fetchImpl: chatFetch({ frames: ['data: [DONE]\n\n'] }),
        findPort: async () => 51021,
        healthIntervalMs: 1
      }
    )
    await small.start()
    const joined2 = calls2[0].args.join(' ')
    expect(joined2).toContain('--batch-size 1024')
    expect(joined2).toContain('--ubatch-size 1024')
    await small.stop()
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

  it('surfaces the server error body and flags an exceed-context HTTP 400', async () => {
    const { spawn } = fakeSpawn()
    const errorJson = JSON.stringify({
      error: {
        message: 'request (6006 tokens) exceeds the available context size (4096 tokens)',
        type: 'exceed_context_size_error'
      }
    })
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      return {
        ok: false,
        status: 400,
        text: async () => errorJson
      } as unknown as Response
    }) as typeof fetch
    const runtime = new LlamaRuntime(startOpts, {
      binPath: '/bin/s',
      spawn,
      fetchImpl,
      findPort: async () => 51010,
      healthIntervalMs: 1
    })
    await runtime.start()
    let caught: unknown
    try {
      for await (const _t of runtime.chatStream([{ role: 'user', content: 'hi' }])) void _t
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ChatRequestError)
    expect((caught as Error).message).toMatch(/HTTP 400/)
    // The server's REASON is now part of the error (it used to be discarded).
    expect((caught as Error).message).toMatch(/exceeds the available context size/)
    expect(isExceedContextError(caught)).toBe(true)
    await runtime.stop()
  })

  it('isExceedContextError is false for ordinary errors and non-context HTTP failures', () => {
    expect(isExceedContextError(new Error('boom'))).toBe(false)
    expect(isExceedContextError(new ChatRequestError(503, 'service unavailable', ''))).toBe(false)
  })
})

// ---- Answer-depth modes (Phase 20, wave-1 decisions D4+D5 — architecture.md "Chat & streaming") ---------------------------

describe('answer-depth mode → request mapping (D4)', () => {
  it('maps fast / balanced / deep / omitted per the locked D4 table', () => {
    expect(requestParamsForMode('fast')).toEqual({
      enableThinking: false,
      temperature: FAST_TEMPERATURE,
      maxTokens: FAST_MAX_TOKENS
    })
    expect(requestParamsForMode('balanced')).toEqual({ enableThinking: false })
    expect(requestParamsForMode('deep')).toEqual({
      enableThinking: true,
      temperature: DEEP_TEMPERATURE
    })
    // Omitted = balanced: thinking must be EXPLICITLY off (the b9585 server default
    // is thinking ON for any capable template — omitting the kwarg would think).
    expect(requestParamsForMode(undefined)).toEqual({ enableThinking: false })
  })

  const startOpts: RuntimeStartOptions = {
    modelId: 'qwen3-4b-instruct-q4',
    modelPath: '/models/x.gguf',
    contextTokens: 4096
  }

  async function captureBody(opts?: Parameters<LlamaRuntime['chatStream']>[1]): Promise<{
    body: Record<string, unknown>
    args: string[]
  }> {
    const { spawn, calls } = fakeSpawn()
    let chatBody: Record<string, unknown> = {}
    const runtime = new LlamaRuntime(startOpts, {
      binPath: '/bin/llama-server',
      spawn,
      fetchImpl: chatFetch({
        frames: ['data: [DONE]\n\n'],
        onChat: (_url, init) => {
          chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        }
      }),
      findPort: async () => 51002,
      healthIntervalMs: 1
    })
    await runtime.start()
    for await (const _t of runtime.chatStream([{ role: 'user', content: 'q' }], opts)) void _t
    await runtime.stop()
    return { body: chatBody, args: calls[0].args }
  }

  it('sends chat_template_kwargs.enable_thinking=false with NO sampling overrides when mode is omitted (balanced)', async () => {
    const { body, args } = await captureBody()
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('max_tokens')
    // The D5 mechanism's preconditions are pinned in the spawn args: jinja templating
    // (kwargs only act there) + deepseek reasoning extraction (separate deltas).
    expect(args.join(' ')).toContain('--jinja')
    expect(args.join(' ')).toContain('--reasoning-format deepseek')
  })

  it('sends cache_prompt:true so the slot KV prefix is reused across turns (skill-fence prefill is one-time)', async () => {
    const { body } = await captureBody()
    expect(body.cache_prompt).toBe(true)
  })

  it('fast → thinking off + temperature 0.7 + modest max_tokens', async () => {
    const { body } = await captureBody({ mode: 'fast' })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(body.temperature).toBe(FAST_TEMPERATURE)
    expect(body.max_tokens).toBe(FAST_MAX_TOKENS)
  })

  it('deep → thinking ON + the Qwen3 thinking-mode temperature, uncapped', async () => {
    const { body } = await captureBody({ mode: 'deep' })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(body.temperature).toBe(DEEP_TEMPERATURE)
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('explicit maxTokens/temperature win over the mode mapping', async () => {
    const { body } = await captureBody({ mode: 'fast', maxTokens: 64, temperature: 0.2 })
    expect(body.max_tokens).toBe(64)
    expect(body.temperature).toBe(0.2)
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('routes reasoning deltas to onReasoning and never into the yielded answer', async () => {
    const { spawn } = fakeSpawn()
    const runtime = new LlamaRuntime(startOpts, {
      binPath: '/bin/llama-server',
      spawn,
      fetchImpl: chatFetch({
        frames: [
          reasoningChunk('Let me'),
          reasoningChunk(' think.'),
          // A single chunk may carry BOTH keys (diffs batched into one delta).
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: ' Done.', content: 'The' } }] })}\n\n`,
          chatChunk(' answer.'),
          'data: [DONE]\n\n'
        ]
      }),
      findPort: async () => 51003,
      healthIntervalMs: 1
    })
    await runtime.start()
    const reasoning: string[] = []
    const out: string[] = []
    for await (const t of runtime.chatStream([{ role: 'user', content: 'q' }], {
      mode: 'deep',
      onReasoning: (d) => reasoning.push(d)
    })) {
      out.push(t)
    }
    expect(reasoning.join('')).toBe('Let me think. Done.')
    expect(out.join('')).toBe('The answer.')
    await runtime.stop()
  })

  it('readChatSSE reports reasoning via the callback without breaking [DONE]/abort semantics', async () => {
    const stream = sseStream([
      reasoningChunk('r1'),
      chatChunk('c1'),
      'data: [DONE]\n\n',
      reasoningChunk('IGNORED AFTER DONE')
    ])
    const reasoning: string[] = []
    const out: string[] = []
    for await (const t of readChatSSE(stream, undefined, (d) => reasoning.push(d))) out.push(t)
    expect(reasoning).toEqual(['r1'])
    expect(out).toEqual(['c1'])
  })

  it('CHAT_SERVER_ARGS precede ladder extraArgs (a rung can still force --device none)', async () => {
    const { spawn, calls } = fakeSpawn()
    const runtime = new LlamaRuntime(startOpts, {
      binPath: '/bin/llama-server',
      spawn,
      fetchImpl: chatFetch({ frames: ['data: [DONE]\n\n'] }),
      findPort: async () => 51004,
      healthIntervalMs: 1,
      extraArgs: ['--device', 'none']
    })
    await runtime.start()
    const joined = calls[0].args.join(' ')
    for (const a of CHAT_SERVER_ARGS) expect(calls[0].args).toContain(a)
    expect(joined).toContain('--device none')
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
