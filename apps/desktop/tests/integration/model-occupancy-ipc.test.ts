import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Issues #185/#186 at the IPC entry points — the two handlers the issues actually name:
// `runBenchmark` (which had no re-entrancy or busy guard at all) and `startSkillRun` (which
// consulted neither `inFlightStreams` nor the doc-task registry). The registry itself, the
// composed predicate, and the chat/doc-task seams are pinned in `model-occupancy.test.ts`.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
// A gate a test can set to HOLD the save dialog — and with it a confirmed skill run — open, so
// the occupancy span can be observed while the run is genuinely in flight.
const dialogState = vi.hoisted(() => ({
  saveResult: { canceled: true } as { canceled: boolean; filePath?: string },
  gate: undefined as Promise<void> | undefined
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => {
      if (dialogState.gate) await dialogState.gate
      return dialogState.saveResult
    }
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerSkillsIpc } from '../../src/main/ipc/registerSkillsIpc'
import { runAndPersistBenchmark } from '../../src/main/ipc/registerBenchmarkIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { RuntimeManager } from '../../src/main/services/runtime'
import type { ModelRuntime } from '../../src/main/services/runtime'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings, getSettings } from '../../src/main/services/settings'
import { createAuditRecorder } from '../../src/main/services/audit'
import { createSkillRegistry } from '../../src/main/services/skills/registry'
import { createConversation } from '../../src/main/services/chat'
import { IPC } from '../../src/shared/ipc'
import { t } from '../../src/shared/i18n'
import type { AppContext } from '../../src/main/services/context'
import type { SkillRunState, StartSkillRunResult } from '../../src/shared/types'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-occ-ipc-'))
}

function fakeRuntime(): ModelRuntime {
  return {
    modelId: 'm',
    async start() {},
    async stop() {},
    async health() {
      return { healthy: true, message: '', port: null }
    },
    async *chatStream() {
      yield '[]'
    }
  }
}

async function startedManager(): Promise<RuntimeManager> {
  const mgr = new RuntimeManager(() => fakeRuntime())
  await mgr.start({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 2048 })
  return mgr
}

function writeSkill(appSkillsDir: string, id: string, tools: string[]): void {
  const d = join(appSkillsDir, id)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'SKILL.md'),
    [
      '---',
      `id: ${id}`,
      `title: ${id}`,
      'description: A test skill.',
      'version: 1.0.0',
      'kind: tool',
      `allowedTools: [${tools.join(', ')}]`,
      '---',
      'Body.'
    ].join('\n'),
    'utf8'
  )
}

function seedDoc(db: Db, text: string): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  const storedPath = join(tempDir(), 'document.txt')
  writeFileSync(storedPath, text, 'utf8')
  db.prepare(
    `INSERT INTO documents (id, title, stored_path, status, mime_type, created_at, updated_at)
     VALUES (?, ?, ?, 'indexed', 'text/plain', ?, ?)`
  ).run(docId, 'document.txt', storedPath, now, now)
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
     VALUES (?, ?, 0, ?, 'p', 1, ?)`
  ).run(randomUUID(), docId, text, now)
  return docId
}

interface Harness {
  db: Db
  ctx: AppContext
  runtime: RuntimeManager
  conversationId: string
  skillInstallId: string
}

/** A skills-IPC harness with a REAL, started RuntimeManager — so the #186 guard is live. */
async function makeHarness(
  skillId: string,
  tools: string[],
  docText: string,
  opts: { docTasksActive?: boolean } = {}
): Promise<Harness> {
  const root = tempDir()
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  mkdirSync(appSkillsDir, { recursive: true })
  mkdirSync(userSkillsDir, { recursive: true })
  writeSkill(appSkillsDir, skillId, tools)
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const runtime = await startedManager()
  const ctx = {
    trustedSenders: ANY_SENDER,
    db,
    paths: { workspacePath: root, rootPath: root },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    isDev: false,
    runtime,
    docTasks: opts.docTasksActive ? { hasActiveTask: () => true } : undefined,
    manifestsDir: null,
    audit: createAuditRecorder(() => db),
    skills: createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir }),
    ocrEngine: undefined
  } as unknown as AppContext
  registerSkillsIpc(ctx)
  const docId = seedDoc(db, docText)
  const conv = createConversation(db, {
    mode: 'documents',
    scope: { collectionIds: [], documentIds: [docId] }
  })
  return { db, ctx, runtime, conversationId: conv.id, skillInstallId: `app:${skillId}` }
}

async function startRun(
  h: Harness,
  toolName: string,
  confirmed?: boolean
): Promise<StartSkillRunResult> {
  const { result } = await invoke(handlers, IPC.startSkillRun, {
    skillInstallId: h.skillInstallId,
    toolName,
    conversationId: h.conversationId,
    confirmed
  })
  return result as StartSkillRunResult
}

/** Narrow the started-run union and hand back its handle. */
function startedHandle(start: StartSkillRunResult): string {
  if (!start.started) throw new Error(`expected the run to start: ${JSON.stringify(start)}`)
  return start.run.runHandle
}

/** The refusal message of a NOT-started result (the union's other arm). */
function refusal(start: StartSkillRunResult): string | undefined {
  if (start.started) throw new Error('expected the run to be refused')
  return 'error' in start ? start.error : undefined
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function pollUntilTerminal(runHandle: string): Promise<SkillRunState> {
  for (let i = 0; i < 200; i++) {
    const { result } = await invoke(handlers, IPC.getSkillRun, runHandle)
    const state = result as SkillRunState | null
    if (state && state.state !== 'running') return state
    await flush()
  }
  throw new Error('run did not terminate')
}

beforeEach(() => {
  ipcState.handlers.clear()
  dialogState.saveResult = { canceled: true }
  dialogState.gate = undefined
  inFlightStreams.clear()
})

// ---- #186: a skill run and a chat stream can no longer generate concurrently ----

describe('startSkillRun — the model-lane guard (#186)', () => {
  const DOC = 'Contact leak.source@example.com about the invoice.'

  it('refuses a direct-lane run while a chat answer is streaming', async () => {
    const h = await makeHarness('redaction', ['redact_document'], DOC)
    inFlightStreams.set('c1', new AbortController())

    const start = await startRun(h, 'redact_document', true)
    expect(start.started).toBe(false)
    expect(refusal(start)).toBe(t('en', 'main.busy.chat'))
    // Nothing was taken, so a refusal cannot leave the model looking permanently busy.
    expect(h.runtime.occupancy.isBusy()).toBe(false)
  })

  it('refuses a direct-lane run while a document task is queued or running', async () => {
    const h = await makeHarness('redaction', ['redact_document'], DOC, { docTasksActive: true })
    const start = await startRun(h, 'redact_document', true)
    expect(start.started).toBe(false)
    expect(refusal(start)).toBe(t('en', 'main.busy.docTask'))
  })

  it('refuses a direct-lane run while the benchmark is measuring', async () => {
    const h = await makeHarness('redaction', ['redact_document'], DOC)
    const release = h.runtime.occupancy.begin('benchmark')
    const start = await startRun(h, 'redact_document', true)
    expect(start.started).toBe(false)
    expect(refusal(start)).toBe(t('en', 'main.busy.benchmark'))
    release()
  })

  it('holds a skill-run span for the life of the run, and releases it on every exit', async () => {
    const h = await makeHarness('redaction', ['redact_document'], DOC)
    // Hold the save dialog open so the run is genuinely in flight while we look.
    let openDialog!: () => void
    dialogState.gate = new Promise<void>((resolve) => {
      openDialog = resolve
    })

    const start = await startRun(h, 'redact_document', true)
    expect(start.started).toBe(true)
    // Give the run a tick to reach the dialog.
    for (let i = 0; i < 50 && !h.runtime.occupancy.held('skill-run'); i++) await flush()
    expect(h.runtime.occupancy.held('skill-run')).toBe(true)
    // …and while it is held, a second run is refused with the skill-run copy.
    const second = await startRun(h, 'redact_document', true)
    expect(second.started).toBe(false)
    expect(refusal(second)).toBe(t('en', 'main.busy.skillRun'))

    openDialog()
    await pollUntilTerminal(startedHandle(start))
    // Released in the runner's own `finally` — a cancelled dialog is a terminal path too.
    expect(h.runtime.occupancy.held('skill-run')).toBe(false)
    expect(h.runtime.isExternallyBusy()).toBe(false)
  })

  it('takes NO span for a deterministic tool — those never reach the model', async () => {
    const h = await makeHarness('bank', ['extract_transactions'], 'EUR\n2026-01-02 Grocery -45,90')
    const start = await startRun(h, 'extract_transactions')
    expect(start.started).toBe(true)
    expect(h.runtime.occupancy.held('skill-run')).toBe(false)
    await pollUntilTerminal(startedHandle(start))
    expect(h.runtime.occupancy.isBusy()).toBe(false)
  })

  it('takes NO span for the doctask-lane categorizer — a span there would deadlock its own task', async () => {
    // D26: `categorize_transactions` enqueues a doc task and the model call happens INSIDE it.
    // A `skill-run` span here would make `startDocTask` refuse the very task the run awaits.
    const h = await makeHarness(
      'bank',
      ['extract_transactions', 'categorize_transactions'],
      'EUR\n2026-01-02 Grocery -45,90'
    )
    await pollUntilTerminal(startedHandle(await startRun(h, 'extract_transactions')))

    const start = await startRun(h, 'categorize_transactions')
    expect(start.started).toBe(true)
    expect(h.runtime.occupancy.held('skill-run')).toBe(false)
    await pollUntilTerminal(startedHandle(start))
  })

  it('takes no span when no runtime is active — there is nothing to exclude', async () => {
    const h = await makeHarness('redaction', ['redact_document'], DOC)
    await h.runtime.stop()
    const start = await startRun(h, 'redact_document', true)
    // The redaction still runs (it degrades to its deterministic floor, D78), just unguarded.
    expect(start.started).toBe(true)
    expect(h.runtime.occupancy.held('skill-run')).toBe(false)
    await pollUntilTerminal(startedHandle(start))
  })
})

// ---- #185: the benchmark's re-entrancy and busy guard ---------------------------

describe('runAndPersistBenchmark — the re-entrancy and busy guard (#185)', () => {
  async function benchCtx(): Promise<{ ctx: AppContext; runtime: RuntimeManager; db: Db }> {
    const root = tempDir()
    const db = openDatabase(join(root, 'test.sqlite'))
    seedSettings(db)
    const runtime = await startedManager()
    const ctx = {
      db,
      paths: { workspacePath: root, rootPath: root },
      workspace: { isUnlocked: () => true },
      isDev: false,
      runtime,
      manifestsDir: null,
      docTasks: undefined
    } as unknown as AppContext
    return { ctx, runtime, db }
  }

  it('refuses a SECOND concurrent run — the re-entrancy guard', async () => {
    const { ctx, runtime } = await benchCtx()
    const first = runAndPersistBenchmark(ctx)
    // The span is taken synchronously, before the first await, so the second caller cannot
    // race into "idle" — this is the two-Diagnostics-clicks case from the issue.
    expect(runtime.occupancy.held('benchmark')).toBe(true)
    await expect(runAndPersistBenchmark(ctx)).rejects.toThrow(t('en', 'main.busy.benchmark'))

    await first
    expect(runtime.occupancy.held('benchmark')).toBe(false)
    // …and a run after the first finished is admitted normally.
    await expect(runAndPersistBenchmark(ctx)).resolves.toBeTruthy()
  })

  it('refuses to start while a chat answer is streaming', async () => {
    const { ctx } = await benchCtx()
    inFlightStreams.set('c1', new AbortController())
    await expect(runAndPersistBenchmark(ctx)).rejects.toThrow(t('en', 'main.busy.chat'))
  })

  it('refuses to start while a skill run holds the model', async () => {
    const { ctx, runtime } = await benchCtx()
    const release = runtime.occupancy.begin('skill-run')
    await expect(runAndPersistBenchmark(ctx)).rejects.toThrow(t('en', 'main.busy.skillRun'))
    release()
  })

  it('releases its span when the run throws, so one failure cannot wedge every lane', async () => {
    const { ctx, runtime } = await benchCtx()
    // `ctx.db` is the persistence step's only reach; make it throw AFTER the span is taken.
    Object.defineProperty(ctx, 'db', {
      get() {
        throw new Error('workspace locked mid-benchmark')
      }
    })
    await expect(runAndPersistBenchmark(ctx)).rejects.toThrow(/locked mid-benchmark/)
    expect(runtime.occupancy.held('benchmark')).toBe(false)
    expect(runtime.isExternallyBusy()).toBe(false)
  })

  it('persists a normal result and holds nothing afterwards', async () => {
    const { ctx, runtime, db } = await benchCtx()
    const result = await runAndPersistBenchmark(ctx)
    expect(getSettings(db).lastBenchmark?.ranAt).toBe(result.ranAt)
    expect(runtime.occupancy.isBusy()).toBe(false)
  })
})
