import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { log } from '../../src/main/services/logging'
import { registeredSidecarPids, type ChildProcessLike, type SpawnFn } from '../../src/main/services/runtime/sidecar'
import { registerPack, servedCandidates, writeLibraryXml, type PackDeps } from '../../src/main/services/zim/packs'
import { readZimHeader } from '../../src/main/services/zim/identity'
import { packUuid, writeZimFixture } from '../helpers/zim-header'
import {
  KiwixManageError,
  kiwixManageAdd,
  _resetKiwixManageSkipLegacyWarnForTests
} from '../../src/main/services/zim/tools'
import type { BinaryVerifyResult } from '../../src/main/services/binary-verifier'
import { ZimService, type ServedLibrary, type ZimAdmission } from '../../src/main/services/zim'
import { KiwixServer } from '../../src/main/services/zim/serve'
import { ServeFakeChild, serveGate, type ServeChildMode } from '../helpers/zim-fakes'

// P3a — service generations, publication and cancellation. This file is shared with a
// parallel agent's T05 (`KiwixServer`/`ZimService`) block; this describe covers ONLY
// Brief B's contract: `kiwixManageAdd` (M9) plus its `packs.ts` callers
// (`writeLibraryXml`, `readZimMetadata` via `registerPack`). Binding design note:
// tmp/zim-wave/p3a/ledger-9.15.md item 8 (a copy of plan §9.15, PR #294 / issue #301).

// ---- shared test doubles (prefixed `manage*` so names cannot clash with T05's) -----

/** A controllable fake `kiwix-manage` child: `kill()` only RECORDS the call — it never
 *  emits `'exit'`/`'error'` on its own. The test decides when (or whether) the child
 *  actually dies, so the timeout/abort kill-escalation path can be observed step by
 *  step instead of asserted only via elapsed wall-clock time. */
class ManageFakeChild extends EventEmitter implements ChildProcessLike {
  pid: number
  killed = false
  stderr = new EventEmitter()
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = []
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal)
    this.killed = true
    return true
  }
}

function manageFakeSpawn(pid = 9001): {
  spawn: SpawnFn
  child: ManageFakeChild
  calls: Array<{ command: string; args: string[] }>
} {
  const calls: Array<{ command: string; args: string[] }> = []
  const child = new ManageFakeChild(pid)
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

describe('kiwixManageAdd — verifier, PID registry, abort, settle-before-cleanup (M9, P3a)', () => {
  beforeEach(() => {
    _resetKiwixManageSkipLegacyWarnForTests()
  })

  it('T06 kiwix-manage runs under the verifier (match / mismatch / hashless policy), every PID is registered, timeout and caller abort settle before cleanup, late exit and ignored kill are bounded', async () => {
    // --- verify: 'mismatch' refuses with NO spawn -----------------------------------
    {
      const { spawn, calls } = manageFakeSpawn(1)
      const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        verifyBinary: async () => 'mismatch'
      })
      await expect(done).rejects.toBeInstanceOf(KiwixManageError)
      await expect(done).rejects.toMatchObject({ kind: 'verify', childState: 'not-spawned' })
      expect(calls).toHaveLength(0)
    }

    // --- verify: 'ok' proceeds; PID registered while running, unregistered at exit --
    {
      const { spawn, calls, child } = manageFakeSpawn(2001)
      const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        verifyBinary: async () => 'ok'
      })
      await tick()
      expect(calls).toHaveLength(1)
      expect(registeredSidecarPids('kiwix_tools')).toContain(2001)
      child.emit('exit', 0, null)
      await expect(done).resolves.toBeUndefined()
      expect(registeredSidecarPids('kiwix_tools')).not.toContain(2001)
    }

    // --- verify: 'skip-legacy' still spawns; the R-1 warn fires ONCE across two calls
    {
      const warn = vi.spyOn(log, 'warn')
      for (const pid of [2101, 2102]) {
        const { spawn, calls, child } = manageFakeSpawn(pid)
        const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
          verifyBinary: async () => 'skip-legacy'
        })
        await tick()
        expect(calls).toHaveLength(1) // spawn happens — 'skip-legacy' never blocks
        child.emit('exit', 0, null)
        await expect(done).resolves.toBeUndefined()
      }
      const r1Warnings = warn.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('R-1'))
      expect(r1Warnings).toHaveLength(1) // once per process, not once per call
      expect(r1Warnings[0]?.[0]).not.toMatch(/[\\/]/) // never a path in the message
    }

    // --- timeout: the promise stays pending after kill() while the fake ignores it,
    //     settles only once the fake emits 'exit' -------------------------------------
    {
      const { spawn, calls, child } = manageFakeSpawn(3001)
      const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        verifyBinary: async () => 'ok',
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
        verifyBinary: async () => 'ok',
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
        verifyBinary: async () => 'ok',
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

  it('verifyBinary mismatch refuses with zero spawns; ok / skip-dev spawn silently (no R-1 warn)', async () => {
    const warn = vi.spyOn(log, 'warn')
    for (const verdict of ['ok', 'skip-dev'] as const) {
      const { spawn, calls, child } = manageFakeSpawn()
      const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        verifyBinary: async () => verdict
      })
      await tick()
      expect(calls).toHaveLength(1)
      child.emit('exit', 0, null)
      await expect(done).resolves.toBeUndefined()
    }
    expect(warn.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('R-1'))).toHaveLength(0)

    const { spawn, calls } = manageFakeSpawn()
    await expect(
      kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        verifyBinary: async () => 'mismatch'
      })
    ).rejects.toMatchObject({ kind: 'verify', childState: 'not-spawned' })
    expect(calls).toHaveLength(0)
  })

  it('a sync spawn throw rejects kind "spawn" with childState "not-spawned" and never registers a PID', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('spawn ENOENT')
    }
    await expect(
      kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        verifyBinary: async () => 'ok'
      })
    ).rejects.toMatchObject({ kind: 'spawn', childState: 'not-spawned' })
  })

  it('an already-aborted caller signal refuses after the verifier with no spawn', async () => {
    const { spawn, calls } = manageFakeSpawn()
    const controller = new AbortController()
    controller.abort()
    await expect(
      kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/a.zim', spawn, {
        verifyBinary: async () => 'ok',
        signal: controller.signal
      })
    ).rejects.toMatchObject({ kind: 'abort', childState: 'not-spawned' })
    expect(calls).toHaveLength(0)
  })

  it('preserves the existing ordinary-exit message shape (regex /code 1 — Cannot add ZIM/ still matches)', async () => {
    const { spawn, child } = manageFakeSpawn()
    const done = kiwixManageAdd('/bin/kiwix-manage', '/lib/library.xml', '/zim/bad.zim', spawn, {
      verifyBinary: async () => 'ok'
    })
    await tick()
    child.stderr.emit('data', 'Cannot add ZIM /zim/bad.zim to the library.')
    child.emit('exit', 1, null)
    await expect(done).rejects.toThrow(/code 1 — Cannot add ZIM/)
  })
})

describe('writeLibraryXml — stops on an unconfirmed manager child (M9 → packs.ts, P3a)', () => {
  it('stops and rethrows on childState "uncertain" but still skips an ordinary per-pack failure', async () => {
    const { db, zimDir, root } = managePackHarness()
    let mode: 'register' | 'build' = 'register'
    const buildCalls: string[] = []
    const manageAdd: PackDeps['manageAdd'] = async (libraryXmlPath, zimPath) => {
      const leaf = basename(zimPath)
      if (mode === 'register') {
        appendFileSync(
          libraryXmlPath,
          `<book id="${readZimHeader(zimPath).uuid}" path="${zimPath.replace(/\\/g, '/')}" title="T ${leaf}" ` +
            `language="deu" date="2026-07-01" articleCount="1" mediaCount="0" />\n`
        )
        return
      }
      buildCalls.push(leaf)
      if (leaf.includes('badordinary')) throw new Error('Cannot add ZIM — ordinary failure')
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
    const manageAdd: PackDeps['manageAdd'] = async (libraryXmlPath, zimPath) => {
      const leaf = basename(zimPath)
      if (mode === 'register') {
        appendFileSync(
          libraryXmlPath,
          `<book id="${readZimHeader(zimPath).uuid}" path="${zimPath.replace(/\\/g, '/')}" title="T ${leaf}" language="deu" />\n`
        )
        return
      }
      buildCalls.push(leaf)
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

  it('forwards its signal to manageAdd (the additive third ManageAddFn param)', async () => {
    const { db, zimDir, root } = managePackHarness()
    let mode: 'register' | 'build' = 'register'
    let receivedSignal: AbortSignal | undefined
    const manageAdd: PackDeps['manageAdd'] = async (libraryXmlPath, zimPath, signal) => {
      const leaf = basename(zimPath)
      if (mode === 'register') {
        appendFileSync(
          libraryXmlPath,
          `<book id="${readZimHeader(zimPath).uuid}" path="${zimPath.replace(/\\/g, '/')}" title="T ${leaf}" language="deu" />\n`
        )
        return
      }
      receivedSignal = signal
      appendFileSync(libraryXmlPath, `<book id="uuid-${leaf}" path="x" title="T" language="deu" />\n`)
    }
    const deps: PackDeps = { zimDir, manageAdd }
    await registerPack(db, deps, addManageZimFile(zimDir, 'a.zim'))
    mode = 'build'
    const controller = new AbortController()
    const libraryPath = join(root, 'library.xml')
    await writeLibraryXml(deps, libraryPath, servedCandidates(db, zimDir), controller.signal)
    expect(receivedSignal).toBe(controller.signal)
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
// Brief A — `KiwixServer` per-child records + `ZimService` generations (H3, M2; T05).
// Binding design note: tmp/zim-wave/p3a/ledger-9.15.md items 1–7 and 9–11 (a copy of plan
// §9.15, PR #294 / issue #301). Helpers below are prefixed `serve*`/`svc*` so they cannot
// clash with the `manage*` doubles of the M9 block above.
//
// Every ordering fact is established by a controlled promise with an `entered`/`release`
// pair (the verifier, the port allocator, a manager child, a probe = the publication
// boundary), never by a fixed sleep. `waitMs` appears only to let the tiny configured
// kill-grace timers elapse, and what is asserted afterwards is a fake's RECORDED state.
// =====================================================================================

// The controlled gate and the fake serve child now live in tests/helpers/zim-fakes.ts —
// shared verbatim with the P3b session suite so the two cannot drift on what "the child
// ignored SIGTERM" means (#301).

interface ServeSpawnRecord {
  args: string[]
  libraryXmlPath: string
  child: ServeFakeChild
  /** Had EVERY earlier child already reached a terminal state at the moment of this spawn? */
  priorChildrenAllExited: boolean
}

interface SvcHooks {
  verify: (binPath: string) => Promise<BinaryVerifyResult>
  findPort: () => Promise<number>
  probe: (port: number) => Promise<boolean>
  /** Runs inside a fake kiwix-manage child before it appends its `<book>` and exits 0. */
  manage: (libraryXmlPath: string, zimPath: string) => Promise<void>
}

interface SvcHarness {
  db: Db
  root: string
  zimDir: string
  libraryDir: string
  svc: ZimService
  hooks: SvcHooks
  /** kiwix-serve spawns, in order. */
  serveSpawns: ServeSpawnRecord[]
  /** kiwix-manage invocations that wrote a LIBRARY BUILD (registration throwaways excluded). */
  buildAdds: Array<{ libraryXmlPath: string; zimPath: string }>
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
  const libraryDir = join(root, 'library')
  mkdirSync(libraryDir, { recursive: true })
  const db = openDatabase(join(root, 'test.sqlite'))

  const serveSpawns: ServeSpawnRecord[] = []
  const buildAdds: Array<{ libraryXmlPath: string; zimPath: string }> = []
  let servePid = 9100
  let managePid = 7100

  const hooks: SvcHooks = {
    verify: async () => 'ok',
    findPort: async () => 8300 + serveSpawns.length,
    probe: async () => true,
    manage: async () => undefined
  }

  const harness: SvcHarness = {
    db,
    root,
    zimDir,
    libraryDir,
    hooks,
    serveSpawns,
    buildAdds,
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
      readdirSync(libraryDir)
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

  // A fake kiwix-manage: `LIBRARY add ZIM` appends one <book> derived from the file name
  // (the zim-packs.test.ts shape) and exits 0 — but only if it was not killed first, so an
  // aborted/timed-out manager writes nothing more (the settle-before-cleanup contract).
  const manageSpawn: SpawnFn = (_command, args) => {
    const libraryXmlPath = args[0] as string
    const zimPath = args[2] as string
    const child = new ServeFakeChild(managePid++, 'exit-on-sigterm')
    if (dirname(libraryXmlPath) === libraryDir) buildAdds.push({ libraryXmlPath, zimPath })
    void (async () => {
      let failure: unknown = null
      try {
        await hooks.manage(libraryXmlPath, zimPath)
      } catch (err) {
        failure = err
      }
      await tick()
      if (child.killed) return // a killed kiwix-manage never appends anything
      if (failure) {
        child.stderr.emit('data', String(failure))
        child.emit('exit', 1, null)
        return
      }
      const stem = basename(zimPath).replace(/\.zim$/i, '')
      appendFileSync(
        libraryXmlPath,
        `<book id="${readZimHeader(zimPath).uuid}" path="${zimPath.replace(/\\/g, '/')}" title="Title of ${stem}" ` +
          `description="Test archive" language="deu" date="2026-07-01" articleCount="41" mediaCount="7" />\n`
      )
      child.emit('exit', 0, null)
    })()
    return child
  }

  harness.svc = new ZimService({
    rootPath: root,
    isDev: true,
    admission: opts.admission,
    deps: {
      resolveTools: () => ({ serve: '/bin/kiwix-serve', manage: '/bin/kiwix-manage' }),
      spawn: serveSpawn,
      manageSpawn,
      findPort: () => hooks.findPort(),
      probe: (port) => hooks.probe(port),
      verifyBinary: (bin) => hooks.verify(bin),
      healthTimeoutMs: opts.healthTimeoutMs ?? 1_000,
      healthIntervalMs: 1,
      killGraceMs: opts.killGraceMs ?? 5,
      forceKillWaitMs: opts.forceKillWaitMs ?? 5,
      libraryDir
    }
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

/** Assert a promise rejects with the #159 AbortError convention (a DOMException named
 *  `AbortError`, the shape `isStartAbortError` in runtime/sidecar.ts recognises). */
async function serveExpectAbortError(promise: Promise<unknown>): Promise<void> {
  const err = await promise.then(
    () => {
      throw new Error('expected an AbortError rejection, but the call resolved')
    },
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(DOMException)
  expect((err as DOMException).name).toBe('AbortError')
}

describe('ZimService + KiwixServer — generations, publication and cancellation (H3/M2, P3a)', () => {
  it('T05 parked verifier / port / manager / publication / health with overlapping stop, invalidate and restart: no obsolete spawn or publication, no old callback or finally mutates the current child, one writer, latest revision served, current XML path in argv', async () => {
    const h = svcHarness()
    const alpha = await h.addPack('alpha.zim') // revision 1

    // --- (1) PARKED VERIFIER: a pack change while a start sits in the pre-spawn verifier -
    const verifyGate = serveGate<BinaryVerifyResult>()
    h.hooks.verify = async (bin) => (bin.includes('serve') ? verifyGate.wait() : 'ok')
    const firstAsk = h.svc.ensureServer(h.db)
    await verifyGate.entered
    expect(h.buildAdds).toHaveLength(1) // build A written, one book (alpha)
    const buildA = h.buildAdds[0]!.libraryXmlPath
    expect(existsSync(buildA)).toBe(true)
    expect(h.serveSpawns).toHaveLength(0)

    const beta = await h.addPack('beta.zim') // revision 2 — aborts the parked start
    h.hooks.verify = async () => 'ok'
    verifyGate.release('ok')
    const portAfterOne = await svcPort(firstAsk) // the ask re-loops onto revision 2 rather than failing

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
    const spawnsBeforeD = h.serveSpawns.length
    h.svc.setPackEnabled(h.db, alpha, true) // revision 6 — aborts the parked manager
    h.hooks.manage = async () => undefined
    manageGate.release()
    const portAfterThree = await svcPort(thirdAsk)

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
    await h.svc.whenSettled()
    expect(stubborn.killCalls).toEqual([undefined, 'SIGKILL']) // escalated, then gave up
    expect(registeredSidecarPids('kiwix_tools')).toContain(stubborn.pid) // stays reapable
    expect(h.builds()).toContain(basename(stubbornBuild)) // its file is NOT deleted

    const portAfterStubborn = await svcPort(h.svc.ensureServer(h.db))
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
    await serveExpectAbortError(lastAsk)
    await stopping
    expect(h.svc.serverState()).toBeNull() // nothing published
    expect(quitChild.killCalls.length).toBeGreaterThan(0)
    const spawnsAtQuit = h.serveSpawns.length
    await serveExpectAbortError(h.svc.ensureServer(h.db)) // terminal
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
    await serveExpectAbortError(cancelled)
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
    await serveExpectAbortError(first)
    await serveExpectAbortError(second)
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
    const outcome = await Promise.race([
      h.svc.stop().then(() => 'stopped'),
      waitMs(2_000).then(() => 'deadlocked')
    ])
    expect(outcome).toBe('stopped')

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
      expect(uncertain[0]).not.toContain(h.libraryDir) // the sentinel rule: no paths
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
    await serveExpectAbortError(duringBuild)
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
    await serveExpectAbortError(ask)
    expect(h.svc.serverState()).toBeNull() // the old epoch never publishes
    expect(h.lastServeChild().killCalls.length).toBeGreaterThan(0) // and its child is gone

    // A workspace that stopped admitting work refuses at the entry recheck, before any work.
    admits = false
    const spawnsBefore = h.serveSpawns.length
    await serveExpectAbortError(h.svc.ensureServer(h.db))
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

    const ac = new AbortController()
    ac.abort()
    await serveExpectAbortError(arm!('a question', ac.signal))
    expect(h.serveSpawns).toHaveLength(0) // the cancelled ask never spawned a sidecar
    await h.svc.stop()
  })
})

// --- KiwixServer on its own: the per-child record boundary (H3) -----------------------
// The service's own pre-publication recheck would mask a missing recheck INSIDE the server,
// so these drive `KiwixServer` directly.

interface ServeOnlyHarness {
  server: KiwixServer
  spawns: ServeSpawnRecord[]
  hooks: { probe: () => Promise<boolean>; findPort: () => Promise<number> }
  nextChildMode: ServeChildMode
}

function serveOnlyHarness(): ServeOnlyHarness {
  const spawns: ServeSpawnRecord[] = []
  let pid = 9500
  const hooks = {
    probe: async (): Promise<boolean> => true,
    findPort: async (): Promise<number> => 8500 + spawns.length
  }
  const harness: ServeOnlyHarness = {
    spawns,
    hooks,
    nextChildMode: 'exit-on-sigterm',
    server: null as unknown as KiwixServer
  }
  harness.server = new KiwixServer({
    binPath: '/bin/kiwix-serve',
    spawn: (_command, args) => {
      const child = new ServeFakeChild(pid++, harness.nextChildMode)
      spawns.push({
        args: [...args],
        libraryXmlPath: args[args.indexOf('--library') + 1] as string,
        child,
        priorChildrenAllExited: spawns.every((s) => s.child.exited)
      })
      return child
    },
    findPort: () => hooks.findPort(),
    probe: () => hooks.probe(),
    verifyBinary: async () => 'ok',
    healthTimeoutMs: 1_000,
    healthIntervalMs: 1,
    killGraceMs: 5,
    forceKillWaitMs: 5
  })
  return harness
}

describe('KiwixServer — per-child records (H3, P3a)', () => {
  it('a superseded start never publishes its child even when its parked probe finally succeeds', async () => {
    const h = serveOnlyHarness()
    h.nextChildMode = 'ignore-all' // it also never reaches a terminal state on its own
    const gate = serveGate<boolean>()
    h.hooks.probe = () => gate.wait()

    const start = h.server.ensureStarted({ libraryXmlPath: '/ws/library.1.xml' })
    await gate.entered
    const stale = h.spawns[0]!.child
    const stopping = h.server.stop()
    gate.release(true) // the OLD probe succeeds — after the teardown began
    await serveExpectAbortError(start)
    await stopping

    expect(h.server.alive()).toBe(false)
    expect(h.server.port()).toBeNull()
    expect(h.server.generation()).toBeNull()
    expect(h.server.current()).toBeNull()
    expect(stale.killCalls).toEqual([undefined, 'SIGKILL']) // bounded escalation, then given up
    expect(h.server.lastStopUncertain()).toBe(true)

    // The restart is an independent record with its own generation and its own path.
    h.nextChildMode = 'exit-on-sigterm'
    h.hooks.probe = async () => true
    const again = await h.server.ensureStarted({ libraryXmlPath: '/ws/library.2.xml' })
    const live = h.spawns[1]!.child
    expect(h.server.current()).toEqual({
      port: again.port,
      generation: again.generation,
      libraryXmlPath: '/ws/library.2.xml'
    })

    // The obsolete record's LATE terminal event mutates only itself.
    stale.emit('exit', 1, null)
    await tick()
    expect(h.server.alive()).toBe(true)
    expect(h.server.generation()).toBe(again.generation)
    expect(h.server.port()).toBe(again.port)
    expect(live.killCalls).toEqual([])
    await h.server.stop()
  })

  it('overlapping stops share ONE teardown pass (the translation single-flight shape)', async () => {
    const h = serveOnlyHarness()
    h.nextChildMode = 'ignore-sigterm' // a real grace window for a second stop to arrive in
    await h.server.ensureStarted({ libraryXmlPath: '/ws/library.1.xml' })
    const child = h.spawns[0]!.child

    const firstStop = h.server.stop()
    const secondStop = h.server.stop() // arrives inside the SIGTERM → SIGKILL window
    expect(secondStop).toBe(firstStop) // the same pass, not a second no-op body
    await Promise.all([firstStop, secondStop])
    expect(child.killCalls).toEqual([undefined, 'SIGKILL']) // killed once, escalated once
    expect(h.server.alive()).toBe(false)
    expect(h.server.lastStopUncertain()).toBe(false)
  })

  it('every child of the process takes a distinct generation, and a start aborted by a teardown never latches', async () => {
    const h = serveOnlyHarness()
    const first = await h.server.ensureStarted({ libraryXmlPath: '/ws/library.1.xml' })
    await h.server.stop()
    const second = await h.server.ensureStarted({ libraryXmlPath: '/ws/library.1.xml' })
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(second.port).not.toBe(first.port)

    // An aborted start must not arm the compatibility failure latch: the very next
    // ensureStarted() spawns again instead of rethrowing the abort forever.
    const gate = serveGate<boolean>()
    h.hooks.probe = () => gate.wait()
    const parked = h.server.ensureStarted({ libraryXmlPath: '/ws/library.2.xml' })
    await gate.entered
    const stopping = h.server.stop()
    gate.release(false)
    await serveExpectAbortError(parked)
    await stopping
    h.hooks.probe = async () => true
    const third = await h.server.ensureStarted({ libraryXmlPath: '/ws/library.2.xml' })
    expect(third.generation).toBeGreaterThan(second.generation)
    expect(h.spawns).toHaveLength(4)
    await h.server.stop()
  })
})
