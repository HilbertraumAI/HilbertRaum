import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parseSkillMarkdown } from '../../src/shared/skill-manifest'
import { openDatabase, type Db } from '../../src/main/services/db'
import { reconcileSkills, getSkill, skillInstallId } from '../../src/main/services/skills/registry'
import { suggestSkillsForTurn } from '../../src/main/services/skills/suggest'
import { createConversation } from '../../src/main/services/chat'

// The "Professional Documents" wave — the upgraded Meeting Minutes skill plus four NEW Tier-1
// instruction skills (contract-brief, deadline-obligation-finder, what-changed, share-safe-review).
// Proves, against the COMMITTED app-skills/ packages: every skill parses as a valid bundled skill;
// the four new ones are kind:instruction reserving NO tools; the meeting-protocol id is unchanged
// (old conversations still resolve it); English + German triggers fire the right skill on the REAL
// selector; ambiguous/neutral inputs fire nothing; share-safe-review never displaces the redaction
// tool and what-changed fires on compare/version language.

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const APP_SKILLS_DIR = join(REPO_ROOT, 'app-skills')

const NEW_SKILL_IDS = ['contract-brief', 'deadline-obligation-finder', 'what-changed', 'share-safe-review'] as const
const ALL_PRO_SKILL_IDS = ['meeting-protocol', ...NEW_SKILL_IDS] as const

function readSkillMd(id: string): string {
  return readFileSync(join(APP_SKILLS_DIR, id, 'SKILL.md'), 'utf8')
}

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-prodocs-')), 'test.sqlite'))
}

/** Reconcile against the REAL committed app-skills/ so the live selector sees the shipped triggers. */
function realDeps(): { appSkillsDir: string; userSkillsDir: string } {
  return {
    appSkillsDir: APP_SKILLS_DIR,
    userSkillsDir: join(mkdtempSync(join(tmpdir(), 'hilbertraum-prodocs-user-')), 'user-skills')
  }
}

describe('Professional Documents — every package is a valid bundled skill', () => {
  it('all five skills parse with no errors', () => {
    for (const id of ALL_PRO_SKILL_IDS) {
      const parsed = parseSkillMarkdown(readSkillMd(id))
      expect(parsed.errors, `${id} should parse cleanly`).toEqual([])
      expect(parsed.ok).toBe(true)
      expect(parsed.manifest!.id).toBe(id)
    }
  })

  it('the four new skills are Tier-1 instruction skills with NO tools and a German display name', () => {
    for (const id of NEW_SKILL_IDS) {
      const m = parseSkillMarkdown(readSkillMd(id)).manifest!
      expect(m.kind, `${id} must be instruction`).toBe('instruction')
      expect(m.allowedTools, `${id} must reserve no tools`).toEqual([])
      expect(m.reservesTools, `${id} must not reserve tools`).toBe(false)
      // v1 ceiling holds — no network, documents at most selected_only.
      expect(m.permissions.network).toBe('denied')
      expect(m.permissions.documents).toBe('selected_only')
      expect(m.permissions.filesystem).toBe('skill_resources_only')
      // German localized display metadata is present (parser supports localized.de).
      expect(m.localized?.de?.title, `${id} needs a German title`).toBeTruthy()
      expect(m.localized?.de?.description, `${id} needs a German description`).toBeTruthy()
    }
  })

  it('keeps the meeting-protocol id stable while re-titling it Meeting Minutes (backward compat)', () => {
    const m = parseSkillMarkdown(readSkillMd('meeting-protocol')).manifest!
    expect(m.id).toBe('meeting-protocol') // old conversations/messages still resolve it
    expect(m.kind).toBe('instruction')
    expect(m.allowedTools).toEqual([])
    expect(m.title).toBe('Meeting Minutes')
    expect(m.localized?.de?.title).toBe('Besprechungsprotokoll')
  })

  it('share-safe-review is advisory: instruction-only, declares no redaction tool', () => {
    const m = parseSkillMarkdown(readSkillMd('share-safe-review')).manifest!
    expect(m.kind).toBe('instruction')
    expect(m.allowedTools).toEqual([])
    expect(m.reservesTools).toBe(false)
  })
})

describe('Professional Documents — discovery + reconcile (S3)', () => {
  it('discovers and enables all five committed app skills', () => {
    const db = freshDb()
    reconcileSkills(db, realDeps())
    for (const id of ALL_PRO_SKILL_IDS) {
      const rec = getSkill(db, skillInstallId('app', id))
      expect(rec, `${id} must be discovered from app-skills/`).not.toBeNull()
      expect(rec!.enabled).toBe(true)
      expect(rec!.source).toBe('app')
      expect(rec!.trustedLevel).toBe('app')
      expect(rec!.kind).toBe('instruction')
    }
  })
})

describe('Professional Documents — triggers fire the right skill on the real selector', () => {
  function offerFor(question: string): string | null {
    const db = freshDb()
    reconcileSkills(db, realDeps()) // app skills install enabled
    const conv = createConversation(db, {})
    const out = suggestSkillsForTurn(db, conv.id, question)
    return out.length > 0 ? out[0].installId : null
  }

  // ---- English ----
  it('contract-brief fires for an English contract question', () => {
    expect(offerFor('Please give me a contract brief before signing this agreement.')).toBe('app:contract-brief')
  })
  it('deadline-obligation-finder fires for an English deadlines question', () => {
    expect(offerFor('What are the deadlines and notice periods I need to track?')).toBe(
      'app:deadline-obligation-finder'
    )
  })
  it('what-changed fires for English compare/version language', () => {
    expect(offerFor('What changed between these two versions of the document?')).toBe('app:what-changed')
    expect(offerFor('Compare versions and show me the differences between them.')).toBe('app:what-changed')
  })
  it('share-safe-review fires for an English "before sharing" question', () => {
    expect(offerFor('Is this safe to share before I send it out?')).toBe('app:share-safe-review')
  })
  it('meeting-protocol (Meeting Minutes) fires for an English minutes question', () => {
    expect(offerFor('Please write the meeting minutes with the action items.')).toBe('app:meeting-protocol')
  })

  // ---- German (incl. umlaut/plural forms) ----
  it('contract-brief fires for a German contract question', () => {
    expect(offerFor('Bitte den Vertrag prüfen vor der Unterschrift.')).toBe('app:contract-brief')
  })
  it('deadline-obligation-finder fires for a German Fristen question', () => {
    expect(offerFor('Welche Fristen und Fälligkeiten muss ich beachten?')).toBe(
      'app:deadline-obligation-finder'
    )
  })
  it('what-changed fires for a German "was hat sich geändert" question', () => {
    expect(offerFor('Was hat sich geändert zwischen den Versionen?')).toBe('app:what-changed')
  })
  it('share-safe-review fires for a German "sicher teilen" question', () => {
    expect(offerFor('Kann ich das sicher teilen?')).toBe('app:share-safe-review')
  })
  it('meeting-protocol fires for a German Besprechungsprotokoll question', () => {
    expect(offerFor('Erstelle ein Besprechungsprotokoll mit Beschlüssen und Aufgaben.')).toBe(
      'app:meeting-protocol'
    )
  })

  // ---- Precision: no cross-fire, no spurious fire on neutral/ambiguous input ----
  it('a pure redaction request still suggests the redaction TOOL, not the share-safe advisory', () => {
    expect(offerFor('Bitte dieses Dokument anonymisieren.')).toBe('app:document-redaction')
  })
  it('neutral and ambiguous inputs suggest nothing', () => {
    expect(offerFor("What's the weather like today?")).toBeNull()
    expect(offerFor('Tell me a joke.')).toBeNull()
    expect(offerFor('Sag mir einen Witz.')).toBeNull()
  })
  it('a meeting question does not suggest contract-brief (no cross-contamination)', () => {
    expect(offerFor('Erstelle bitte ein Protokoll dieser Besprechung.')).toBe('app:meeting-protocol')
  })
  it('an invoice question does not suggest contract-brief', () => {
    expect(offerFor('Prüfe die Beträge auf dieser Rechnung.')).toBe('app:invoice')
  })

  // Audit fix: a pure German notice-period question must reach the Deadline finder, not Contract
  // Brief. Both match score 2 on the bare stem ('kündigung' vs 'kündigungsfrist') and Contract sorts
  // first on the tie-break — the added 'frist' keyword tips it to deadline (kündigungsfrist + frist).
  it('a German Kündigungsfrist question goes to the deadline finder, not contract-brief', () => {
    expect(offerFor('Welche Kündigungsfrist muss ich einhalten?')).toBe('app:deadline-obligation-finder')
  })
})

// Audit fix: what-changed's filename patterns were tightened to version-markers only. A common,
// unrelated file (final-report.pdf) in scope must NO LONGER clear the mime+filename suggest bar — a
// lone, generic filename should never offer a document comparison.
describe('what-changed — tightened filename patterns no longer auto-fire on common files', () => {
  function seedIndexedDoc(db: Db, title: string, mime: string): string {
    const now = new Date().toISOString()
    const id = randomUUID()
    db.prepare(
      `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?, ?)`
    ).run(id, title, mime, now, now)
    return id
  }

  it('a generic "final-report.pdf" in scope with an unrelated question suggests nothing', () => {
    const db = freshDb()
    reconcileSkills(db, realDeps())
    const docId = seedIndexedDoc(db, 'final-report.pdf', 'application/pdf')
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    // No question text — only the lone document signal. Under the old broad `*final*` pattern this
    // would have offered what-changed (mime+filename = 2); now it must offer nothing.
    expect(suggestSkillsForTurn(db, conv.id, '')).toEqual([])
  })

  it('a version-marked "contract-v2.pdf" offers nothing on a doc-only turn, and what-changed WITH a keyword', () => {
    const db = freshDb()
    reconcileSkills(db, realDeps())
    const docId = seedIndexedDoc(db, 'contract-v2.pdf', 'application/pdf')
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    // W5 (audit §4.2): a lone document signal (mime + *-v2* / *contract* filename = 2) no longer offers on
    // its own — a suggestion now REQUIRES a keyword hit. So the empty-question turn is inert…
    expect(suggestSkillsForTurn(db, conv.id, '')).toEqual([])
    // …but a compare-shaped question DOES offer what-changed, with the version filename corroborating
    // (its *-v2* pattern + the 'what changed' keyword outscore contract-brief's lone *contract* filename).
    const offer = suggestSkillsForTurn(db, conv.id, 'what changed between these two versions?')
    expect(offer.length).toBe(1)
    expect(offer[0].installId).toBe('app:what-changed')
  })
})
