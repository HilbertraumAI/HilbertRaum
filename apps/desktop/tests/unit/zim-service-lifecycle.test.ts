import { describe, expect, it, vi, afterEach } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { log } from '../../src/main/services/logging'
import { registeredSidecarPids, type SpawnFn } from '../../src/main/services/runtime/sidecar'
import { registerPack, servedCandidates, writeLibraryXml, type PackDeps } from '../../src/main/services/zim/packs'
import { readZimHeader } from '../../src/main/services/zim/identity'
import { packUuid, writeZimFixture } from '../helpers/zim-header'
import { KiwixManageError, kiwixManageAdd } from '../../src/main/services/zim/tools'
import {
  initBinaryVerification,
  _resetBinaryVerificationForTests,
  type BinaryVerifyResult
} from '../../src/main/services/binary-verifier'
import { ZimService, type ServedLibrary, type ZimAdmission } from '../../src/main/services/zim'
import {
  ServeFakeChild,
  binaryWithMarker,
  expectAbortError,
  fakeManageSpawn,
  serveGate,
  zimServiceDeps,
  type ServeChildMode,
  type ServeGate
} from '../helpers/zim-fakes'
import { manageAddFromHeader } from '../helpers/zim-library'
import { until, within } from '../helpers/hang-budget'

// T05 parks kiwix-serve's pre-spawn verifier. The REAL verifier is wrapped here, on the test side
// (production has no verifier seam); with no gate set, every call goes straight through to it.
const parkedVerifier = vi.hoisted(() => ({ gate: null as ServeGate<BinaryVerifyResult> | null }))
vi.mock('../../src/main/services/binary-verifier', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/services/binary-verifier')>()
  return {
    ...real,
    verifyBinaryBeforeSpawn: (binPath: string, io?: Parameters<typeof real.verifyBinaryBeforeSpawn>[1]) =>
      parkedVerifier.gate && binPath.includes('kiwix-serve')
        ? parkedVerifier.gate.wait()
        : real.verifyBinaryBeforeSpawn(binPath, io)
  }
})

// P3a — service generations, publication and cancellation. This file is shared with a
// parallel agent's T05 (`KiwixServer`/`ZimService`) block; this describe covers ONLY
// Brief B's contract: `kiwixManageAdd` (M9) plus its `packs.ts` callers
// (`writeLibraryXml`, `readZimMetadata` via `registerPack`). Binding design note:
// tmp/zim-wave/p3a/ledger-9.15.md item 8 (a copy of plan §9.15, PR #294 / issue #301).

// ---- shared test doubles (prefixed `manage*` so names cannot clash with T05's) -----

/** A fake `kiwix-manage` spawn whose child only RECORDS `kill()` (`ignore-all`): the test
 *  decides when (or whether) it actually dies, so the timeout/abort kill-escalation path can
 *  be observed step by step instead of asserted only via elapsed wall-clock time. */
function manageFakeSpawn(pid = 9001): {
  spawn: SpawnFn
  child: ServeFakeChild
  calls: Array<{ command: string; args: string[] }>
} {
  const calls: Array<{ command: string; args: string[] }> = []
  const child = new ServeFakeChild(pid, 'ignore-all')
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args })
    return child
  }
  return { spawn, child, calls }
}

/** Flush pending microtasks AND the current macrotask queue (spawn registration, the
 *  verifier's `await`, listener attachment) — the same 0ms-`setTimeout` idiom
 *  `sidecar.test.ts` uses after a fake child's async exit. Every assertion taken right
 *  after it reads a fake's RECORDED state (call counts, registry membership), never
 *  elapsed wall-clock time, so it is not a race-condition "proof". */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** #301 P3b: `ensureServer` publishes the whole `ServedLibrary` (port + revision +
 *  generation + the identity-checked serving map). These P3a cases assert the PORT it
 *  carries — the same claim, one field deeper. */
async function svcPort(p: Promise<ServedLibrary | null>): Promise<number | null> {
  return (await p)?.port ?? null
}
/** Let a real (tiny) timer configured on the call under test actually fire. Used only
 *  to let `timeoutMs`/`killGraceMs`/`forceKillWaitMs` elapse before checking a fake's
 *  recorded state — never as the proof of an outcome by itself. */
const waitMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function managePackHarness(): { db: Db; zimDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-lifecycle-'))
  const zimDir = join(root, 'zim')
  mkdirSync(zimDir, { recursive: true })
  const db = openDatabase(join(root, 'test.sqlite'))
  return { db, zimDir, root }
}

/** A REAL 80-byte ZIM header (#301 P3b): a pack IS its header UUID, so every fixture the
 *  registry reads must carry one — and the fake manager below echoes exactly that uuid. */
function addManageZimFile(dir: string, leaf: string): string {
  return writeZimFixture(join(dir, leaf), packUuid('0000aa01', leaf.slice(0, 6)), {
    trailing: `body of ${leaf}`
  })
}

// Several tests spy on `log.warn` and count its calls. Since vitest 4, `vi.spyOn` on a method
// that is still a spy returns THAT spy, earlier tests' calls included, so each test must start
// from the real method.
afterEach(() => {
  vi.restoreAllMocks()
  parkedVerifier.gate = null // a failed T05 must not park every later start
})

describe('kiwixManageAdd — verifier, PID registry, abort, settle-before-cleanup (M9, P3a)', () => {
  it('T06 kiwix-manage runs under the verifier (match / mismatch / hashless policy), every PID is registered, timeout and caller abort settle before cleanup, late exit and ignored kill are bounded', async () => {
    // The verdicts come from the REAL verifier on real install markers. The R-1 warning fires
    // once per process, so the silent verdicts run first: after it fired, "says nothing" would
    // hold whatever the verdict. This is the file's first kiwix-manage call, in a fresh fork.
    const warn = vi.spyOn(log, 'warn')
    const r1Warnings = (): string[] =>
      warn.mock.calls.map((c) => c[0]).filter((m): m is string => typeof m === 'string' && m.includes('R-1'))
    try {
      // --- unenforced (a dev build): 'skip-dev' spawns -------------------------------
      {
        const { spawn, calls, child } = manageFakeSpawn(1001)
        const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn)
        await tick()
        expect(calls).toHaveLength(1)
        child.emit('exit', 0, null)
        await expect(done).resolves.toBeUndefined()
      }

      initBinaryVerification(false) // a packaged build: the install marker decides

      // --- 'mismatch' (a tampered binary) refuses with NO spawn ------------------------
      {
        const { spawn, calls } = manageFakeSpawn(1)
        const tampered = await binaryWithMarker('kiwix-manage.exe', 'mismatch')
        const done = kiwixManageAdd(tampered, '/lib/library.xml', '/zim/a.zim', spawn)
        await expect(done).rejects.toBeInstanceOf(KiwixManageError)
        await expect(done).rejects.toMatchObject({ kind: 'verify', childState: 'not-spawned' })
        expect(calls).toHaveLength(0)
      }

      // --- 'ok' proceeds; PID registered while running, unregistered at exit --------
      {
        const { spawn, calls, child } = manageFakeSpawn(2001)
        const matching = await binaryWithMarker('kiwix-manage.exe', 'ok')
        const done = kiwixManageAdd(matching, '/lib/library.xml', '/zim/a.zim', spawn)
        await until(() => calls.length === 1, 'the kiwix-manage spawn after a matching hash')
        expect(registeredSidecarPids('kiwix_tools')).toContain(2001)
        child.emit('exit', 0, null)
        await expect(done).resolves.toBeUndefined()
        expect(registeredSidecarPids('kiwix_tools')).not.toContain(2001)
      }
      expect(r1Warnings()).toEqual([]) // skip-dev and ok say nothing

      // --- 'skip-legacy' (a hashless marker) still spawns; the R-1 warn fires ONCE across two calls
      const hashless = await binaryWithMarker('kiwix-manage.exe', 'legacy')
      for (const pid of [2101, 2102]) {
        const { spawn, calls, child } = manageFakeSpawn(pid)
        const done = kiwixManageAdd(hashless, '/lib/library.xml', '/zim/a.zim', spawn)
        await until(() => calls.length === 1, 'the kiwix-manage spawn on a hashless marker')
        child.emit('exit', 0, null) // spawn happened — 'skip-legacy' never blocks
        await expect(done).resolves.toBeUndefined()
      }
      expect(r1Warnings()).toHaveLength(1) // once per process, not once per call
      expect(r1Warnings()[0]).not.toMatch(/[\\/]/) // never a path in the message
    } finally {
      _resetBinaryVerificationForTests()
    }

    // --- timeout: the promise stays pending after kill() while the fake ignores it,
    //     settles only once the fake emits 'exit' -------------------------------------
    {
      const { spawn, calls, child } = manageFakeSpawn(3001)
      const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        timeoutMs: 5,
        killGraceMs: 500,
        forceKillWaitMs: 500
      })
      await tick()
      expect(calls).toHaveLength(1)
      await waitMs(30) // let the 5ms timeout fire and beginCancel() send the polite kill()
      expect(child.killCalls.length).toBeGreaterThanOrEqual(1)
      let settled = false
      done.then(
        () => (settled = true),
        () => (settled = true)
      )
      await tick()
      expect(settled).toBe(false) // still pending — the fake ignored the kill
      expect(registeredSidecarPids('kiwix_tools')).toContain(3001) // not unregistered yet
      child.emit('exit', null, 'SIGTERM')
      await expect(done).rejects.toMatchObject({ kind: 'timeout', childState: 'exited' })
      expect(registeredSidecarPids('kiwix_tools')).not.toContain(3001)
    }

    // --- caller abort: the same shape as a timeout ------------------------------------
    {
      const { spawn, child } = manageFakeSpawn(3101)
      const controller = new AbortController()
      const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        signal: controller.signal,
        timeoutMs: 100_000,
        killGraceMs: 500,
        forceKillWaitMs: 500
      })
      await tick()
      controller.abort()
      await waitMs(20)
      expect(child.killCalls.length).toBeGreaterThanOrEqual(1)
      let settled = false
      done.then(
        () => (settled = true),
        () => (settled = true)
      )
      await tick()
      expect(settled).toBe(false)
      child.emit('exit', null, 'SIGTERM')
      await expect(done).rejects.toMatchObject({ kind: 'abort', childState: 'exited' })
      expect(registeredSidecarPids('kiwix_tools')).not.toContain(3101)
    }

    // --- ignored kill through BOTH stages → 'uncertain', PID stays registered; a
    //     later exit unregisters it and changes nothing else --------------------------
    {
      const { spawn, child } = manageFakeSpawn(3201)
      const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        timeoutMs: 1,
        killGraceMs: 1,
        forceKillWaitMs: 1
      })
      const result: unknown = await done.catch((err: unknown) => err)
      expect(result).toBeInstanceOf(KiwixManageError)
      expect(result).toMatchObject({ kind: 'timeout', childState: 'uncertain' })
      expect(child.killCalls.length).toBe(2) // polite kill() then SIGKILL
      expect(child.killCalls[1]).toBe('SIGKILL')
      expect(registeredSidecarPids('kiwix_tools')).toContain(3201) // left for the reaper (R-7)

      // A late exit — the child actually died after all — still unregisters the PID
      // and changes nothing else (the promise already settled 'uncertain' above).
      child.emit('exit', null, 'SIGKILL')
      await tick()
      expect(registeredSidecarPids('kiwix_tools')).not.toContain(3201)
    }
  })

  it('a sync spawn throw rejects kind "spawn" with childState "not-spawned"', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('spawn ENOENT')
    }
    await expect(kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn)).rejects.toMatchObject({
      kind: 'spawn',
      childState: 'not-spawned'
    })
  })

  it('an already-aborted caller signal refuses after the verifier with no spawn', async () => {
    const { spawn, calls } = manageFakeSpawn()
    const controller = new AbortController()
    controller.abort()
    await expect(
      kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ kind: 'abort', childState: 'not-spawned' })
    expect(calls).toHaveLength(0)
  })
})

describe('writeLibraryXml — stops on an unconfirmed manager child (M9 → packs.ts, P3a)', () => {
  it('stops and rethrows on childState "uncertain" but still skips an ordinary per-pack failure', async () => {
    const { db, zimDir, root } = managePackHarness()
    let mode: 'register' | 'build' = 'register'
    const buildCalls: string[] = []
    const register = manageAddFromHeader()
    const manageAdd: PackDeps['manageAdd'] = async (libraryXmlPath, zimPath) => {
      if (mode === 'register') return register(libraryXmlPath, zimPath)
      const leaf = basename(zimPath)
      buildCalls.push(leaf)
      // The real binary's stderr names the archive, so a log that printed the error would leak it.
      if (leaf.includes('badordinary')) throw new Error(`Cannot add ZIM ${zimPath} to the library.`)
      if (leaf.includes('uncertain')) {
        throw new KiwixManageError('kiwix-manage timed out — cleanup not confirmed', 'timeout', 'uncertain')
      }
      appendFileSync(libraryXmlPath, `<book id="uuid-${leaf}" path="x" title="T" language="deu" />\n`)
    }
    const deps: PackDeps = { zimDir, manageAdd }

    await registerPack(db, deps, addManageZimFile(zimDir, 'a-good.zim'))
    await registerPack(db, deps, addManageZimFile(zimDir, 'b-badordinary.zim'))
    await registerPack(db, deps, addManageZimFile(zimDir, 'c-uncertain.zim'))
    await registerPack(db, deps, addManageZimFile(zimDir, 'd-never.zim'))

    mode = 'build'
    const libraryPath = join(root, 'library.xml')
    const warn = vi.spyOn(log, 'warn')
    const err: unknown = await writeLibraryXml(deps, libraryPath, servedCandidates(db, zimDir)).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(KiwixManageError)
    expect(err).toMatchObject({ childState: 'uncertain' })
    // The ordinary failure (b) was skipped with a warn, not rethrown — c stopped the build.
    expect(buildCalls).toEqual(['a-good.zim', 'b-badordinary.zim', 'c-uncertain.zim'])
    // The warn names the pack by its archive UUID, never by its filename (#301 P3b: the
    // library build now works from identity-resolved candidates, and the sentinel rule keeps
    // the leaf out of the log).
    const skippedId = readZimHeader(join(zimDir, 'b-badordinary.zim')).uuid
    // Message AND metadata are inspected: the id rides the structured fields, the message is
    // a fixed sentence, and neither may carry the leaf or the manager's path-bearing stderr.
    const warnText = warn.mock.calls.map((c) => JSON.stringify(c)).join(' ')
    expect(warnText).toContain(skippedId)
    expect(warnText).not.toContain('b-badordinary.zim')
  })

  it('stops immediately when the signal is already aborted; no pack is attempted', async () => {
    const { db, zimDir, root } = managePackHarness()
    let mode: 'register' | 'build' = 'register'
    const buildCalls: string[] = []
    const register = manageAddFromHeader()
    const manageAdd: PackDeps['manageAdd'] = async (libraryXmlPath, zimPath) => {
      if (mode === 'register') return register(libraryXmlPath, zimPath)
      buildCalls.push(basename(zimPath))
    }
    const deps: PackDeps = { zimDir, manageAdd }
    await registerPack(db, deps, addManageZimFile(zimDir, 'only.zim'))
    mode = 'build'
    const controller = new AbortController()
    controller.abort()
    const libraryPath = join(root, 'library.xml')
    await expect(
      writeLibraryXml(deps, libraryPath, servedCandidates(db, zimDir), controller.signal)
    ).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(buildCalls).toEqual([])
  })
})

describe('readZimMetadata (via registerPack) — the throwaway meta dir on an unconfirmed manager child (M9, P3a)', () => {
  it('keeps the meta dir when the manager settles "uncertain"; removes it on an ordinary failure', async () => {
    const { db, zimDir } = managePackHarness()
    let capturedMetaDir: string | null = null

    const uncertainDeps: PackDeps = {
      zimDir,
      manageAdd: async (libraryXmlPath) => {
        capturedMetaDir = dirname(libraryXmlPath)
        throw new KiwixManageError('kiwix-manage timed out — cleanup not confirmed', 'timeout', 'uncertain')
      }
    }
    await expect(registerPack(db, uncertainDeps, addManageZimFile(zimDir, 'a.zim'))).rejects.toBeInstanceOf(
      KiwixManageError
    )
    expect(capturedMetaDir).not.toBeNull()
    expect(existsSync(capturedMetaDir as unknown as string)).toBe(true) // left for P3b's startup sweep (R-7)

    capturedMetaDir = null
    const ordinaryDeps: PackDeps = {
      zimDir,
      manageAdd: async (libraryXmlPath) => {
        capturedMetaDir = dirname(libraryXmlPath)
        throw new Error('kiwix-manage exited with code 1 — Cannot add ZIM')
      }
    }
    await expect(registerPack(db, ordinaryDeps, addManageZimFile(zimDir, 'b.zim'))).rejects.toThrow(
      /Cannot add ZIM/
    )
    expect(capturedMetaDir).not.toBeNull()
    expect(existsSync(capturedMetaDir as unknown as string)).toBe(false) // ordinary failure: removed as before
  })
})

// =====================================================================================
// Brief A — `ZimService` generations over the real `KiwixServer` (H3, M2; T05); the rows that
// drive `KiwixServer` alone live in zim-serve.test.ts. Binding design note: tmp/zim-wave/p3a/ledger-9.15.md items 1–7 and 9–11 (a copy of plan
// §9.15, PR #294 / issue #301). Helpers below are prefixed `serve*`/`svc*` so they cannot
// clash with the `manage*` doubles of the M9 block above.
//
// Every ordering fact is established by a controlled promise with an `entered`/`release`
// pair (the verifier, the port allocator, a manager child, a probe = the publication
// boundary), never by a fixed sleep. `waitMs` appears only to let the tiny configured
// kill-grace timers elapse, and what is asserted afterwards is a fake's RECORDED state.
// =====================================================================================

// The controlled gate, the fake children and the fake kiwix-manage live in
// tests/helpers/zim-fakes.ts — shared with the P3b session suite so the two cannot drift on
// what "the child ignored SIGTERM" means (#301).

interface ServeSpawnRecord {
  args: string[]
  libraryXmlPath: string
  child: ServeFakeChild
  /** Had EVERY earlier child already reached a terminal state at the moment of this spawn? */
  priorChildrenAllExited: boolean
}

interface SvcHooks {
  findPort: () => Promise<number>
  probe: (port: number) => Promise<boolean>
  /** Runs inside a fake kiwix-manage child before it appends its `<book>` and exits 0. */
  manage: (libraryXmlPath: string, zimPath: string) => Promise<void>
}

interface SvcHarness {
  db: Db
  root: string
  zimDir: string
  /** The service's `transientDir`, where every library build is written. */
  transientDir: string
  svc: ZimService
  hooks: SvcHooks
  /** kiwix-serve spawns, in order. */
  serveSpawns: ServeSpawnRecord[]
  /** kiwix-manage invocations that wrote a LIBRARY BUILD (registration throwaways excluded). */
  buildAdds: Array<{ libraryXmlPath: string; zimPath: string }>
  /** Every kiwix-manage child, in spawn order. */
  manageChildren: ServeFakeChild[]
  /** Mode applied to the NEXT spawned kiwix-serve child. */
  nextChildMode: ServeChildMode
  addPack(leaf: string): Promise<string>
  lastServeChild(): ServeFakeChild
  /** The `library.<n>.xml` files currently on disk, sorted. */
  builds(): string[]
}

function svcHarness(
  opts: {
    healthTimeoutMs?: number
    admission?: ZimAdmission
    killGraceMs?: number
    forceKillWaitMs?: number
  } = {}
): SvcHarness {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-svc-'))
  const zimDir = join(root, 'zim')
  mkdirSync(zimDir, { recursive: true })
  const transientDir = join(root, 'zim-transient')
  const db = openDatabase(join(root, 'test.sqlite'))

  const serveSpawns: ServeSpawnRecord[] = []
  const buildAdds: Array<{ libraryXmlPath: string; zimPath: string }> = []
  let servePid = 9100

  const hooks: SvcHooks = {
    findPort: async () => 8300 + serveSpawns.length,
    probe: async () => true,
    manage: async () => undefined
  }

  const harness: SvcHarness = {
    db,
    root,
    zimDir,
    transientDir,
    hooks,
    serveSpawns,
    buildAdds,
    manageChildren: [],
    nextChildMode: 'exit-on-sigterm',
    svc: null as unknown as ZimService,
    addPack: async (leaf) => {
      const file = writeZimFixture(join(zimDir, leaf), packUuid('0000bb02', leaf.slice(0, 6)), {
        trailing: `body of ${leaf}`
      })
      const pack = await harness.svc.registerPack(db, file)
      return pack.id
    },
    lastServeChild: () => {
      const last = serveSpawns[serveSpawns.length - 1]
      if (!last) throw new Error('no kiwix-serve child has been spawned')
      return last.child
    },
    builds: () =>
      readdirSync(transientDir)
        .filter((f) => /^library\.\d+\.xml$/.test(f))
        .sort()
  }

  const serveSpawn: SpawnFn = (_command, args) => {
    const child = new ServeFakeChild(servePid++, harness.nextChildMode)
    const priorChildrenAllExited = serveSpawns.every((s) => s.child.exited)
    serveSpawns.push({
      args: [...args],
      libraryXmlPath: args[args.indexOf('--library') + 1] as string,
      child,
      priorChildrenAllExited
    })
    return child
  }

  // Library builds go straight into the transient dir; a registration's throwaway is a meta-<n>/.
  const manage = fakeManageSpawn({
    firstPid: 7100,
    before: (libraryXmlPath, zimPath) => hooks.manage(libraryXmlPath, zimPath),
    onSpawn: ({ libraryXmlPath, zimPath }) => {
      if (dirname(libraryXmlPath) === transientDir) buildAdds.push({ libraryXmlPath, zimPath })
    }
  })
  harness.manageChildren = manage.children

  harness.svc = new ZimService({
    rootPath: root,
    isDev: true,
    admission: opts.admission,
    transientDir,
    deps: zimServiceDeps({
      spawn: serveSpawn,
      manageSpawn: manage.spawn,
      findPort: () => hooks.findPort(),
      probe: (port) => hooks.probe(port),
      healthTimeoutMs: opts.healthTimeoutMs,
      killGraceMs: opts.killGraceMs,
      forceKillWaitMs: opts.forceKillWaitMs
    })
  })
  return harness
}

/** One writer at a time and no two builds sharing a path: the sequence of library paths the
 *  manager was pointed at must be GROUPED — a build is never revisited after another began. */
function serveAssertSingleWriter(adds: Array<{ libraryXmlPath: string }>): void {
  const order: string[] = []
  for (const add of adds) {
    if (order[order.length - 1] === add.libraryXmlPath) continue
    expect(order, 'a library build was written again after another build started').not.toContain(
      add.libraryXmlPath
    )
    order.push(add.libraryXmlPath)
  }
}

describe('ZimService + KiwixServer — generations, publication and cancellation (H3/M2, P3a)', () => {
  it('T05 parked verifier / port / manager / publication / health with overlapping stop, invalidate and restart: no obsolete spawn or publication, no old callback or finally mutates the current child, one writer, latest revision served, current XML path in argv', async () => {
    const h = svcHarness()
    const alpha = await h.addPack('alpha.zim') // revision 1

    // --- (1) PARKED VERIFIER: a pack change while a start sits in the pre-spawn verifier -
    const verifyGate = serveGate<BinaryVerifyResult>()
    parkedVerifier.gate = verifyGate
    let portCalls = 0
    h.hooks.findPort = async () => {
      portCalls++
      return 8300 + h.serveSpawns.length
    }
    const firstAsk = h.svc.ensureServer(h.db)
    await verifyGate.entered
    expect(h.buildAdds).toHaveLength(1) // build A written, one book (alpha)
    const buildA = h.buildAdds[0]!.libraryXmlPath
    expect(existsSync(buildA)).toBe(true)
    expect(h.serveSpawns).toHaveLength(0)

    const beta = await h.addPack('beta.zim') // revision 2 — aborts the parked start
    parkedVerifier.gate = null
    verifyGate.release('ok')
    const portAfterOne = await svcPort(firstAsk) // the ask re-loops onto revision 2 rather than failing

    // The aborted start stopped right after the verifier: only the re-looped start took a port.
    expect(portCalls).toBe(1)
    // No obsolete spawn: nothing was ever launched with build A, and A deleted its OWN file.
    expect(h.serveSpawns).toHaveLength(1)
    expect(h.serveSpawns[0]!.libraryXmlPath).not.toBe(buildA)
    expect(existsSync(buildA)).toBe(false)
    // Latest revision served, current XML path in argv, exactly one writer per build.
    const buildB = h.serveSpawns[0]!.libraryXmlPath
    expect(h.buildAdds.filter((a) => a.libraryXmlPath === buildB)).toHaveLength(2) // alpha + beta
    serveAssertSingleWriter(h.buildAdds)
    expect(h.svc.serverState()).toMatchObject({ revision: 2, port: portAfterOne, alive: true })
    expect(h.serveSpawns[0]!.args).toEqual([
      '--address',
      '127.0.0.1',
      '--port',
      String(portAfterOne),
      '--nosearchbar',
      '--blockexternal',
      '--library',
      buildB
    ])
    const childB = h.serveSpawns[0]!.child

    // --- (2) PARKED PORT ALLOCATION: the abandoned build never reaches a spawn ------------
    const portGate = serveGate<number>()
    h.hooks.findPort = () => portGate.wait()
    h.svc.setPackEnabled(h.db, beta, false) // revision 3
    const secondAsk = h.svc.ensureServer(h.db)
    await portGate.entered
    const buildC = h.buildAdds[h.buildAdds.length - 1]!.libraryXmlPath
    expect(buildC).not.toBe(buildB)
    h.svc.setPackEnabled(h.db, beta, true) // revision 4 — aborts the parked start
    h.hooks.findPort = async () => 8400 + h.serveSpawns.length
    portGate.release(8399)
    const portAfterTwo = await svcPort(secondAsk)

    expect(h.serveSpawns.map((s) => s.libraryXmlPath)).not.toContain(buildC)
    expect(h.builds()).not.toContain(basename(buildC)) // the stale build cleaned its own file
    expect(h.svc.serverState()).toMatchObject({ revision: 4, port: portAfterTwo, alive: true })
    // The superseded child B was torn down exactly once, politely, and is gone.
    expect(childB.killCalls).toEqual([undefined])
    expect(registeredSidecarPids('kiwix_tools')).not.toContain(childB.pid)
    serveAssertSingleWriter(h.buildAdds)

    // --- (3) PARKED MANAGER CHILD: a build interrupted mid-write is discarded whole -------
    const manageGate = serveGate<void>()
    h.hooks.manage = async (_lib, zim) => (zim.includes('beta') ? manageGate.wait() : undefined)
    h.svc.setPackEnabled(h.db, alpha, false) // revision 5
    const thirdAsk = h.svc.ensureServer(h.db)
    await manageGate.entered
    const buildD = h.buildAdds[h.buildAdds.length - 1]!.libraryXmlPath
    const managerD = h.manageChildren[h.manageChildren.length - 1]!
    const spawnsBeforeD = h.serveSpawns.length
    h.svc.setPackEnabled(h.db, alpha, true) // revision 6 — aborts the parked manager
    h.hooks.manage = async () => undefined
    manageGate.release()
    const portAfterThree = await svcPort(thirdAsk)

    expect(managerD.killed).toBe(true) // the teardown reached the running manager, not just its file
    expect(h.serveSpawns.map((s) => s.libraryXmlPath)).not.toContain(buildD)
    expect(h.builds()).not.toContain(basename(buildD))
    expect(h.serveSpawns).toHaveLength(spawnsBeforeD + 1)
    expect(h.svc.serverState()).toMatchObject({ revision: 6, port: portAfterThree, alive: true })
    serveAssertSingleWriter(h.buildAdds)

    // --- (4) PARKED PROBE (the publication boundary) overlapped by an invalidate ----------
    // The OLD probe is released TRUE only after the supersession: it must publish nothing.
    const probeGate = serveGate<boolean>()
    h.hooks.probe = () => probeGate.wait()
    h.svc.setPackEnabled(h.db, beta, false) // revision 7
    const fourthAsk = h.svc.ensureServer(h.db)
    await probeGate.entered
    const staleChild = h.lastServeChild()
    const staleState = h.svc.serverState()
    expect(staleState).toBeNull() // nothing published while the probe is parked
    h.svc.setPackEnabled(h.db, beta, true) // revision 8 — supersedes the parked start
    h.hooks.probe = async () => true
    probeGate.release(true)
    const portAfterFour = await svcPort(fourthAsk)

    const freshChild = h.lastServeChild()
    expect(freshChild).not.toBe(staleChild)
    // The superseded child was torn down by its OWN start path; the newer child was never
    // touched by the old probe, the old finally or the old teardown (the H3 cross-talk).
    expect(staleChild.killCalls.length).toBeGreaterThan(0)
    expect(freshChild.killCalls).toEqual([])
    expect(h.svc.serverState()).toMatchObject({ revision: 8, port: portAfterFour, alive: true })
    // No stale start failure latched: the next ask is served from the publication, no spawn.
    const spawnsAfterFour = h.serveSpawns.length
    await expect(h.svc.ensureServer(h.db)).resolves.toMatchObject({ port: portAfterFour })
    expect(h.serveSpawns).toHaveLength(spawnsAfterFour)

    // --- (5) NATURAL CRASH: the restart is a NEW generation over the SAME build -----------
    const beforeCrash = h.svc.serverState()!
    const buildOfCrashed = h.serveSpawns[h.serveSpawns.length - 1]!.libraryXmlPath
    const addsBeforeCrash = h.buildAdds.length
    freshChild.emit('exit', 1, null) // died on its own after being healthy
    await tick()
    expect(h.svc.serverState()).toMatchObject({
      revision: beforeCrash.revision,
      build: beforeCrash.build,
      generation: beforeCrash.generation,
      alive: false
    })
    const portAfterCrash = await svcPort(h.svc.ensureServer(h.db))
    const afterCrash = h.svc.serverState()!
    expect(afterCrash.revision).toBe(beforeCrash.revision)
    expect(afterCrash.build).toBe(beforeCrash.build) // the pack set did not change
    expect(afterCrash.generation).toBeGreaterThan(beforeCrash.generation) // a distinct child
    expect(afterCrash.alive).toBe(true)
    expect(afterCrash.port).toBe(portAfterCrash)
    expect(h.buildAdds).toHaveLength(addsBeforeCrash) // no rebuild: the build is still current
    expect(h.serveSpawns[h.serveSpawns.length - 1]!.libraryXmlPath).toBe(buildOfCrashed)

    // --- (6) IGNORED KILL → bounded → `uncertain`, then a LATE exit from that old child ---
    h.nextChildMode = 'ignore-all'
    h.svc.setPackEnabled(h.db, alpha, false) // revision 9 — restart with a stubborn child
    await h.svc.ensureServer(h.db)
    const stubborn = h.lastServeChild()
    const stubbornBuild = h.serveSpawns[h.serveSpawns.length - 1]!.libraryXmlPath
    h.nextChildMode = 'exit-on-sigterm'
    h.svc.setPackEnabled(h.db, alpha, true) // revision 10 — tears the stubborn child down
    // The next start queues behind that teardown on the one FIFO chain, so it is over here.
    const portAfterStubborn = await svcPort(h.svc.ensureServer(h.db))
    expect(stubborn.killCalls).toEqual([undefined, 'SIGKILL']) // escalated, then gave up
    expect(registeredSidecarPids('kiwix_tools')).toContain(stubborn.pid) // stays reapable
    expect(h.builds()).toContain(basename(stubbornBuild)) // its file is NOT deleted

    const currentChild = h.lastServeChild()
    const stateBeforeLateExit = h.svc.serverState()!
    expect(stateBeforeLateExit).toMatchObject({ revision: 10, port: portAfterStubborn, alive: true })
    // The obsolete child's LATE terminal event: it completes its own cleanup (it leaves the
    // reaper registry) and changes nothing about the live record.
    stubborn.emit('exit', 0, null)
    await tick()
    expect(registeredSidecarPids('kiwix_tools')).not.toContain(stubborn.pid)
    expect(registeredSidecarPids('kiwix_tools')).toContain(currentChild.pid)
    expect(h.svc.serverState()).toEqual(stateBeforeLateExit)
    expect(currentChild.killCalls).toEqual([])

    // --- (7) OVERLAPPING stop(): the old probe releases TRUE after the quit ---------------
    const quitGate = serveGate<boolean>()
    h.hooks.probe = () => quitGate.wait()
    h.svc.setPackEnabled(h.db, beta, false) // revision 11
    const lastAsk = h.svc.ensureServer(h.db)
    await quitGate.entered
    const quitChild = h.lastServeChild()
    const stopping = h.svc.stop()
    quitGate.release(true) // the probe succeeds — but the quit already happened
    await expectAbortError(lastAsk)
    await stopping
    expect(h.svc.serverState()).toBeNull() // nothing published
    expect(quitChild.killCalls.length).toBeGreaterThan(0)
    const spawnsAtQuit = h.serveSpawns.length
    await expectAbortError(h.svc.ensureServer(h.db)) // terminal
    expect(h.serveSpawns).toHaveLength(spawnsAtQuit)
  })

  it('a cancelled waiter stops waiting without cancelling the shared start a live waiter still consumes', async () => {
    const h = svcHarness()
    await h.addPack('alpha.zim')
    const probeGate = serveGate<boolean>()
    h.hooks.probe = () => probeGate.wait()

    const ac = new AbortController()
    const cancelled = h.svc.ensureServer(h.db, ac.signal)
    const live = h.svc.ensureServer(h.db)
    await probeGate.entered
    expect(h.serveSpawns).toHaveLength(1) // one shared start for both waiters

    ac.abort()
    await expectAbortError(cancelled)
    expect(h.serveSpawns).toHaveLength(1) // the cancelled waiter did NOT abort the start

    probeGate.release(true)
    const port = await svcPort(live)
    expect(h.svc.serverState()).toMatchObject({ port, alive: true })
    expect(h.serveSpawns).toHaveLength(1)
    await h.svc.stop()
  })

  it('a lock (suspend) aborts every waiter with an AbortError and a later ask restarts the sidecar', async () => {
    const h = svcHarness()
    await h.addPack('alpha.zim')
    const probeGate = serveGate<boolean>()
    h.hooks.probe = () => probeGate.wait()

    const first = h.svc.ensureServer(h.db)
    const second = h.svc.ensureServer(h.db)
    await probeGate.entered
    const lockedChild = h.lastServeChild()

    const suspending = h.svc.suspend()
    h.hooks.probe = async () => true
    probeGate.release(true) // the parked probe succeeds only AFTER the lock
    await expectAbortError(first)
    await expectAbortError(second)
    await suspending
    expect(h.svc.serverState()).toBeNull()
    expect(lockedChild.killCalls.length).toBeGreaterThan(0)

    // suspend() is NOT a latch: the next ask lazily restarts (vision's lock shape).
    const port = await svcPort(h.svc.ensureServer(h.db))
    expect(h.serveSpawns).toHaveLength(2)
    expect(h.svc.serverState()).toMatchObject({ port, alive: true })
    await h.svc.stop()
  })

  it('a failed start latches by revision, never deadlocks stop(), and a pack change clears it', async () => {
    const h = svcHarness({ healthTimeoutMs: 15 })
    await h.addPack('alpha.zim')
    h.hooks.probe = async () => false

    await expect(h.svc.ensureServer(h.db)).rejects.toThrow(/did not become healthy/)
    expect(h.serveSpawns).toHaveLength(1)
    expect(h.lastServeChild().killCalls.length).toBeGreaterThan(0) // killRecord, not stop()
    // Latched under this revision: no second spawn while the pack set is unchanged.
    await expect(h.svc.ensureServer(h.db)).rejects.toThrow(/did not become healthy/)
    expect(h.serveSpawns).toHaveLength(1)

    // The failed start left nothing awaiting itself: stop() completes rather than deadlocking.
    await within(h.svc.stop(), 'stop() after a latched start failure')

    // A fresh service proves the other half: a pack change clears the latch.
    const h2 = svcHarness({ healthTimeoutMs: 15 })
    await h2.addPack('alpha.zim')
    h2.hooks.probe = async () => false
    await expect(h2.svc.ensureServer(h2.db)).rejects.toThrow(/did not become healthy/)
    h2.hooks.probe = async () => true
    await h2.addPack('beta.zim') // the pack set changed — the change may be the fix
    const port = await svcPort(h2.svc.ensureServer(h2.db))
    expect(h2.serveSpawns).toHaveLength(2)
    expect(h2.svc.serverState()).toMatchObject({ port, alive: true })
    await h2.svc.stop()
  })

  it('an ignored SIGTERM escalates to SIGKILL; a child that ignores both is reported unconfirmed with its PID and file kept', async () => {
    // (a) The polite signal is ignored but SIGKILL works: an ordinary, CONFIRMED teardown.
    const esc = svcHarness()
    await esc.addPack('alpha.zim')
    esc.nextChildMode = 'ignore-sigterm'
    await esc.svc.ensureServer(esc.db)
    const escChild = esc.lastServeChild()
    const escBuild = esc.serveSpawns[0]!.libraryXmlPath
    await esc.svc.suspend()
    expect(escChild.killCalls).toEqual([undefined, 'SIGKILL'])
    expect(registeredSidecarPids('kiwix_tools')).not.toContain(escChild.pid)
    expect(existsSync(escBuild)).toBe(false) // confirmed terminal ⇒ the build is cleaned up

    // (b) Nothing kills it: bounded wait, then the recorded failure policy.
    const h = svcHarness()
    await h.addPack('alpha.zim')
    h.nextChildMode = 'ignore-all'
    const port = await svcPort(h.svc.ensureServer(h.db))
    const child = h.lastServeChild()
    const build = h.serveSpawns[0]!.libraryXmlPath
    const generation = h.svc.serverState()!.generation
    expect(h.svc.serverState()).toMatchObject({ port, alive: true })

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    try {
      await h.svc.suspend()
      expect(child.killCalls).toEqual([undefined, 'SIGKILL'])
      const messages = warn.mock.calls.map((c) => String(c[0]))
      const uncertain = messages.filter((m) => /could not be confirmed stopped/.test(m))
      expect(uncertain).toHaveLength(1)
      expect(uncertain[0]).toContain(`generation ${generation}`)
      expect(uncertain[0]).toContain(`pid ${child.pid}`)
      expect(uncertain[0]).not.toContain(h.transientDir) // the sentinel rule: no paths
      expect(uncertain[0]).not.toContain('.zim')
    } finally {
      warn.mockRestore()
    }
    expect(registeredSidecarPids('kiwix_tools')).toContain(child.pid) // still reapable
    expect(existsSync(build)).toBe(true) // it may still be writing: the file stays

    // Quit must not remove the transient directory of an unconfirmed child either.
    await h.svc.stop()
    expect(existsSync(build)).toBe(true)
    child.emit('exit', 0, null)
    await tick()
    expect(registeredSidecarPids('kiwix_tools')).not.toContain(child.pid)
  })

  it('an empty pack set publishes a revision-keyed "nothing to serve": no child, no XML, no rebuild on the next ask', async () => {
    const h = svcHarness()
    const alpha = await h.addPack('alpha.zim') // revision 1
    h.svc.setPackEnabled(h.db, alpha, false) // revision 2 — nothing enabled

    expect(await h.svc.ensureServer(h.db)).toBeNull()
    expect(h.serveSpawns).toHaveLength(0)
    expect(h.builds()).toEqual([]) // the empty build removed its own file
    expect(h.svc.serverState()).toBeNull()

    expect(await h.svc.ensureServer(h.db)).toBeNull()
    expect(h.serveSpawns).toHaveLength(0)

    // The generation allocator is the witness that the second ask did NOT rebuild. P3b (#301)
    // draws the registration throwaway `meta-<n>/` from the SAME allocator, so `addPack` above
    // took g1: the empty build is g2, the next real build g3 and its child g4 — not g4/g5,
    // which is what a rebuild on the second (null) ask would have produced. Unchanged claim,
    // shifted by exactly the one registration.
    h.svc.setPackEnabled(h.db, alpha, true) // revision 3
    const port = await svcPort(h.svc.ensureServer(h.db))
    expect(h.svc.serverState()).toMatchObject({ revision: 3, build: 3, generation: 4, port, alive: true })
    await h.svc.stop()
  })

  it('teardown and the next rebuild are serialized: no concurrent library writer and no spawn before the old child is terminal', async () => {
    // A deliberately slow teardown (the polite signal is ignored for the whole grace) so
    // the ordering below is decided by the chain, not by the rebuild happening to be slower.
    const h = svcHarness({ killGraceMs: 250, forceKillWaitMs: 250 })
    const alpha = await h.addPack('alpha.zim')
    const beta = await h.addPack('beta.zim')
    await h.svc.ensureServer(h.db)
    const old = h.lastServeChild()
    old.mode = 'ignore-sigterm' // the polite kill is ignored, so the teardown really takes time

    h.svc.setPackEnabled(h.db, beta, false) // invalidate: teardown enqueued, then a rebuild
    await h.svc.ensureServer(h.db)
    const fresh = h.serveSpawns[h.serveSpawns.length - 1]!
    expect(fresh.child).not.toBe(old)
    expect(old.exited).toBe(true)
    expect(fresh.priorChildrenAllExited).toBe(true) // the start waited for the teardown

    // The old build is cleaned up inside the chain step that replaces it, so the rebuild
    // writes a NEW path and the pack set it captured is the current one.
    const freshBuild = fresh.libraryXmlPath
    expect(h.builds()).toEqual([basename(freshBuild)])
    expect(h.buildAdds.filter((a) => a.libraryXmlPath === freshBuild).map((a) => basename(a.zimPath))).toEqual([
      'alpha.zim'
    ])
    serveAssertSingleWriter(h.buildAdds)
    await h.svc.stop()
  })

  it('the admission seam is rechecked before publishing and before consuming a result', async () => {
    let epoch = 1
    let admits = true
    const h = svcHarness({ admission: { admitsWork: () => admits, epoch: () => epoch } })
    await h.addPack('alpha.zim')

    // (a) the epoch moves during the MANAGER work: the build is discarded, nothing spawns.
    const manageGate = serveGate<void>()
    h.hooks.manage = () => manageGate.wait()
    const duringBuild = h.svc.ensureServer(h.db)
    await manageGate.entered
    epoch = 2 // the workspace locked and unlocked while the library was being written
    h.hooks.manage = async () => undefined
    manageGate.release()
    await expectAbortError(duringBuild)
    expect(h.serveSpawns).toHaveLength(0) // no child was ever launched for that build
    expect(h.builds()).toEqual([]) // and the build deleted its own file
    expect(h.svc.serverState()).toBeNull()

    // (b) the epoch moves during the HEALTH PROBE: the child is torn down, not published.
    const gate = serveGate<boolean>()
    h.hooks.probe = () => gate.wait()

    const ask = h.svc.ensureServer(h.db)
    await gate.entered
    epoch = 3 // the workspace locked and unlocked again while this start was in the probe
    gate.release(true) // the probe succeeds — nothing aborted the signal
    await expectAbortError(ask)
    expect(h.svc.serverState()).toBeNull() // the old epoch never publishes
    expect(h.lastServeChild().killCalls.length).toBeGreaterThan(0) // and its child is gone

    // A workspace that stopped admitting work refuses at the entry recheck, before any work.
    admits = false
    const spawnsBefore = h.serveSpawns.length
    await expectAbortError(h.svc.ensureServer(h.db))
    expect(h.serveSpawns).toHaveLength(spawnsBefore)

    // Admitted again under the new epoch: an ordinary start publishes.
    admits = true
    h.hooks.probe = async () => true
    const port = await svcPort(h.svc.ensureServer(h.db))
    expect(h.svc.serverState()).toMatchObject({ port, alive: true })
    await h.svc.stop()
  })

  it('a pack set that keeps changing gives up with an ordinary error instead of spinning', async () => {
    const h = svcHarness()
    await h.addPack('alpha.zim')
    const beta = await h.addPack('beta.zim')
    let invalidations = 0
    // Every build is superseded by a pack change while its first manager child runs.
    h.hooks.manage = async () => {
      invalidations++
      h.svc.setPackEnabled(h.db, beta, true)
    }
    await expect(h.svc.ensureServer(h.db)).rejects.toThrow(/kept changing/)
    expect(invalidations).toBe(3) // MAX_ENSURE_ATTEMPTS rounds, then an ordinary rejection
    expect(h.serveSpawns).toHaveLength(0)
    expect(h.builds()).toEqual([]) // every abandoned build cleaned up its own file
    await h.svc.stop()
  })

  it('makeArm carries the ask signal into the sidecar start, not only into HTTP', async () => {
    const h = svcHarness()
    const alpha = await h.addPack('alpha.zim')
    const arm = h.svc.makeArm(h.db, [alpha])
    expect(arm).not.toBeNull()

    // The start parks in its health probe. Only the ask's own signal can end the wait there: a
    // start that never saw it would hold the arm until the probe answers.
    const probeGate = serveGate<boolean>()
    h.hooks.probe = () => probeGate.wait()
    const ac = new AbortController()
    const armP = arm!('a question', ac.signal)
    try {
      await probeGate.entered
      ac.abort()
      await within(expectAbortError(armP), 'the arm settling while the probe is parked')
      expect(h.serveSpawns).toHaveLength(1) // the shared start was not cancelled with the ask
    } finally {
      probeGate.release(true)
      await h.svc.stop()
    }
  })
})

// ---------------------------------------------------------------------------------------
// P5 — the alive/generation REQUEST GUARD (#301, finding M1; plan §9.19 (a)). The races are
// walked on the real vault + the real handlers by T17-a in
// `tests/integration/zim-ipc-session.test.ts`; these are the two ordinary paths that walk
// cannot reach on their own: nothing to serve, and an ordinary failure under a live child.
// ---------------------------------------------------------------------------------------
describe('ZimService.withServer — the alive/generation request guard (M1, P5)', () => {
  it('resolves null without running the callback when there is nothing to serve', async () => {
    const h = svcHarness() // no packs registered at all
    const op = h.svc.beginRegistration()
    try {
      let ran = 0
      const value = await h.svc.withServer(h.db, op, async () => {
        ran++
        return 'unreachable'
      })
      expect(value).toBeNull()
      expect(ran).toBe(0)
      expect(h.serveSpawns).toHaveLength(0)
    } finally {
      op.release()
    }
  })

  it('rethrows an ordinary request failure UNCHANGED under a live, unchanged generation, with no retry', async () => {
    const h = svcHarness()
    await h.addPack('alpha.zim')
    const op = h.svc.beginRegistration()
    try {
      // An HTTP 500 or a parse failure from a live, unchanged child is an ordinary failure,
      // not a lifecycle change: the arm's per-pack catch and the viewer's null must keep
      // their meaning, so the guard must not convert it into a retry or a StaleServerError.
      const boom = new Error('kiwix-serve article fetch failed (HTTP 500)')
      let attempts = 0
      const failing = h.svc.withServer(h.db, op, async () => {
        attempts++
        throw boom
      })
      await expect(failing).rejects.toBe(boom)
      expect(attempts).toBe(1)
      expect(h.serveSpawns).toHaveLength(1)
      expect(h.svc.serverState()).toMatchObject({ alive: true })
    } finally {
      op.release()
    }
  })
})
