import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { initBinaryVerification } from '../../src/main/services/binary-verifier'
import { LlamaServer, type ChildProcessLike, type SpawnFn } from '../../src/main/services/runtime/sidecar'
import { probeGpuDevices } from '../../src/main/services/runtime/gpu'
import { createWhisperCliTranscriber } from '../../src/main/services/transcriber'
import { checkProgramLoads } from '../../src/main/services/engine-health'
import { KiwixServer } from '../../src/main/services/zim/serve'
import { kiwixManageAdd } from '../../src/main/services/zim/tools'
import { engineProblemFor, resetEngineProblemsForTest } from '../../src/main/services/runtime/engine-load'
import { binaryWithMarker, verifierInert, type MarkerVerdict } from '../helpers/binary-fixtures'

// TEST-2 (full-audit-2026-06-29, Phase 3): the binary-verifier verdict/cache matrix is well unit-
// tested (binary-verifier.test.ts). A seam test that injects a fake verdict (`verify: () => 'mismatch'`)
// proves only "IF the verifier says mismatch the seam refuses", NOT that the seam is still WIRED to
// the REAL verifier: a regression that silently stopped calling `verifyBinaryBeforeSpawn` before a
// spawn would redden none of them — the supply-chain control (vuln-scan-2026-06-21 item B) could be
// fully correct and fully unwired.
//
// So this file drives the REAL `verifyBinaryBeforeSpawn` end-to-end at the spawn seams:
// `LlamaServer.start`, the GPU `--list-devices` probe, the `whisper-cli` spawn, the #530
// "Check again" engine check (`checkProgramLoads`), and the knowledge packs' `kiwix-serve` and
// `kiwix-manage` (#656). PACKAGED enforcement ON
// (`initBinaryVerification(false)`) + a real on-disk install marker whose recorded hash does NOT
// match the binary's bytes → each seam must REFUSE to spawn (no child created). They
// deliberately do NOT inject a seam's `verify` option — the wiring IS the point. The
// LlamaServer seam's positive controls run through the real verifier too: a matching marker (`ok`)
// and a legacy, hash-less marker (`skip-legacy`, security-model.md §3's non-breaking rollout). The
// injected-verdict copies in sidecar.test.ts (LlamaServer) and transcriber.test.ts (whisper-cli) were
// retired for these, and neither seam takes a verifier option any more; nor do the kiwix seams.
//
// TEETH: delete the `verifyBinaryBeforeSpawn`/`verify` call at a seam → the spawn proceeds (`calls` non-empty /
// the refusal vanishes) → the matching test reddens. The matching-marker positive control proves the
// refusal is genuinely the hash mismatch, not an always-refuse harness artefact.

afterEach(() => {
  verifierInert()
  resetEngineProblemsForTest()
})

// ---- LlamaServer.start seam (chat / embedder / reranker / vision all funnel here) -----

class FakeLlamaChild extends EventEmitter implements ChildProcessLike {
  pid = 4242
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
}
function recordingLlamaSpawn(): { spawn: SpawnFn; calls: string[][]; child: FakeLlamaChild } {
  const calls: string[][] = []
  const child = new FakeLlamaChild()
  const spawn: SpawnFn = (_command, args) => {
    calls.push(args)
    return child
  }
  return { spawn, calls, child }
}
const healthyFetch = (): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }) as Response) as typeof fetch

/** A piped-stdout fake child for the GPU probe seam (mirrors gpu.test.ts's FakeProbeChild). */
class FakeProbeChild extends EventEmitter implements ChildProcessLike {
  pid = 7
  killed = false
  stdout = new EventEmitter()
  kill(): boolean {
    this.killed = true
    return true
  }
}

describe('TEST-2 — spawn seams refuse a hash-mismatched binary through the REAL verifier', () => {
  it('LlamaServer.start REFUSES a tampered binary (no child ever spawned)', async () => {
    initBinaryVerification(false) // packaged build → enforcement ON
    const bin = await binaryWithMarker('llama-server.exe', 'mismatch')
    const { spawn, calls } = recordingLlamaSpawn()
    const server = new LlamaServer({
      binPath: bin,
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl: healthyFetch(),
      findPort: async () => 51000,
      healthIntervalMs: 1
      // NB: LlamaServer has no verifier seam: it always calls the REAL verifyBinaryBeforeSpawn.
    })
    // The exact shape `failureSignature` classifies as `integrity` (the ladder's #312 comparison).
    await expect(server.start()).rejects.toThrow(/^llama-server failed pre-spawn integrity verification/)
    expect(calls).toHaveLength(0) // the real verifier blocked the spawn before any port/child
  })

  it.each<[string, MarkerVerdict]>([
    ['the marker records the true hash (ok)', 'ok'],
    // security-model.md §3 "non-breaking rollout": a packaged legacy drive still launches.
    ['no marker records a hash — a legacy drive (skip-legacy)', 'legacy']
  ])('LlamaServer.start PROCEEDS through the real verifier: %s (positive control)', async (_label, verdict) => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('llama-server.exe', verdict)
    const { spawn, calls } = recordingLlamaSpawn()
    const server = new LlamaServer({
      binPath: bin,
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl: healthyFetch(),
      findPort: async () => 51001,
      healthIntervalMs: 1
    })
    await server.start()
    expect(calls).toHaveLength(1) // the real verifier let the spawn through — so the refusal above is real
    await server.stop()
  })

  // ---- GPU --list-devices probe seam ------------------------------------------------

  it('the GPU probe REFUSES a tampered binary (returns [], no child spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('llama-server.exe', 'mismatch')
    const calls: string[][] = []
    const spawn: SpawnFn = (_command, args) => {
      calls.push(args)
      const child = new FakeProbeChild()
      // If (wrongly) spawned, settle fast so a neutered teeth-check terminates instead of hanging.
      queueMicrotask(() => child.emit('close', 0))
      return child
    }
    const devices = await probeGpuDevices(bin, { spawn, timeoutMs: 200 })
    expect(devices).toEqual([]) // a tampered binary reads as "no GPU" — the probe never throws
    expect(calls).toHaveLength(0) // …and the real verifier blocked the probe spawn entirely
  })

  // ---- #530 "Check again" engine check seam (engine-health.ts checkProgramLoads) ------------

  it('the engine check REFUSES to launch a tampered binary (unchecked, no child spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('llama-server.exe', 'mismatch')
    const calls: string[][] = []
    const spawn: SpawnFn = (_command, args) => {
      calls.push(args)
      const child = new FakeProbeChild()
      queueMicrotask(() => child.emit('close', 0, null)) // if (wrongly) spawned, settle fast
      return child
    }
    // NB: no `verify` → checkProgramLoads falls back to the REAL verifyBinaryBeforeSpawn, as
    // recheckEngines(ctx) calls it in production.
    expect(await checkProgramLoads('llama_cpp', bin, ['--version'], { spawn, timeoutMs: 200 })).toBe('unchecked')
    expect(calls).toHaveLength(0)
  })

  // ---- whisper-cli spawn seam -------------------------------------------------------

  it('WhisperCliTranscriber.transcribe REFUSES a tampered whisper-cli (no child spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('whisper-cli.exe', 'mismatch')
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-verify-spawn-work-'))
    let spawned = false
    const transcriber = createWhisperCliTranscriber({
      id: 'whisper-small-multilingual',
      binPath: bin,
      modelPath: '/m/ggml-small.bin',
      spawnImpl: (_cmd: string, _args: string[], _o: SpawnOptions): ChildProcess => {
        spawned = true
        const child = new EventEmitter() as unknown as ChildProcess
        // If (wrongly) spawned, settle fast so a neutered teeth-check fails by name instead of hanging.
        queueMicrotask(() => child.emit('close', 0, null))
        return child
      }
      // NB: WhisperCliTranscriber has no verifier seam: it always calls the REAL verifyBinaryBeforeSpawn.
    })
    await expect(transcriber.transcribe('/audio/meeting.mp3', { workDir })).rejects.toThrow(
      /integrity verification/
    )
    expect(spawned).toBe(false) // the real verifier blocked the whisper spawn
  })

  // ---- Knowledge packs: kiwix-serve and kiwix-manage (#656) ---------------------------

  it('KiwixServer.ensureStarted REFUSES a tampered kiwix-serve (no port, no child spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('kiwix-serve.exe', 'mismatch')
    const { spawn, calls } = recordingLlamaSpawn()
    let ports = 0
    const server = new KiwixServer({
      binPath: bin,
      spawn,
      findPort: async () => {
        ports++
        return 51002
      },
      probe: async () => true,
      allocateGeneration: () => 1,
      healthIntervalMs: 1
      // NB: KiwixServer has no verifier seam: it always calls the REAL verifyBinaryBeforeSpawn.
    })
    await expect(server.ensureStarted({ libraryXmlPath: join(tmpdir(), 'library.1.xml') })).rejects.toThrow(
      /^kiwix-serve failed pre-spawn integrity verification$/
    )
    expect(calls).toHaveLength(0)
    expect(ports).toBe(0) // refused before a port was even taken
  })

  it('kiwixManageAdd REFUSES a tampered kiwix-manage (no child spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('kiwix-manage.exe', 'mismatch')
    const calls: string[][] = []
    const spawn: SpawnFn = (_command, args) => {
      calls.push(args)
      const child = new FakeProbeChild()
      queueMicrotask(() => child.emit('exit', 0, null)) // if (wrongly) spawned, settle fast
      return child
    }
    // NB: kiwixManageAdd has no verifier seam: it always calls the REAL verifyBinaryBeforeSpawn.
    await expect(
      kiwixManageAdd(bin, join(tmpdir(), 'library.xml'), join(tmpdir(), 'pack.zim'), spawn, { timeoutMs: 200 })
    ).rejects.toMatchObject({ name: 'KiwixManageError', kind: 'verify', childState: 'not-spawned' })
    expect(calls).toHaveLength(0)
  })
})

// #1012: the marker records a file that is not on the disk (an antivirus quarantine, a copy cut short).
// That is no tamper: the two engines refuse the start and record the "engine files damaged" verdict the
// #532 "Install again" offer reads (a start that went ahead and ran would drop that verdict at once). The
// knowledge-pack tools have no such repair: they refuse a missing program or library like the engines
// (review R-1, R-6) and start when only another file is missing (owner call on #1012).
describe('#1012 — spawn seams and a copy missing a file its marker records, through the REAL verifier', () => {
  const engineFilesDamaged = { reason: 'files-damaged' }

  it('LlamaServer.start REFUSES it with the engine-files verdict (no child spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('llama-server.exe', 'missing')
    const { spawn, calls } = recordingLlamaSpawn()
    const server = new LlamaServer({
      binPath: bin,
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl: healthyFetch(),
      findPort: async () => 51003,
      healthIntervalMs: 1
    })
    // The typed refusal the start ladder walks on from (next rung), blaming neither the GPU nor the model.
    await expect(server.start()).rejects.toMatchObject({
      name: 'EngineCannotRunError',
      problem: { family: 'llama_cpp', ...engineFilesDamaged }
    })
    expect(engineProblemFor('llama_cpp')).toMatchObject(engineFilesDamaged)
    expect(calls).toHaveLength(0)
  })

  it('the GPU probe answers unknown (null, never "no GPU") and records the verdict (no child spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('llama-server.exe', 'missing')
    const calls: string[][] = []
    const spawn: SpawnFn = (_command, args) => {
      calls.push(args)
      const child = new FakeProbeChild()
      queueMicrotask(() => child.emit('close', 0)) // if (wrongly) spawned, settle fast
      return child
    }
    expect(await probeGpuDevices(bin, { spawn, timeoutMs: 200 })).toBeNull()
    expect(engineProblemFor('llama_cpp')).toMatchObject(engineFilesDamaged)
    expect(calls).toHaveLength(0)
  })

  it('the engine check ("Check again") still finds it refused (no child spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('llama-server.exe', 'missing')
    const calls: string[][] = []
    const spawn: SpawnFn = (_command, args) => {
      calls.push(args)
      const child = new FakeProbeChild()
      queueMicrotask(() => child.emit('close', 0, null)) // if (wrongly) spawned, settle fast
      return child
    }
    expect(await checkProgramLoads('llama_cpp', bin, ['--version'], { spawn, timeoutMs: 200 })).toBe('refused')
    expect(engineProblemFor('llama_cpp')).toMatchObject(engineFilesDamaged)
    expect(calls).toHaveLength(0)
  })

  it('WhisperCliTranscriber.transcribe REFUSES it with the voice engine’s verdict (no child spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('whisper-cli.exe', 'missing')
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-verify-spawn-work-'))
    let spawned = false
    const transcriber = createWhisperCliTranscriber({
      id: 'whisper-small-multilingual',
      binPath: bin,
      modelPath: '/m/ggml-small.bin',
      spawnImpl: (_cmd: string, _args: string[], _o: SpawnOptions): ChildProcess => {
        spawned = true
        const child = new EventEmitter() as unknown as ChildProcess
        queueMicrotask(() => child.emit('close', 0, null)) // if (wrongly) spawned, settle fast
        return child
      }
    })
    await expect(transcriber.transcribe('/audio/meeting.mp3', { workDir })).rejects.toMatchObject({
      name: 'EngineCannotRunError',
      problem: { family: 'whisper_cpp', ...engineFilesDamaged }
    })
    expect(engineProblemFor('whisper_cpp')).toMatchObject(engineFilesDamaged)
    expect(spawned).toBe(false)
  })

  // Review R-1: a missing LIBRARY is looked for elsewhere by the OS loader — the kiwix children start in
  // the knowledge-pack library's folder, where a planted copy would be found — so it stops kiwix too.
  it('KiwixServer.ensureStarted REFUSES a copy missing a recorded library (no port, no child spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('kiwix-serve.exe', 'missing')
    const { spawn, calls } = recordingLlamaSpawn()
    let ports = 0
    const server = new KiwixServer({
      binPath: bin,
      spawn,
      findPort: async () => {
        ports++
        return 51004
      },
      probe: async () => true,
      allocateGeneration: () => 1,
      healthIntervalMs: 1
    })
    // Code review round 3: its own kind and message — a missing file is no tamper.
    await expect(server.ensureStarted({ libraryXmlPath: join(tmpdir(), 'library.1.xml') })).rejects.toMatchObject({
      name: 'KiwixServeStartError',
      kind: 'files',
      message: 'kiwix-serve was not started: a file of its install is missing'
    })
    expect(calls).toHaveLength(0)
    expect(ports).toBe(0)
  })

  // Owner call on #1012: the knowledge-pack tools have no in-app repair, so a missing file the program
  // never loads (a tool the app never runs, such as `kiwix-search`) is logged and the program starts.
  it('kiwixManageAdd still runs kiwix-manage when only a program it never loads is missing', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('kiwix-manage.exe', 'missing-other')
    const calls: string[][] = []
    const spawn: SpawnFn = (_command, args) => {
      calls.push(args)
      const child = new FakeProbeChild()
      queueMicrotask(() => child.emit('exit', 0, null))
      return child
    }
    await expect(
      kiwixManageAdd(bin, join(tmpdir(), 'library.xml'), join(tmpdir(), 'pack.zim'), spawn, { timeoutMs: 200 })
    ).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  // Review R-6: the spawned program itself gone (quarantined) is refused before the spawn, as before #1012.
  it('kiwixManageAdd REFUSES when kiwix-manage itself is gone (not spawned)', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('kiwix-manage.exe', 'program-gone')
    const calls: string[][] = []
    const spawn: SpawnFn = (_command, args) => {
      calls.push(args)
      const child = new FakeProbeChild()
      queueMicrotask(() => child.emit('exit', 0, null)) // if (wrongly) spawned, settle fast
      return child
    }
    await expect(
      kiwixManageAdd(bin, join(tmpdir(), 'library.xml'), join(tmpdir(), 'pack.zim'), spawn, { timeoutMs: 200 })
    ).rejects.toMatchObject({ name: 'KiwixManageError', kind: 'files', childState: 'not-spawned' }) // no tamper
    expect(calls).toHaveLength(0)
  })
})

// #1012 review R-2: a recorded file that cannot be READ right now (an antivirus or indexer holding it, a
// denied read) is neither a tamper nor damage. The verifier answers `unreadable` (re-checked on the next
// attempt); no seam records a verdict, the probe gives no answer, and the start fails with a typed error
// the ladder does not count as evidence about the GPU. The read error is real: a folder sits at the
// library's recorded path, so the production `sha256File` read fails with EISDIR (not ENOENT), on every OS.
describe('#1012 — spawn seams and a recorded file that cannot be read, through the REAL verifier', () => {
  it('LlamaServer.start fails with the typed unreadable error: no verdict, no child spawned', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('llama-server.exe', 'unreadable')
    const { spawn, calls } = recordingLlamaSpawn()
    const server = new LlamaServer({
      binPath: bin,
      modelPath: '/m.gguf',
      contextTokens: 2048,
      spawn,
      fetchImpl: healthyFetch(),
      findPort: async () => 51005,
      healthIntervalMs: 1
    })
    await expect(server.start()).rejects.toMatchObject({ name: 'EngineFilesUnreadableError' })
    expect(engineProblemFor('llama_cpp')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('the GPU probe gives no answer (null, never "no GPU" for the session): no verdict, no child spawned', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('llama-server.exe', 'unreadable')
    const calls: string[][] = []
    const spawn: SpawnFn = (_command, args) => {
      calls.push(args)
      const child = new FakeProbeChild()
      queueMicrotask(() => child.emit('close', 0)) // if (wrongly) spawned, settle fast
      return child
    }
    expect(await probeGpuDevices(bin, { spawn, timeoutMs: 200 })).toBeNull()
    expect(engineProblemFor('llama_cpp')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('WhisperCliTranscriber.transcribe fails with the typed unreadable error: no verdict, no child spawned', async () => {
    initBinaryVerification(false)
    const bin = await binaryWithMarker('whisper-cli.exe', 'unreadable')
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-verify-spawn-work-'))
    let spawned = false
    const transcriber = createWhisperCliTranscriber({
      id: 'whisper-small-multilingual',
      binPath: bin,
      modelPath: '/m/ggml-small.bin',
      spawnImpl: (_cmd: string, _args: string[], _o: SpawnOptions): ChildProcess => {
        spawned = true
        const child = new EventEmitter() as unknown as ChildProcess
        queueMicrotask(() => child.emit('close', 0, null)) // if (wrongly) spawned, settle fast
        return child
      }
    })
    await expect(transcriber.transcribe('/audio/meeting.mp3', { workDir })).rejects.toMatchObject({
      name: 'EngineFilesUnreadableError'
    })
    expect(engineProblemFor('whisper_cpp')).toBeNull()
    expect(spawned).toBe(false)
  })
})
