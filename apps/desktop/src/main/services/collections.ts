import { randomUUID } from 'node:crypto'
import { type Db, prepareCached } from './db'
import type {
  Collection,
  CollectionType,
  DocumentCollectionRole,
  DocumentLifecycle,
  DocumentScope,
  ImportDestination,
  RetrievalScope
} from '../../shared/types'

// Collection service (document-organization — design record: rag-design.md §13). The backend
// foundation: CRUD + membership over the additive `collections` / `document_collections`
// tables, plus `resolveScope` (a conversation's stored scope → the `RetrievalScope` that
// retrieval filters by). All local SQLite — no network, no model calls.
//
// The full document-organization feature (project-management IPC, the multi-select scope
// picker, chat attachments via conversation_documents) shipped across Phases A–F; this module
// is its backend half. (The Phase-F rule-based filing-suggestion engine was removed 2026-06-15
// — filing is manual.) Delete-with-documents (shredding genuinely project-only docs via the
// `projectOnlyDocumentIds` C2 predicate below) shipped — see architecture.md §1 C2. Built-ins
// (Library/Temporary) are seeded in db.ts.

function nowIso(): string {
  return new Date().toISOString()
}

interface CollectionRow {
  id: string
  name: string
  type: string
  description: string | null
  builtin: number
  color: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

function rowToCollection(r: CollectionRow): Collection {
  return {
    id: r.id,
    name: r.name,
    type: r.type as CollectionType,
    description: r.description,
    builtin: r.builtin === 1,
    color: r.color,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at
  }
}

/** Coalesce a stored `documents.lifecycle` (NULL ⇒ 'permanent'), the parseScope precedent. */
export function docLifecycle(value: string | null | undefined): DocumentLifecycle {
  return value === 'temporary' || value === 'archived' ? value : 'permanent'
}

/** All collections, built-ins first then by name. */
export function listCollections(db: Db): Collection[] {
  const rows = db
    .prepare('SELECT * FROM collections ORDER BY builtin DESC, name ASC')
    .all() as unknown as CollectionRow[]
  return rows.map(rowToCollection)
}

export function getCollection(db: Db, id: string): Collection | null {
  const row = db
    .prepare('SELECT * FROM collections WHERE id = ?')
    .get(id) as unknown as CollectionRow | undefined
  return row ? rowToCollection(row) : null
}

/** The seeded built-in of a given kind (Library/Temporary), or null if not seeded. */
export function getBuiltinCollection(db: Db, type: 'library' | 'temporary'): Collection | null {
  const row = db
    .prepare('SELECT * FROM collections WHERE type = ? AND builtin = 1 LIMIT 1')
    .get(type) as unknown as CollectionRow | undefined
  return row ? rowToCollection(row) : null
}

export interface CreateCollectionOptions {
  description?: string | null
  color?: string | null
}

/**
 * Create a user collection (a Project). Built-ins are seeded by the migration, never here,
 * so `type` is restricted to non-built-in kinds in v1 (only `'project'` is used).
 */
export function createCollection(
  db: Db,
  name: string,
  type: Exclude<CollectionType, 'library' | 'temporary'> = 'project',
  opts: CreateCollectionOptions = {}
): Collection {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Collection name must not be empty')
  const now = nowIso()
  const coll: Collection = {
    id: randomUUID(),
    name: trimmed,
    type,
    description: opts.description ?? null,
    builtin: false,
    color: opts.color ?? null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null
  }
  db.prepare(
    `INSERT INTO collections (id, name, type, description, builtin, color, created_at, updated_at, archived_at, retention_policy_json)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL)`
  ).run(coll.id, coll.name, coll.type, coll.description, coll.color, coll.createdAt, coll.updatedAt)
  return coll
}

/** Rename a collection. Refuses an empty name or an unknown id. */
export function renameCollection(db: Db, id: string, name: string): Collection {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Collection name must not be empty')
  const existing = getCollection(db, id)
  if (!existing) throw new Error(`Unknown collection: ${id}`)
  const now = nowIso()
  db.prepare('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?').run(trimmed, now, id)
  return { ...existing, name: trimmed, updatedAt: now }
}

/**
 * Archive / unarchive a project (sets/clears `archived_at`). A project-level archive is a
 * scope-target change, NOT a global exclusion (plan C1): the project disappears from the
 * scope picker but its members stay retrievable via their other memberships. Built-ins
 * cannot be archived.
 */
export function setCollectionArchived(db: Db, id: string, archived: boolean): Collection {
  const existing = getCollection(db, id)
  if (!existing) throw new Error(`Unknown collection: ${id}`)
  if (existing.builtin) throw new Error('Built-in collections cannot be archived')
  const now = nowIso()
  const archivedAt = archived ? now : null
  db.prepare('UPDATE collections SET archived_at = ?, updated_at = ? WHERE id = ?').run(
    archivedAt,
    now,
    id
  )
  return { ...existing, archivedAt, updatedAt: now }
}

/**
 * Delete a collection (membership-only): the `collections` row is removed and its
 * `document_collections` rows cascade away (ON DELETE CASCADE), so the documents themselves
 * are untouched (they remain in Library / other projects / unfiled). Built-ins are
 * undeletable. Deleting a project together with its genuinely-project-only documents is a
 * later phase (needs the document-delete/shred path).
 */
export function deleteCollection(db: Db, id: string): void {
  const existing = getCollection(db, id)
  if (!existing) return
  if (existing.builtin) throw new Error('Built-in collections cannot be deleted')
  db.prepare('DELETE FROM collections WHERE id = ?').run(id)
}

/**
 * Add documents to a collection (idempotent — `ON CONFLICT DO NOTHING` on the composite PK,
 * so re-adding is a no-op and a shared document keeps its single chunk/vector set, plan §8.4).
 */
export function addToCollection(
  db: Db,
  documentIds: string[],
  collectionId: string,
  role: DocumentCollectionRole = 'source'
): void {
  const now = nowIso()
  const stmt = db.prepare(
    `INSERT INTO document_collections (document_id, collection_id, role, added_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (document_id, collection_id) DO NOTHING`
  )
  for (const docId of documentIds) stmt.run(docId, collectionId, role, now)
}

/** Remove documents from a collection (no-op for documents that were not members). */
export function removeFromCollection(db: Db, documentIds: string[], collectionId: string): void {
  const stmt = db.prepare(
    'DELETE FROM document_collections WHERE collection_id = ? AND document_id = ?'
  )
  for (const docId of documentIds) stmt.run(collectionId, docId)
}

/** Set the retention lifecycle on documents (plan §8.2; 'permanent'|'temporary'|'archived'). */
export function setDocumentsLifecycle(
  db: Db,
  documentIds: string[],
  lifecycle: DocumentLifecycle
): void {
  const now = nowIso()
  const stmt = db.prepare('UPDATE documents SET lifecycle = ?, updated_at = ? WHERE id = ?')
  for (const docId of documentIds) stmt.run(lifecycle, now, docId)
}

/**
 * Document ids that are GENUINELY project-only (the C2 delete-with-documents predicate,
 * plan §12.3): a member of `collectionId` that has NO OTHER membership of any kind — no
 * Library, no other project, no Temporary. Counting ALL memberships (built-ins included)
 * is the fix for the first draft's bug: a Library+project doc is Library knowledge and
 * must be spared. Returned ids are safe to delete; everything else is only un-filed.
 */
export function projectOnlyDocumentIds(db: Db, collectionId: string): string[] {
  const rows = db
    .prepare(
      `SELECT dc.document_id AS id FROM document_collections dc
       WHERE dc.collection_id = ?
         AND (SELECT COUNT(*) FROM document_collections o
              WHERE o.document_id = dc.document_id AND o.collection_id <> ?) = 0`
    )
    .all(collectionId, collectionId) as unknown as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * File a freshly-indexed document into Library IF it has no membership yet (plan §11.2
 * default destination). Idempotent and safe for re-index: a doc already filed somewhere
 * (e.g. project-only) keeps its membership and is NOT re-filed to Library. This is the
 * Library destination + the no-recorded-intent fallback of `fileFromPendingDestination`
 * (Phase C), so an options-less import still lands in Library and "Library == all" holds.
 */
export function fileIntoLibraryIfUnfiled(db: Db, documentId: string): void {
  const existing = db
    .prepare('SELECT 1 FROM document_collections WHERE document_id = ? LIMIT 1')
    .get(documentId) as unknown as { 1: number } | undefined
  if (existing) return
  const library = getBuiltinCollection(db, 'library')
  if (library) addToCollection(db, [documentId], library.id, 'source')
}

// ---- Phase-C import destination filing (plan §11.3) --------------------------------

/** Tolerant parse of a stored `pending_destination_json`. Malformed/unknown ⇒ null. */
export function parsePendingDestination(json: string | null | undefined): ImportDestination | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Record<string, unknown> | null
    if (!v || typeof v !== 'object') return null
    switch (v.kind) {
      case 'library':
        return { kind: 'library' }
      case 'temporary':
        return { kind: 'temporary' }
      case 'collection':
        return typeof v.collectionId === 'string' && v.collectionId.length > 0
          ? { kind: 'collection', collectionId: v.collectionId }
          : null
      case 'conversation':
        return typeof v.conversationId === 'string' && v.conversationId.length > 0
          ? { kind: 'conversation', conversationId: v.conversationId }
          : null
      default:
        return null
    }
  } catch {
    return null
  }
}

/** File a freshly-indexed document into the built-in Temporary collection + mark it
 *  `lifecycle='temporary'` (plan §7.3/§14.1). Idempotent. */
function fileIntoTemporary(db: Db, documentId: string): void {
  const temporary = getBuiltinCollection(db, 'temporary')
  if (temporary) addToCollection(db, [documentId], temporary.id, 'source')
  setDocumentsLifecycle(db, [documentId], 'temporary')
}

/**
 * Bind a temporary document to the conversation that received it (plan C3/§11.3) — the
 * link is authoritative for "files in this chat", NOT Temporary membership, so a later
 * Keep-in-Library doesn't drop the file from its chat. Append-only/idempotent.
 *
 * **FK-guarded (N3):** the link is written on indexing SUCCESS, which may be seconds after
 * the import was queued; if the conversation was deleted meanwhile the FK on
 * `conversation_id` would raise (and `ON CONFLICT DO NOTHING` catches only the PK conflict,
 * not an FK violation). So verify the conversation still exists first AND wrap the insert in
 * a try/catch for the check-then-insert race — if it is gone, skip the link and leave the
 * doc in Temporary. Returns true when the link was written.
 */
export function linkConversationDocument(
  db: Db,
  conversationId: string,
  documentId: string
): boolean {
  const conv = db
    .prepare('SELECT 1 FROM conversations WHERE id = ?')
    .get(conversationId) as unknown as { 1: number } | undefined
  if (!conv) return false
  try {
    db.prepare(
      `INSERT INTO conversation_documents (conversation_id, document_id, added_at)
       VALUES (?, ?, ?)
       ON CONFLICT (conversation_id, document_id) DO NOTHING`
    ).run(conversationId, documentId, nowIso())
    return true
  } catch {
    // The conversation was deleted between the existence check and the insert — keep the
    // doc in Temporary, drop only the chat binding (its chat no longer exists).
    return false
  }
}

/**
 * Apply an `ImportDestination` to a freshly-indexed document (plan §11.3): write the
 * membership/lifecycle/link it implies. Library ⇒ Library (unfiled-guarded, "Library ==
 * all"); collection ⇒ that project; temporary ⇒ Temporary membership + lifecycle; a
 * conversation ⇒ Temporary + the FK-guarded `conversation_documents` link.
 */
export function fileDocumentByDestination(
  db: Db,
  documentId: string,
  destination: ImportDestination
): void {
  switch (destination.kind) {
    case 'library':
      fileIntoLibraryIfUnfiled(db, documentId)
      break
    case 'collection':
      addToCollection(db, [documentId], destination.collectionId, 'source')
      break
    case 'temporary':
      fileIntoTemporary(db, documentId)
      break
    case 'conversation':
      fileIntoTemporary(db, documentId)
      linkConversationDocument(db, destination.conversationId, documentId)
      break
  }
}

/**
 * File a freshly-indexed document by its persisted `pending_destination_json` (plan §11.3,
 * M1), then clear it. This is the single filing entry point on indexing success — it works
 * for the in-session import loop AND a crash-resume (whoever drives the doc to `indexed`
 * files it to its intended destination). No persisted destination ⇒ the legacy Library
 * default (so old no-options imports stay byte-for-byte). A normal re-index of an
 * already-filed doc is a no-op here (its pending was cleared on first success).
 */
export function fileFromPendingDestination(db: Db, documentId: string): void {
  const row = db
    .prepare('SELECT pending_destination_json, origin_json FROM documents WHERE id = ?')
    .get(documentId) as unknown as
    | { pending_destination_json: string | null; origin_json: string | null }
    | undefined
  // Generated work-products carry provenance (`origin_json`) and NEVER get a membership
  // (D3/N1) — they are reachable only by explicit doc-id. Re-indexing one must not sweep it
  // into Library via the no-intent default below, so skip filing entirely. This keeps the
  // helper safe as the single indexing-success entry point on EVERY driver-to-`indexed`.
  if (row?.origin_json != null) return
  const destination = parsePendingDestination(row?.pending_destination_json)
  if (!destination) {
    // No recorded intent (a pre-Phase-C import, or an options-less call) ⇒ Library default.
    fileIntoLibraryIfUnfiled(db, documentId)
    return
  }
  fileDocumentByDestination(db, documentId, destination)
  db.prepare('UPDATE documents SET pending_destination_json = NULL WHERE id = ?').run(documentId)
}

/** A conversation's temporary-attachment document ids (plan C3 — `conversation_documents`). */
export function conversationAttachmentIds(db: Db, conversationId: string): string[] {
  const rows = db
    .prepare('SELECT document_id FROM conversation_documents WHERE conversation_id = ?')
    .all(conversationId) as unknown as Array<{ document_id: string }>
  return rows.map((r) => r.document_id)
}

/**
 * The collection ids a document currently belongs to (the reverse of
 * `documentIdsInCollection`). Used to snapshot a generated output's source
 * memberships into its provenance at creation time (plan §15.1/§15.2).
 */
export function collectionIdsForDocument(db: Db, documentId: string): string[] {
  const rows = db
    .prepare('SELECT collection_id FROM document_collections WHERE document_id = ?')
    .all(documentId) as unknown as Array<{ collection_id: string }>
  return rows.map((r) => r.collection_id)
}

/** Document ids that belong to a collection (membership listing). */
export function documentIdsInCollection(db: Db, collectionId: string): string[] {
  const rows = db
    .prepare('SELECT document_id FROM document_collections WHERE collection_id = ?')
    .all(collectionId) as unknown as Array<{ document_id: string }>
  return rows.map((r) => r.document_id)
}

// ---- Scope resolution (plan §10.1) -------------------------------------------------

/** Tolerant parse of a stored composite scope (`scope_v2_json`). Malformed ⇒ null. */
export function parseDocumentScope(json: string | null): DocumentScope | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    if (typeof v !== 'object' || v === null) return null
    const o = v as Record<string, unknown>
    const collectionIds = Array.isArray(o.collectionIds)
      ? o.collectionIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : []
    const documentIds = Array.isArray(o.documentIds)
      ? o.documentIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : []
    // A present-but-empty scope is the explicit "All documents" choice — keep it distinct
    // from an absent (NULL) scope, which falls through to the Library default.
    return { collectionIds, documentIds, includeArchived: o.includeArchived === true }
  } catch {
    return null
  }
}

/** Tolerant parse of the legacy `scope_json` doc-id array. Malformed/empty ⇒ null. */
function parseLegacyScope(json: string | null): string[] | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    if (!Array.isArray(v)) return null
    const ids = v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    return ids.length > 0 ? ids : null
  } catch {
    return null
  }
}

interface ScopeRow {
  scope_v2_json: string | null
  scope_json: string | null
  collection_id: string | null
}

/**
 * Resolve the `RetrievalScope` for a conversation (plan §10.1). The composed scope is the
 * UNION of (members of every selected collection) ∪ (specific document ids) ∪ (chat
 * attachments), with archived excluded by default. Resolution order:
 *
 *  1. `scope_v2_json` present ⇒ authoritative composite scope (collections + docs).
 *  2. else legacy fallback: non-empty `scope_json` ⇒ explicit specific-doc scope; else
 *     `collection_id` ⇒ that project; else the Library default (documents-mode default).
 *  3. chat attachments (`conversation_documents`) are ALWAYS merged into `documentIds`.
 *
 * `hasExplicitDocSelection` is set from the user's HAND-PICKED docs BEFORE attachments are
 * merged (N2), so filename auto-scope (plan §10.1 rule 5) can tell a deliberate pick from an
 * attachment. An empty composed scope (explicit "All documents") ⇒ whole corpus.
 */
export function resolveScope(db: Db, conversationId: string): RetrievalScope {
  const row = prepareCached(
    db,
    'SELECT scope_v2_json, scope_json, collection_id FROM conversations WHERE id = ?'
  ).get(conversationId) as unknown as ScopeRow | undefined

  let collectionIds: string[] = []
  let documentIds: string[] = []
  let includeArchived = false
  let hasExplicitDocSelection = false

  const v2 = parseDocumentScope(row?.scope_v2_json ?? null)
  if (v2) {
    collectionIds = v2.collectionIds
    documentIds = [...v2.documentIds]
    includeArchived = v2.includeArchived === true
    hasExplicitDocSelection = v2.documentIds.length > 0
  } else {
    const legacy = parseLegacyScope(row?.scope_json ?? null)
    if (legacy) {
      documentIds = [...legacy]
      hasExplicitDocSelection = true
    } else if (row?.collection_id) {
      collectionIds = [row.collection_id]
    } else {
      // Documents-mode default: the whole Library (plan §9). Absent only if not seeded.
      const lib = getBuiltinCollection(db, 'library')
      if (lib) collectionIds = [lib.id]
    }
  }

  // Rule 1: chat attachments are always unioned in (after the hasExplicitDocSelection flag
  // is fixed, so an attachment never masquerades as a hand-pick — N2).
  const attachments = prepareCached(
    db,
    'SELECT document_id FROM conversation_documents WHERE conversation_id = ?'
  ).all(conversationId) as unknown as Array<{ document_id: string }>
  for (const a of attachments) {
    if (!documentIds.includes(a.document_id)) documentIds.push(a.document_id)
  }

  return {
    collectionIds: collectionIds.length > 0 ? collectionIds : null,
    documentIds: documentIds.length > 0 ? documentIds : null,
    includeArchived,
    hasExplicitDocSelection
  }
}
