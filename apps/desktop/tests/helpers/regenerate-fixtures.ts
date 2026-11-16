// The regenerate harness (review + export test campaign, commit H): the scratch workspace, the guarded-runFn driver and
// the answered-turn seed the regenerate suites copied verbatim. The IPC context is skills-world's `makeRagAskContext`
// (its `skills` is optional for these callers). No `electron` import (`ChatStreamRunFn` is a type only), so it is safe
// beside a suite's own hoisted `vi.mock('electron', …)`.
import { join } from 'node:path'
import type { ChatStreamRunFn } from '../../src/main/ipc/chat-stream'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import type { Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import type { Citation, Message } from '../../src/shared/types'
import { freshWorkspaceDb } from './db-fixtures'

/**
 * `freshWorkspaceDb(label)` (a `hilbertraum-<label>-` root with its workspace DB at `<root>/test.sqlite`) plus
 * `seedSettings`; `workspacePath` is `<root>/workspace` (not created). Pass it to `makeRagAskContext` as the world.
 * Replaces `freshDb` at 27bd0b0d: regenerate-evidence-review-guard.test.ts:88 and
 * regenerate-result-table-restore.test.ts:120.
 */
export function regenWorkspace(label: string): { db: Db; root: string; workspacePath: string } {
  const { db, root } = freshWorkspaceDb(label)
  seedSettings(db)
  return { db, root, workspacePath: join(root, 'workspace') }
}

/**
 * Drive a guarded runFn (`withRegenerateGuard(…)`) with `signal` (default: a fresh, never-aborted one) and inert
 * senders; the guard ignores their output. Replaces `drive` at 27bd0b0d: regenerate-evidence-review-guard.test.ts:221,
 * regenerate-result-table-restore.test.ts:197 (and chat-stream-regenerate.test.ts:26, out of this campaign's scope).
 */
export function driveGuarded(
  wrapped: ChatStreamRunFn,
  signal: AbortSignal = new AbortController().signal
): Promise<Message> {
  const noop = (): void => {}
  return wrapped(signal, noop, noop, noop, noop, noop)
}

/**
 * One conversation ending in a question + its assistant answer (the shape a regenerate re-answers). `mode`
 * 'documents' (the default when `documentIds` is given) scopes the conversation to `documentIds`; 'chat' (the default
 * otherwise) is a bare `createConversation(db, {})`. `citations`, `skillId` and `autoFired` stamp the answer (the
 * skill-stamped "Answer without it" shape). Replaces at 27bd0b0d: regenerate-evidence-review-guard.test.ts:115
 * (`seedDocumentsTurn`, minus its `seedEmbeddedDoc`, which the caller keeps) and :309 (`seedChatTurn`), and the turn
 * halves of regenerate-result-table-restore.test.ts:147 (`seedDocumentsTurnWithTable`) and :177
 * (`seedChatTurnWithTable`), whose `saveResultTable` stays with the caller.
 */
export function seedAnsweredTurn(
  db: Db,
  o: {
    question: string
    answer: string
    mode?: 'documents' | 'chat'
    documentIds?: string[]
    citations?: Citation[]
    skillId?: string
    autoFired?: boolean
  }
): { conversationId: string; answer: Message } {
  const mode = o.mode ?? (o.documentIds ? 'documents' : 'chat')
  const conv =
    mode === 'documents'
      ? createConversation(db, {
          mode: 'documents',
          scope: { collectionIds: [], documentIds: o.documentIds ?? [] }
        })
      : createConversation(db, {})
  appendMessage(db, { conversationId: conv.id, role: 'user', content: o.question })
  const answer = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: o.answer,
    citations: o.citations,
    skillId: o.skillId,
    autoFired: o.autoFired
  })
  return { conversationId: conv.id, answer }
}
