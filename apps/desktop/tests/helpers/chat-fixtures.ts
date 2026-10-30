// Typed renderer fixtures: `SkillInfo`, `Conversation`, `Message`, `Citation` and `DocumentInfo` factories
// (override any field). Pure data. Some suites assert the DEFAULTS in the DOM ('Bank statement helper', 'My chat'
// — SkillPerTurn, SkillInfoFirstPick, SkillRunLifecycle), so changing a default here means updating those
// assertions; other suites wrap these with their own literals.
//
// The message / citation / document factories (chat-ui campaign) replace the local copies the chat suites
// carried: `msg` / `userMsg` / `assistantMsg` / `message` in ~19 renderer files, the byte-identical `cites(n)` of
// CitationMarkers and SourcesProvenance, and the `doc` / `docInfo` / `indexedDoc` DocumentInfo literals. Optional
// fields stay ABSENT unless a test overrides them, so a row that needs `tokenCount: null` or `lifecycle` says so.
import type { Citation, Conversation, DocumentInfo, Message, SkillInfo } from '../../src/shared/types'

/** A bundled-looking instruction skill (`app:bank-statement`); override any field. Typed (no `as SkillInfo` cast). */
export function makeSkillInfo(over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    installId: 'app:bank-statement',
    id: 'bank-statement',
    title: 'Bank statement helper',
    description: 'Explains a bank statement.',
    version: '1.0.0',
    kind: 'instruction',
    author: 'You',
    language: 'en',
    source: 'app',
    trustedLevel: 'app',
    enabled: true,
    warningAck: true,
    unavailable: false,
    permissions: { documents: 'selected_only', network: 'denied', filesystem: 'skill_resources_only' },
    permissionSummary: 'x',
    duplicateId: false,
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

/** A plain chat conversation `c1` / `My chat`; override any field. */
export function makeConversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'My chat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'chat',
    scopeDocumentIds: null,
    collectionId: null,
    scope: null,
    ...over
  }
}

/** A persisted assistant answer `a1` in conversation `c1` ('An answer.'); every optional field absent. */
export function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'a1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'An answer.',
    createdAt: '2026-01-01T00:02:00Z',
    ...over
  }
}

/** A user turn in `c1`, stamped a minute BEFORE `makeMessage`'s answer (the local copies' times). */
export function userMsg(id: string, content: string, over: Partial<Message> = {}): Message {
  return makeMessage({ id, role: 'user', content, createdAt: '2026-01-01T00:01:00Z', ...over })
}

/** An assistant answer in `c1`; pass `{ conversationId }` (or citations, coverage, …) in `over`. */
export function assistantMsg(id: string, content: string, over: Partial<Message> = {}): Message {
  return makeMessage({ id, content, ...over })
}

/** `n` document citations labelled `S1…Sn` (the stored, language-independent label), each on its own
 *  section, page and snippet: `section {i+1}`, page `i+1`, `body of section {i+1}`. `over(i)` patches one. */
export function makeCitations(n: number, over?: (i: number) => Partial<Citation>): Citation[] {
  return Array.from({ length: n }, (_, i) => ({
    label: `S${i + 1}`,
    sourceTitle: `section ${i + 1}`,
    pageNumber: i + 1,
    snippet: `body of section ${i + 1}`,
    ...over?.(i)
  }))
}

/** An indexed PDF `d1` / `doc.pdf` (3 chunks, 1 KiB); override any field. */
export function makeDocumentInfo(over: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    id: 'd1',
    title: 'doc.pdf',
    originalPath: null,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    status: 'indexed',
    errorMessage: null,
    chunkCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}
