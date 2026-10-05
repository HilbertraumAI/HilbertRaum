import { describe, it, expect, vi, beforeEach } from 'vitest'

// Skill-whole-doc engine, Follow-up B — the CHAT wiring for a 2-document compare: `askDocuments`
// routes a compare-shaped question for the `grounded-whole-doc-compare` skill (what-changed) to a
// MODEL answer over BOTH documents read whole (budget split, capped coverage, fence applied), REFUSES
// when either doc is not fully chunked (a 1- or 3-doc scope gets the "select exactly two" answer in
// rag-skill-analysis.test.ts).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  app: { getVersion: () => '0.0.0-test' }
}))

import { IPC } from '../../src/shared/ipc'
import type { Message } from '../../src/shared/types'
import { createConversation } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { registerBuiltinSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import type { Db } from '../../src/main/services/db'
import { t } from '../../src/shared/i18n'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { writeSkillPackage } from '../helpers/skill-fixtures'
import { recordingRuntime, type RecordingRuntime } from '../helpers/scripted-runtime'
import { ingestTextFile, makeRagAskContext, makeSkillsWorld } from '../helpers/skills-world'

const handlers = ipcState.handlers as unknown as IpcHandlers
const WHAT_CHANGED_INSTALL_ID = 'app:what-changed'

// A real version pair: same wording except the amounts/terms — the diff-driven compare path.
const VERSION_A = 'Service fee is 100 EUR per month. Term: 12 months. Cancellation notice: 30 days.'
const VERSION_B = 'Service fee is 120 EUR per month. Term: 24 months. Cancellation notice: 60 days.'
// A pair with NO shared wording — the diff is abandoned and the whole-doc-compare read runs.
const REWRITE_A = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike'
const REWRITE_B = 'one two three four five six seven eight nine ten eleven twelve thirteen'

function writeWhatChangedSkill(appSkillsDir: string): void {
  writeSkillPackage(appSkillsDir, {
    id: 'what-changed',
    title: 'What Changed?',
    description: 'Compare two versions.',
    kind: 'instruction',
    body: 'Compare the two versions and report the material changes that matter, in business language.'
  })
}

interface Harness {
  db: Db
  conversationId: (docIds: string[]) => string
  docA: string
  docB: string
  mk: (name: string, text: string) => Promise<string>
  runtime: RecordingRuntime
}

async function makeHarness(opts: { bothFullyChunked?: boolean } = {}): Promise<Harness> {
  const w = makeSkillsWorld('wholedoccompare', {
    seedApp: writeWhatChangedSkill,
    appVersion: '0.0.0-test',
    reconcile: true
  })
  const { db } = w

  const mk = (name: string, text: string): Promise<string> => ingestTextFile(w, name, text)
  const docA = await mk('v1.txt', VERSION_A)
  const docB = await mk('v2.txt', VERSION_B)
  if (opts.bothFullyChunked === false) {
    db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(docB)
  }

  const runtime = recordingRuntime('Material changes: fee 100→120, term 12→24, notice 30→60.')

  const { ctx } = makeRagAskContext(w, runtime)

  registerBuiltinSkillAnalysisHandlers()
  registerRagIpc(ctx)
  const conversationId = (docIds: string[]): string =>
    createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: docIds } }).id
  return { db, conversationId, docA, docB, mk, runtime }
}

beforeEach(() => {
  inFlightStreams.clear()
})

describe('askDocuments — grounded-whole-doc-compare routing (what-changed, Follow-up B)', () => {
  it('diff path: the EXACT changes reach the model (not two walls of text), capped coverage, cited, stamped', async () => {
    const h = await makeHarness({ bothFullyChunked: true })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([h.docA, h.docB]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const msg = result as Message

    expect(h.runtime.calls).toBe(1)
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    // The model is handed the deterministic change list — the exact changed values, not two whole
    // documents. A one-word change here cannot be missed because it is spelled out. The diff runs A→B
    // by import order; the prompt labels the pair by title + import date and must NEVER assert which is
    // the old/new version (audit §5.1) — an inverted guess would flip the whole report.
    expect(userTurn).toContain('deterministic word-level comparison')
    expect(userTurn).toContain('100')
    expect(userTurn).toContain('120')
    expect(userTurn).toMatch(/~~(100|120)~~ \*\*(120|100)\*\*/) // redline shows the exact swap
    expect(userTurn).toContain('v1.txt') // both documents labelled by title + import date…
    expect(userTurn).toContain('v2.txt')
    expect(userTurn).toMatch(/Document A: ".+" \(imported \d{4}-\d\d-\d\d\)/)
    expect(userTurn).toMatch(/Document B: ".+" \(imported \d{4}-\d\d-\d\d\)/)
    expect(userTurn).not.toMatch(/old version|new version/i) // …never asserting old→new
    // The SKILL.md fence rode in the compare user turn.
    expect(userTurn).toContain('material changes')
    // Honest breadth: the diff examined the WHOLE of both documents → capped/not-truncated.
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    // Citations point at the change locations in BOTH documents; the skill is stamped.
    expect(msg.citations && msg.citations.length).toBeGreaterThanOrEqual(2)
    expect(msg.skillId).toBe(WHAT_CHANGED_INSTALL_ID)
    expect(msg.autoFired).toBe(false)
  })

  it('labels the compare pair in deterministic import order — not DB insertion order (§5.1/§4.6)', async () => {
    const h = await makeHarness({ bothFullyChunked: true })
    // Insert two versions, then force created_at so import order is the REVERSE of insertion (rowid)
    // order. The old private query had no ORDER BY → it returned rowid order, so which document was
    // "A" was undefined (a user who imported the newer contract first got every addition reported as a
    // removal). The shared helper orders by created_at,id, so the EARLIER-imported doc is always
    // Document A — deterministic, and the prompt never claims it is the older/newer version.
    const insertedFirst = await h.mk('inserted-first.txt', VERSION_A)
    const insertedSecond = await h.mk('inserted-second.txt', VERSION_B)
    h.db.prepare('UPDATE documents SET created_at = ? WHERE id = ?').run('2001-01-01T00:00:00.000Z', insertedSecond)
    h.db.prepare('UPDATE documents SET created_at = ? WHERE id = ?').run('2002-01-01T00:00:00.000Z', insertedFirst)
    await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([insertedFirst, insertedSecond]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    // The earlier-imported document (inserted SECOND) is Document A; the later one is Document B —
    // independent of insertion order, and with no old/new claim.
    expect(userTurn).toContain('Document A: "inserted-second.txt" (imported 2001-01-01)')
    expect(userTurn).toContain('Document B: "inserted-first.txt" (imported 2002-01-01)')
    expect(userTurn).not.toMatch(/old version|new version/i)
  })

  it('identical documents: the model is told they are identical (not asked to eyeball two walls)', async () => {
    const h = await makeHarness({ bothFullyChunked: true })
    const same = await h.mk('same.txt', VERSION_A)
    const sameCopy = await h.mk('same-copy.txt', VERSION_A)
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([same, sameCopy]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const msg = result as Message
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    expect(userTurn).toContain('textually identical')
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
  })

  it('a full rewrite (no shared wording) falls back to the labelled whole-doc-compare read', async () => {
    const h = await makeHarness({ bothFullyChunked: true })
    const a = await h.mk('rewrite-a.txt', REWRITE_A)
    const b = await h.mk('rewrite-b.txt', REWRITE_B)
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([a, b]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const msg = result as Message
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    // The diff was abandoned (no shared content) → the two documents are presented as labelled blocks,
    // named A/B by title + import date with no old/new assertion (audit §5.1).
    expect(userTurn).toContain('rewrite-a.txt')
    expect(userTurn).toContain('rewrite-b.txt')
    expect(userTurn).toMatch(/Document A: ".+" \(imported \d{4}-\d\d-\d\d\)/)
    expect(userTurn).toMatch(/Document B: ".+" \(imported \d{4}-\d\d-\d\d\)/)
    expect(userTurn).not.toContain('deterministic word-level comparison')
    expect(userTurn).not.toMatch(/old version|new version/i)
    expect(msg.coverage?.mode).toBe('capped')
  })

  it('refuse path: a not-fully-chunked doc in the pair is refused — fixed message, no model call', async () => {
    const h = await makeHarness({ bothFullyChunked: false })
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([h.docA, h.docB]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const msg = result as Message
    expect(msg.content).toBe(t('en', 'skills.analysis.refusePartial'))
    expect(h.runtime.calls).toBe(0)
    expect(msg.coverage).toBeUndefined()
  })

  it('a PARTIAL compare half prints its own beginning-only notice in the prompt (audit §2.2)', async () => {
    const h = await makeHarness({ bothFullyChunked: true })
    // A large document A with NO shared wording with B: the diff is abandoned → the labelled
    // whole-doc-compare read runs, and A's split-budget half overflows → only A is partial.
    const bigA = Array.from(
      { length: 300 },
      (_, i) => `Zeile ${i}: einzigartiger Vermerk alpha${i} beta${i} gamma${i} delta${i} epsilon${i}.`
    ).join('\n')
    const a = await h.mk('big-a.txt', bigA)
    const b = await h.mk('tiny-b.txt', 'kurzer text ohne gemeinsame woerter')
    const { result } = await invoke(
      handlers,
      IPC.askDocuments,
      h.conversationId([a, b]),
      'what changed between these two versions?',
      WHAT_CHANGED_INSTALL_ID
    )
    const msg = result as Message
    const userTurn = h.runtime.lastMessages.find((m) => m.role === 'user')?.content ?? ''
    // Fell back to the labelled whole-doc-compare read (not the diff), and A overflowed its half.
    expect(userTurn).not.toContain('deterministic word-level comparison')
    expect(userTurn).toContain('PARTIAL Document A')
    expect(userTurn).toContain('did not fit and were NOT provided')
    // The small document B FIT its half → it must carry NO partial notice (per-half gating, not global).
    expect(userTurn).not.toContain('PARTIAL Document B')
    // A's notice uses A's OWN per-half counts (covered < total), and that total is strictly below the
    // SUMMED whole-doc total — proving the notice reports per-half numbers, not the compare-wide sum.
    const partialA = userTurn.match(/the first (\d+) of (\d+) sections/)
    expect(partialA).not.toBeNull()
    const coveredA = Number(partialA![1])
    const totalA = Number(partialA![2])
    expect(coveredA).toBeLessThan(totalA)
    expect(totalA).toBeLessThan(msg.coverage?.chunksTotal ?? Infinity)
    // Honest coverage: truncated because a half overflowed.
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(true)
  })
})
