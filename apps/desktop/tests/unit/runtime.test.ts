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

  it('yields a stub chat stream (full streaming in Phase 3)', async () => {
    const runtime = createMockRuntime({ modelId: 'a', modelPath: '/a.gguf', contextTokens: 2048 })
    await runtime.start()
    const chunks: string[] = []
    for await (const t of runtime.chatStream([{ role: 'user', content: 'hi' }])) chunks.push(t)
    expect(chunks.join('')).toContain('Phase 3')
  })
})
