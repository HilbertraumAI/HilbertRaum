import { describe, it, expect, vi, beforeEach } from 'vitest'

// Skill-whole-doc engine, Follow-up B — the CHAT wiring for a 2-document compare: `askDocuments`
// routes a compare-shaped question for the `grounded-whole-doc-compare` skill (what-changed) to a
// MODEL answer over BOTH documents read whole (budget split, capped coverage, fence applied), REFUSES
// when either doc is not fully chunked (a 1- or 3-doc scope gets the "select exactly two" answer in
// rag-skill-analysis.test.ts). #632: any other question at a 1- or 3-doc scope falls through to the
// ordinary grounded answer with paragraph 1 of the compare skill's fence only (the second describe below).
// #831: so does a fall-through turn of the four bundled whole-document skills (the third).

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

import { cpSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../../src/shared/ipc'
import type { Message } from '../../src/shared/types'
import { parseSkillMarkdown } from '../../src/shared/skill-manifest'
import { createConversation } from '../../src/main/services/chat'
import { registerRagIpc } from '../../src/main/ipc/registerRagIpc'
import { registerBuiltinSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { readLogTail } from '../../src/main/services/logging'
import type { Db } from '../../src/main/services/db'
import { t } from '../../src/shared/i18n'
import { chunkIdsOf, seedReadyTree } from '../helpers/doc-fixtures'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { REPO_APP_SKILLS_DIR, writeSkillPackage } from '../helpers/skill-fixtures'
import { recordingRuntime, type RecordingRuntime } from '../helpers/scripted-runtime'
import { ingestTextFile, makeRagAskContext, makeSkillsWorld } from '../helpers/skills-world'
import { asPreRequestMapPrompt } from '../helpers/whole-doc-fixtures'

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

  // #649: both documents are read whole, so a total asked of them leads with the arithmetic heads-up
  // (design-guidelines §11.24); an ordinary compare (above) carries none.
  it.each([
    { question: 'what changed in the total fees between these two versions?', total: true },
    { question: 'what changed between these two versions?', total: false }
  ])('the arithmetic heads-up leads a compare of totals only — $question', async ({ question, total }) => {
    const h = await makeHarness({ bothFullyChunked: true })
    const { result } = await invoke(handlers, IPC.askDocuments, h.conversationId([h.docA, h.docB]), question, WHAT_CHANGED_INSTALL_ID)
    const msg = result as Message
    expect(h.runtime.calls).toBe(1)
    expect(msg.skillId).toBe(WHAT_CHANGED_INSTALL_ID)
    expect(msg.content.startsWith(t('en', 'analysis.wholeReadSumHint'))).toBe(total)
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
    // #643: the diff shows the model change lines, not the sections — provenance, not labelled excerpts.
    expect(msg.coverage?.labelledExcerpts).toBeUndefined()
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
    // #643: both documents' sections were shown under their [Sn] labels.
    expect(msg.coverage?.labelledExcerpts).toBe(true)
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

// ---- #632: a compare skill's fall-through turn (open-issues wave owner call G-1, option A; owner round WB2-1) ----
// With What Changed? picked, a question that is not a compare request at a scope of other than two documents
// falls through to the ordinary grounded answer (a compare request gets "select exactly two" instead:
// rag-skill-analysis.test.ts). The model sees ordinary passages there, with no A/B labels and no diff, so the
// fence carries paragraph 1 only — the heading + honesty rules — and not the section format a 4B followed even
// on "Wer ist der Mieter?". The answer stays stamped. Bundled skills only: a user skill declaring
// `analysis: compare` keeps its whole fence (its paragraph 1 is whatever its author wrote). Run on the COMMITTED
// SKILL.md bodies: the shipped what-changed keeps "Produce the answer in this order" after paragraph 1. These
// rows prove "paragraph 1 only"; that paragraph 1 holds the honesty rules (SKA-15) is the skills-skillmd-parity
// suite's to pin.

const USER_COMPARE_INSTALL_ID = 'user:version-check'
const USER_COMPARE_BODY = [
  '# Version check\nRules: answer only from the documents.',
  'Produce a table of every change.',
  'End with the open questions.'
].join('\n\n')
/** A user instruction skill with NO analysis engine (no `analysis:`): fence-only, no handler at all. */
const USER_PLAIN_INSTALL_ID = 'user:plain-notes'
const USER_PLAIN_BODY = ['# Plain notes\nRules: quote the documents.', 'Produce three bullet points.', 'End with a question.'].join(
  '\n\n'
)
/** #831: a user instruction skill declaring `analysis: whole-doc` (the manifest fallback, no vocabulary). */
const USER_WHOLE_DOC_INSTALL_ID = 'user:lease-digest'
const USER_WHOLE_DOC_BODY = [
  '# Lease digest\nRules: answer only from the document.',
  'Produce a digest with five headings.',
  'End with the open points.'
].join('\n\n')
/** #831: the four bundled skills with the `grounded-whole-doc` engine. */
const WHOLE_DOC_SKILLS = ['contract-brief', 'meeting-protocol', 'share-safe-review', 'deadline-obligation-finder'] as const

const lease = (version: number, months: number, rent: string): string =>
  [
    `Draft version ${version}`,
    'Lease agreement between Anna Berger (landlord) and Max Huber (tenant).',
    `Term: ${months} months.`,
    `Monthly rent: EUR ${rent}.`,
    'Notice period: three months.'
  ].join('\n')
const LEASE_DRAFTS = [lease(1, 24, '2,400'), lease(2, 36, '2,550'), lease(3, 36, '2,500')]

/** A skill body's paragraphs, split as the fence counts them (blank-line separated). */
const paragraphsOf = (body: string): string[] =>
  body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

const committedBody = (id: string): string =>
  parseSkillMarkdown(readFileSync(join(REPO_APP_SKILLS_DIR, id, 'SKILL.md'), 'utf8')).body!
const BODIES: Record<string, string> = {
  [WHAT_CHANGED_INSTALL_ID]: committedBody('what-changed'),
  ...Object.fromEntries(WHOLE_DOC_SKILLS.map((id) => [`app:${id}`, committedBody(id)])),
  [USER_COMPARE_INSTALL_ID]: USER_COMPARE_BODY,
  [USER_PLAIN_INSTALL_ID]: USER_PLAIN_BODY,
  [USER_WHOLE_DOC_INSTALL_ID]: USER_WHOLE_DOC_BODY
}

interface FenceHarness {
  db: Db
  conversationId: string
  docIds: string[]
  runtime: RecordingRuntime
}

async function makeFenceHarness(texts: string[], contextWindow = 8192): Promise<FenceHarness> {
  const w = makeSkillsWorld('compare632', {
    seedApp: (d) => {
      for (const id of ['what-changed', ...WHOLE_DOC_SKILLS]) cpSync(join(REPO_APP_SKILLS_DIR, id), join(d, id), { recursive: true })
    },
    seedUser: (d) => {
      writeSkillPackage(d, {
        id: 'version-check',
        title: 'Version check',
        kind: 'instruction',
        analysis: 'compare',
        body: USER_COMPARE_BODY
      })
      writeSkillPackage(d, { id: 'plain-notes', title: 'Plain notes', kind: 'instruction', body: USER_PLAIN_BODY })
      writeSkillPackage(d, {
        id: 'lease-digest',
        title: 'Lease digest',
        kind: 'instruction',
        analysis: 'whole-doc',
        body: USER_WHOLE_DOC_BODY
      })
    },
    // No appVersion: the committed SKILL.md files declare a minAppVersion the test version would fail.
    reconcile: true
  })
  // A user skill is reconciled disabled until its import warning is acknowledged; the engine is under test here.
  w.db.prepare("UPDATE skills SET enabled = 1 WHERE source = 'user'").run()
  const docIds: string[] = []
  for (const [i, text] of texts.entries()) docIds.push(await ingestTextFile(w, `lease-draft-${i + 1}.txt`, text))
  const runtime = recordingRuntime('The tenant is Max Huber.', { contextWindow })
  registerBuiltinSkillAnalysisHandlers()
  registerRagIpc(makeRagAskContext(w, runtime).ctx)
  const conv = createConversation(w.db, { mode: 'documents', scope: { collectionIds: [], documentIds: docIds } })
  return { db: w.db, conversationId: conv.id, docIds, runtime }
}

/** The skill instructions each model call saw (between the fence's label and its END line), call by call. */
function fenceBodies(rt: RecordingRuntime): string[] {
  return rt.turns.map((turn) => {
    const user = turn.filter((m) => m.role === 'user').at(-1)?.content ?? ''
    const match = user.match(/\nSkill instructions:\n([\s\S]*?)\n--- END LOCAL SKILL ---/)
    return match ? match[1] : '(no fence)'
  })
}

/** The first-paragraph-cap lines (`logSkillFenceReduction`) the local log holds for this skill so far. */
const capLogCount = (skillId: string): number =>
  readLogTail(100_000).filter((l) => l.includes('capped to its first paragraph') && l.includes(`"skillId":"${skillId}"`)).length

async function ask(h: FenceHarness, question: string, skillId: string): Promise<Message> {
  return (await invoke(handlers, IPC.askDocuments, h.conversationId, question, skillId)).result as Message
}

const ONE_DRAFT = LEASE_DRAFTS.slice(0, 1)
const TWO_DRAFTS = LEASE_DRAFTS.slice(0, 2)
const TENANT = 'Wer ist der Mieter?'
// Two drafts that close with thanks, so top-k finds a passage for a thank-you and the model is called.
const THANKING_DRAFTS = TWO_DRAFTS.map((d) => `${d}\nVielen Dank für Ihre Zusammenarbeit.`)

describe("askDocuments — the bundled compare skill's fall-through turn carries paragraph 1 of its fence (#632)", () => {
  // Small talk over two documents falls through too (`applies()` opts small talk out of the compare engine), so
  // its top-k answer also gets paragraph 1: the one two-document prompt #632 changes.
  it.each([
    { name: 'what-changed over one document', skillId: WHAT_CHANGED_INSTALL_ID, texts: ONE_DRAFT, question: TENANT },
    { name: 'what-changed over three documents', skillId: WHAT_CHANGED_INSTALL_ID, texts: LEASE_DRAFTS, question: TENANT },
    { name: 'what-changed, small talk over two documents', skillId: WHAT_CHANGED_INSTALL_ID, texts: THANKING_DRAFTS, question: 'Vielen Dank!' }
  ])('$name: the heading + honesty rules only, and the answer is still stamped', async ({ skillId, texts, question }) => {
    const h = await makeFenceHarness(texts)
    const logged = capLogCount(skillId)
    const msg = await ask(h, question, skillId)
    expect(h.runtime.calls).toBe(1)
    expect(fenceBodies(h.runtime)).toEqual([paragraphsOf(BODIES[skillId])[0]])
    expect(capLogCount(skillId) - logged).toBe(1)
    expect(fenceBodies(h.runtime).join('\n')).not.toContain('Produce ')
    expect(msg.content).toBe('The tenant is Max Huber.')
    expect(msg.skillId).toBe(skillId)
  })

  // The other place a fall-through answer builds the fence: a summary ask over one document too large to read
  // whole, whose deep index is ready, is answered by the tree map-reduce (#642). Three long sections span
  // several windows at this size, so map calls run before the reduce. (A fold needs more windows than the map
  // ceiling and long notes; it reads the same `skillFence` the map and reduce calls read.)
  it('a summary from a ready deep index: every map call and the reduce carry paragraph 1 only', async () => {
    const big = Array.from({ length: 700 }, (_, i) => `Clause ${i + 1}: the tenant Max Huber pays EUR 2,400.`).join('\n')
    const h = await makeFenceHarness([big], 4096)
    const section = (n: number): string => `Section ${n}: ${'the tenant Max Huber pays the rent on time '.repeat(130)}`
    seedReadyTree(h.db, h.docIds[0], chunkIdsOf(h.db, h.docIds[0]), {
      summary: 'Summary: a lease with Max Huber.',
      sections: [section(1), section(2), section(3)]
    })
    const logged = capLogCount(WHAT_CHANGED_INSTALL_ID)
    const msg = await ask(h, 'Fasse dieses Dokument zusammen', WHAT_CHANGED_INSTALL_ID)
    expect(msg.coverage?.mode).toBe('tree')
    expect(capLogCount(WHAT_CHANGED_INSTALL_ID) - logged).toBe(1)
    expect(h.runtime.calls).toBeGreaterThanOrEqual(3)
    const firstParagraph = paragraphsOf(BODIES[WHAT_CHANGED_INSTALL_ID])[0]
    expect(fenceBodies(h.runtime)).toEqual(Array(h.runtime.calls).fill(firstParagraph))
    expect(msg.skillId).toBe(WHAT_CHANGED_INSTALL_ID)
  })

  // Two documents: the compare engine runs for any question but small talk (A3), with the whole fence, on the
  // diff path and on the labelled whole-document read of a rewrite — the prompts #632 leaves byte-identical
  // (checked once against master's capture when it landed).
  it.each([
    { name: 'the diff of two drafts, "Was hat sich geändert?"', texts: TWO_DRAFTS, question: 'Was hat sich geändert?', diff: true },
    { name: 'the diff of two drafts, "Wer ist der Mieter?"', texts: TWO_DRAFTS, question: TENANT, diff: true },
    { name: 'a rewrite, read whole and labelled', texts: [REWRITE_A, REWRITE_B], question: 'Was hat sich geändert?', diff: false }
  ])('two documents ($name): the compare engine, with the whole fence', async ({ texts, question, diff }) => {
    const h = await makeFenceHarness(texts)
    const msg = await ask(h, question, WHAT_CHANGED_INSTALL_ID)
    expect(h.runtime.calls).toBe(1)
    const prompt = JSON.stringify(h.runtime.turns)
    expect(prompt).toContain('Document A: \\"lease-draft-')
    expect(prompt.includes('deterministic word-level comparison')).toBe(diff)
    expect(fenceBodies(h.runtime)).toEqual([paragraphsOf(BODIES[WHAT_CHANGED_INSTALL_ID]).join('\n\n')])
    expect(msg.skillId).toBe(WHAT_CHANGED_INSTALL_ID)
  })

  // A user compare skill, a user whole-document skill and one with no handler at all (fence only): the reduction is
  // for the bundled skills only (owner round WB2-1), so a user one keeps its whole fence. (#831 gave the four bundled
  // whole-document skills the reduction too: the describe below.)
  it.each([
    { name: 'a user skill declaring analysis: compare, one document', skillId: USER_COMPARE_INSTALL_ID, texts: ONE_DRAFT, mode: 'capped' },
    { name: 'a user skill declaring analysis: whole-doc, three documents', skillId: USER_WHOLE_DOC_INSTALL_ID, texts: LEASE_DRAFTS, mode: 'relevance' },
    { name: 'a user skill with no analysis engine, one document', skillId: USER_PLAIN_INSTALL_ID, texts: ONE_DRAFT, mode: 'capped' }
  ])("another skill's fall-through keeps its whole fence ($name)", async ({ skillId, texts, mode }) => {
    const h = await makeFenceHarness(texts)
    const logged = capLogCount(skillId)
    const msg = await ask(h, TENANT, skillId)
    expect(msg.coverage?.mode).toBe(mode)
    expect(capLogCount(skillId) - logged).toBe(0)
    expect(fenceBodies(h.runtime)).toEqual([paragraphsOf(BODIES[skillId]).join('\n\n')])
    expect(msg.skillId).toBe(skillId)
  })
})

// ---- #831: a bundled whole-document skill's fall-through turn (follow-ups wave 4 owner call G-9) ----
// Contract Brief, Meeting Minutes, Share-Safe Review and Deadline & Obligation Finder read ONE document whole. Three
// kinds of turn go to the ordinary grounded answer instead: a question outside the skill's vocabulary over several
// documents, small talk, and a single-fact question over a document too long to read whole (the needle downgrade:
// the engine applied, then sent the question to the passage search). Like What Changed? since #632, each gets
// paragraph 1 of the fence only, the heading + rules, and not the section format that a 4B followed there on 11 of
// 16 plain questions. The engine's own reads keep the whole fence. Run on the COMMITTED SKILL.md bodies, each of
// which carries "Produce the … in this order" after paragraph 1.

/** A lease too long to read whole at a 4,096 window, with its notice period in the last line. */
const LONG_LEASE = [
  ...Array.from({ length: 700 }, (_, i) => `Clause ${i + 1}: the tenant Max Huber pays EUR 2,400 on the first day of each month.`),
  'Notice period: three months, to the end of a calendar quarter.'
].join('\n')
const appId = (id: string): string => `app:${id}`

describe("askDocuments — a bundled whole-document skill's fall-through turn carries paragraph 1 of its fence (#831)", () => {
  it.each(WHOLE_DOC_SKILLS)('%s over three documents, a question outside its vocabulary: paragraph 1 only, stamped', async (id) => {
    const h = await makeFenceHarness(LEASE_DRAFTS)
    const logged = capLogCount(appId(id))
    const msg = await ask(h, TENANT, appId(id))
    expect(h.runtime.calls).toBe(1)
    expect(msg.coverage?.mode).toBe('relevance')
    expect(fenceBodies(h.runtime)).toEqual([paragraphsOf(BODIES[appId(id)])[0]])
    expect(fenceBodies(h.runtime).join('\n')).not.toContain('Produce ')
    expect(capLogCount(appId(id)) - logged).toBe(1)
    expect(msg.skillId).toBe(appId(id))
  })

  it.each(WHOLE_DOC_SKILLS)('%s, small talk over one document: paragraph 1 only, stamped', async (id) => {
    const h = await makeFenceHarness(THANKING_DRAFTS.slice(0, 1))
    const logged = capLogCount(appId(id))
    const msg = await ask(h, 'Vielen Dank!', appId(id))
    expect(h.runtime.calls).toBe(1)
    expect(fenceBodies(h.runtime)).toEqual([paragraphsOf(BODIES[appId(id)])[0]])
    expect(capLogCount(appId(id)) - logged).toBe(1)
    expect(msg.skillId).toBe(appId(id))
  })

  it.each(WHOLE_DOC_SKILLS)(
    '%s, a single-fact question over a document too long to read whole: the passage search, paragraph 1 only',
    async (id) => {
      const h = await makeFenceHarness([LONG_LEASE], 4096)
      const logged = capLogCount(appId(id))
      const msg = await ask(h, 'When is the notice period?', appId(id))
      expect(h.runtime.calls).toBe(1)
      expect(msg.coverage?.mode).toBe('relevance')
      expect(fenceBodies(h.runtime)).toEqual([paragraphsOf(BODIES[appId(id)])[0]])
      expect(capLogCount(appId(id)) - logged).toBe(1)
      expect(msg.skillId).toBe(appId(id))
    }
  )

  // The engine's own reads: a deliverable over the same long document (the chunk map-reduce) and any question over
  // one document that fits (one whole read). Both carry the whole fence on every call, as before #831.
  it('contract-brief, a summary of a document too long to read whole: the whole fence on every map and reduce call', async () => {
    const h = await makeFenceHarness([LONG_LEASE], 4096)
    const logged = capLogCount(appId('contract-brief'))
    const msg = await ask(h, 'Summarize this contract', appId('contract-brief'))
    expect(msg.coverage?.mode).toBe('capped')
    expect(msg.coverage?.truncated).toBe(false)
    expect(h.runtime.calls).toBeGreaterThan(2)
    const wholeFence = paragraphsOf(BODIES[appId('contract-brief')]).join('\n\n')
    expect(fenceBodies(h.runtime)).toEqual(Array(h.runtime.calls).fill(wholeFence))
    expect(capLogCount(appId('contract-brief')) - logged).toBe(0)
    expect(msg.skillId).toBe(appId('contract-brief'))
  })

  it('contract-brief, one document that fits: the whole-document read, with the whole fence', async () => {
    const h = await makeFenceHarness(ONE_DRAFT)
    const logged = capLogCount(appId('contract-brief'))
    const msg = await ask(h, TENANT, appId('contract-brief'))
    expect(h.runtime.calls).toBe(1)
    expect(msg.coverage?.mode).toBe('capped')
    expect(fenceBodies(h.runtime)).toEqual([paragraphsOf(BODIES[appId('contract-brief')]).join('\n\n')])
    expect(capLogCount(appId('contract-brief')) - logged).toBe(0)
    expect(msg.skillId).toBe(appId('contract-brief'))
  })

  // A user skill declaring `analysis: whole-doc` keeps its whole fence on the needle downgrade too (bundled only).
  it('a user whole-document skill, a single-fact question over a document too long to read whole: the whole fence', async () => {
    const h = await makeFenceHarness([LONG_LEASE], 4096)
    const logged = capLogCount(USER_WHOLE_DOC_INSTALL_ID)
    const msg = await ask(h, 'When is the notice period?', USER_WHOLE_DOC_INSTALL_ID)
    expect(h.runtime.calls).toBe(1)
    expect(msg.coverage?.mode).toBe('relevance')
    expect(fenceBodies(h.runtime)).toEqual([paragraphsOf(USER_WHOLE_DOC_BODY).join('\n\n')])
    expect(capLogCount(USER_WHOLE_DOC_INSTALL_ID) - logged).toBe(0)
    expect(msg.skillId).toBe(USER_WHOLE_DOC_INSTALL_ID)
  })
})

// ---- #939: which whole-document reads take notes for the question (follow-ups wave 4, owner call 2026-11-20) ----
// Over a document too long for one call, the map step used to take notes for the skill's task only, so "Find every
// mention of 'indemnity'" under Contract Brief was answered from notes for a brief (master: 1 of 3 and 0 of 3 indemnity
// articles). A list-shaped question (the router's own list detection, `asksForList`) under a bundled whole-document
// skill now rides every map call; every other question keeps the map prompt as it was, byte for byte, because the
// ungated version cost Meeting Minutes facts in the real-model check.

/** A meeting record too long to read whole at a 4,096 window, with the next meeting in its last line. */
const LONG_MEETING = [
  ...Array.from({ length: 600 }, (_, i) => `Item ${i + 1}: Anna Berg and Tomasz Nowak discussed the website budget and the hosting contract.`),
  'The next meeting will take place on Tuesday, 19 May 2026.'
].join('\n')
/** The map turns of a map-reduce answer: every call but the last (the reduce). */
const mapTurnsOf = (rt: RecordingRuntime): string[] =>
  rt.turns.slice(0, -1).map((turn) => turn.filter((m) => m.role === 'user').at(-1)?.content ?? '')

describe('askDocuments — the map step takes notes for a list-shaped question only (#939)', () => {
  it.each(['en', 'de', 'es'] as const)(
    '%s: the every-mention chip under Contract Brief: every map call takes notes for it',
    async (code) => {
      const h = await makeFenceHarness([LONG_LEASE], 4096)
      const chip = t(code, 'chat.example.indemnity')
      const msg = await ask(h, chip, appId('contract-brief'))
      expect(msg.coverage?.mode).toBe('capped')
      const maps = mapTurnsOf(h.runtime)
      expect(maps.length).toBeGreaterThan(1)
      for (const map of maps) {
        expect(map).toContain(`\nUser request:\n${chip}\n`)
        expect(map.indexOf('User request:')).toBeLessThan(map.indexOf('Skill instructions:'))
      }
    }
  )

  it('a typed list question under Contract Brief: every map call takes notes for it', async () => {
    const h = await makeFenceHarness([LONG_LEASE], 4096)
    const question = 'List every deadline in this contract'
    const msg = await ask(h, question, appId('contract-brief'))
    expect(msg.coverage?.mode).toBe('capped')
    const maps = mapTurnsOf(h.runtime)
    expect(maps.length).toBeGreaterThan(1)
    for (const map of maps) expect(map).toContain(`\nUser request:\n${question}\n`)
  })

  it.each([
    { name: 'Contract Brief, "Summarize this contract"', skillId: 'app:contract-brief', text: LONG_LEASE, question: 'Summarize this contract' },
    { name: 'Contract Brief, the summarize chip', skillId: 'app:contract-brief', text: LONG_LEASE, question: t('en', 'chat.example.summarize') },
    { name: 'Contract Brief, "Fasse dieses Dokument zusammen"', skillId: 'app:contract-brief', text: LONG_LEASE, question: 'Fasse dieses Dokument zusammen' },
    { name: 'Meeting Minutes, "Write the meeting minutes"', skillId: 'app:meeting-protocol', text: LONG_MEETING, question: 'Write the meeting minutes' },
    { name: 'a user whole-document skill, a list question', skillId: USER_WHOLE_DOC_INSTALL_ID, text: LONG_LEASE, question: 'List every deadline in this contract' }
  ])('$name: every map call is the prompt as it was', async ({ skillId, text, question }) => {
    const h = await makeFenceHarness([text], 4096)
    const msg = await ask(h, question, skillId)
    expect(msg.coverage?.mode).toBe('capped')
    const maps = mapTurnsOf(h.runtime)
    expect(maps.length).toBeGreaterThan(1)
    for (const map of maps) {
      expect(map).not.toContain('User request:')
      expect(map).toBe(asPreRequestMapPrompt(map))
    }
  })
})
