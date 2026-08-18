import { randomBytes } from 'node:crypto'
import type { Db } from '../db'

// Local-API access-key store (local-api wave P2) — MAIN-PROCESS-ONLY by design. The key
// must never enter AppSettings: `getSettings` spreads every stored settings row into the
// object it returns to the renderer on three IPC surfaces (`settings:get`, the
// `settings:update` return, the `tryGpuAgain` return), so a settings-row token would sit
// in renderer React state. This module owns the dedicated single-row `local_api_token`
// table instead; the renderer only ever sees `maskToken`'s output, and copying the full
// value to the clipboard happens main-side (P4).

/** Recognizable prefix so a pasted key is identifiable in client configs as HilbertRaum's. */
const TOKEN_PREFIX = 'hr-'

function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

function writeToken(db: Db, token: string): void {
  db.prepare(
    `INSERT INTO local_api_token (id, token, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at`
  ).run(token, new Date().toISOString())
}

/** The stored key, or null when none was ever generated (fresh workspace). */
export function readToken(db: Db): string | null {
  const row = db.prepare('SELECT token FROM local_api_token WHERE id = 1').get() as
    | { token: string }
    | undefined
  return row?.token ?? null
}

/** Single generation site: return the stored key, minting one on first use. */
export function getOrCreateToken(db: Db): string {
  const existing = readToken(db)
  if (existing != null) return existing
  const token = generateToken()
  writeToken(db, token)
  return token
}

/** Regenerate: the old key is invalid the moment this returns. Callers must also abort
 *  active + queued external streams (auth is checked once at admission, so an in-flight
 *  stream would otherwise outlive the rotation — the P4 regenerate flow owns that). */
export function rotateToken(db: Db): string {
  const token = generateToken()
  writeToken(db, token)
  return token
}

/** Display form for the renderer: prefix + ellipsis + last 4 chars. The full value never
 *  crosses IPC. */
export function maskToken(token: string): string {
  return `${TOKEN_PREFIX}…${token.slice(-4)}`
}
