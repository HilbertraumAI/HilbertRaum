import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parseSkillMarkdown } from '../../src/shared/skill-manifest'
import { openDatabase, type Db } from '../../src/main/services/db'
import { reconcileSkills, getSkill, listSkills, skillInstallId } from '../../src/main/services/skills/registry'
import { recordToInfo } from '../../src/main/services/skills/installer'
import { runDocumentEdit, type OriginalDocumentBytes } from '../../src/main/services/skills/run'
import { runnableToolsForSkill, buildToolRunner } from '../../src/main/services/skills/tool-runs'
import { readDocxTextLayer } from '../../src/main/services/export/docx-rewrite'
import { makeDocx, otherDocxParts } from '../helpers/docx'
import type { AuditEventType, RunnableTool } from '../../src/shared/types'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

// Phase 8 (beta-feedback-2026-07 §11, #23, D76; architecture.md "Skills — design record" §22) — the
// SECOND read-transform-export skill: document-edit. Like redaction, the deliverable is a FILE (no
// content-class data table): the committed package parses to a kind:'tool' skill reserving exactly
// `apply_document_edits`, is discovered + enabled, surfaces one confirm-gated runnable tool, and the run
// seam LOCATES (model) → VERIFIES + SPLICES (app) → writes the edited copy via a stub saveTextFile,
// reporting only the applied/dropped counts + an 'edited'/'editedPartial'/'none' discriminator. Unlike
// redaction there is NO deterministic floor: a missing model / instruction refuses cleanly.

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const APP_SKILLS_DIR = join(REPO_ROOT, 'app-skills')
const EDIT_SKILL_MD = readFileSync(join(APP_SKILLS_DIR, 'document-edit', 'SKILL.md'), 'utf8')

/** A scripted runtime whose `chatStream` replies with `reply(call)` token-by-token — the locate pass sees
 *  fixture edits (the MockRuntime ignores `responseSchema`, so this mirrors it for the seam). */
function scriptedRuntime(
  reply: (call: { messages: ChatMessage[]; options?: RuntimeChatOptions }) => string,
  calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
): ModelRuntime {
  return {
    modelId: 'mock',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      calls.push({ messages, options })
      for (const tok of reply({ messages, options }).match(/\S+\s*/g) ?? []) {
        if (options?.signal?.aborted) return
        yield tok
      }
    }
  }
}

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-edit-')), 'test.sqlite'))
}

function deps(): { appSkillsDir: string; userSkillsDir: string } {
  return {
    appSkillsDir: APP_SKILLS_DIR,
    userSkillsDir: join(mkdtempSync(join(tmpdir(), 'hilbertraum-edit-user-')), 'user-skills')
  }
}

function seedDocWithChunks(db: Db, text: string): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at)
     VALUES (?, 'Vollmacht', 'indexed', 'text/plain', ?, ?)`
  ).run(docId, now, now)
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
     VALUES (?, ?, 0, ?, 'p', 1, ?)`
  ).run(randomUUID(), docId, text, now)
  return docId
}

function capturingAudit(): { audit: (t: AuditEventType, m?: Record<string, unknown>) => void; events: unknown[] } {
  const events: unknown[] = []
  return { audit: (type, meta) => events.push({ type, meta }), events }
}

const skillInstall = 'app:document-edit'

describe('document-edit — committed SKILL.md is a Tier-2 tool skill', () => {
  it('parses with kind:tool, the one allowedTool, reservesTools true, and autoFire off', () => {
    const parsed = parseSkillMarkdown(EDIT_SKILL_MD)
    expect(parsed.errors).toEqual([])
    expect(parsed.ok).toBe(true)
    const m = parsed.manifest!
    expect(m.id).toBe('document-edit')
    expect(m.kind).toBe('tool')
    expect(m.allowedTools).toEqual(['apply_document_edits'])
    expect(m.reservesTools).toBe(true)
    expect(m.triggers.autoFire).not.toBe(true) // a write-edit is deliberately activated, never auto-fired
    expect(m.permissions.network).toBe('denied')
    expect(m.permissions.documents).toBe('selected_only')
  })

  it('covers the English + German find-and-replace triggers', () => {
    const kws = parseSkillMarkdown(EDIT_SKILL_MD).manifest!.triggers.keywords
    expect(kws).toContain('find and replace')
    expect(kws).toContain('replace all')
    expect(kws).toContain('rename')
    expect(kws).toContain('suchen und ersetzen')
    expect(kws).toContain('ersetzen')
    expect(kws).toContain('umbenennen')
  })
})

describe('document-edit — discovery + dispatch', () => {
  it('discovers the committed app skill as enabled, with its tool effective', () => {
    const db = freshDb()
    const res = reconcileSkills(db, deps())
    expect(res.errors).toEqual([])
    const record = getSkill(db, skillInstallId('app', 'document-edit'))
    expect(record, 'document-edit must be discovered from app-skills/').not.toBeNull()
    expect(record!.enabled).toBe(true)
    expect(record!.source).toBe('app')
    expect(record!.kind).toBe('tool')
    expect(record!.manifest.allowedTools).toEqual(['apply_document_edits'])
    expect(recordToInfo(record!, false).reservesTools).toBe(true)
    expect(listSkills(db).filter((s) => s.source === 'app').map((s) => s.id)).toContain('document-edit')
  })

  it('runnableToolsForSkill returns apply_document_edits, confirm-gated', () => {
    const db = freshDb()
    reconcileSkills(db, deps())
    const record = getSkill(db, skillInstallId('app', 'document-edit'))!
    expect(runnableToolsForSkill(record)).toEqual<RunnableTool[]>([
      { name: 'apply_document_edits', requiresConfirmation: true }
    ])
  })

  it('buildToolRunner needs the save capability (null without it, non-null with it)', () => {
    const db = freshDb()
    const { audit } = capturingAudit()
    const args = { skillInstallId: skillInstall, conversationId: '', documentId: 'd1' }
    expect(buildToolRunner(db, 'apply_document_edits', args, audit)).toBeNull()
    expect(buildToolRunner(db, 'apply_document_edits', args, audit, { saveTextFile: async () => true })).not.toBeNull()
  })
})

describe('document-edit — the run seam (locate → verify → splice → write)', () => {
  it('applies a located edit, writes the edited copy, and reports the count + resultKind', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'Der Vertreter kennt den Fall.')
    const { audit, events } = capturingAudit()
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(
      () => JSON.stringify({ edits: [{ line: 1, find: 'Vertreter', occurrence: 1, replace: 'Anwalt' }] }),
      calls
    )
    let written: { name: string; content: string } | null = null
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      confirmed: true,
      runtime,
      instruction: 'replace Vertreter with Anwalt',
      saveTextFile: async (name, content) => {
        written = { name, content }
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(res.editCount).toBe(1)
    expect(res.droppedCount).toBe(0)
    expect(res.resultKind).toBe('edited')
    expect(written!.name).toBe('edited.txt')
    // Only the anchored span changed; everything else byte-identical (D58).
    expect(written!.content).toBe('Der Anwalt kennt den Fall.')
    // Grammar-constrained (D55): the locate call carries the schema at temperature 0, and the instruction rides in.
    expect(calls[0].options?.responseSchema).toBeTruthy()
    expect(calls[0].options?.temperature).toBe(0)
    expect(calls[0].messages[0].content).toContain('replace Vertreter with Anwalt')
    // The run row is recorded done with NO result_ref (no DB artifact); the gate audited ids/counts only.
    const run = db.prepare('SELECT * FROM skill_runs WHERE id = ?').get(res.runId) as Record<string, unknown>
    expect(run.status).toBe('done')
    expect(run.result_ref).toBeNull()
    expect((events as Array<{ type: string }>).map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_done'])
  })

  it('reports editedPartial + a dropped count when some requested text is not found verbatim', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'der A und der B.')
    const { audit } = capturingAudit()
    const runtime = scriptedRuntime(() =>
      JSON.stringify({
        edits: [
          { line: 1, find: 'der', occurrence: 1, replace: 'die' }, // applied
          { line: 1, find: 'Ghost', occurrence: 1, replace: 'X' } // not present verbatim ⇒ dropped
        ]
      })
    )
    let written = ''
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      confirmed: true,
      runtime,
      instruction: 'change der to die',
      saveTextFile: async (_n, content) => {
        written = content
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(res.editCount).toBe(1)
    expect(res.droppedCount).toBe(1)
    expect(res.resultKind).toBe('editedPartial')
    expect(written).toBe('die A und der B.') // only the FIRST 'der' changed (D76 precision)
  })

  it('reports "none" and writes NO file when nothing matches verbatim', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'nothing to change here')
    const { audit } = capturingAudit()
    const runtime = scriptedRuntime(() =>
      JSON.stringify({ edits: [{ line: 1, find: 'Ghost', occurrence: 1, replace: 'X' }] })
    )
    let saveCalled = false
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      confirmed: true,
      runtime,
      instruction: 'replace Ghost with X',
      saveTextFile: async () => {
        saveCalled = true
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(res.editCount).toBe(0)
    expect(res.resultKind).toBe('none')
    expect(saveCalled).toBe(false) // an unchanged file is never dressed up as an edit (D78)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('done')
  })

  it('refuses cleanly with needsModel when no model is running (no floor for edits)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'Der Vertreter kennt den Fall.')
    const { audit } = capturingAudit()
    let saveCalled = false
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      confirmed: true,
      instruction: 'replace Vertreter with Anwalt',
      // no runtime injected
      saveTextFile: async () => {
        saveCalled = true
        return true
      }
    })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('needsModel')
    expect(saveCalled).toBe(false)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('failed')
  })

  it('refuses cleanly with needsInstruction when the edit instruction is empty', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'Der Vertreter kennt den Fall.')
    const { audit } = capturingAudit()
    const runtime = scriptedRuntime(() => JSON.stringify({ edits: [] }))
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      confirmed: true,
      runtime,
      instruction: '   ', // whitespace only
      saveTextFile: async () => true
    })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('needsInstruction')
  })

  it('a cancel during the locate pass writes nothing and reports it calmly (cancelled, not failed)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'Der Vertreter kennt den Fall.')
    const { audit } = capturingAudit()
    const controller = new AbortController()
    let saveCalled = false
    const runtime = scriptedRuntime(() => {
      controller.abort()
      return JSON.stringify({ edits: [] })
    })
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      confirmed: true,
      signal: controller.signal,
      runtime,
      instruction: 'replace Vertreter with Anwalt',
      saveTextFile: async () => {
        saveCalled = true
        return true
      }
    })
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    expect(saveCalled).toBe(false)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('cancelled')
  })

  it('refuses without confirmation UP FRONT — zero model calls, nothing is written (GAP-6)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'Der Vertreter kennt den Fall.')
    const { audit } = capturingAudit()
    const calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }> = []
    const runtime = scriptedRuntime(
      () => JSON.stringify({ edits: [{ line: 1, find: 'Vertreter', occurrence: 1, replace: 'Anwalt' }] }),
      calls
    )
    let saveCalled = false
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      runtime,
      instruction: 'replace Vertreter with Anwalt',
      saveTextFile: async () => {
        saveCalled = true
        return true
      }
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/confirmation/i) // the gate's exact refusal copy, surfaced up front
    expect(saveCalled).toBe(false)
    // GAP-6 (full-audit 2026-07-11): the refusal lands BEFORE the LLM locate pass — pre-fix the
    // whole multi-window locate ran for nothing before the gate refused.
    expect(calls).toHaveLength(0)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('failed')
  })

  // GAP-4 (full-audit 2026-07-11): a user cancel whose in-flight stream rejects with a WRAPPED
  // error (a killed fetch surfaces e.g. 'terminated', not a DOMException named AbortError) must
  // still record a calm 'cancelled' — pre-fix the narrow name-check recorded a 'failed' run with
  // "The edits could not be completed".
  it("a cancel surfacing as a wrapped runtime error records 'cancelled', not 'failed' (GAP-4)", async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'Der Vertreter kennt den Fall.')
    const { audit } = capturingAudit()
    const controller = new AbortController()
    const runtime: ModelRuntime = {
      modelId: 'mock',
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: null }),
      // eslint-disable-next-line require-yield
      async *chatStream() {
        controller.abort() // the user cancels…
        throw new Error('terminated') // …and the aborted request rejects with a plain Error
      }
    }
    let saveCalled = false
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      confirmed: true,
      signal: controller.signal,
      runtime,
      instruction: 'replace Vertreter with Anwalt',
      saveTextFile: async () => {
        saveCalled = true
        return true
      }
    })
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    expect(saveCalled).toBe(false)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('cancelled')
  })

  it('a dismissed save persists nothing and reports it calmly (cancelled, not failed)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'Der Vertreter kennt den Fall.')
    const { audit } = capturingAudit()
    const runtime = scriptedRuntime(() =>
      JSON.stringify({ edits: [{ line: 1, find: 'Vertreter', occurrence: 1, replace: 'Anwalt' }] })
    )
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      confirmed: true,
      runtime,
      instruction: 'replace Vertreter with Anwalt',
      saveTextFile: async () => false // user dismissed the dialog
    })
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('cancelled')
  })
})

describe('document-edit — Phase 9 same-format DOCX export (D77)', () => {
  it('a DOCX source is edited IN PLACE: a .docx copy, spliced <w:t> text, other parts byte-identical', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'ignored — the DOCX branch reads the injected original bytes')
    const original = await makeDocx(['Der Vertreter kennt den Fall.', 'Auch der Vertreter erscheint.'])
    const { audit } = capturingAudit()
    // Rename only the FIRST occurrence (D76 precision) — the second "Vertreter" stays.
    const runtime = scriptedRuntime(() =>
      JSON.stringify({ edits: [{ line: 1, find: 'Vertreter', occurrence: 1, replace: 'Anwalt' }] })
    )
    let savedBinary: { name: string; bytes: Uint8Array } | null = null
    let textCalled = false
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      confirmed: true,
      runtime,
      instruction: 'replace the first Vertreter with Anwalt',
      readOriginalDocument: async (): Promise<OriginalDocumentBytes> => ({ format: 'docx', bytes: original }),
      saveBinaryFile: async (name, bytes) => {
        savedBinary = { name, bytes }
        return true
      },
      saveTextFile: async () => {
        textCalled = true
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(res.editCount).toBe(1)
    expect(res.resultKind).toBe('edited')
    expect(textCalled).toBe(false)
    expect(savedBinary!.name).toBe('edited.docx')
    // Re-read the saved DOCX: paragraph 1's first "Vertreter" became "Anwalt"; the layer text is spliced.
    const layer = await readDocxTextLayer(savedBinary!.bytes)
    expect(layer.text).toBe('Der Anwalt kennt den Fall.\nAuch der Vertreter erscheint.\n')
    // Non-document.xml parts byte-identical (styles/formatting untouched, D77).
    const before = await otherDocxParts(original)
    const after = await otherDocxParts(savedBinary!.bytes)
    for (const [path, b64] of before) expect(after.get(path), `${path} byte-identical`).toBe(b64)
  })

  it('source-format branch: a non-DOCX source keeps the unchanged .txt path (no binary write)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'Der Vertreter kennt den Fall.')
    const { audit } = capturingAudit()
    const runtime = scriptedRuntime(() =>
      JSON.stringify({ edits: [{ line: 1, find: 'Vertreter', occurrence: 1, replace: 'Anwalt' }] })
    )
    let textWrite: string | null = null
    let binaryCalled = false
    const res = await runDocumentEdit(db, { skillInstallId: skillInstall, documentId: docId }, {
      audit,
      confirmed: true,
      runtime,
      instruction: 'replace Vertreter with Anwalt',
      readOriginalDocument: async (): Promise<OriginalDocumentBytes> => ({ format: 'other' }),
      saveBinaryFile: async () => {
        binaryCalled = true
        return true
      },
      saveTextFile: async (name) => {
        textWrite = name
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(binaryCalled).toBe(false)
    expect(textWrite).toBe('edited.txt')
  })
})
