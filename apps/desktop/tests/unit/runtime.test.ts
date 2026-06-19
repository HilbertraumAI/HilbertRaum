import { describe, it, expect } from 'vitest'
import { RuntimeManager } from '../../src/main/services/runtime'
import { createMockRuntime } from '../../src/main/services/runtime/mock'

describe('RuntimeManager + MockRuntime', () => {
  it('starts a model and reports healthy status', async () => {
    const mgr = new RuntimeManager(createMockRuntime)
    expect(mgr.status().running).toBe(false)

    const status = await mgr.start({
      modelId: 'qwen3-4b-instruct-q4',
      modelPath: '/models/chat/x.gguf',
      contextTokens: 4096
    })
    expect(status.running).toBe(true)
    expect(status.healthy).toBe(true)
    expect(status.modelId).toBe('qwen3-4b-instruct-q4')
    expect(mgr.activeModelId()).toBe('qwen3-4b-instruct-q4')
  })

  it('reports the launched context window on status (§L0) and clears it when stopped', async () => {
    const mgr = new RuntimeManager(createMockRuntime)
    // Not running → no window to report.
    expect(mgr.status().contextWindow).toBeUndefined()
    await mgr.start({ modelId: 'a', modelPath: '/a.gguf', contextTokens: 7777 })
    // The runtime echoes the exact value it was launched with (its --ctx-size).
    expect(mgr.status().contextWindow).toBe(7777)
    await mgr.stop()
    expect(mgr.status().contextWindow).toBeUndefined()
  })

  it('the mock runtime reports its configured context window', () => {
    const runtime = createMockRuntime({ modelId: 'a', modelPath: '/a.gguf', contextTokens: 3210 })
    expect(runtime.contextWindow()).toBe(3210)
  })

  it('switches models by restarting the runtime', async () => {
    const mgr = new RuntimeManager(createMockRuntime)
    await mgr.start({ modelId: 'a', modelPath: '/a.gguf', contextTokens: 2048 })
    const s = await mgr.start({ modelId: 'b', modelPath: '/b.gguf', contextTokens: 2048 })
    expect(s.modelId).toBe('b')
    expect(mgr.activeModelId()).toBe('b')
  })

  it('stops cleanly', async () => {
    const mgr = new RuntimeManager(createMockRuntime)
    await mgr.start({ modelId: 'a', modelPath: '/a.gguf', contextTokens: 2048 })
    await mgr.stop()
    expect(mgr.status().running).toBe(false)
    expect(mgr.activeModelId()).toBe(null)
  })

  it('streams a mock reply token-by-token that echoes the user message', async () => {
    const runtime = createMockRuntime({ modelId: 'a', modelPath: '/a.gguf', contextTokens: 2048 })
    await runtime.start()
    const chunks: string[] = []
    for await (const t of runtime.chatStream([{ role: 'user', content: 'hello there' }]))
      chunks.push(t)
    // Multiple tokens (not one blob), and the reply references the user's text.
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toContain('hello there')
  })

  it('stops streaming promptly when the signal is aborted', async () => {
    const runtime = createMockRuntime({ modelId: 'a', modelPath: '/a.gguf', contextTokens: 2048 })
    await runtime.start()
    const controller = new AbortController()
    const chunks: string[] = []
    for await (const t of runtime.chatStream([{ role: 'user', content: 'hi' }], {
      signal: controller.signal
    })) {
      chunks.push(t)
      if (chunks.length === 2) controller.abort()
    }
    // Aborting after 2 tokens means the stream ends without emitting the whole reply.
    expect(chunks.length).toBe(2)
  })
})
