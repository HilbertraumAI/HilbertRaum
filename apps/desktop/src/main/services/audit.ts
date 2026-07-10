import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import type { AuditEvent, AuditEventType } from '../../shared/types'

// Audit log over the spec §8 `runtime_events` table (architecture.md "Audit log") —
// the user's local answer to "what did this app do, when", without reading app.log.
// NOT telemetry: the log lives in the workspace DB
// (encrypted at rest on encrypted workspaces, exactly like chats) and nothing here ever
// leaves the device (spec §7.11).
//
// Invariants:
// - `recordEvent` NEVER throws — an audit failure must never break the operation it
//   records. Callers in the IPC layer go through an `AuditRecorder` (below), which also
//   absorbs a locked workspace (`ctx.db` throws while locked) by buffering in memory.
// - PRIVACY RULE (hard): `message`/`metadata` carry ids, model ids, and counts —
//   NEVER chat content, document text, passwords, OR user-chosen names. Document
//   titles/filenames and conversation/project names are CONTENT (S1,
//   full-audit-2026-06-30): they can be as sensitive as the text they label
//   (`biopsy-results.pdf`), and the whole log is exfiltrated verbatim by the plaintext
//   activity-log.json export — so a documentId, not its title, goes on record. Enforced
//   by review at the call sites + the sentinel-grep test in
//   tests/integration/audit-ipc.test.ts (the filename basename is now a grepped sentinel).
// - Retention: the table is pruned back to the newest `AUDIT_MAX_ROWS` rows once an insert
//   pushes it past `AUDIT_MAX_ROWS + AUDIT_PRUNE_SLACK` (PF-3, full audit 2026-07-10 — a
//   bounded overshoot instead of a DELETE + second fsync per event) — bounded table, no
//   vacuum ceremony. Readers never see the slack: `listAuditEvents` pages newest-first and
//   clamps `limit` to AUDIT_MAX_ROWS.

/** Fixed retention ceiling — deliberately not configurable in this edition. */
export const AUDIT_MAX_ROWS = 5000

/**
 * PF-3: how far past the ceiling the table may drift before `recordEvent` prunes. Keeps the
 * common insert a single statement (the COUNT is a cheap index-only scan over
 * idx_runtime_events_created); when the threshold is crossed, insert + prune run in ONE
 * transaction (one commit, not two auto-commit fsyncs).
 */
export const AUDIT_PRUNE_SLACK = 250

/** Newest-first ordering: ISO-8601 `created_at`, with rowid breaking equal-ms ties. */
const NEWEST_FIRST = 'ORDER BY created_at DESC, rowid DESC'

/**
 * Drop everything older than the newest `maxRows` events (an ordered scan over
 * idx_runtime_events_created, not a full-table sort). Exported for tests; callers normally
 * rely on `recordEvent` doing this once the table drifts past the slack threshold.
 */
export function pruneAuditEvents(db: Db, maxRows: number = AUDIT_MAX_ROWS): void {
  db.prepare(
    `DELETE FROM runtime_events WHERE rowid IN
       (SELECT rowid FROM runtime_events ${NEWEST_FIRST} LIMIT -1 OFFSET ?)`
  ).run(maxRows)
}

/**
 * Record one audit event, pruning back to the retention ceiling once the table exceeds
 * ceiling + slack (PF-3 — not on every insert). Returns false (and stays silent) on ANY
 * failure — auditing must never break the operation it records.
 */
export function recordEvent(
  db: Db,
  type: AuditEventType,
  message: string,
  metadata?: Record<string, unknown>,
  createdAt: string = new Date().toISOString()
): boolean {
  try {
    const insert = db.prepare(
      `INSERT INTO runtime_events (id, event_type, message, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    const params = [
      randomUUID(),
      type,
      message,
      metadata ? JSON.stringify(metadata) : null,
      createdAt
    ] as const
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM runtime_events').get() as { n: number }
    if (n + 1 > AUDIT_MAX_ROWS + AUDIT_PRUNE_SLACK) {
      // Insert + prune as ONE transaction — one commit fsync, and the prune can never land
      // without its triggering insert.
      db.exec('BEGIN')
      try {
        insert.run(...params)
        pruneAuditEvents(db)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err // → the outer catch; the never-throws contract stays at recordEvent's edge
      }
    } else {
      insert.run(...params)
    }
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

/**
 * Read audit events newest-first. A supplied `beforeId` whose anchor row no longer exists
 * (e.g. the cursor event was pruned by retention between page fetches) returns an EMPTY page,
 * terminating pagination — NOT the newest page, which made a client paging toward older events
 * loop / show duplicates (BUG vuln-scan-2026-06-21).
 */
export function listAuditEvents(db: Db, opts: ListAuditEventsOptions = {}): AuditEvent[] {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100), AUDIT_MAX_ROWS))
  let where = ''
  const params: Array<string | number> = []
  if (opts.beforeId) {
    const anchor = db
      .prepare('SELECT created_at, rowid FROM runtime_events WHERE id = ?')
      .get(opts.beforeId) as { created_at: string; rowid: number } | undefined
    // An unresolved cursor means "older than a row that's gone" — there is nothing newer we
    // should honestly return, so stop here rather than restarting at the top.
    if (!anchor) return []
    where = 'WHERE created_at < ? OR (created_at = ? AND rowid < ?)'
    params.push(anchor.created_at, anchor.created_at, anchor.rowid)
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
