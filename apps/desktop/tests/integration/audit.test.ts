import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  AUDIT_MAX_ROWS,
  AUDIT_PRUNE_SLACK,
  createAuditRecorder,
  listAuditEvents,
  pruneAuditEvents,
  recordEvent
} from '../../src/main/services/audit'

// Phase 19 service-level tests (architecture.md "Audit log"): the never-throws
// contract, newest-first paging, the fixed-retention prune (decision D7), and the
// locked-workspace buffering of the app-wide recorder.

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-audit-')), 'test.sqlite'))
}

/** Deterministic, strictly increasing ISO timestamps (second `n` of a fixed minute). */
function at(n: number): string {
  return new Date(Date.UTC(2026, 5, 10, 12, 0, 0, n)).toISOString()
}

describe('recordEvent / listAuditEvents', () => {
  it('records an event with parsed metadata and reads it back newest-first', () => {
    const db = freshDb()
    expect(recordEvent(db, 'model_selected', 'Model selected: m1', { modelId: 'm1' }, at(1))).toBe(
      true
    )
    expect(recordEvent(db, 'runtime_started', 'Model runtime started: m1', undefined, at(2))).toBe(
      true
    )
    const events = listAuditEvents(db)
    expect(events.map((e) => e.type)).toEqual(['runtime_started', 'model_selected'])
    expect(events[1].metadata).toEqual({ modelId: 'm1' })
    expect(events[0].metadata).toBeNull()
    expect(events[0].id).toBeTruthy()
  })

  it('NEVER throws — a broken database yields false, not an error', () => {
    const db = freshDb()
    db.close()
    expect(() => recordEvent(db, 'model_selected', 'after close')).not.toThrow()
    expect(recordEvent(db, 'model_selected', 'after close')).toBe(false)
  })

  it('pages newest-first with limit + the beforeId cursor; an unresolved cursor ENDS pagination (BUG vuln-scan-2026-06-21)', () => {
    const db = freshDb()
    for (let i = 1; i <= 5; i++) recordEvent(db, 'model_selected', `event ${i}`, undefined, at(i))
    const page1 = listAuditEvents(db, { limit: 2 })
    expect(page1.map((e) => e.message)).toEqual(['event 5', 'event 4'])
    const page2 = listAuditEvents(db, { limit: 2, beforeId: page1[1].id })
    expect(page2.map((e) => e.message)).toEqual(['event 3', 'event 2'])
    const page3 = listAuditEvents(db, { limit: 2, beforeId: page2[1].id })
    expect(page3.map((e) => e.message)).toEqual(['event 1'])
    // A cursor whose anchor row is gone (e.g. pruned between fetches) returns an EMPTY page so
    // a paging client terminates — it must NOT silently restart at the newest events (which
    // looped / duplicated the newest page).
    expect(listAuditEvents(db, { limit: 2, beforeId: 'no-such-id' })).toEqual([])
  })

  it('breaks equal-timestamp ties by insertion order (rowid)', () => {
    const db = freshDb()
    const same = at(0)
    recordEvent(db, 'model_selected', 'first', undefined, same)
    recordEvent(db, 'model_selected', 'second', undefined, same)
    expect(listAuditEvents(db).map((e) => e.message)).toEqual(['second', 'first'])
  })
})

describe('retention (decision D7 / PF-3: fixed AUDIT_MAX_ROWS, slack-gated prune on insert)', () => {
  it('pruneAuditEvents keeps only the newest maxRows', () => {
    const db = freshDb()
    for (let i = 1; i <= 12; i++) recordEvent(db, 'model_selected', `event ${i}`, undefined, at(i))
    pruneAuditEvents(db, 10)
    const events = listAuditEvents(db, { limit: 100 })
    expect(events).toHaveLength(10)
    expect(events[events.length - 1].message).toBe('event 3') // 1 and 2 pruned
  })

  // PF-3 (full audit 2026-07-10): the prune no longer runs on EVERY insert (a full-scan DELETE +
  // a second auto-commit fsync per event). recordEvent lets the table drift up to
  // AUDIT_MAX_ROWS + AUDIT_PRUNE_SLACK, then prunes back to AUDIT_MAX_ROWS in one transaction
  // with the triggering insert.
  it('recordEvent prunes back to the ceiling once an insert crosses ceiling + slack', () => {
    const db = freshDb()
    // Seed exactly to the threshold with raw inserts (recordEvent would prune as it goes).
    const insert = db.prepare(
      'INSERT INTO runtime_events (id, event_type, message, metadata_json, created_at) VALUES (?, ?, ?, NULL, ?)'
    )
    const threshold = AUDIT_MAX_ROWS + AUDIT_PRUNE_SLACK
    for (let i = 0; i < threshold; i++) {
      insert.run(`seed-${i}`, 'model_selected', `seed ${i}`, at(i))
    }
    recordEvent(db, 'runtime_started', 'the newest event', undefined, at(threshold))
    const count = db.prepare('SELECT COUNT(*) AS n FROM runtime_events').get() as { n: number }
    expect(count.n).toBe(AUDIT_MAX_ROWS)
    // Ordering preserved: the newest survive — including the event that triggered the prune —
    // and the oldest were the ones dropped.
    const events = listAuditEvents(db, { limit: AUDIT_MAX_ROWS })
    expect(events[0].message).toBe('the newest event')
    expect(events[events.length - 1].message).toBe(`seed ${threshold - AUDIT_MAX_ROWS + 1}`)
  })

  it('below the slack threshold recordEvent inserts WITHOUT pruning (bounded overshoot)', () => {
    const db = freshDb()
    const insert = db.prepare(
      'INSERT INTO runtime_events (id, event_type, message, metadata_json, created_at) VALUES (?, ?, ?, NULL, ?)'
    )
    // One short of triggering: post-insert count == threshold, prune requires strictly greater.
    for (let i = 0; i < AUDIT_MAX_ROWS + AUDIT_PRUNE_SLACK - 1; i++) {
      insert.run(`seed-${i}`, 'model_selected', `seed ${i}`, at(i))
    }
    recordEvent(db, 'model_selected', 'still within slack', undefined, at(AUDIT_MAX_ROWS + AUDIT_PRUNE_SLACK))
    const count = db.prepare('SELECT COUNT(*) AS n FROM runtime_events').get() as { n: number }
    expect(count.n).toBe(AUDIT_MAX_ROWS + AUDIT_PRUNE_SLACK)
    // The next insert crosses the threshold and converges back to the cap.
    recordEvent(db, 'model_selected', 'crosses threshold', undefined, at(AUDIT_MAX_ROWS + AUDIT_PRUNE_SLACK + 1))
    const after = db.prepare('SELECT COUNT(*) AS n FROM runtime_events').get() as { n: number }
    expect(after.n).toBe(AUDIT_MAX_ROWS)
  })

  it('idx_runtime_events_created exists (by NAME via sqlite_master — the prune/order index)', () => {
    const db = freshDb()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_runtime_events_created') as { name: string } | undefined
    expect(row?.name).toBe('idx_runtime_events_created')
  })
})

describe('createAuditRecorder (the ctx.audit recorder)', () => {
  it('buffers events while the DB is unavailable and flushes them, in order, on the next write', () => {
    const db = freshDb()
    let locked = true
    const audit = createAuditRecorder(() => {
      if (locked) throw new Error('Workspace is locked')
      return db
    })

    audit('workspace_unlock_failed', 'Workspace unlock failed (wrong password)')
    audit('workspace_unlock_failed', 'Workspace unlock failed (wrong password)')
    expect(listAuditEvents(db)).toHaveLength(0) // nothing written while locked

    locked = false
    audit('workspace_unlocked', 'Workspace unlocked')
    const events = listAuditEvents(db)
    expect(events.map((e) => e.type)).toEqual([
      'workspace_unlocked',
      'workspace_unlock_failed',
      'workspace_unlock_failed'
    ])
  })

  it('never throws even when every write fails', () => {
    const db = freshDb()
    db.close()
    const audit = createAuditRecorder(() => db)
    expect(() => audit('model_selected', 'event')).not.toThrow()
  })
})
