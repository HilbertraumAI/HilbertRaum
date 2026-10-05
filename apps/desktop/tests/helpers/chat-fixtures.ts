// Typed renderer fixtures: a `SkillInfo` and a `Conversation` factory (override any field). Pure data. Some
// suites assert the DEFAULTS in the DOM ('Bank statement helper', 'My chat' — SkillPerTurn, SkillInfoFirstPick,
// SkillRunLifecycle), so changing a default here means updating those assertions; other suites wrap these with
// their own literals.
import type { Conversation, SkillInfo } from '../../src/shared/types'

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
