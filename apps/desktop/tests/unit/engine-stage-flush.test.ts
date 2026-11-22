import { describe, expect, it, vi } from 'vitest'
// #1000: the engine stage runs while the models keep answering, so its flush must not block the main
// thread. Every staged file goes to the device through `FileHandle.sync()` (the thread pool), one after
// the other, before the marker is written, and the marker itself after; no `fsyncSync` in the stage.
// The synchronous flush measured 64–105 ms of one event-loop block for the 52-file b12110 copy on NVMe
// (seconds on a stick). The seams record the module's own calls: `open` (node:fs/promises) wraps each
// handle's `sync`, and `fsyncSync` / `writeFileSync` (node:fs) note the sync flush and the marker write.
const seen = vi.hoisted(() => ({ recording: false, events: [] as string[] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  const mocked = {
    ...orig,
    open: async (...args: Parameters<typeof orig.open>) => {
      const handle = await orig.open(...args)
      const sync = handle.sync.bind(handle)
      return Object.assign(handle, {
        sync: async () => {
          if (seen.recording) seen.events.push(`sync ${String(args[0])}`)
          return sync()
        }
      })
    }
  }
  return { ...mocked, default: mocked }
})
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  const mocked = {
    ...orig,
    fsyncSync: (...args: Parameters<typeof orig.fsyncSync>) => {
      if (seen.recording) seen.events.push('fsyncSync')
      return orig.fsyncSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof orig.writeFileSync>) => {
      if (seen.recording) seen.events.push(`write ${String(args[0])}`)
      return orig.writeFileSync(...args)
    }
  }
  return { ...mocked, default: mocked }
})

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostRuntimeArch, hostRuntimeOs, stageEngineInstall, type ExtractFn } from '../../src/main/services/runtime-download'
import { planRuntimeDownload, runtimeMarkerPath } from '../../src/main/services/assets'
import { llamaServerBinaryName } from '../../src/main/services/runtime/sidecar'

const BIN = llamaServerBinaryName()

describe('the engine stage flushes off the main thread (#1000)', () => {
  it('every staged file gets FileHandle.sync() before the marker is written, the marker one after, and no fsyncSync runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hr-stage-flush-'))
    const plan = planRuntimeDownload(
      root,
      {
        os: hostRuntimeOs(),
        arch: hostRuntimeArch(),
        backend: 'cpu',
        url: 'https://example.test/llama.zip',
        sha256: 'a'.repeat(64),
        extractTo: `runtime/llama.cpp/${hostRuntimeOs()}`
      },
      'b200'
    )
    mkdirSync(plan.extractTo, { recursive: true })
    writeFileSync(plan.zipDest, 'a verified archive')
    const staging = `${plan.extractTo}.new`
    const files = [join(staging, BIN), join(staging, 'ggml.dll'), join(staging, 'backends', 'ggml-cpu.dll')]
    const extract: ExtractFn = async () => {
      await mkdir(join(staging, 'backends'), { recursive: true })
      for (const f of files) await writeFile(f, `bytes of ${f}`)
    }
    seen.recording = true
    try {
      await stageEngineInstall(plan, staging, { extract })
    } finally {
      seen.recording = false
    }
    const marker = runtimeMarkerPath(staging)
    const markerWrite = seen.events.indexOf(`write ${marker}`)
    expect(markerWrite).toBeGreaterThan(-1)
    for (const f of files) {
      const at = seen.events.indexOf(`sync ${f}`)
      expect(at, f).toBeGreaterThan(-1)
      expect(at, f).toBeLessThan(markerWrite)
    }
    expect(seen.events.indexOf(`sync ${marker}`)).toBeGreaterThan(markerWrite)
    expect(seen.events).not.toContain('fsyncSync')
  })
})
