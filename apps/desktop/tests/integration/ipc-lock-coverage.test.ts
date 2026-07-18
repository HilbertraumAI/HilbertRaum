import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// F16 / TEST-N8 generalized (audit-postmerge-2026-06-29).
//
// The prior TEST-N8 (chat-ipc.test.ts) enumerated only registerChatIpc + the two benchmark
// handlers. The audit found four more DB-touching handler GROUPS with no explicit
// requireUnlocked() preamble — rag (rag:ask), audit, core settings, and model — which were
// fail-closed (the `ctx.db` getter throws when locked) but surfaced the RAW unlocalized
// "Workspace is locked — unlock it first." instead of the friendly localized copy, and were
// not covered by an enumerating test (so a future unguarded handler would slip the net).
//
// This is the GENERALIZED structural test: it drives each DB-touching register*Ipc module
// against a LOCKED ctx and asserts EVERY non-exempt handler refuses with the friendly copy
// ("Workspace is locked." — note the PERIOD; the raw vault-getter string has " — unlock it
// first."). It also asserts the read-only / in-memory channels (getLogTail, getRuntimeStatus)
// STILL resolve when locked (pre-unlock diagnostics + runtime status must work at the gate).
//
// Modules with their own dedicated locked-vault rejection tests are not duplicated here:
// chat (chat-ipc TEST-N8), docs (docs-ipc "M6"), doctasks (doctasks-ipc), images
// (images-ipc). Together with this file every DB-touching IPC module is enumerated.
//
// NOTE: this also SUBSUMES Phase-5 item T3 (rag:ask lock-rejection) — registerRagIpc is
// driven here against a locked ctx, so T3 needs no separate test.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  // registerCoreIpc imports `app`/`clipboard`; only referenced inside handlers we don't drive.
  app: { getVersion: () => '0.0.0-test' },
  clipboard: { writeText: () => {} }
}))

import { registerCoreIpc } from '../../src/main/ipc/registerCoreIpc'
import { registerModelIpc } from '../../src/main/ipc/registerModelIpc'
import { registerAuditIpc } from '../../src/main/ipc/registerAuditIpc'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { registerBenchmarkIpc } from '../../src/main/ipc/registerBenchmarkIpc'
import { registerCollectionsIpc } from '../../src/main/ipc/registerCollectionsIpc'
import { registerEvidenceReviewsIpc } from '../../src/main/ipc/registerEvidenceReviewsIpc'
import { IPC } from '../../src/shared/ipc'
import { initLogging } from '../../src/main/services/logging'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** A LOCKED ctx with just enough shape for each module to REGISTER and for the documented
 *  read-only/in-memory channels to run. Every DB-touching handler must refuse at its
 *  requireUnlocked() preamble (the first statement) before any of this matters. */
function lockedCtx(tmp: string): AppContext {
  return {
    workspace: { isUnlocked: () => false },
    paths: { workspacePath: tmp, rootPath: tmp, configPath: join(tmp, 'config.json') },
    runtime: {
      status: () => ({ running: false, modelId: null, backend: null }),
      active: () => null,
      activeModelId: () => null
    },
    manifestsDir: null,
    isDev: false
  } as unknown as AppContext
}

// Per-module exemptions: the channels that LEGITIMATELY work while locked (read-only,
// in-memory, or workspace-agnostic). Everything else must refuse.
const MODULES: Array<{
  name: string
  register: (ctx: AppContext) => void
  exempt: Set<string>
}> = [
  {
    name: 'registerCoreIpc',
    register: registerCoreIpc,
    // Status/policy/preflight are workspace-aware (safe-default while locked); the diagnostics
    // log channels are intentionally pre-unlock; clipboard is in-memory. settings:get/update gated.
    exempt: new Set<string>([
      IPC.getAppStatus,
      IPC.getDriveStatus,
      IPC.runPreflight,
      IPC.getPolicy,
      IPC.getLogTail,
      IPC.exportLog,
      IPC.writeClipboard
    ])
  },
  {
    name: 'registerModelIpc',
    register: registerModelIpc,
    // stopRuntime + the two read-only runtime channels touch the in-memory runtime / disk
    // marker, never ctx.db, and must work at the gate.
    exempt: new Set<string>([IPC.stopRuntime, IPC.getRuntimeStatus, IPC.getRuntimeInstall])
  },
  { name: 'registerAuditIpc', register: registerAuditIpc, exempt: new Set<string>() },
  { name: 'registerRagIpc', register: registerRagIpc, exempt: new Set<string>() },
  { name: 'registerBenchmarkIpc', register: registerBenchmarkIpc, exempt: new Set<string>() },
  { name: 'registerCollectionsIpc', register: registerCollectionsIpc, exempt: new Set<string>() },
  // EP-1 Phase 1: every evidence-review handler is DB-backed — none are exempt.
  {
    name: 'registerEvidenceReviewsIpc',
    register: registerEvidenceReviewsIpc,
    exempt: new Set<string>()
  }
]

// DX-4 (full-audit-2026-06-29 follow-up, Phase 7): the locked-vault posture of every register*Ipc
// module not driven HERE (in MODULES) is verified by a DEDICATED test, OR the module is
// intentionally PRE-UNLOCK (it runs at the setup gate, before a workspace exists, so it has no
// requireUnlocked preamble by design). Each entry names WHY, so this set can never silently absorb
// a genuinely-unguarded module. The enumeration meta-assertion below proves
// union(MODULES, COVERED_ELSEWHERE) == every register*Ipc discovered by glob — so a NEW module that
// is added uncovered reds this file (the exact drift it exists to catch).
const COVERED_ELSEWHERE: Record<string, string> = {
  registerChatIpc: 'chat-ipc.test.ts (TEST-N8 locked-vault rejection)',
  registerDocsIpc: 'docs-ipc.test.ts ("M6" locked-vault rejection)',
  registerDocTasksIpc: 'doctasks-ipc.test.ts (locked-vault rejection)',
  registerImagesIpc: 'images-ipc.test.ts (locked-vault rejection)',
  registerTranslateIpc:
    'translate-ipc.test.ts (locked-vault rejection of translateStart — a start lazily respawns the suspended sidecar; cancel/getActive are safe non-DB reads, intentionally ungated)',
  registerSkillsIpc: 'skills-ipc.test.ts (locked-vault rejection; DB-touching, requireUnlocked-gated)',
  registerWorkspaceIpc:
    'workspace-ipc.test.ts — IS the lock/unlock/create/rekey gate; unlock + getStatus MUST work pre-unlock (no requireUnlocked by design)',
  registerDictationIpc:
    'dictation-ipc.test.ts (locked-vault rejection; S3 full-audit-2026-06-30 — writes a transient plaintext WAV into the documents dir, so it is lock-gated, not pre-unlock)',
  registerDownloadIpc:
    'pre-unlock by design — model downloads run at the setup gate; its only ctx.db read is guarded behind ctx.workspace.isUnlocked()',
  registerEngineIpc:
    'pre-unlock by design — engine-binary downloads run at the setup gate; its only ctx.db read is guarded behind ctx.workspace.isUnlocked()'
}

describe('IPC lock-guard coverage across modules (F16 / TEST-N8 generalized)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-lockcov-'))
    ipcState.handlers.clear()
  })

  for (const mod of MODULES) {
    it(`${mod.name}: every DB-touching handler refuses with the friendly copy when locked`, async () => {
      ipcState.handlers.clear()
      mod.register(lockedCtx(tmp))
      const channels = [...handlers.keys()]
      expect(channels.length).toBeGreaterThan(0) // the module registered something
      let checked = 0
      for (const ch of channels) {
        if (mod.exempt.has(ch)) continue
        // Throwaway args — requireUnlocked() is the FIRST statement of every DB-touching
        // handler, so the refusal is arg-shape-independent.
        await expect(invoke(handlers, ch, 'x', 'y', 'z')).rejects.toThrow(/Workspace is locked\./)
        // …and never the raw vault-getter string ("Workspace is locked — unlock it first.").
        await expect(invoke(handlers, ch, 'x', 'y', 'z')).rejects.not.toThrow(/unlock it first/i)
        checked++
      }
      // Guard against an exempt set that accidentally swallows the whole surface.
      expect(checked).toBeGreaterThan(0)
    })
  }

  it('read-only / in-memory channels still resolve when locked (getLogTail, getRuntimeStatus)', async () => {
    ipcState.handlers.clear()
    initLogging(tmp) // deterministic buffering state (no key attached → pre-unlock diagnostics)
    registerCoreIpc(lockedCtx(tmp))
    registerModelIpc(lockedCtx(tmp))

    const tail = await invoke(handlers, IPC.getLogTail)
    expect(Array.isArray(tail.result)).toBe(true)

    const status = await invoke(handlers, IPC.getRuntimeStatus)
    expect(status.result).toMatchObject({ running: false })
  })

  // DX-4: close the enumeration loop. Glob EVERY `register*Ipc` export from the source tree and
  // assert each is accounted for — either driven HERE (MODULES) or in COVERED_ELSEWHERE with a
  // reason. A new register*Ipc module added uncovered lands in `unaccounted` and reds this; a
  // module renamed/removed without updating the lists lands in `stale`. Discovery reads the source
  // files (regex on the `export function register*Ipc` declaration) rather than importing them, so
  // it needs no module side effects and matches what an author greps.
  it('every register*Ipc module is enumerated here or in COVERED_ELSEWHERE (DX-4 drift guard)', () => {
    const ipcDir = join(__dirname, '../../src/main/ipc')
    const discovered = new Set<string>()
    for (const file of readdirSync(ipcDir)) {
      if (!file.startsWith('register') || !file.endsWith('Ipc.ts')) continue
      const src = readFileSync(join(ipcDir, file), 'utf8')
      for (const m of src.matchAll(/export function (register\w*Ipc)\b/g)) discovered.add(m[1])
    }
    // Sanity: the glob actually found the modules (a broken path would vacuously pass).
    expect(discovered.size).toBeGreaterThanOrEqual(MODULES.length)

    const accounted = new Set<string>([
      ...MODULES.map((m) => m.name),
      ...Object.keys(COVERED_ELSEWHERE)
    ])
    const unaccounted = [...discovered].filter((n) => !accounted.has(n)).sort()
    const stale = [...accounted].filter((n) => !discovered.has(n)).sort()
    // A new module appears in `unaccounted` (add it to MODULES or COVERED_ELSEWHERE with a reason);
    // a removed/renamed module appears in `stale` (drop it from the lists).
    expect({ unaccounted, stale }).toEqual({ unaccounted: [], stale: [] })
  })
})
