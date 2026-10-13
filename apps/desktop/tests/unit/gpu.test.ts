import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCachedGpuProbe, parseListDevices, probeGpuDevices } from '../../src/main/services/runtime/gpu'
import { holdEngineSpawns } from '../../src/main/services/runtime/spawn-gate'
import { log } from '../../src/main/services/logging'
import { until } from '../helpers/hang-budget'
import type { ChildProcessLike, SpawnFn } from '../../src/main/services/runtime/sidecar'

// Phase 15 GPU probe (architecture.md GPU record §5.1). Zero GPUs, zero binaries: the
// probe is driven entirely through the fake-spawn seam.

// L19 (audit-2026-06-13): a captured-real-output regression fixture. This is the verbatim
// `llama-server --list-devices` STDOUT captured on the CURRENT pin, b11146, on the dev box
// (i9-14900K / RTX 3080 Ti, 2026-09-27, #518; CRLF preserved — .gitattributes keeps it binary).
// b11146 also prints `llama_server: initializing ...` on STDERR, which the probe never reads.
// The b9585 capture it replaces (F-40, audit-2026-07-16) was two pins old and is retired: same
// machine, same device-line shape, only the free figure differed, and a pin-named fixture that
// lags the pin is exactly what #518 describes. This one lists TWO devices — the card and the
// Intel UHD 770 iGPU the b9585 run did not show — so it also pins the hybrid-box parse (both
// names sit in gpu-rules.test.ts's `looksIntegrated` table). Re-capture on every runtime pin
// bump (TS-3(a)).
const LIST_DEVICES_B11146 = readFileSync(
  join(__dirname, '..', 'fixtures', 'list-devices-b11146-vulkan-rtx3080ti.txt'),
  'utf8'
)

// A hand-written LF variant of the same card's line (an earlier b9585 free figure).
const RTX_3080TI_OUTPUT = `Available devices:
  Vulkan0: NVIDIA GeForce RTX 3080 Ti (12300 MiB, 11511 MiB free)
`

describe('parseListDevices', () => {
  it('parses the captured real b11146 --list-devices fixture (L19 regression, #518)', () => {
    // The on-disk capture still carries the tool's native CRLF line endings — the parser
    // must split on /\r?\n/ and land the same devices a hand-written string would.
    expect(LIST_DEVICES_B11146).toContain('\r\n')
    expect(parseListDevices(LIST_DEVICES_B11146)).toEqual([
      { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12084, freeMb: 11316 },
      // The iGPU reports unified memory: "free" above "total" is what the tool printed.
      { id: 'Vulkan1', name: 'Intel(R) UHD Graphics 770', totalMb: 32606, freeMb: 48060 }
    ])
  })

  it('parses multiple devices in order', () => {
    const out = parseListDevices(
      'Available devices:\n' +
        '  Vulkan0: AMD Radeon RX 6700 XT (12272 MiB, 12000 MiB free)\n' +
        '  Vulkan1: Intel(R) Iris(R) Xe Graphics (16000 MiB, 15000 MiB free)\n'
    )
    expect(out.map((d) => d.id)).toEqual(['Vulkan0', 'Vulkan1'])
    expect(out[0].name).toBe('AMD Radeon RX 6700 XT')
    expect(out[1].name).toBe('Intel(R) Iris(R) Xe Graphics')
    expect(out[1].totalMb).toBe(16000)
  })

  it('returns [] for an empty device list (CPU build / no usable Vulkan)', () => {
    expect(parseListDevices('Available devices:\n')).toEqual([])
    expect(parseListDevices('')).toEqual([])
    // #653: the real "no device" stdout of both pins (captured on the GTX 1070 Ti box with every
    // device hidden): b11146 prints `(none)` under the header, b9849 the header alone.
    expect(parseListDevices('Available devices:\r\n  (none)\r\n')).toEqual([])
    expect(parseListDevices('Available devices:\r\n')).toEqual([])
  })

  it('ignores garbage and non-device noise', () => {
    const out = parseListDevices(
      'ggml_vulkan: Found 1 Vulkan devices:\n' +
        'random warning text\n' +
        'error: something (not a device)\n' +
        '  Vulkan0: NVIDIA GeForce RTX 3080 Ti (12300 MiB, 11511 MiB free)\n' +
        'trailing line\n'
    )
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('Vulkan0')
  })

  it('handles odd device names (parentheses, unicode, registered marks)', () => {
    const out = parseListDevices(
      '  Vulkan0: Intel(R) UHD Graphics 630 (CFL GT2) (8000 MiB, 7000 MiB free)\n' +
        '  Metal0: Apple M2 Pro — GPU (21845 MiB, 20000 MiB free)\n'
    )
    expect(out).toHaveLength(2)
    expect(out[0].name).toBe('Intel(R) UHD Graphics 630 (CFL GT2)')
    expect(out[1].name).toBe('Apple M2 Pro — GPU')
  })
})

// ---- probeGpuDevices (fake spawn — no real binary, no GPU) -------------------------

class FakeProbeChild extends EventEmitter implements ChildProcessLike {
  pid = 9
  killed = false
  stdout = new EventEmitter()
  kill(): boolean {
    this.killed = true
    return true
  }
}

function probeSpawn(behavior: (child: FakeProbeChild) => void): {
  spawn: SpawnFn
  calls: Array<{ command: string; args: string[] }>
} {
  const calls: Array<{ command: string; args: string[] }> = []
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args })
    const child = new FakeProbeChild()
    queueMicrotask(() => behavior(child))
    return child
  }
  return { spawn, calls }
}

describe('probeGpuDevices', () => {
  afterEach(() => vi.useRealTimers()) // T6: timeout test uses fake timers; restore for the rest

  it('parses devices from a successful probe and passes --list-devices', async () => {
    const { spawn, calls } = probeSpawn((child) => {
      child.stdout.emit('data', RTX_3080TI_OUTPUT)
      child.emit('close', 0, null)
    })
    const devices = await probeGpuDevices('/bin/llama-server', { spawn })
    expect(devices).toHaveLength(1)
    expect(devices![0].name).toBe('NVIDIA GeForce RTX 3080 Ti')
    expect(calls[0].args).toEqual(['--list-devices'])
  })

  // #516 (architecture.md "In-app engine updates" §3): the probe runs the llama-server an engine
  // install replaces, so it waits for the swap like LlamaServer does (sidecar.test.ts).
  it('waits for an engine install to finish its swap before it spawns (#516 spawn gate)', async () => {
    const { spawn, calls } = probeSpawn((child) => {
      child.stdout.emit('data', RTX_3080TI_OUTPUT)
      child.emit('close', 0, null)
    })
    const release = holdEngineSpawns('llama_cpp')
    const probing = probeGpuDevices('/bin/llama-server', { spawn })
    try {
      // One macrotask: every microtask the probe could chain (verify, spawn) has run.
      await new Promise((r) => setImmediate(r))
      expect(calls).toHaveLength(0) // held: nothing spawned mid-swap
    } finally {
      release()
    }
    expect(await probing).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('waits for stdout drained after exit ("close"), so late data is not truncated', async () => {
    // Audit fix regression: Node can fire 'exit' BEFORE pending stdout data is
    // delivered. Resolving there would parse a truncated (often empty) device list.
    const { spawn } = probeSpawn((child) => {
      child.emit('exit', 0, null) // process gone, pipe not drained yet
      child.stdout.emit('data', RTX_3080TI_OUTPUT) // late-delivered output
      child.emit('close', 0, null) // stdio drained — only NOW may we parse
    })
    const devices = await probeGpuDevices('/bin/llama-server', { spawn })
    expect(devices).toHaveLength(1)
    expect(devices![0].name).toBe('NVIDIA GeForce RTX 3080 Ti')
  })

  // #653: a probe that never got to answer is UNKNOWN (`null`), not "no graphics card". Before, these
  // resolved `[]`, which the session cache kept and `probeAndPersistGpu` stamped: a card machine whose
  // probe child crashed read "None" everywhere and its card start was labelled cpu. Windows EPERM /
  // EACCES / UNKNOWN are refusals (`null` + the engine verdict, engine-load-spawn.test.ts); the
  // non-refusal codes below record no verdict. Never rejects.
  it.each([
    {
      name: 'a Vulkan driver crash during enumeration on Windows (exit 0xC0000005)',
      platform: 'win32' as const,
      spawn: probeSpawn((child) => child.emit('close', 0xc0000005, null)).spawn
    },
    {
      name: 'a crash during enumeration on Linux (SIGSEGV)',
      platform: 'linux' as const,
      spawn: probeSpawn((child) => child.emit('close', null, 'SIGSEGV')).spawn
    },
    {
      name: "an async 'error' event (ENOENT — the binary is missing)",
      platform: 'win32' as const,
      spawn: probeSpawn((child) =>
        child.emit('error', Object.assign(new Error('spawn /missing/llama-server ENOENT'), { code: 'ENOENT' }))
      ).spawn
    },
    {
      name: "an async 'error' event out of descriptors on Linux (EMFILE)",
      platform: 'linux' as const,
      spawn: probeSpawn((child) =>
        child.emit('error', Object.assign(new Error('spawn /bin/llama-server EMFILE'), { code: 'EMFILE' }))
      ).spawn
    },
    {
      name: 'a synchronous spawn throw (EINVAL)',
      platform: 'win32' as const,
      spawn: (() => {
        throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' })
      }) as SpawnFn
    }
  ])('a probe that gave no answer resolves null, not [] — $name (#653)', async ({ spawn, platform }) => {
    expect(await probeGpuDevices('/bin/llama-server', { spawn, platform, verify: async () => 'skip-dev' })).toBeNull()
  })

  it('kills a hung probe on timeout and resolves NULL — unknown, NOT "no GPU" (#380; T6 — fake timers, no wall-clock flake)', async () => {
    // T6 (post-merge audit Phase 5): the prior version awaited a REAL 20 ms setTimeout against a
    // never-exiting child — a TEST-1-family wall-clock flake. Drive the probe's own kill-timeout
    // through fake timers instead (the combine-signals.test.ts idiom) so it fires deterministically.
    // `verify` is injected as a trivial resolver so only the timeout path is under fake-timer
    // control (no real fs/microtask racing the timer); the verify path is pinned through the REAL
    // verifier in binary-verify-spawn.test.ts.
    //
    // #380: this used to resolve `[]`, which every consumer read as "this machine has no card".
    // Under the #330 weight upload the driver simply had not answered yet — the child is still
    // killed (a wedge must not stall startup), but the ANSWER is now the absence of one.
    vi.useFakeTimers()
    let child!: FakeProbeChild
    const spawn: SpawnFn = () => {
      child = new FakeProbeChild() // never exits on its own
      // #653 review: Node emits 'error' (syscall `kill`) synchronously from a kill() that fails.
      // The probe is settled before it kills, so that is never logged as a spawn failure.
      child.kill = () => {
        child.killed = true
        child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' }))
        return false
      }
      return child
    }
    const warn = vi.spyOn(log, 'warn')
    try {
      const probe = probeGpuDevices('/bin/llama-server', {
        spawn,
        timeoutMs: 20,
        verify: async () => 'skip-dev'
      })
      // Flush the pre-spawn verify() microtask (arming the timer), then trip the kill-timeout.
      await vi.advanceTimersByTimeAsync(20)
      const devices = await probe
      expect(devices).toBeNull()
      expect(child.killed).toBe(true)
      // #653 (found on the real app): the killed child's own 'close' arrives after the probe settled.
      // It is the kill, not a second non-answer, so nothing more is logged — nor was the failed kill.
      child.emit('close', null, 'SIGKILL')
      expect(warn.mock.calls.map((c) => c[0])).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })
})

describe('createCachedGpuProbe', () => {
  afterEach(() => vi.useRealTimers()) // the #380 timeout case below uses fake timers

  function countingSpawn(): { spawn: SpawnFn; count: () => number } {
    let spawned = 0
    const spawn: SpawnFn = () => {
      spawned += 1
      const child = new FakeProbeChild()
      queueMicrotask(() => {
        child.stdout.emit('data', RTX_3080TI_OUTPUT)
        child.emit('close', 0, null)
      })
      return child
    }
    return { spawn, count: () => spawned }
  }

  it('probes once per binary per session and caches the promise', async () => {
    const { spawn, count } = countingSpawn()
    const probe = createCachedGpuProbe({ spawn })
    const [a, b] = await Promise.all([probe('/bin/x'), probe('/bin/x')])
    await probe('/bin/x')
    expect(count()).toBe(1)
    expect(a).toEqual(b)
    // A different binary is its own cache entry.
    await probe('/bin/y')
    expect(count()).toBe(2)
  })

  it('a TIMED-OUT probe is never cached: the next call re-probes without anyone pressing "Try GPU again" (#380)', async () => {
    vi.useFakeTimers()
    let spawned = 0
    const children: FakeProbeChild[] = []
    const spawn: SpawnFn = () => {
      spawned += 1
      const child = new FakeProbeChild() // never exits on its own — the wedged driver
      children.push(child)
      return child
    }
    const probe = createCachedGpuProbe({ spawn, timeoutMs: 20, verify: async () => 'skip-dev' })

    const p1 = probe('/bin/x')
    await vi.advanceTimersByTimeAsync(20)
    expect(await p1).toBeNull()
    expect(children[0].killed).toBe(true)
    expect(spawned).toBe(1)

    // The unknown answer left NO entry behind (it dropped itself once it settled), so the very
    // next caller — the ladder, the next unlock's refresh — asks the driver again. Before #380
    // the `[]` this resolved stayed the session's answer and every consumer read "no GPU".
    const p2 = probe('/bin/x')
    await vi.advanceTimersByTimeAsync(20)
    expect(await p2).toBeNull()
    expect(spawned).toBe(2)
  })

  it('an EMPTY answer IS cached — "this machine enumerates nothing" is an answer (#380 contrast)', async () => {
    let spawned = 0
    const spawn: SpawnFn = () => {
      spawned += 1
      const child = new FakeProbeChild()
      queueMicrotask(() => child.emit('close', 0, null)) // exit 0, no device lines: a GPU-less box
      return child
    }
    const probe = createCachedGpuProbe({ spawn })
    expect(await probe('/bin/x')).toEqual([])
    expect(await probe('/bin/x')).toEqual([])
    expect(spawned).toBe(1) // one child: the session keeps the answer, exactly as before
  })

  it('invalidate() drops the cache so the next call re-probes (Try GPU again)', async () => {
    const { spawn, count } = countingSpawn()
    const probe = createCachedGpuProbe({ spawn })
    await probe('/bin/x')
    expect(count()).toBe(1)
    probe.invalidate()
    await probe('/bin/x')
    expect(count()).toBe(2)
  })

  // R5 (full-audit-2026-06-30, Phase C): a probe's timeout SIGKILLs but doesn't await the reap, and
  // the child is unref'd, so rapid invalidate()+re-probe ("Try GPU again" mashing) WHILE one probe
  // is still in flight used to drop the in-flight entry and spawn a SECOND child per click — N
  // clicks → N stacked children for one binary. The fix coalesces: invalidate only drops SETTLED
  // entries; a re-probe during the in-flight window returns the existing promise (one child).
  it('coalesces re-probes while one is in flight — invalidate+re-probe mashing does not stack children (R5)', async () => {
    let spawned = 0
    const children: FakeProbeChild[] = []
    const spawn: SpawnFn = () => {
      spawned += 1
      const child = new FakeProbeChild()
      children.push(child) // NEVER closes on its own — the probe stays in flight until we drive it
      return child
    }
    const probe = createCachedGpuProbe({ spawn })
    const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

    const p1 = probe('/bin/x') // kicks off probe #1 (verify() is async, so spawn lands a tick later)
    // Mash "Try GPU again" while the probe is still in flight: each invalidate()+probe() must
    // coalesce onto the one running probe, never spawn another child.
    for (let i = 0; i < 5; i++) {
      probe.invalidate()
      void probe('/bin/x')
    }
    await until(() => spawned > 0, "the in-flight probe's spawn") // its verify() resolves, then it spawns
    // A couple more mashes now that the child is actually alive (still in flight — it never closed).
    for (let i = 0; i < 3; i++) {
      probe.invalidate()
      void probe('/bin/x')
    }
    await tick()
    expect(spawned).toBe(1) // ONE child despite all the mashing (reds at 1+5 with the old cache.clear)
    expect(children.length).toBe(1)

    // Let the in-flight probe settle; only THEN does invalidate()+probe re-spawn (feature intact).
    children[0].stdout.emit('data', RTX_3080TI_OUTPUT)
    children[0].emit('close', 0, null)
    await p1
    probe.invalidate()
    const p2 = probe('/bin/x')
    await until(() => spawned > 1, 'the re-probe spawning')
    expect(spawned).toBe(2)
    children[1].stdout.emit('data', RTX_3080TI_OUTPUT)
    children[1].emit('close', 0, null)
    await p2
  })
})
