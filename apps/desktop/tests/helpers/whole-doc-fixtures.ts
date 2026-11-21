// Whole-document read fixtures for the rag-whole-doc-* suites (pure: no electron import). Every root is minted via
// `tempRoot`, so it carries the swept `hilbertraum-` prefix. No deep-index tree is ever built here, so an over-budget
// whole-document turn over this harness takes the Phase-1 chunk map-reduce path.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { MockEmbedder } from '../../src/main/services/embeddings'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { generateGroundedAnswer, ragSettingsFrom, type GroundedAnswerOptions } from '../../src/main/services/rag'
import type { ModelRuntime } from '../../src/main/services/runtime'
import { DEFAULT_SETTINGS, type Message } from '../../src/shared/types'
import { tempRoot } from './db-fixtures'

/** The map and fold instructions as they were before #939 (frozen copies of master's builders), which a turn under a
 *  skill keeps byte for byte when its notes do not take the request (#939). With no skill the notes always take it:
 *  the no-fence template below (#952). */
export const MASTER_MAP_HEAD = (part: string | number, total: string | number): string =>
  `You are processing part ${part} of ${total} of ONE document, section by section, to complete the task ` +
  'described below. From THIS part only, note every detail the task needs — keep names, numbers, dates, ' +
  'decisions, and obligations exact. Write brief notes, not the final answer.\n'
export const MASTER_FOLD_HEAD = (part: string | number, total: string | number): string =>
  `You are condensing the notes from part ${part} of ${total} of ONE document into a shorter summary, to complete ` +
  'the task described below. Keep every name, number, date, decision, and obligation exact — drop only ' +
  'repetition and filler. Write condensed notes, not the final answer.\n'

/** Master's whole map or fold user turn for one window (`text`) and the turn's fence (`skillFence`, as
 *  `buildSkillFence` returns it, or null for no skill). The frozen template of master's builders. */
export function masterMapPrompt(fold: boolean, skillFence: string | null, part: number | string, total: number | string, text: string): string {
  const fence = skillFence ? `\n${skillFence}\n` : ''
  const head = fold ? MASTER_FOLD_HEAD(part, total) : MASTER_MAP_HEAD(part, total)
  const label = fold ? '(section notes)' : '(section summaries)'
  return `${head}${fence}\nPart ${part} of ${total} ${label}:\n${text}\n\n${fold ? 'Condensed notes:' : 'Notes:'}`
}

/** #952: the map and fold instructions with no skill (frozen copies of the no-fence builders). There is no task, so
 *  the user's request is the notes' only target, in the fenced request layout with the fence left out. */
export const NO_FENCE_MAP_HEAD = (part: string | number, total: string | number): string =>
  `You are processing part ${part} of ${total} of ONE document, section by section, to answer the user request ` +
  'below. From THIS part only, note every detail the user request needs — keep names, numbers, dates, decisions, ' +
  'and obligations exact. Write brief notes, not the final answer.\n'
export const NO_FENCE_FOLD_HEAD = (part: string | number, total: string | number): string =>
  `You are condensing the notes from part ${part} of ${total} of ONE document into a shorter summary, to answer ` +
  'the user request below. Keep every name, number, date, decision, and obligation exact — drop only repetition ' +
  'and filler. Write condensed notes, not the final answer.\n'

/** The whole no-skill map or fold user turn for one window (`text`) and the user's `request` (#952). */
export function noFenceMapPrompt(fold: boolean, request: string, part: number | string, total: number | string, text: string): string {
  const head = fold ? NO_FENCE_FOLD_HEAD(part, total) : NO_FENCE_MAP_HEAD(part, total)
  const label = fold ? '(section notes)' : '(section summaries)'
  return `${head}\nUser request:\n${request}\n\nPart ${part} of ${total} ${label}:\n${text}\n\n${fold ? 'Condensed notes:' : 'Notes:'}`
}

/** A map or fold user turn split into its step kind, part numbers and window text, or null when it is neither. */
function mapStepOf(user: string): { fold: boolean; part: string; total: string; text: string } | null {
  const m = user.match(/^You are (processing|condensing the notes from) part (\d+) of (\d+) /)
  if (!m) return null
  const fold = m[1] !== 'processing'
  const marker = `\nPart ${m[2]} of ${m[3]} ${fold ? '(section notes)' : '(section summaries)'}:\n`
  const tail = fold ? '\n\nCondensed notes:' : '\n\nNotes:'
  const at = user.lastIndexOf(marker)
  if (at < 0 || !user.endsWith(tail)) return null
  return { fold, part: m[2], total: m[3], text: user.slice(at + marker.length, user.length - tail.length) }
}

/** A map or fold user turn rebuilt as master's builder would write it for ITS OWN part numbers and window text
 *  and the EXPECTED fence, or null when `user` is neither. Equal to `user` ⇔ the step sent master's prompt for that
 *  window: every byte but the window text is master's template and the given fence. */
export function asPreRequestMapPrompt(user: string, skillFence: string | null): string | null {
  const step = mapStepOf(user)
  return step && masterMapPrompt(step.fold, skillFence, step.part, step.total, step.text)
}

/** The same for the no-skill template (#952): equal to `user` ⇔ the step sent the no-fence prompt for `request`. */
export function asNoFenceMapPrompt(user: string, request: string): string | null {
  const step = mapStepOf(user)
  return step && noFenceMapPrompt(step.fold, request, step.part, step.total, step.text)
}

/** The whole-document question the suites ask (German, like the fixture). */
export const WHOLE_DOC_QUESTION = 'Fasse das gesamte Dokument zusammen: welche Entscheidungen wurden getroffen?'

/** A realistic German document, one sentence per line: each carries a unique `M####` marker, so a duplicated chunk
 *  overlap and whole-document reach (first AND last marker) are directly detectable, and the subword-dense prose is
 *  what the budget math is sized for. One coalesced segment, so the chunker produces OVERLAPPING windows. */
export function germanDoc(sentences: number): string {
  const lines: string[] = []
  for (let i = 0; i < sentences; i++) {
    const marker = `M${String(i).padStart(4, '0')}`
    lines.push(
      `${marker} Abschnitt: Der Kontostand des Geschäftskontos wurde im Berichtszeitraum sorgfältig ` +
        `geprüft, sämtliche Buchungen ordnungsgemäß erfasst und den jeweiligen Kategorien zugeordnet.`
    )
  }
  return lines.join('\n')
}

export interface WholeDocHarness {
  db: Db
  docId: string
  conversationId: string
}

/** Ingest `text` as `statement.txt` through the real pipeline (mock embedder) into a fresh workspace and open a
 *  documents-scoped conversation over it. */
export async function wholeDocHarness(text: string): Promise<WholeDocHarness> {
  const root = tempRoot('wholedoc')
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const docPath = join(root, 'statement.txt')
  writeFileSync(docPath, text, 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, documentsDir(workspacePath), doc.id, { embedder: new MockEmbedder() })
  const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [doc.id] } })
  return { db, docId: doc.id, conversationId: conv.id }
}

/** Ask `question` as a whole-document turn over `h`'s document (`extra` adds or overrides grounded-answer options). */
export async function answerWholeDoc(
  h: WholeDocHarness,
  runtime: ModelRuntime,
  extra: GroundedAnswerOptions = {},
  question = WHOLE_DOC_QUESTION
): Promise<Message> {
  appendMessage(h.db, { conversationId: h.conversationId, role: 'user', content: question })
  return (await generateGroundedAnswer(
    h.db,
    runtime,
    new MockEmbedder(),
    h.conversationId,
    question,
    ragSettingsFrom(DEFAULT_SETTINGS),
    { wholeDocument: { documentId: h.docId }, ...extra }
  )) as Message
}
