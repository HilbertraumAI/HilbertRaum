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

/** The map and fold instructions as they were before #939, which leaves them byte for byte on every turn but a
 *  list-shaped question under a bundled whole-document skill. */
const MASTER_MAP_HEAD = (part: string, total: string): string =>
  `You are processing part ${part} of ${total} of ONE document, section by section, to complete the task ` +
  'described below. From THIS part only, note every detail the task needs — keep names, numbers, dates, ' +
  'decisions, and obligations exact. Write brief notes, not the final answer.\n'
const MASTER_FOLD_HEAD = (part: string, total: string): string =>
  `You are condensing the notes from part ${part} of ${total} of ONE document into a shorter summary, to complete ` +
  'the task described below. Keep every name, number, date, decision, and obligation exact — drop only ' +
  'repetition and filler. Write condensed notes, not the final answer.\n'

/** A map or fold user turn rebuilt with the pre-#939 instruction around ITS OWN fence, part numbers and text, or
 *  null when `user` is neither. Equal to `user` ⇔ the step sent the prompt as it was (with no request block, which
 *  the caller checks too: the rebuild keeps whatever sits between the instruction and the part label). */
export function asPreRequestMapPrompt(user: string): string | null {
  const m = user.match(/^You are (processing|condensing the notes from) part (\d+) of (\d+) /)
  if (!m) return null
  const fold = m[1] !== 'processing'
  const marker = `\nPart ${m[2]} of ${m[3]} ${fold ? '(section notes)' : '(section summaries)'}:\n`
  const at = user.lastIndexOf(marker)
  const end = 'not the final answer.\n'
  const instructionEnd = user.indexOf(end) + end.length
  if (at < 0 || instructionEnd < end.length || instructionEnd > at) return null
  const head = fold ? MASTER_FOLD_HEAD(m[2], m[3]) : MASTER_MAP_HEAD(m[2], m[3])
  return head + user.slice(instructionEnd, at) + user.slice(at)
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
