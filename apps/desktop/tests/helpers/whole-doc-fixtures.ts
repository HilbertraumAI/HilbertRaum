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
