import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import type { AuditEvent, AuditEventType } from '../../shared/types'

// Audit log over the spec §8 `runtime_events` table (Phase 19,
// architecture.md "Audit log") — the user's local answer to "what did this app do,
// when", without reading app.log. NOT telemetry: the log lives in the workspace DB
// (encrypted at rest on encrypted workspaces, exactly like chats) and nothing here ever
// leaves the device (spec §7.11).
//
// Invariants:
// - `recordEvent` NEVER throws — an audit failure must never break the operation it
//   records. Callers in the IPC layer go through an `AuditRecorder` (below), which also
//   absorbs a locked workspace (`ctx.db` throws while locked) by buffering in memory.
// - PRIVACY RULE (hard): `message`/`metadata` carry ids, model ids, filenames, and
//   counts — NEVER chat content, document text, or passwords. Enforced by review at the
//   call sites + the sentinel-grep test in tests/integration/audit-ipc.test.ts.
// - Retention: the table is pruned to the newest `AUDIT_MAX_ROWS` rows on every insert
//   (decision D7: fixed for wave 1) — bounded table, no vacuum ceremony.

/** Fixed retention ceiling (decision D7 — configurability is Office-edition surface). */
export const AUDIT_MAX_ROWS = 5000

/** Newest-first ordering: ISO-8601 `created_at`, with rowid breaking equal-ms ties. */
const NEWEST_FIRST = 'ORDER BY created_at DESC, rowid DESC'

/**
 * Drop everything older than the newest `maxRows` events. Exported for tests; callers
 * normally rely on `recordEvent` doing this per insert.
 */
export function pruneAuditEvents(db: Db, maxRows: number = AUDIT_MAX_ROWS): void {
  db.prepare(
    `DELETE FROM runtime_events WHERE rowid IN
       (SELECT rowid FROM runtime_events ${NEWEST_FIRST} LIMIT -1 OFFSET ?)`
  ).run(maxRows)
}

/**
 * Record one audit event and prune to the retention ceiling. Returns false (and stays
 * silent) on ANY failure — auditing must never break the operation it records.
 */
export function recordEvent(
  db: Db,
  type: AuditEventType,
  message: string,
  metadata?: Record<string, unknown>,
  createdAt: string = new Date().toISOString()
): boolean {
  try {
    db.prepare(
      `INSERT INTO runtime_events (id, event_type, message, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID(), type, message, metadata ? JSON.stringify(metadata) : null, createdAt)
    pruneAuditEvents(db)
    return true
  } catch {
    return false
  }
}

export interface ListAuditEventsOptions {
  /** Page size, newest-first. Clamped to 1..AUDIT_MAX_ROWS; default 100. */
  limit?: number
  /** Return only events strictly OLDER than this event id (pagination cursor). */
  beforeId?: string | null
}

/** Read audit events newest-first. An unknown `beforeId` reads from the newest. */
export function listAuditEvents(db: Db, opts: ListAuditEventsOptions = {}): AuditEvent[] {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100), AUDIT_MAX_ROWS))
  let where = ''
  const params: Array<string | number> = []
  if (opts.beforeId) {
    const anchor = db
      .prepare('SELECT created_at, rowid FROM runtime_events WHERE id = ?')
      .get(opts.beforeId) as { created_at: string; rowid: number } | undefined
    if (anchor) {
      where = 'WHERE created_at < ? OR (created_at = ? AND rowid < ?)'
      params.push(anchor.created_at, anchor.created_at, anchor.rowid)
    }
  }
  const rows = db
    .prepare(
      `SELECT id, event_type, message, metadata_json, created_at
       FROM runtime_events ${where} ${NEWEST_FIRST} LIMIT ?`
    )
    .all(...params, limit) as Array<{
    id: string
    event_type: string
    message: string
    metadata_json: string | null
    created_at: string
  }>
  return rows.map((r) => ({
    id: r.id,
    type: r.event_type as AuditEventType,
    message: r.message,
    metadata: parseMetadata(r.metadata_json),
    createdAt: r.created_at
  }))
}

function parseMetadata(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    const value = JSON.parse(json) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The fire-and-forget recorder the IPC layer calls (`ctx.audit`). Never throws. */
export type AuditRecorder = (
  type: AuditEventType,
  message: string,
  metadata?: Record<string, unknown>
) => void

/** Events buffered while the workspace DB is unavailable (locked). Memory-only, bounded. */
const PENDING_MAX = 100

interface PendingEvent {
  type: AuditEventType
  message: string
  metadata?: Record<string, unknown>
  createdAt: string
}

/**
 * Build the app-wide recorder over a DB *getter* (the `ctx.db` workspace getter throws
 * while the vault is locked). Events that cannot be written yet — most importantly
 * `workspace_unlock_failed`, which by definition happens while the DB is still locked —
 * are buffered in memory (bounded, oldest dropped) and flushed in order on the next
 * successful write, keeping their original timestamps.
 */
export function createAuditRecorder(getDb: () => Db): AuditRecorder {
  const pending: PendingEvent[] = []
  const buffer = (entry: PendingEvent): void => {
    pending.push(entry)
    if (pending.length > PENDING_MAX) pending.shift()
  }
  return (type, message, metadata) => {
    const entry: PendingEvent = { type, message, metadata, createdAt: new Date().toISOString() }
    let db: Db
    try {
      db = getDb()
    } catch {
      buffer(entry) // locked workspace — flushed after the next unlock
      return
    }
    while (pending.length > 0) {
      const head = pending[0]
      if (!recordEvent(db, head.type, head.message, head.metadata, head.createdAt)) break
      pending.shift()
    }
    if (!recordEvent(db, entry.type, entry.message, entry.metadata, entry.createdAt)) {
      buffer(entry)
    }
  }
}
