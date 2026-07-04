import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder } from '../../src/main/services/embeddings'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import { reconcileSkills, setSkillEnabled } from '../../src/main/services/skills/registry'
import { resolveTurnSkill } from '../../src/main/services/skills/turn'
import {
  appendMessage,
  buildChatMessages,
  BASE_SYSTEM_PROMPT,
  createConversation,
  generateAssistantMessage,
  listMessages,
  setConversationDefaultSkill
} from '../../src/main/services/chat'
import { updateSettings } from '../../src/main/services/settings'
import {
  buildGroundedChatMessages,
  buildGroundedPrompt,
  GROUNDED_SYSTEM_PROMPT,
  generateGroundedAnswer,
  ragSettingsFrom,
  type RetrievedChunk
} from '../../src/main/services/rag'
import { SKILL_GUARD_LINE } from '../../src/main/services/skills/prompt'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

// Skills plan S6+S7 — manual activation + prompt integration. Proves: resolveTurnSkill (sticky /
// override / disabled / deleted → none), the fence placement (plain-chat system vs RAG user turn —
// §22-H2), assistant-row stamping ONLY when the fence was placed (§22-A5), the no-context RAG turn
// stamps NULL, and the carry-forward invariant — a DELETED skill resolves messages.skill_id → NULL.

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-skillturn-'))
}
function freshDb(): Db {
  return openDatabase(join(tempDir(), 'test.sqlite'))
}
function makeDirs(): { appSkillsDir: string; userSkillsDir: string } {
  const root = tempDir()
  return { appSkillsDir: join(root, 'app-skills'), userSkillsDir: join(root, 'user-skills') }
}
function writeSkill(dir: string, id: string, body: string, version = '1.0.0'): void {
  const d = join(dir, id)
  mkdirSync(d, { recursive: true })
  const md = [
    '---',
    `id: ${id}`,
    `title: Skill ${id}`,
    `description: Test skill ${id}`,
    `version: ${version}`,
    '---',
    body
  ].join('\n')
  writeFileSync(join(d, 'SKILL.md'), md, 'utf8')
}

/** A db with one ENABLED user skill `bank` (body "Quote totals.") + its install_id. */
function envWithSkill(): { db: Db; dirs: { appSkillsDir: string; userSkillsDir: string }; installId: string } {
  const db = freshDb()
  const dirs = makeDirs()
  writeSkill(dirs.userSkillsDir, 'bank', 'Quote the printed totals.\n\nFlag anything you cannot verify.')
  reconcileSkills(db, dirs)
  const installId = 'user:bank'
  setSkillEnabled(db, installId, true) // drop-ins install disabled (DS19) — enable it
  return { db, dirs, installId }
}

function runtime() {
  return createMockRuntime({ modelId: 'mock', modelPath: '/m.gguf', contextTokens: 2048 })
}

describe('resolveTurnSkill (skills plan §10.1/§10.3)', () => {
  it('uses the conversation sticky default, and a per-turn arg overrides it', () => {
    const { db, dirs, installId } = envWithSkill()
    writeSkill(dirs.userSkillsDir, 'other', 'Other body.')
    reconcileSkills(db, dirs)
    setSkillEnabled(db, 'user:other', true)
    const conv = createConversation(db, {})
    setConversationDefaultSkill(db, conv.id, installId)

    expect(resolveTurnSkill(db, dirs, conv.id)?.installId).toBe(installId)
    // Per-turn override.
    expect(resolveTurnSkill(db, dirs, conv.id, 'user:other')?.installId).toBe('user:other')
    // Explicit null clears for the turn (without touching the default).
    expect(resolveTurnSkill(db, dirs, conv.id, null)).toBeNull()
    expect(resolveTurnSkill(db, dirs, conv.id)?.installId).toBe(installId)
  })

  it('resolves a disabled or deleted default to none (graceful degradation)', () => {
    const { db, dirs, installId } = envWithSkill()
    const conv = createConversation(db, {})
    setConversationDefaultSkill(db, conv.id, installId)
    expect(resolveTurnSkill(db, dirs, conv.id)).not.toBeNull()

    setSkillEnabled(db, installId, false)
    expect(resolveTurnSkill(db, dirs, conv.id)).toBeNull()

    setSkillEnabled(db, installId, true)
    db.prepare('DELETE FROM skills WHERE install_id = ?').run(installId)
    expect(resolveTurnSkill(db, dirs, conv.id)).toBeNull()
  })

  it('skips an enabled-but-incompatible skill at the use-site (§6.5/M1 airtight gate)', () => {
    // An enabled skill whose SKILL.md was edited on disk to require a newer app than is running. The
    // `enabled` flag is stale (reconcile preserves it); the use-site gate must still exclude it.
    const db = freshDb()
    const dirs = makeDirs()
    const d = join(dirs.userSkillsDir, 'futureskill')
    mkdirSync(d, { recursive: true })
    writeFileSync(
      join(d, 'SKILL.md'),
      [
        '---',
        'id: futureskill',
        'title: Future Skill',
        'description: Needs a newer app',
        'version: 1.0.0',
        'compatibility:',
        '  minAppVersion: 99.0.0',
        '---',
        'Body that should never reach a turn while the app is too old.'
      ].join('\n'),
      'utf8'
    )
    reconcileSkills(db, dirs)
    setSkillEnabled(db, 'user:futureskill', true) // force-enable (simulate stale enabled flag)
    const conv = createConversation(db, {})
    setConversationDefaultSkill(db, conv.id, 'user:futureskill')

    // Too old → skipped even though enabled.
    expect(resolveTurnSkill(db, { ...dirs, appVersion: '1.2.3' }, conv.id)).toBeNull()
    // New enough → resolves normally.
    expect(resolveTurnSkill(db, { ...dirs, appVersion: '99.0.0' }, conv.id)?.installId).toBe('user:futureskill')
    // No appVersion supplied ⇒ tolerant (treated as compatible) — the existing callers' default.
    expect(resolveTurnSkill(db, dirs, conv.id)?.installId).toBe('user:futureskill')
  })
})

describe('fence placement (§11.2/§22-H2)', () => {
  it('plain chat brackets the fence in the SYSTEM message — base first, guard last', () => {
    const { db } = envWithSkill()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Hello' })
    const fence = '--- BEGIN LOCAL SKILL ---\nSkill instructions:\nDo it.\n--- END LOCAL SKILL ---\n' + SKILL_GUARD_LINE
    const messages = buildChatMessages(db, conv.id, undefined, fence)
    const system = messages[0]
    expect(system.role).toBe('system')
    expect(system.content.startsWith(BASE_SYSTEM_PROMPT)).toBe(true)
    expect(system.content).toContain('BEGIN LOCAL SKILL')
    expect(system.content.trimEnd().endsWith(SKILL_GUARD_LINE)).toBe(true)
  })

  it('grounded answers put the fence in the USER turn, never in system (untrusted reference text)', () => {
    const { db } = envWithSkill()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'What is the balance?' })
    const chunks: RetrievedChunk[] = [
      { id: 'c1', documentId: 'd1', sourceTitle: 'stmt.pdf', text: 'Closing balance 100.', label: 'S1', pageNumber: 1, sectionLabel: null, score: 1 } as unknown as RetrievedChunk
    ]
    const fence = 'FENCE-MARKER\n' + SKILL_GUARD_LINE
    const grounded = buildGroundedPrompt('What is the balance?', chunks, fence)
    expect(grounded).toContain('FENCE-MARKER')
    expect(grounded).toContain('Document excerpts:')
    // RT-2: the grounding rules keep precedence by living in the SYSTEM prompt (≥ the user
    // turn), no longer inline in the user prompt before the fence.
    expect(GROUNDED_SYSTEM_PROMPT).toContain('Use only the document excerpts')
    expect(grounded).not.toContain('Use only the document excerpts')

    const messages = buildGroundedChatMessages(db, conv.id, grounded)
    expect(messages[0].role).toBe('system')
    // The fence is NOT in system (untrusted reference text); the grounded system prompt is
    // the base preamble + the stable grounding rules (RT-2), and starts with the base.
    expect(messages[0].content).toBe(GROUNDED_SYSTEM_PROMPT)
    expect(messages[0].content.startsWith(BASE_SYSTEM_PROMPT)).toBe(true)
    expect(messages[0].content).not.toContain('FENCE-MARKER') // no fence in system
    expect(messages[messages.length - 1].content).toContain('FENCE-MARKER') // fence in the user turn
  })
})

describe('assistant-row stamping (DS16/§22-A5) + the deleted-skill provenance (SKA-38)', () => {
  it('stamps messages.skill_id when a skill shaped the plain-chat turn; resolves the title back', async () => {
    const { db, installId } = envWithSkill()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Summarize.' })
    await generateAssistantMessage(db, runtime(), conv.id, {
      skill: { installId, title: 'Skill bank', body: 'Quote totals.' }
    })
    const msgs = listMessages(db, conv.id)
    const assistant = msgs[msgs.length - 1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.skillId).toBe(installId)
    expect(assistant.skillTitle).toBe('Skill bank')
  })

  it('does NOT stamp a turn produced without a skill', async () => {
    const { db } = envWithSkill()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Hi.' })
    await generateAssistantMessage(db, runtime(), conv.id, {})
    const msgs = listMessages(db, conv.id)
    expect(msgs[msgs.length - 1].skillId ?? null).toBeNull()
  })

  it('keeps the stamped id but drops the JOIN title for a DELETED skill (SKA-38: provenance survives)', async () => {
    // SKA-38 (skills audit 2026-07-03, U6): the provenance is keyed off the PERSISTED `messages.skill_id`
    // now — deleting the skill must NOT erase the glyph + the "answer without it" undo from an
    // already-stamped turn (a disabled skill already kept both). The read keeps `skillId` (raw) and
    // drops only `skillTitle` (no JOIN row); the renderer labels such a turn "(removed skill)".
    const { db, installId } = envWithSkill()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Go.' })
    await generateAssistantMessage(db, runtime(), conv.id, {
      skill: { installId, title: 'Skill bank', body: 'Quote totals.' }
    })
    expect(listMessages(db, conv.id).at(-1)?.skillId).toBe(installId)
    // Delete the skill row — the stamped id SURVIVES (provenance), only the JOIN title is now NULL.
    db.prepare('DELETE FROM skills WHERE install_id = ?').run(installId)
    const after = listMessages(db, conv.id).at(-1)
    expect(after?.skillId).toBe(installId)
    expect(after?.skillTitle ?? null).toBeNull()
  })

  it('does NOT stamp when the fence is omitted for budget (a skill that did not shape the answer)', async () => {
    const { db, installId } = envWithSkill()
    // A tiny context window leaves no room for any fence → omitted → no stamp.
    updateSettings(db, { contextTokens: 64 })
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'A long enough question to matter.' })
    await generateAssistantMessage(db, runtime(), conv.id, {
      skill: { installId, title: 'Skill bank', body: 'x'.repeat(4000) }
    })
    expect(listMessages(db, conv.id).at(-1)?.skillId ?? null).toBeNull()
  })
})

describe('grounded (RAG) stamping carries the skill too (audit A1) — no-context stamps NULL', () => {
  it('a no-context document turn does not stamp the skill (the model was never called)', async () => {
    const { db, installId } = envWithSkill()
    const embedder = new MockEmbedder()
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Anything here?' })
    // Empty corpus → retrieve finds nothing → fixed answer, model not called.
    const msg = await generateGroundedAnswer(
      db,
      runtime(),
      embedder,
      conv.id,
      'Anything here?',
      ragSettingsFrom(DEFAULT_SETTINGS),
      { skill: { installId, title: 'Skill bank', body: 'Quote totals.' } }
    )
    expect(msg.skillId ?? null).toBeNull()
  })
})
