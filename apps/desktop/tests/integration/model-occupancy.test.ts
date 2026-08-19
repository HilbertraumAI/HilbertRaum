import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ModelOccupancy, modelBusyMessageKey } from '../../src/main/services/runtime/occupancy'
import { RuntimeManager } from '../../src/main/services/runtime'
import type { ModelRuntime } from '../../src/main/services/runtime'
import { modelBusyLane } from '../../src/main/ipc/model-busy'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { assertChatStreamReady } from '../../src/main/ipc/chat-stream'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createConversation } from '../../src/main/services/chat'
import { DocTaskManager } from '../../src/main/services/doctasks'
import {
  createQueuedDocument,
  documentsDir,
  processDocument
} from '../../src/main/services/ingestion'
import { runBenchmark, measureTokensPerSecond } from '../../src/main/services/benchmark'
import { SKILL_TOOL_DESCRIPTORS, getToolDescriptor } from '../../src/shared/skill-tools'
import { t } from '../../src/shared/i18n'
import type { AppContext } from '../../src/main/services/context'
import type { OccupancyLane } from '../../src/main/services/runtime/occupancy'

// Issues #185/#186 — the shared model-occupancy span (architecture.md "Model occupancy —
// design record"). Both issues were the same defect seen from two sides: the local-API wave's
// generation gate made every lane that reaches `chatStream` VISIBLE, and that visibility showed
// that the benchmark had no guard at all (#185) and that a skill run's LLM locate pass could
// generate beside a chat answer (#186).
//
// The gate itself could not be the fix: it counts in-flight PULLS, so a multi-step job reads
// idle between two of its own model calls, and a guard riding it would admit a second job into
// that gap. These tests pin the span registry, the four guard seams that read it, and the two
// deliberate NON-guards (chat is never refused by the benchmark; a doc task never refuses on
// the doc-task span it holds itself).

const opts = { modelId: 'm', modelPath: '/m.gguf', contextTokens: 2048 }

/** A minimal runtime whose `chatStream` yields `tokens` — enough for the gate to see a pull. */
function fakeRuntime(tokens: string[] = ['hi']): ModelRuntime {
  return {
    modelId: 'm',
    async start() {},
    async stop() {},
    async health() {
      return { healthy: true, message: '', port: null }
    },
    async *chatStream() {
      for (const token of tokens) yield token
    }
  }
}

/** A started manager, so `active()` is non-null and `isExternallyBusy` is not fail-closed. */
async function startedManager(runtime: ModelRuntime = fakeRuntime()): Promise<RuntimeManager> {
  const mgr = new RuntimeManager(() => runtime)
  await mgr.start(opts)
  return mgr
}

/** A `modelBusyLane`-shaped context over a real manager + an optional doc-task probe. */
function busyCtx(mgr: RuntimeManager, hasActiveTask = false): AppContext {
  return { runtime: mgr, docTasks: { hasActiveTask: () => hasActiveTask } } as unknown as AppContext
}

beforeEach(() => {
  inFlightStreams.clear()
})

// ---- The registry ---------------------------------------------------------------

describe('ModelOccupancy (the span registry)', () => {
  it('reports a lane busy for exactly the life of its span', () => {
    const occ = new ModelOccupancy()
    expect(occ.isBusy()).toBe(false)
    expect(occ.held('benchmark')).toBe(false)

    const release = occ.begin('benchmark')
    expect(occ.isBusy()).toBe(true)
    expect(occ.held('benchmark')).toBe(true)
    expect(occ.held('skill-run')).toBe(false)

    release()
    expect(occ.isBusy()).toBe(false)
    expect(occ.held('benchmark')).toBe(false)
  })

  it('releases idempotently — a double release cannot under-count a concurrent span', () => {
    const occ = new ModelOccupancy()
    const first = occ.begin('skill-run')
    occ.begin('skill-run')
    first()
    first()
    first()
    // The second span is untouched: a leaked double-release must not free someone else's slot.
    expect(occ.held('skill-run')).toBe(true)
  })

  it('reports the OLDEST held lane, and honours `ignore`', () => {
    const occ = new ModelOccupancy()
    const releaseTask = occ.begin('doc-task')
    occ.begin('skill-run')

    expect(occ.heldLane()).toBe('doc-task')
    expect(occ.heldLane(['doc-task'])).toBe('skill-run')
    expect(occ.heldLane(['doc-task', 'skill-run'])).toBeNull()

    releaseTask()
    expect(occ.heldLane()).toBe('skill-run')
  })

  it('snapshot() is diagnostics-only and lists the held lanes oldest-first', () => {
    const occ = new ModelOccupancy()
    occ.begin('doc-task')
    occ.begin('benchmark')
    expect(occ.snapshot().map((s) => s.lane)).toEqual(['doc-task', 'benchmark'])
    for (const span of occ.snapshot()) expect(span.heldMs).toBeGreaterThanOrEqual(0)
  })

  it('gives every lane its own friendly refusal copy, in both catalogs', () => {
    const lanes: Array<'chat' | OccupancyLane> = ['chat', 'doc-task', 'skill-run', 'benchmark']
    const keys = lanes.map(modelBusyMessageKey)
    expect(new Set(keys).size).toBe(lanes.length)
    for (const key of keys) {
      expect(t('en', key).length).toBeGreaterThan(0)
      // A missing German value falls back to English (i18n D-L8) — pin that it is translated.
      expect(t('de', key)).not.toBe(t('en', key))
    }
  })
})

// ---- The external lane ----------------------------------------------------------

describe('RuntimeManager.isExternallyBusy folds the spans in (#185/#186)', () => {
  it('is busy while a background span is held, even with no generation in flight', async () => {
    const mgr = await startedManager()
    expect(mgr.isGenerating()).toBe(false)
    expect(mgr.isExternallyBusy()).toBe(false)

    const release = mgr.occupancy.begin('doc-task')
    // The gate still reads idle — this is exactly the gap a multi-step job leaves between two
    // of its model calls, and the gap an external request used to be admitted into.
    expect(mgr.isGenerating()).toBe(false)
    expect(mgr.isExternallyBusy()).toBe(true)

    release()
    expect(mgr.isExternallyBusy()).toBe(false)
  })

  it('a skill-run and a benchmark span each close external admission', async () => {
    const mgr = await startedManager()
    for (const lane of ['skill-run', 'benchmark'] as const) {
      const release = mgr.occupancy.begin(lane)
      expect(mgr.isExternallyBusy()).toBe(true)
      release()
      expect(mgr.isExternallyBusy()).toBe(false)
    }
  })
})

// ---- The composed predicate -----------------------------------------------------

describe('modelBusyLane (the composed answer)', () => {
  it('composes all four lanes from their own registries', async () => {
    const mgr = await startedManager()
    expect(modelBusyLane(busyCtx(mgr))).toBeNull()

    inFlightStreams.set('c1', new AbortController())
    expect(modelBusyLane(busyCtx(mgr))).toBe('chat')
    inFlightStreams.clear()

    // Queued OR running: the doc-task lane is read from `hasActiveTask`, not only its span,
    // so a task waiting in the queue still refuses a benchmark that would collide seconds later.
    expect(modelBusyLane(busyCtx(mgr, true))).toBe('doc-task')

    const release = mgr.occupancy.begin('skill-run')
    expect(modelBusyLane(busyCtx(mgr))).toBe('skill-run')
    release()

    const releaseBench = mgr.occupancy.begin('benchmark')
    expect(modelBusyLane(busyCtx(mgr))).toBe('benchmark')
    releaseBench()
    expect(modelBusyLane(busyCtx(mgr))).toBeNull()
  })

  it('`ignore` excludes a lane through BOTH halves — including a doc task holding a span', async () => {
    const mgr = await startedManager()
    const release = mgr.occupancy.begin('doc-task')
    expect(modelBusyLane(busyCtx(mgr, true))).toBe('doc-task')
    // Ignoring the lane must silence the span half too, or the option would not work at all.
    expect(modelBusyLane(busyCtx(mgr, true), { ignore: ['doc-task'] })).toBeNull()
    release()
  })

  it('the benchmark does NOT ignore its own lane — that read IS the re-entrancy guard', async () => {
    const mgr = await startedManager()
    const release = mgr.occupancy.begin('benchmark')
    expect(modelBusyLane(busyCtx(mgr))).toBe('benchmark')
    release()
  })

  // (Title wording avoids the two-word phrase the F-41 cast ratchet greps for.)
  it('reports idle when the runtime/doc-task registries are unwired (partial test contexts)', () => {
    expect(modelBusyLane({} as unknown as AppContext)).toBeNull()
  })
})

// ---- Chat (#186, the direction that protects the user's turn) -------------------

describe('assertChatStreamReady vs a model-lane skill run (#186)', () => {
  let db: Db
  let conversationId: string

  beforeEach(() => {
    db = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-occ-chat-')), 'test.sqlite'))
    conversationId = createConversation(db, { mode: 'chat' }).id
  })

  function chatCtx(mgr: RuntimeManager): AppContext {
    return { db, runtime: mgr, docTasks: undefined } as unknown as AppContext
  }

  it('refuses a chat turn while a direct skill run holds the model', async () => {
    const mgr = await startedManager()
    const release = mgr.occupancy.begin('skill-run')
    await expect(assertChatStreamReady(chatCtx(mgr), conversationId)).rejects.toThrow(
      t('en', 'main.busy.skillRun')
    )
    release()
    // …and admits it again the moment the run ends.
    await expect(assertChatStreamReady(chatCtx(mgr), conversationId)).resolves.toBeTruthy()
  })

  it('does NOT refuse a chat turn for the benchmark — the benchmark yields to chat instead', async () => {
    const mgr = await startedManager()
    const release = mgr.occupancy.begin('benchmark')
    // The first-run benchmark fires right after unlock; refusing the user's first message
    // there would be a regression, so this lane is deliberately absent from the chat guard.
    await expect(assertChatStreamReady(chatCtx(mgr), conversationId)).resolves.toBeTruthy()
    release()
  })

  it('does not read the doc-task SPAN — the pre-existing yielding-build exception is untouched', async () => {
    const mgr = await startedManager()
    const release = mgr.occupancy.begin('doc-task')
    // A yielding tree build holds this span while it cedes the slot to chat via the arbiter.
    // Reading the span here would refuse exactly the chat turn the handoff exists to allow.
    await expect(assertChatStreamReady(chatCtx(mgr), conversationId)).resolves.toBeTruthy()
    release()
  })
})

// ---- Doc tasks (#185/#186, the admission half) ----------------------------------

describe('DocTaskManager vs the occupancy spans', () => {
  let tmp: string
  let db: Db
  let storeDir: string
  let docId: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-occ-task-'))
    db = openDatabase(join(tmp, 'test.sqlite'))
    storeDir = documentsDir(join(tmp, 'workspace'))
    const file = join(tmp, 'doc.txt')
    writeFileSync(file, Array.from({ length: 400 }, (_, i) => `word${i}`).join(' '), 'utf8')
    const queued = createQueuedDocument(db, file)
    expect((await processDocument(db, storeDir, queued.id)).status).toBe('indexed')
    docId = queued.id
  })

  function makeManager(occ: ModelOccupancy, runtime: ModelRuntime | null = fakeRuntime()): DocTaskManager {
    return new DocTaskManager({
      getDb: () => db,
      getRuntime: () => runtime,
      getTranslator: () => null,
      isChatStreaming: () => false,
      getContextTokens: () => 4096,
      getStoreDir: () => storeDir,
      getIngestionDeps: () => ({}),
      beginDocumentWork: () => () => {},
      occupiedLane: () => {
        const lane = occ.heldLane(['doc-task'])
        return lane === 'doc-task' ? null : lane
      },
      beginOccupancy: () => occ.begin('doc-task')
    })
  }

  it('refuses a new task while a skill run or the benchmark holds the model', () => {
    const occ = new ModelOccupancy()
    const manager = makeManager(occ)

    const releaseSkill = occ.begin('skill-run')
    expect(() => manager.startDocTask({ kind: 'summary', documentIds: [docId] })).toThrow(
      t('en', 'main.busy.skillRun')
    )
    releaseSkill()

    const releaseBench = occ.begin('benchmark')
    expect(() => manager.startDocTask({ kind: 'summary', documentIds: [docId] })).toThrow(
      t('en', 'main.busy.benchmark')
    )
    releaseBench()

    // Nothing held ⇒ admitted as before.
    expect(manager.startDocTask({ kind: 'summary', documentIds: [docId] }).jobId).toBeTruthy()
  })

  it('does NOT refuse on the doc-task span it holds itself (the #38 tree→extract chain)', () => {
    const occ = new ModelOccupancy()
    const manager = makeManager(occ)
    // A running task holds this span; the chain enqueues its follow-up from inside `run()`,
    // still holding it. Refusing there would break the chain — task-vs-task is the queue's job.
    const release = occ.begin('doc-task')
    expect(manager.startDocTask({ kind: 'summary', documentIds: [docId] }).jobId).toBeTruthy()
    release()
  })

  it('holds a doc-task span for exactly the run, so the other lanes see a multi-step task', async () => {
    const occ = new ModelOccupancy()
    const seen: boolean[] = []
    // Sample occupancy from INSIDE the model call — the point of the span is that it covers the
    // whole dispatch, including the local work between two generations.
    const sampling: ModelRuntime = {
      ...fakeRuntime(),
      async *chatStream() {
        seen.push(occ.held('doc-task'))
        yield 'a summary of the document'
      }
    }
    const manager = makeManager(occ, sampling)
    expect(occ.held('doc-task')).toBe(false)

    const { jobId } = manager.startDocTask({ kind: 'summary', documentIds: [docId] })
    const deadline = Date.now() + 10_000
    for (;;) {
      const state = manager.getDocTask(jobId).state
      if (state === 'done' || state === 'failed' || state === 'cancelled') break
      if (Date.now() > deadline) throw new Error(`task never settled: ${state}`)
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
    // Released on the same `finally` that clears `runningId` — the span cannot outlive its task.
    expect(occ.held('doc-task')).toBe(false)
  })

  it('an unwired occupancy dep leaves the manager byte-identical (partial test deps)', () => {
    const manager = new DocTaskManager({
      getDb: () => db,
      getRuntime: () => fakeRuntime(),
      getTranslator: () => null,
      isChatStreaming: () => false,
      getContextTokens: () => 4096,
      getStoreDir: () => storeDir,
      getIngestionDeps: () => ({}),
      beginDocumentWork: () => () => {}
    })
    expect(manager.startDocTask({ kind: 'summary', documentIds: [docId] }).jobId).toBeTruthy()
  })
})

// ---- The benchmark's contended-probe discard (#185) -----------------------------

describe('the benchmark refuses to measure a contended model (#185)', () => {
  const workspacePath = (): string => mkdtempSync(join(tmpdir(), 'hilbertraum-occ-bench-'))

  it('skips the speed probe entirely when the model is already busy', async () => {
    let calls = 0
    const runtime: ModelRuntime = {
      ...fakeRuntime(),
      async *chatStream() {
        calls++
        yield 'x'
      }
    }
    const skipped: boolean[] = []
    const tps = await measureTokensPerSecond(runtime, {
      modelBusy: () => true,
      onBusySkip: () => skipped.push(true)
    })
    expect(tps).toBeNull()
    expect(calls).toBe(0) // never even reached the model
    expect(skipped).toEqual([true])
  })

  it('DISCARDS a reading that becomes contended mid-probe', async () => {
    let busy = false
    const runtime: ModelRuntime = {
      ...fakeRuntime(),
      async *chatStream() {
        yield 'one'
        busy = true // a chat turn starts while the 64-token probe streams
        yield 'two'
        yield 'three'
      }
    }
    let skipped = false
    const tps = await measureTokensPerSecond(runtime, {
      modelBusy: () => busy,
      onBusySkip: () => {
        skipped = true
      }
    })
    // A contended figure would be a shared slot measured as slow hardware — and a slow figure
    // steps the profile AND the recommendation down, persisted in settings.lastBenchmark.
    expect(tps).toBeNull()
    expect(skipped).toBe(true)
  })

  it('turns the discard into a visible warning, never a silent hole', async () => {
    const result = await runBenchmark({
      workspacePath: workspacePath(),
      manifests: [],
      runtime: fakeRuntime(),
      modelBusy: () => true
    })
    expect(result.tokensPerSecond).toBeNull()
    expect(result.measuredModelId).toBeNull()
    expect(result.warnings).toContain(t('en', 'main.benchmark.warnSpeedSkipped'))
  })

  it('stays silent when there was simply no runtime to measure (the long-standing case)', async () => {
    const result = await runBenchmark({
      workspacePath: workspacePath(),
      manifests: [],
      runtime: null,
      modelBusy: () => true
    })
    expect(result.tokensPerSecond).toBeNull()
    expect(result.warnings).not.toContain(t('en', 'main.benchmark.warnSpeedSkipped'))
  })

  it('measures normally with no `modelBusy` probe wired (every non-IPC caller)', async () => {
    const result = await runBenchmark({
      workspacePath: workspacePath(),
      manifests: [],
      runtime: fakeRuntime(['a', 'b', 'c'])
    })
    expect(result.tokensPerSecond).not.toBeNull()
    expect(result.warnings).not.toContain(t('en', 'main.benchmark.warnSpeedSkipped'))
  })
})

// ---- The descriptor-derived skill lane (#186) -----------------------------------

describe('skill tool model lanes are declared, not hand-listed (#186)', () => {
  it('declares exactly the two tools whose run streams on the chat runtime', () => {
    const direct = SKILL_TOOL_DESCRIPTORS.filter((d) => d.modelLane === 'direct').map((d) => d.name)
    expect(direct.sort()).toEqual(['apply_document_edits', 'redact_document'])
  })

  it('routes the categorizer through the doctask lane, so it takes no span of its own', () => {
    // D26: its model call happens inside a doc task it enqueues. A `skill-run` span here would
    // make `startDocTask` refuse the very task the run is waiting on.
    expect(getToolDescriptor('categorize_transactions')?.modelLane).toBe('doctask')
  })

  it('leaves every deterministic tool with no lane at all', () => {
    for (const d of SKILL_TOOL_DESCRIPTORS) {
      if (d.name === 'redact_document' || d.name === 'apply_document_edits') continue
      if (d.name === 'categorize_transactions') continue
      expect(d.modelLane, d.name).toBeUndefined()
    }
  })

  // The drift guard: `buildToolRunner` is a switch, so the ONE mechanical fact linking a tool to
  // the model is whether its case forwards `deps.runtime`. Pin that to the declaration — a tenth
  // tool that starts generating without declaring `modelLane: 'direct'` would otherwise silently
  // reopen #186 (it would take no span, and refuse nothing).
  it('pins the declaration to the dispatch: `deps.runtime` is forwarded only by `direct` tools', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/services/skills/tool-runs.ts'),
      'utf8'
    )
    // Split the dispatch into per-`case` blocks; the last block runs to the end of the switch.
    const blocks = source.split(/^\s*case '/m).slice(1)
    const forwarding = new Set<string>()
    for (const block of blocks) {
      const name = block.slice(0, block.indexOf("'"))
      if (/\bruntime:\s*deps\.runtime\b/.test(block)) forwarding.add(name)
    }
    expect(forwarding.size).toBeGreaterThan(0) // the scan actually found the dispatch
    const declared = SKILL_TOOL_DESCRIPTORS.filter((d) => d.modelLane === 'direct').map((d) => d.name)
    expect([...forwarding].sort()).toEqual(declared.sort())
  })
})
