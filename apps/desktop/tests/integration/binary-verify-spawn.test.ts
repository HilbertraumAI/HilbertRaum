import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  initBinaryVerification,
  _resetBinaryVerificationForTests
} from '../../src/main/services/binary-verifier'
import { writeRuntimeMarker, markerBinaryKey } from '../../src/main/services/assets'
import { sha256File } from '../../src/main/services/models'
import { LlamaServer, type ChildProcessLike, type SpawnFn } from '../../src/main/services/runtime/sidecar'
import { probeGpuDevices } from '../../src/main/services/runtime/gpu'
import { createWhisperCliTranscriber } from '../../src/main/services/transcriber'
import { checkProgramLoads } from '../../src/main/services/engine-health'
import { KiwixServer } from '../../src/main/services/zim/serve'
import { kiwixManageAdd } from '../../src/main/services/zim/tools'

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

afterEach(() => _resetBinaryVerificationForTests())

/** A real on-disk binary whose install marker records a WRONG hash → the verifier returns `mismatch`. */
function tamperedBinary(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-verify-spawn-'))
  const bin = join(dir, name)
  writeFileSync(bin, 'real-binary-bytes')
  writeRuntimeMarker(dir, {
    version: 'b9585',
    backend: 'vulkan',
    os: 'win',
    arch: 'x64',
    binaries: { [markerBinaryKey(dir, bin)]: 'c'.repeat(64) } // recorded hash ≠ the actual bytes
  })
  return bin
}

/** A real on-disk binary whose install marker records its TRUE hash → the verifier returns `ok`. */
async function matchingBinary(name: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-verify-spawn-'))
  const bin = join(dir, name)
  writeFileSync(bin, 'real-binary-bytes')
  writeRuntimeMarker(dir, {
    version: 'b9585',
    backend: 'vulkan',
    os: 'win',
    arch: 'x64',
    binaries: { [markerBinaryKey(dir, bin)]: await sha256File(bin) }
  })
  return bin
}

/** A real on-disk binary under a LEGACY install marker (no recorded hashes) → the verifier says `skip-legacy`. */
function legacyBinary(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-verify-spawn-'))
  const bin = join(dir, name)
  writeFileSync(bin, 'real-binary-bytes')
  writeRuntimeMarker(dir, { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' })
  return bin
}

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
    const bin = tamperedBinary('llama-server.exe')
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

  it.each<[string, () => Promise<string> | string]>([
    ['the marker records the true hash (ok)', () => matchingBinary('llama-server.exe')],
    // security-model.md §3 "non-breaking rollout": a packaged legacy drive still launches.
    ['no marker records a hash — a legacy drive (skip-legacy)', () => legacyBinary('llama-server.exe')]
  ])('LlamaServer.start PROCEEDS through the real verifier: %s (positive control)', async (_label, make) => {
    initBinaryVerification(false)
    const bin = await make()
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
    const bin = tamperedBinary('llama-server.exe')
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
    const bin = tamperedBinary('llama-server.exe')
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
    const bin = tamperedBinary('whisper-cli.exe')
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
    const bin = tamperedBinary('kiwix-serve.exe')
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
    const bin = tamperedBinary('kiwix-manage.exe')
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
