import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parseSkillMarkdown } from '../../src/shared/skill-manifest'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  reconcileSkills,
  getSkill,
  listSkills,
  skillInstallId
} from '../../src/main/services/skills/registry'
import { recordToInfo } from '../../src/main/services/skills/installer'
import { runDocumentRedaction } from '../../src/main/services/skills/run'
import { runnableToolsForSkill, buildToolRunner } from '../../src/main/services/skills/tool-runs'
import type { AuditEventType, RunnableTool } from '../../src/shared/types'

// architecture.md "Skills — design record" §8 — the THIRD bundled Tier-2 skill: document-redaction.
// It exercises the read-transform-export shape (no content-class data table — the deliverable is a
// file): the committed package parses to a kind:'tool' skill reserving exactly `redact_document`, is
// discovered + enabled, surfaces one confirm-gated runnable tool, and the run seam reads → masks →
// writes the redacted copy via a stub saveTextFile, reporting only the count + a 'redacted'/'clean'
// discriminator. The cancelled-save calm path and a write-failure are covered too.

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const APP_SKILLS_DIR = join(REPO_ROOT, 'app-skills')
const REDACTION_SKILL_MD = readFileSync(join(APP_SKILLS_DIR, 'document-redaction', 'SKILL.md'), 'utf8')

const PII_TEXT = [
  'Reach Jane at jane.doe@example.com or call +43 660 1234567.',
  'Account IBAN AT61 1904 3002 3457 3201, opened on 2026-03-15.',
  'More at https://example.com/profile.'
].join('\n')

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-redaction-')), 'test.sqlite'))
}

function deps(): { appSkillsDir: string; userSkillsDir: string } {
  return {
    appSkillsDir: APP_SKILLS_DIR,
    userSkillsDir: join(mkdtempSync(join(tmpdir(), 'hilbertraum-redaction-user-')), 'user-skills')
  }
}

function seedDocWithChunks(db: Db, text: string): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at)
     VALUES (?, 'Memo', 'indexed', 'text/plain', ?, ?)`
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

describe('document-redaction — committed SKILL.md is a Tier-2 tool skill', () => {
  it('parses with kind:tool, the one allowedTool, and reservesTools true', () => {
    const parsed = parseSkillMarkdown(REDACTION_SKILL_MD)
    expect(parsed.errors).toEqual([])
    expect(parsed.ok).toBe(true)
    const m = parsed.manifest!
    expect(m.id).toBe('document-redaction')
    expect(m.kind).toBe('tool')
    expect(m.allowedTools).toEqual(['redact_document'])
    expect(m.reservesTools).toBe(true)
    // v1 permission ceiling holds.
    expect(m.permissions.network).toBe('denied')
    expect(m.permissions.documents).toBe('selected_only')
  })

  it('covers English + German triggers, singular and plural', () => {
    const kws = parseSkillMarkdown(REDACTION_SKILL_MD).manifest!.triggers.keywords
    // English.
    expect(kws).toContain('redact')
    expect(kws).toContain('anonymize')
    expect(kws).toContain('remove personal data')
    // German singular + plural (the ending breaks the substring, so both are listed).
    expect(kws).toContain('anonymisieren')
    expect(kws).toContain('anonymisierung')
    expect(kws).toContain('schwärzen')
    expect(kws).toContain('schwärzung')
    expect(kws).toContain('personenbezogene daten')
    // The PII-CONTENT topics stay — the informational dry-run (PII_TOPIC_RE) acts on them.
    expect(kws).toContain('sensitive data')
    expect(kws).toContain('sensible daten')
    // It is intent-driven, not filename-driven.
    expect(parseSkillMarkdown(REDACTION_SKILL_MD).manifest!.triggers.filenamePatterns).toEqual([])
  })

  it('U4/§4.4: the pure legal words (datenschutz/dsgvo/gdpr) are DROPPED from the manifest', () => {
    // The handler acts on NEITHER routeMatch NOR the informational PII_TOPIC_RE for these, so keeping
    // them let redaction offer/auto-fire a wrong-flavoured fence on "Was regelt die DSGVO?". Aligning the
    // manifest to the handler = removing them.
    const kws = parseSkillMarkdown(REDACTION_SKILL_MD).manifest!.triggers.keywords.map((k) => k.toLowerCase())
    for (const legal of ['datenschutz', 'dsgvo', 'gdpr']) expect(kws).not.toContain(legal)
  })
})

describe('document-redaction — discovery + reconcile', () => {
  it('discovers and reconciles the committed app skill as enabled, with its tool effective', () => {
    const db = freshDb()
    const d = deps()
    const res = reconcileSkills(db, d)
    expect(res.errors).toEqual([])

    const record = getSkill(db, skillInstallId('app', 'document-redaction'))
    expect(record, 'document-redaction must be discovered from app-skills/').not.toBeNull()
    expect(record!.enabled).toBe(true)
    expect(record!.source).toBe('app')
    expect(record!.trustedLevel).toBe('app')
    expect(record!.kind).toBe('tool')
    expect(record!.manifest.allowedTools).toEqual(['redact_document'])
    expect(record!.manifest.reservesTools).toBe(true)
    expect(recordToInfo(record!, false).reservesTools).toBe(true)

    const appSkills = listSkills(db).filter((s) => s.source === 'app')
    expect(appSkills.map((s) => s.id)).toContain('document-redaction')
  })
})

describe('document-redaction — the dispatch surfaces one confirm-gated tool', () => {
  it('runnableToolsForSkill returns redact_document, confirm-gated', () => {
    const db = freshDb()
    reconcileSkills(db, deps())
    const record = getSkill(db, skillInstallId('app', 'document-redaction'))!
    expect(runnableToolsForSkill(record)).toEqual<RunnableTool[]>([
      { name: 'redact_document', requiresConfirmation: true }
    ])
  })

  it('buildToolRunner needs the save capability (null without it, non-null with it)', () => {
    const db = freshDb()
    const { audit } = capturingAudit()
    const args = { skillInstallId: 'app:document-redaction', conversationId: '', documentId: 'd1' }
    expect(buildToolRunner(db, 'redact_document', args, audit)).toBeNull()
    expect(
      buildToolRunner(db, 'redact_document', args, audit, { saveTextFile: async () => true })
    ).not.toBeNull()
  })
})

describe('document-redaction — the run seam (read → mask → write) on a real DB', () => {
  const skillInstallId = 'app:document-redaction'

  it('runDocumentRedaction masks the PII, writes the redacted copy, and reports the count + resultKind', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, PII_TEXT)
    const { audit, events } = capturingAudit()
    let written: { name: string; content: string } | null = null
    const res = await runDocumentRedaction(db, { skillInstallId, documentId: docId }, {
      audit,
      confirmed: true,
      saveTextFile: async (name, content) => {
        written = { name, content }
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(res.redactionCount).toBe(5)
    expect(res.resultKind).toBe('redacted')
    // The redacted copy was written (default file name) with the personal data masked, not present.
    expect(written!.name).toBe('redacted.txt')
    expect(written!.content).toContain('[EMAIL]')
    expect(written!.content).toContain('[IBAN]')
    expect(written!.content).not.toContain('jane.doe@example.com')
    expect(written!.content).not.toContain('AT61 1904 3002 3457 3201')
    // The run row is recorded done with NO result_ref (no DB artifact) — counts only.
    const run = db.prepare('SELECT * FROM skill_runs WHERE id = ?').get(res.runId) as Record<string, unknown>
    expect(run.status).toBe('done')
    expect(run.result_ref).toBeNull()
    // The gate audited the run, ids/counts only.
    expect((events as Array<{ type: string }>).map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_done'])
  })

  it('SKA-27 rider (R9): a transient finishRun(done) throw after the write neither fails the run nor strands it', async () => {
    // Redaction is the OTHER dialog-shaped seam: pre-R9 an unguarded terminal 'done' throw (workspace
    // transiently locked during the minutes-open dialog) fell into the outer B4 catch, stamping the run
    // 'failed' and reporting "Nothing was changed." after the redacted copy WAS written.
    const db = freshDb()
    const docId = seedDocWithChunks(db, PII_TEXT)
    const { audit } = capturingAudit()
    let fileWritten = false
    let failuresInjected = 0
    const realPrepare = db.prepare.bind(db)
    ;(db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (fileWritten && failuresInjected === 0 && /UPDATE skill_runs SET status/.test(sql)) {
        failuresInjected++
        throw new Error('database is locked')
      }
      return realPrepare(sql)
    }) as typeof db.prepare
    try {
      const res = await runDocumentRedaction(db, { skillInstallId, documentId: docId }, {
        audit,
        confirmed: true,
        saveTextFile: async () => {
          fileWritten = true
          return true
        }
      })
      expect(failuresInjected).toBe(1) // the injected throw hit the terminal 'done' write
      expect(res.ok).toBe(true) // the file WAS written — never "failed. Nothing was changed."
      expect(res.redactionCount).toBe(5)
      const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
      expect(run.status).toBe('done') // the guarded retry landed the terminal status
    } finally {
      ;(db as unknown as { prepare: typeof db.prepare }).prepare = realPrepare
    }
  })

  it('writes a FAITHFUL copy from the verbatim segments — newlines preserved, no collapsed chunk text', async () => {
    const db = freshDb()
    // Production chunk text collapses newlines to spaces; saving THAT would hand the user a
    // de-formatted single-line "redacted copy". The injected verbatim segments keep the layout.
    const docId = seedDocWithChunks(db, PII_TEXT.replace(/\n/g, ' '))
    const segments = PII_TEXT.split('\n').map((text, index) => ({ text, page: 1, index }))
    const { audit } = capturingAudit()
    let written: { name: string; content: string } | null = null
    const res = await runDocumentRedaction(db, { skillInstallId, documentId: docId }, {
      audit,
      confirmed: true,
      readDocumentSegments: async () => segments,
      saveTextFile: async (name, content) => {
        written = { name, content }
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(res.redactionCount).toBe(5)
    // The saved copy keeps the three lines (verbatim segments joined by newline), masked — not the
    // single-line collapsed chunk text the seam would otherwise have read.
    expect(written!.content.split('\n')).toHaveLength(3)
    expect(written!.content).toContain('[EMAIL]')
    expect(written!.content).not.toContain('jane.doe@example.com')
  })

  it('a clean document still saves a copy and reports resultKind clean', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, 'A plain memo about the roadmap. Nothing sensitive here.')
    const { audit } = capturingAudit()
    let saved = false
    const res = await runDocumentRedaction(db, { skillInstallId, documentId: docId }, {
      audit,
      confirmed: true,
      saveTextFile: async () => {
        saved = true
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(res.redactionCount).toBe(0)
    expect(res.resultKind).toBe('clean')
    expect(saved).toBe(true)
  })

  it('refuses without confirmation (the gate) — nothing is written', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, PII_TEXT)
    const { audit } = capturingAudit()
    let saveCalled = false
    const res = await runDocumentRedaction(db, { skillInstallId, documentId: docId }, {
      audit,
      saveTextFile: async () => {
        saveCalled = true
        return true
      }
    })
    expect(res.ok).toBe(false)
    expect(saveCalled).toBe(false)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('failed')
  })

  it('a dismissed save persists nothing and reports it calmly (cancelled, not failed)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, PII_TEXT)
    const { audit } = capturingAudit()
    const res = await runDocumentRedaction(db, { skillInstallId, documentId: docId }, {
      audit,
      confirmed: true,
      saveTextFile: async () => false // user dismissed the dialog
    })
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    expect(res.error).toMatch(/cancel/i)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('cancelled')
  })

  it('a throwing save reports a content-free write failure', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, PII_TEXT)
    const { audit } = capturingAudit()
    const res = await runDocumentRedaction(db, { skillInstallId, documentId: docId }, {
      audit,
      confirmed: true,
      saveTextFile: async () => {
        throw new Error('disk full')
      }
    })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('exportWriteFailed')
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('failed')
  })
})
