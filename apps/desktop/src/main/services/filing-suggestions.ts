import type {
  Collection,
  DocumentInfo,
  FilingRuleId,
  FilingSuggestion,
  FilingSuggestionResult,
  FilingTarget
} from '../../shared/types'
import type { MessageKey } from '../../shared/i18n'

// Rule-based filing suggestions (document-organization plan §20 Phase F). PURE, LOCAL,
// DETERMINISTIC: given a document + the current collections + the existing documents, propose
// which project it might belong to. No model, no network, no clock, no randomness — the same
// inputs always yield the same ranked output. Tolerant: missing/empty metadata yields no
// suggestion and NEVER throws. A suggestion is INERT — the UI only acts on it when the user
// clicks Apply (plan §5: never silent, never auto-file).
//
// DEFERRED here (owner-gated, NOT built): local-AI / model-based classification (plan §20
// "later"); auto-creating projects from top-level folders at import (plan §11.2 / §21 Q8).

/** Normalize a label for case-insensitive comparison (lowercase + collapse whitespace). */
function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Bilingual filename-pattern tokens (plan §20). Kept deliberately SMALL + documented:
 * an English-canonical project name used when CREATING a project, plus EN-canonical + German
 * match tokens. A token matches as a lowercased substring of the document title. Widen with
 * evidence, never by loosening this table.
 */
interface FilenameCategory {
  /** Canonical English name used for a `kind:'newProject'` suggestion. */
  projectName: string
  /** Lowercased match tokens (EN canonical + German). */
  tokens: string[]
}
const FILENAME_CATEGORIES: FilenameCategory[] = [
  {
    projectName: 'Invoices',
    // invoice / receipt / bill / statement  ·  Rechnung / Beleg / Quittung / Kontoauszug
    tokens: ['invoice', 'receipt', 'bill', 'statement', 'rechnung', 'beleg', 'quittung', 'kontoauszug']
  },
  {
    projectName: 'Contracts',
    // contract / agreement  ·  Vertrag / Vereinbarung
    tokens: ['contract', 'agreement', 'vertrag', 'vereinbarung']
  }
]

/**
 * A document is a valid suggestion SUBJECT only when it is unfiled Library-knowledge-candidate
 * material (plan §7/D3): NOT generated (`origin != null`), NOT Temporary/archived, and NOT
 * already a member of any project. Generated/Temporary/archived docs aren't durable Library
 * knowledge, so they are never proposed for filing.
 */
function isSuggestableSubject(doc: DocumentInfo): boolean {
  if (doc.origin != null) return false
  const lifecycle = doc.lifecycle ?? 'permanent'
  if (lifecycle === 'temporary' || lifecycle === 'archived') return false
  if ((doc.collections ?? []).some((c) => c.type === 'project')) return false
  return true
}

/** Active (non-archived) projects, sorted deterministically (name, then id). */
function activeProjectsOf(collections: Collection[]): Collection[] {
  return collections
    .filter((c) => c.type === 'project' && c.archivedAt == null)
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
}

/**
 * Ranked, de-duped filing suggestions for one document (highest confidence first). Empty when
 * the document isn't a suggestable subject or no rule matches. Pure + tolerant.
 *
 * @param allDocs the existing documents (used by the same-source-folder cohort rule).
 */
export function suggestFilingForDocument(
  doc: DocumentInfo,
  collections: Collection[],
  allDocs: DocumentInfo[]
): FilingSuggestion[] {
  if (!isSuggestableSubject(doc)) return []
  const activeProjects = activeProjectsOf(collections)

  const ranked: FilingSuggestion[] = []
  const seen = new Set<string>()
  // De-dup by TARGET identity so two rules pointing at the same project keep only the
  // higher-ranked (first-pushed) suggestion.
  const push = (
    ruleId: FilingRuleId,
    target: FilingTarget,
    reasonKey: MessageKey,
    reasonParams?: Record<string, string>
  ): void => {
    const key =
      target.kind === 'existingProject' ? `e:${target.collectionId}` : `n:${norm(target.suggestedName)}`
    if (seen.has(key)) return
    seen.add(key)
    ranked.push({ ruleId, target, reasonKey, reasonParams })
  }

  const folder = norm(doc.sourceFolderLabel)
  const folderLabel = doc.sourceFolderLabel ?? ''

  // Rule 1 — folder-name match (highest confidence): the doc's source folder label equals or
  // contains an existing project's name. Exact matches rank before contains-matches.
  if (folder) {
    for (const p of activeProjects) {
      if (norm(p.name) === folder) {
        push('folder-name-match', { kind: 'existingProject', collectionId: p.id }, 'docs.suggest.reason.folder', {
          folder: folderLabel
        })
      }
    }
    for (const p of activeProjects) {
      const name = norm(p.name)
      if (name.length >= 2 && name !== folder && folder.includes(name)) {
        push('folder-name-match', { kind: 'existingProject', collectionId: p.id }, 'docs.suggest.reason.folder', {
          folder: folderLabel
        })
      }
    }
  }

  // Rule 2 — same-source-folder cohort: other documents from the same source folder are
  // already filed in a project ⇒ suggest the most common (deterministic tie-break) such
  // ACTIVE project.
  if (folder) {
    const tally = new Map<string, number>()
    for (const other of allDocs) {
      if (other.id === doc.id) continue
      if (norm(other.sourceFolderLabel) !== folder) continue
      for (const c of other.collections ?? []) {
        if (c.type === 'project') tally.set(c.id, (tally.get(c.id) ?? 0) + 1)
      }
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
    if (best) {
      const p = activeProjects.find((c) => c.id === best[0])
      if (p) {
        push('same-source-folder-cohort', { kind: 'existingProject', collectionId: p.id }, 'docs.suggest.reason.cohort', {
          folder: folderLabel
        })
      }
    }
  }

  // Rule 3 — bilingual filename pattern: the title matches a known category (invoice/rechnung,
  // contract/vertrag, …). Prefer an existing project whose name matches the category; else
  // suggest CREATING one with the category's canonical English name.
  const title = norm(doc.title)
  if (title) {
    for (const cat of FILENAME_CATEGORIES) {
      if (!cat.tokens.some((tok) => title.includes(tok))) continue
      const match = activeProjects.find((p) => {
        const name = norm(p.name)
        return cat.tokens.some((tok) => name.includes(tok))
      })
      if (match) {
        push('filename-pattern', { kind: 'existingProject', collectionId: match.id }, 'docs.suggest.reason.filename')
      } else {
        push('filename-pattern', { kind: 'newProject', suggestedName: cat.projectName }, 'docs.suggest.reason.filename')
      }
    }
  }

  return ranked
}

/**
 * Filing suggestions for every suggestable document in a list (the unfiled set). Only
 * documents with at least one suggestion are returned. Pure + tolerant.
 */
export function suggestFilingForDocuments(
  docs: DocumentInfo[],
  collections: Collection[]
): FilingSuggestionResult[] {
  const out: FilingSuggestionResult[] = []
  for (const doc of docs) {
    const suggestions = suggestFilingForDocument(doc, collections, docs)
    if (suggestions.length > 0) out.push({ documentId: doc.id, suggestions })
  }
  return out
}
