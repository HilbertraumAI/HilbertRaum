import { describe, it, expect } from 'vitest'
import { engineSpawnsHeld, holdEngineSpawns, waitForEngineSpawns } from '../../src/main/services/runtime/spawn-gate'

// #516 (architecture.md "In-app engine updates" §3): while an install replaces a family's files,
// a spawn of that family waits for the swap instead of running a half-extracted program — bounded,
// so a wedged swap delays a spawn but never hangs it. The installer's side is pinned in
// engine-download.test.ts ("engine updates (#516)").

describe('engine spawn gate (#516)', () => {
  it('a held family makes spawns wait until the release; other families never wait', async () => {
    const release = holdEngineSpawns('llama_cpp')
    expect(engineSpawnsHeld('llama_cpp')).toBe(true)
    let passed = false
    const waiting = waitForEngineSpawns('llama_cpp').then(() => {
      passed = true
    })
    await waitForEngineSpawns('whisper_cpp') // not held: resolves at once
    await Promise.resolve()
    expect(passed).toBe(false)
    release()
    await waiting
    expect(passed).toBe(true)
    expect(engineSpawnsHeld('llama_cpp')).toBe(false)
  })

  it('release is idempotent, and a stale release cannot free a newer hold', async () => {
    const first = holdEngineSpawns('llama_cpp')
    first()
    first()
    const second = holdEngineSpawns('llama_cpp')
    first() // the first hold's release must not end the second one
    expect(engineSpawnsHeld('llama_cpp')).toBe(true)
    second()
    expect(engineSpawnsHeld('llama_cpp')).toBe(false)
  })

  it('the wait is bounded: a hold that never ends delays a spawn, it does not hang it', async () => {
    const release = holdEngineSpawns('whisper_cpp')
    try {
      await expect(waitForEngineSpawns('whisper_cpp', 20)).resolves.toBeUndefined()
    } finally {
      release()
    }
  })
})
