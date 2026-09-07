import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ArchiveOrigin, PackArticleSaveResult } from '../../../shared/types'
import { fileDocumentByDestination } from '../collections'
import type { Db } from '../db'
import { prepareCached } from '../db'
import { tMain } from '../i18n'
import {
  createQueuedDocument,
  deleteDocument,
  processDocument,
  setDocumentOrigin,
  type IngestionDeps
} from '../ingestion'
import { log } from '../logging'
import { shredFile } from '../workspace-vault'
import type { PackArticle } from './index'

// Tier-2 — "Save article to my documents" (#340, owner ruling C3 (a) 2026-09-06; rag-design §17
// D-Z21). A knowledge-pack article the user is reading becomes a REAL document in the corpus:
// the converted plain text (the same sectioned text the viewer shows — never raw archive HTML)
// is written as Markdown and run through the ONE import path (`createQueuedDocument` →
// `processDocument`), exactly as a translation or comparison output is
// (`doctasks/handlers/shared.ts` `materializeDocument`, the precedent this mirrors step for
// step). So the copy is chunked, embedded, FTS-indexed, encrypted at rest and citable like any
// upload — searchable offline without the pack server, alive after the pack is removed, and a
// resolvable identity in evidence reviews (an archive citation resolves as honest `unresolved`,
// D-Z5; a saved copy resolves with a real sha256).
//
// Provenance rides `documents.origin_json` as an `ArchiveOrigin` (the pack UUID, the entry
// path, the archive title, the save time) — stamped at QUEUE time (DM-2) so a crash between
// `indexed` and a later write can never let the Library backfill file the copy as an upload.
// The same three fields are what the duplicate check reads: saving an article twice returns
// the existing document instead of a second copy (the app has no other import-time dedup).
// Unlike a translation or comparison (a generated work-product that deliberately gets NO
// collection membership, D3/N1), a saved article is a user-chosen IMPORT: it is filed into the
// Library once indexed, so the default documents chat — whose scope IS the Library — finds it.
//
// Content rules: the article title and the archive title are CONTENT (S1) — they go into the
// document and its title, never into a log line or an audit row.

/** A saved copy's document title: `<article> (<archive>).md` — the `.md` extension selects the
 *  Markdown parser (headings → chunk sections), as `translatedDocumentTitle` forces it. */
export const ARTICLE_TITLE_MAX_CHARS = 180

export function articleDocumentTitle(articleTitle: string, archiveTitle: string | null): string {
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim()
  // Cut by code point, never by UTF-16 unit — a lone surrogate is not a title character.
  const cut = (s: string, n: number): string => Array.from(s).slice(0, Math.max(n, 1)).join('').trimEnd()
  const base = clean(articleTitle) || 'Article'
  let archive = archiveTitle ? clean(archiveTitle) : ''
  if (archive.length > ARTICLE_TITLE_MAX_CHARS / 2) archive = cut(archive, ARTICLE_TITLE_MAX_CHARS / 2)
  // The parenthetical stays whole; an over-long ARTICLE title is what gets shortened.
  const room = ARTICLE_TITLE_MAX_CHARS - (archive ? archive.length + 3 : 0)
  const head = base.length > room ? cut(base, room) : base
  return `${archive ? `${head} (${archive})` : head}.md`
}

/**
 * The Markdown the import path parses: `# title`, an attribution block-quote, an honest notice
 * when the converter stopped short, then one `## label` section per viewer section (the
 * label-less lead stays plain). `MarkdownParser` turns each heading into a chunk
 * `section_label`, so a citation into the saved copy names the same section the viewer showed.
 */
export function renderArticleMarkdown(
  article: PackArticle,
  meta: { archiveTitle: string | null; savedAt: string }
): string {
  const title = article.title.replace(/\s+/g, ' ').trim() || 'Article'
  const lines: string[] = [`# ${title}`, '']
  const from = meta.archiveTitle ? ` from the knowledge pack "${meta.archiveTitle.replace(/\s+/g, ' ').trim()}"` : ''
  lines.push(`> Offline copy of the article "${title}"${from}, saved with HilbertRaum on ${meta.savedAt.slice(0, 10)}.`)
  if (article.partial) {
    lines.push('>', '> Only the first part of the article could be copied: the converter stopped short of the whole text.')
  }
  lines.push('')
  for (const section of article.sections) {
    const text = section.text.trim()
    if (section.label) {
      const label = section.label.replace(/\s+/g, ' ').trim()
      lines.push(`## ${label}`, '')
    }
    if (text.length > 0) lines.push(text, '')
  }
  return lines.join('\n')
}

/** The INDEXED copy of this exact pack entry, if one exists. `deleteDocument` is a hard delete,
 *  so a copy the user removed can be saved again; a crash-interrupted save that the startup
 *  reconciliation flipped to `failed` (its transient already shredded) must not block a fresh
 *  save either — hence the status filter, not a "not deleted" one. */
export function findSavedArticle(
  db: Db,
  packId: string,
  articlePath: string
): { id: string; title: string } | null {
  const row = prepareCached(
    db,
    `SELECT id, title FROM documents
      WHERE status = 'indexed'
        AND origin_json IS NOT NULL
        AND json_extract(origin_json, '$.type') = 'archive'
        AND json_extract(origin_json, '$.packId') = ?
        AND json_extract(origin_json, '$.articlePath') = ?
      ORDER BY created_at DESC LIMIT 1`
  ).get(packId, articlePath) as { id: string; title: string } | undefined
  return row ? { id: row.id, title: row.title } : null
}

export interface SaveArticleDeps {
  db: Db
  /** `documentsDir(workspacePath)` — where the stored copies and the `.parse` transient live. */
  storeDir: string
  ingestion: IngestionDeps
  /** The vault lease (`WorkspaceController.beginDocumentWork`) — held for exactly this step. */
  beginDocumentWork: () => () => void
  /** Called with the new row's id as soon as it exists, so the caller can hold it as busy
   *  (the docs IPC delete / re-index guards) for the seconds the import runs. */
  onQueued?: (documentId: string) => void
  now?: () => string
}

/**
 * Materialise one article as a document. Mirrors `materializeDocument`: the lease, the
 * `.parse.md` transient registered on the documents' plaintext registry (a lock/quit sweeps
 * it), the queue-time provenance stamp, the roll-back with `deleteDocument` unless the import
 * reached `indexed`, the shred in `finally`. Returns the new document; a duplicate is answered
 * by the caller BEFORE this runs (`findSavedArticle`).
 */
export async function saveArticleAsDocument(
  deps: SaveArticleDeps,
  article: PackArticle,
  source: { packId: string; articlePath: string; archiveTitle: string | null }
): Promise<PackArticleSaveResult> {
  const release = deps.beginDocumentWork()
  const savedAt = (deps.now ?? (() => new Date().toISOString()))()
  const tempPath = join(deps.storeDir, `${randomUUID()}.parse.md`)
  const op = deps.ingestion.plaintextOps?.register('article-save')
  op?.track(tempPath)
  let newDocId: string | null = null
  try {
    mkdirSync(deps.storeDir, { recursive: true })
    writeFileSync(tempPath, renderArticleMarkdown(article, { archiveTitle: source.archiveTitle, savedAt }), 'utf8')
    const origin: ArchiveOrigin = {
      type: 'archive',
      packId: source.packId,
      articlePath: source.articlePath,
      archiveTitle: source.archiveTitle,
      createdAt: savedAt
    }
    const title = articleDocumentTitle(article.title, source.archiveTitle)
    const info = createQueuedDocument(deps.db, tempPath, { displayTitle: title, origin })
    newDocId = info.id
    deps.onQueued?.(info.id)
    const result = await processDocument(deps.db, deps.storeDir, info.id, deps.ingestion)
    if (result.status !== 'indexed') {
      // Never a half-born row: the import failed, so nothing persists. Only the status and
      // the error CLASS reach the log — the title and path are content.
      log.error('Saving a knowledge-pack article as a document failed', {
        status: result.status,
        error: result.errorMessage ? result.errorMessage.split(':')[0] : null
      })
      throw new Error(tMain('main.zim.saveFailed'))
    }
    setDocumentOrigin(deps.db, info.id, origin)
    // A user-chosen import, not a generated work-product: file it into the Library (the
    // default chat scope) — `fileFromPendingDestination` skips every row that carries an origin.
    fileDocumentByDestination(deps.db, info.id, { kind: 'library' })
    return { documentId: info.id, title, alreadySaved: false, chunkCount: result.chunkCount }
  } catch (err) {
    if (newDocId) deleteDocument(deps.db, deps.storeDir, newDocId)
    throw err
  } finally {
    shredFile(tempPath)
    op?.release()
    release()
  }
}
