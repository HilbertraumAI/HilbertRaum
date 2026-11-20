import { describe, it, expect, vi, beforeEach } from 'vitest'

// Skill-whole-doc engine, Follow-up B — the CHAT wiring for a 2-document compare: `askDocuments`
// routes a compare-shaped question for the `grounded-whole-doc-compare` skill (what-changed) to a
// MODEL answer over BOTH documents read whole (budget split, capped coverage, fence applied), REFUSES
// when either doc is not fully chunked (a 1- or 3-doc scope gets the "select exactly two" answer in
// rag-skill-analysis.test.ts). #963: small talk gets the short small-talk reply, which reads no document (the
// second describe below). #632: any other question at a 1- or 3-doc scope falls through to the ordinary grounded
// answer with paragraph 1 of the compare skill's fence only (the third). #831: so does a fall-through turn of the
// four bundled whole-document skills (the fourth).

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
import { REPO_APP_SKILLS_DIR, type SkillSpec, writeSkillPackage } from '../helpers/skill-fixtures'
import { recordingRuntime, type RecordingRuntime } from '../helpers/scripted-runtime'
import { ingestTextFile, makeRagAskContext, makeSkillsWorld } from '../helpers/skills-world'
import { asPreRequestMapPrompt } from '../helpers/whole-doc-fixtures'
import { approxPromptTokens, buildSkillFence } from '../../src/main/services/skills/prompt'
import {
  documentFitsWholeRead,
  EXCERPT_BEGIN,
  EXCERPT_END,
  GROUNDED_MAX_TOKENS,
  WHOLE_READ_SECTION_FRAMING_TOKENS,
  wholeDocumentFitBudgetTokens
} from '../../src/main/services/rag'

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

/** #962: the five bundled skills whose fall-through turn carries paragraph 1 of the fence (#632, #831). */
const CAPPED_SKILLS = ['what-changed', ...WHOLE_DOC_SKILLS] as const
/** #962: a committed skill's manifest title and body. */
const committedSkill = (id: string): { title: string; body: string } => {
  const parsed = parseSkillMarkdown(readFileSync(join(REPO_APP_SKILLS_DIR, id, 'SKILL.md'), 'utf8'))
  return { title: parsed.manifest!.title, body: parsed.body! }
}
/** #962: two user twins per capped skill, with its committed title and engine. `p1-<id>` installs paragraph 1 as its
 *  whole body (wave 4's emulation): its fence is the bundled fall-through fence word for word. `full-<id>` installs
 *  the whole body: a user skill keeps its whole fence, so it reserves what master reserved for the bundled skill. */
const twinSpecs = (): SkillSpec[] =>
  CAPPED_SKILLS.flatMap((id) => {
    const { title, body } = committedSkill(id)
    const analysis = id === 'what-changed' ? 'compare' : 'whole-doc'
    return [
      { id: `p1-${id}`, title, kind: 'instruction', analysis, body: paragraphsOf(body)[0] },
      { id: `full-${id}`, title, kind: 'instruction', analysis, body }
    ]
  })
const p1Twin = (id: string): string => `user:p1-${id}`
const fullTwin = (id: string): string => `user:full-${id}`

interface FenceHarness {
  db: Db
  conversationId: string
  docIds: string[]
  runtime: RecordingRuntime
}

async function makeFenceHarness(texts: string[], contextWindow = 8192, o: { twins?: boolean } = {}): Promise<FenceHarness> {
  const w = makeSkillsWorld('compare632', {
    seedApp: (d) => {
      for (const id of ['what-changed', ...WHOLE_DOC_SKILLS]) cpSync(join(REPO_APP_SKILLS_DIR, id), join(d, id), { recursive: true })
    },
    seedUser: (d) => {
      if (o.twins) for (const spec of twinSpecs()) writeSkillPackage(d, spec)
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

/** #962: the budget-driven fence trims and omissions (`logSkillFenceReduction`) the local log holds for this skill. */
const reducedLogCount = (skillId: string): number =>
  readLogTail(100_000).filter((l) => l.includes('skill fence reduced to fit context budget') && l.includes(`"skillId":"${skillId}"`)).length

/** #962: the user turn of the last model call, its excerpt block (markers included) and the passages it carried. */
const lastUserTurn = (rt: RecordingRuntime): string => rt.lastMessages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
const excerptBlock = (userTurn: string): string =>
  userTurn.slice(userTurn.indexOf(EXCERPT_BEGIN), userTurn.indexOf(EXCERPT_END) + EXCERPT_END.length)
const passagesSent = (rt: RecordingRuntime): number => (lastUserTurn(rt).match(/^\[S\d+\] File: /gm) ?? []).length

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

async function ask(h: FenceHarness, question: string, skillId: string | null): Promise<Message> {
  return (await invoke(handlers, IPC.askDocuments, h.conversationId, question, skillId)).result as Message
}

const ONE_DRAFT = LEASE_DRAFTS.slice(0, 1)
const TWO_DRAFTS = LEASE_DRAFTS.slice(0, 2)
const TENANT = 'Wer ist der Mieter?'
// Two drafts that close with thanks, so the passage search finds a passage for a thank-you (before #963 the model was
// called with it and summarized the draft).
const THANKING_DRAFTS = TWO_DRAFTS.map((d) => `${d}\nVielen Dank für Ihre Zusammenarbeit. Thanks for your cooperation. Merci beaucoup.`)

// ---- #963: small talk in a documents chat gets a short reply that reads nothing (follow-ups wave 5 owner call G-1) ----
// A thank-you, a greeting or "How are you?" in a chat about documents used to take the passage search under any skill or
// none: the model saw "Question: Danke!" over the excerpts and summarized them, and the reply carried Sources, the
// coverage meter and the skill stamp. Now it gets one short model turn, a fixed small-talk system prompt and the message
// alone (`generateSmallTalkReply`), and the reply carries none of them. A filler QUESTION ("Sure?", «Alles?») still reads
// the documents (`isSmallTalkReply`).

/** #963: the short reply's contract: one call with a system prompt and the message alone (no earlier turn, no fence, no
 *  excerpt, no document text), a cap below a grounded answer's, and a plain reply (no citations, coverage, pack outcomes
 *  or stamp). */
function expectSmallTalkReply(rt: RecordingRuntime, msg: Message, message: string): void {
  expect(rt.calls).toBe(1)
  expect(rt.lastMessages.map((m) => m.role)).toEqual(['system', 'user'])
  expect(rt.lastMessages[1].content).toBe(message)
  for (const sent of [EXCERPT_BEGIN, 'LOCAL SKILL', 'Max Huber']) expect(rt.lastMessages[0].content).not.toContain(sent)
  expect(rt.options.at(-1)?.maxTokens).toBeLessThan(GROUNDED_MAX_TOKENS)
  expect(msg.content).toBe('The tenant is Max Huber.')
  expect(msg.citations ?? []).toEqual([])
  expect(msg.coverage).toBeUndefined()
  expect(msg.packOutcomes).toBeUndefined()
  expect(msg.skillId ?? null).toBeNull()
}

const SMALL_TALK_SCOPES = [
  { name: 'no skill, one document', skillId: null, texts: THANKING_DRAFTS.slice(0, 1) },
  { name: 'Contract Brief, one document', skillId: 'app:contract-brief', texts: THANKING_DRAFTS.slice(0, 1) },
  { name: 'What Changed?, two documents', skillId: WHAT_CHANGED_INSTALL_ID, texts: THANKING_DRAFTS },
  { name: 'a user skill with no analysis engine, one document', skillId: USER_PLAIN_INSTALL_ID, texts: THANKING_DRAFTS.slice(0, 1) }
]

describe('askDocuments — small talk gets the short small-talk reply, which reads no document (#963)', () => {
  it.each(SMALL_TALK_SCOPES.flatMap((scope) => ['Danke!', 'Thanks!', 'Merci !', 'How are you?'].map((message) => ({ ...scope, message }))))(
    '$name, "$message": the short small-talk reply',
    async ({ skillId, texts, message }) => {
      const h = await makeFenceHarness(texts)
      const msg = await ask(h, message, skillId)
      expectSmallTalkReply(h.runtime, msg, message)
    }
  )

  // No earlier turn rides along (owner call G-1): after a document answer, the thank-you's call carries the message alone.
  it('after an answer from the documents, «Danke!» gets the short reply to the message alone', async () => {
    const h = await makeFenceHarness(THANKING_DRAFTS.slice(0, 1))
    await ask(h, TENANT, null)
    const calls = h.runtime.calls
    const msg = await ask(h, 'Danke!', null)
    expect(h.runtime.calls - calls).toBe(1)
    expect(h.runtime.lastMessages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(h.runtime.lastMessages[1].content).toBe('Danke!')
    expect(msg.citations ?? []).toEqual([])
  })

  // The gate: a filler question about the last answer and a real question still read the documents (a draft that holds
  // their words, so the passage search finds a passage for each).
  it.each(['Sure?', 'Alles?', TENANT])('"%s" in the same scope still reads the documents', async (question) => {
    const h = await makeFenceHarness([`${LEASE_DRAFTS[0]}\nAlles inklusive: heating and water. Make sure the keys are returned.`])
    const msg = await ask(h, question, null)
    expect(lastUserTurn(h.runtime)).toContain(EXCERPT_BEGIN)
    expect(msg.citations?.length ?? 0).toBeGreaterThan(0)
  })
})

describe("askDocuments — the bundled compare skill's fall-through turn carries paragraph 1 of its fence (#632)", () => {
  it.each([
    { name: 'what-changed over one document', skillId: WHAT_CHANGED_INSTALL_ID, texts: ONE_DRAFT, question: TENANT },
    { name: 'what-changed over three documents', skillId: WHAT_CHANGED_INSTALL_ID, texts: LEASE_DRAFTS, question: TENANT }
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

  // Small talk over two documents used to fall through here too (`applies()` opts small talk out of the compare engine),
  // so its top-k answer got paragraph 1, the one two-document prompt #632 changed. Since #963 it gets the short
  // small-talk reply before any skill engine runs: no fence, no passage, no stamp.
  it('what-changed, small talk over two documents: the short small-talk reply, no fence, not stamped', async () => {
    const h = await makeFenceHarness(THANKING_DRAFTS)
    const logged = capLogCount(WHAT_CHANGED_INSTALL_ID)
    const msg = await ask(h, 'Vielen Dank!', WHAT_CHANGED_INSTALL_ID)
    expectSmallTalkReply(h.runtime, msg, 'Vielen Dank!')
    expect(capLogCount(WHAT_CHANGED_INSTALL_ID) - logged).toBe(0)
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

  // #962 (owner call G-8, Option 2): the small-document read (#643, `wholeReadFor`) sizes its fit by the fence the turn
  // sends too. A document between the two fit budgets, too long to read whole beside What Changed?'s whole fence and
  // short enough beside its paragraph 1, is read whole on the fall-through turn (#643's rule: one document that fits is
  // read whole); master sent it to the passage search. The user twin with the whole committed body keeps its whole
  // fence, so the same document stays on the passage search there.
  it.each([
    { name: 'What Changed?, whose fall-through fence is paragraph 1', skillId: WHAT_CHANGED_INSTALL_ID, mode: 'capped' },
    { name: 'its user twin with the whole body', skillId: fullTwin('what-changed'), mode: 'relevance' }
  ])('one document between the two fit budgets at 4,096 ($name): $mode', async ({ skillId, mode }) => {
    const band = Array.from({ length: 62 }, (_, i) => `Clause ${i + 1}: the tenant Max Huber pays EUR 2,400 on the first day of each month.`)
    const h = await makeFenceHarness([band.join('\n')], 4096, { twins: true })
    const docId = h.docIds[0]
    const sections = chunkIdsOf(h.db, docId).length
    // The premise: with each section's `[Sn] File: …` line charged, the document fits beside paragraph 1 only.
    const skill = { installId: WHAT_CHANGED_INSTALL_ID, ...committedSkill('what-changed') }
    const fits = (budget: number): boolean => documentFitsWholeRead(h.db, docId, budget, WHOLE_READ_SECTION_FRAMING_TOKENS)
    expect(fits(wholeDocumentFitBudgetTokens(4096, TENANT, skill))).toBe(false)
    expect(fits(wholeDocumentFitBudgetTokens(4096, TENANT, skill, 'first-paragraph'))).toBe(true)

    const msg = await ask(h, TENANT, skillId)
    expect(h.runtime.calls).toBe(1)
    expect(msg.coverage?.mode).toBe(mode)
    if (mode === 'capped') {
      expect(msg.coverage).toMatchObject({ truncated: false, chunksCovered: sections })
      expect(passagesSent(h.runtime)).toBe(sections)
      expect(fenceBodies(h.runtime)).toEqual([paragraphsOf(BODIES[WHAT_CHANGED_INSTALL_ID])[0]])
    } else {
      expect(passagesSent(h.runtime)).toBeLessThan(sections)
    }
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

  // #963: small talk over one document used to fall through with paragraph 1 and a stamp; it now gets the short
  // small-talk reply before any skill engine runs: no fence, no passage, no stamp.
  it.each(WHOLE_DOC_SKILLS)('%s, small talk over one document: the short small-talk reply, no fence, not stamped', async (id) => {
    const h = await makeFenceHarness(THANKING_DRAFTS.slice(0, 1))
    const logged = capLogCount(appId(id))
    const msg = await ask(h, 'Vielen Dank!', appId(id))
    expectSmallTalkReply(h.runtime, msg, 'Vielen Dank!')
    expect(capLogCount(appId(id)) - logged).toBe(0)
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

  // #962: since #962 the budgets of a fall-through turn reserve the fence it sends (paragraph 1), not the whole fence,
  // so the room the cut frees goes to the passages. The yardstick is the user twin whose whole body IS paragraph 1: the
  // same fence text, so the same room. On master the bundled turn read one passage of the long lease at a 4,096 window,
  // where the twin read two. What Changed? over one document is a fall-through turn for any question.
  const NOTICE = 'When is the notice period?'
  /** A long lease whose sections are all full: 713 sixteen-word clauses and the notice line make 11,419 words, so every
   *  500-token window (80 overlapping) holds about 500 words. A short last section would fit beside any fence and blur
   *  the passage counts (LONG_LEASE ends in one of 291 words, ranked first for the notice question). */
  const EVEN_LEASE = [
    ...Array.from({ length: 356 }, (_, i) => `Clause ${i + 1}: the tenant Max Huber pays EUR 2,400 on the first day of each month.`),
    'Notice period: three months, to the end of a calendar quarter.',
    ...Array.from({ length: 357 }, (_, i) => `Clause ${i + 357}: the tenant Max Huber pays EUR 2,400 on the first day of each month.`)
  ].join('\n')
  const evenHarness = async (contextWindow: number, twins = true): Promise<FenceHarness> => {
    const h = await makeFenceHarness([EVEN_LEASE], contextWindow, { twins })
    // The premise: no short section.
    const sizes = h.db.prepare('SELECT token_count FROM chunks WHERE document_id = ?').all(h.docIds[0]) as Array<{ token_count: number }>
    expect(Math.min(...sizes.map((s) => s.token_count))).toBeGreaterThan(450)
    return h
  }

  it.each(CAPPED_SKILLS)('%s, a single-fact question over a long document at 4,096: as many passages as its paragraph-1 twin', async (id) => {
    const bundled = await evenHarness(4096)
    const msg = await ask(bundled, NOTICE, appId(id))
    const twin = await evenHarness(4096)
    const twinMsg = await ask(twin, NOTICE, p1Twin(id))
    expect([msg.coverage?.mode, twinMsg.coverage?.mode]).toEqual(['relevance', 'relevance'])
    expect(fenceBodies(bundled.runtime)).toEqual(fenceBodies(twin.runtime))
    expect(passagesSent(bundled.runtime)).toBe(passagesSent(twin.runtime))
    expect(passagesSent(bundled.runtime)).toBeGreaterThan(1)
    expect(msg.skillId).toBe(appId(id))
  })

  // #962: the reservation and the placement read one `fenceMode`. The budgets' own contract holds on the fall-through
  // turn: everything but the excerpts at the 1.3-per-word estimate, plus the excerpts with the 1.5 German headroom, plus
  // the answer cap, fits the window, and the fence the budgets reserved is the fence placed (paragraph 1, untrimmed). A
  // placement fuller than the reservation came to 4,117 of 4,096 tokens when measured.
  it.each(CAPPED_SKILLS)('%s, the fall-through turn at 4,096 keeps the budget contract and places paragraph 1 whole', async (id) => {
    const h = await evenHarness(4096, false)
    const reduced = reducedLogCount(appId(id))
    const msg = await ask(h, NOTICE, appId(id))
    const prompt = h.runtime.lastMessages.reduce((sum, m) => sum + approxPromptTokens(m.content), 0)
    const excerpts = approxPromptTokens(excerptBlock(lastUserTurn(h.runtime)))
    expect(prompt - excerpts + Math.ceil(1.5 * excerpts) + GROUNDED_MAX_TOKENS).toBeLessThanOrEqual(4096)
    expect(msg.coverage?.mode).toBe('relevance')
    expect(fenceBodies(h.runtime)).toEqual([paragraphsOf(BODIES[appId(id)])[0]])
    expect(reducedLogCount(appId(id)) - reduced).toBe(0)
  })

  // #962's guard: the reservation follows the fence the turn sends, not the skill. A user skill keeps its whole fence on
  // the needle downgrade, so it still reserves its whole body, as master did for every skill: the user twin with Contract
  // Brief's whole committed body reads fewer passages than the paragraph-1 twin.
  it('a user whole-document skill with a long body still reserves its whole fence on the needle downgrade', async () => {
    const full = await evenHarness(4096)
    await ask(full, NOTICE, fullTwin('contract-brief'))
    const p1 = await evenHarness(4096)
    await ask(p1, NOTICE, p1Twin('contract-brief'))
    expect(fenceBodies(full.runtime)).toEqual([paragraphsOf(BODIES[appId('contract-brief')]).join('\n\n')])
    expect(passagesSent(full.runtime)).toBeLessThan(passagesSent(p1.runtime))
  })

  // #962 leaves 8,192 windows as they were (the 9B's): there the `ragMaxContextTokens` setting (2,500) is smaller than
  // what either reservation leaves, so the bundled fall-through turn reads as many passages as the whole-fence
  // reservation, which is what master reserved for it (the user twin with the whole body), and its prompt is master's.
  // (Which of the lease's identical clauses fill the passages is the mock search's tie order, so the count is compared.)
  it.each(CAPPED_SKILLS)('%s at 8,192: as many passages as the whole-fence reservation', async (id) => {
    const bundled = await evenHarness(8192)
    await ask(bundled, NOTICE, appId(id))
    const full = await evenHarness(8192)
    await ask(full, NOTICE, fullTwin(id))
    expect(passagesSent(bundled.runtime)).toBeGreaterThan(2)
    expect(passagesSent(bundled.runtime)).toBe(passagesSent(full.runtime))
  })

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
/** The whole fence each skill's map calls carry (the title the registry holds: the manifest's), built by the same
 *  `buildSkillFence` the core calls with no mode — the fence is not what #939 changes, the instruction around it is. */
const committedTitle = (id: string): string =>
  parseSkillMarkdown(readFileSync(join(REPO_APP_SKILLS_DIR, id, 'SKILL.md'), 'utf8')).manifest!.title
const wholeFenceOf = (skillId: string): string | null => {
  const title = skillId === USER_WHOLE_DOC_INSTALL_ID ? 'Lease digest' : committedTitle(skillId.replace(/^app:/, ''))
  return buildSkillFence({ title, body: BODIES[skillId] }).text
}
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
    { name: 'a user whole-document skill, a list question', skillId: USER_WHOLE_DOC_INSTALL_ID, text: LONG_LEASE, question: 'List every deadline in this contract' },
    // review B1: a report request that carries a list word is still a report (the router's summary reading, or the
    // skill-side report shapes), so its map calls stay master's
    { name: 'Meeting Minutes, "Summarize all the decisions"', skillId: 'app:meeting-protocol', text: LONG_MEETING, question: 'Summarize all the decisions' },
    { name: 'Meeting Minutes, "Fasse alle Beschlüsse zusammen"', skillId: 'app:meeting-protocol', text: LONG_MEETING, question: 'Fasse alle Beschlüsse zusammen' },
    { name: 'Meeting Minutes, "Erstelle das Protokoll mit allen Beschlüssen"', skillId: 'app:meeting-protocol', text: LONG_MEETING, question: 'Erstelle das Protokoll mit allen Beschlüssen' },
    { name: 'Meeting Minutes, "Write the minutes including every action item"', skillId: 'app:meeting-protocol', text: LONG_MEETING, question: 'Write the minutes including every action item' }
  ])('$name: every map call is the prompt as it was', async ({ skillId, text, question }) => {
    const h = await makeFenceHarness([text], 4096)
    const msg = await ask(h, question, skillId)
    expect(msg.coverage?.mode).toBe('capped')
    const maps = mapTurnsOf(h.runtime)
    expect(maps.length).toBeGreaterThan(1)
    for (const map of maps) {
      expect(map).not.toContain('User request:')
      expect(map).toBe(asPreRequestMapPrompt(map, wholeFenceOf(skillId)))
    }
  })

  // review B1's controls: a plain list request under Meeting Minutes keeps the request in its notes.
  it('a list request under Meeting Minutes ("List all action items"): every map call takes notes for it', async () => {
    const h = await makeFenceHarness([LONG_MEETING], 4096)
    const msg = await ask(h, 'List all action items', appId('meeting-protocol'))
    expect(msg.coverage?.mode).toBe('capped')
    const maps = mapTurnsOf(h.runtime)
    expect(maps.length).toBeGreaterThan(1)
    for (const map of maps) expect(map).toContain('\nUser request:\nList all action items\n')
  })

  // review S2: a document with a ready deep index takes the tree rescue (not the chunk map-reduce), which reads the
  // flag through its own argument; the chip's map steps over the node summaries take notes for it there too.
  it('the every-mention chip over a document with a ready deep index: the tree map steps take notes for it', async () => {
    const h = await makeFenceHarness([LONG_LEASE], 4096)
    const section = (n: number): string => `Section ${n}: ${'the tenant shall indemnify the landlord against claims '.repeat(130)}`
    seedReadyTree(h.db, h.docIds[0], chunkIdsOf(h.db, h.docIds[0]), {
      summary: 'Summary: a lease with three indemnity articles.',
      sections: [section(1), section(2), section(3)]
    })
    const chip = t('en', 'chat.example.indemnity')
    const msg = await ask(h, chip, appId('contract-brief'))
    expect(msg.coverage?.mode).toBe('tree')
    const maps = mapTurnsOf(h.runtime)
    expect(maps.length).toBeGreaterThan(1)
    for (const map of maps) expect(map).toContain(`\nUser request:\n${chip}\n`)
  })
})
