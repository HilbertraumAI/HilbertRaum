import type { Db } from '../db'
import { listSkills } from './registry'
import { resolveScope } from '../collections'
import { buildScopeFilter } from '../retrieval-scope'
import { selectSuggestion, type SkillCandidate } from './selector'
import { skillNeedsNewerApp } from '../../../shared/skill-manifest'
import type { SkillSuggestion } from '../../../shared/types'

// suggestSkills orchestration (skills plan §10.2/§16, S8). Resolves the conversation's scope
// MAIN-side from the conversationId (§22-C4 — the renderer holds the draft question, NOT the doc
// scope), gathers the in-scope documents' filename/MIME signals, scores every ENABLED skill's cached
// triggers, and returns at most one offer. Pure-ish (db only), so it is integration-testable without
// Electron. LOGS NOTHING — the question + titles are content.

/** Filename + MIME signals of the indexed documents in a conversation's scope (empty-tolerant). */
function inScopeDocSignals(db: Db, conversationId: string): { titles: string[]; mimeTypes: string[] } {
  if (!conversationId) return { titles: [], mimeTypes: [] }
  let scope
  try {
    scope = resolveScope(db, conversationId)
  } catch {
    // Unknown/locked conversation → keyword-only suggestion (no doc signals).
    return { titles: [], mimeTypes: [] }
  }
  const filter = buildScopeFilter(scope, 'd.id')
  const where = filter ? ` AND ${filter.sql}` : ''
  const params = filter ? filter.params : []
  const rows = db
    .prepare(
      `SELECT d.title AS title, d.mime_type AS mime FROM documents d
       WHERE d.status = 'indexed'${where}`
    )
    .all(...params) as Array<{ title: string; mime: string | null }>
  const titles = rows.map((r) => r.title)
  const mimeTypes = rows.map((r) => r.mime).filter((m): m is string => typeof m === 'string' && m.length > 0)
  return { titles, mimeTypes }
}

/**
 * Suggest the one best skill for this turn (or none). Candidates are ENABLED, available skills only
 * (the user already approved them — a crafted document can never *introduce* a skill, §10.2), and
 * compatible with the running app (`appVersion`): a skill that now needs a newer app is never offered
 * even if its `enabled` flag is stale (§6.5/M1 gate at the use-site — keeps the gate airtight).
 * Returns an array (v1: 0 or 1) so the contract stays future-proof.
 */
export function suggestSkillsForTurn(
  db: Db,
  conversationId: string,
  question = '',
  appVersion = ''
): SkillSuggestion[] {
  const candidates: SkillCandidate[] = listSkills(db)
    .filter(
      (s) =>
        s.enabled &&
        s.unavailableAt == null &&
        !skillNeedsNewerApp(s.manifest.compatibility.minAppVersion, appVersion)
    )
    .map((s) => ({ installId: s.installId, title: s.title, triggers: s.manifest.triggers }))
  if (candidates.length === 0) return []
  const { titles, mimeTypes } = inScopeDocSignals(db, conversationId)
  const best = selectSuggestion(candidates, { question, docTitles: titles, docMimeTypes: mimeTypes })
  return best ? [{ installId: best.installId, title: best.title }] : []
}
