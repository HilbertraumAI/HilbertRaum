import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db'
import { ENCRYPTED_DOC_SUFFIX, shredFile, type DocumentCipher } from '../workspace-vault'
import type {
  ImageAnalyzeRequest,
  ImageSessionDetail,
  ImageSessionSummary
} from '../../../shared/types'

// Image-understanding history (docs/architecture.md image-understanding record). Mirrors the
// documents storage+encryption contract (ingestion/index.ts): the image bytes are stored
// under workspace/images/ — encrypted as a `.enc` sidecar when the vault is encrypted (the
// SAME DocumentCipher the document cache uses), plaintext otherwise — and the Q&A turns live
// in image_turns. Deleting a session shreds the stored image and CASCADE-removes its turns.
//
// Privacy posture (revised from "nothing persists" — see security-model.md): the history is
// LOCAL-ONLY, encrypted at rest, and user-deletable; bytes are never sent off-device and no
// image/prompt/answer content is logged.

/** Directory that holds workspace copies of analyzed images. Created on demand. */
export function imagesDir(workspacePath: string): string {
  const dir = join(workspacePath, 'images')
  mkdirSync(dir, { recursive: true })
  return dir
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg'
}

function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? '.img'
}

interface SessionRow {
  id: string
  title: string
  stored_name: string
  mime_type: string
  size_bytes: number
  width: number | null
  height: number | null
  encrypted: number
  created_at: string
  updated_at: string
}

function getRow(db: Db, id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM image_sessions WHERE id = ?').get(id) as SessionRow | undefined
}

/**
 * Create a history session for a freshly analyzed image: store the bytes (encrypted when a
 * cipher is supplied — i.e. the vault is encrypted) and insert the metadata row. Returns the
 * new session id. The caller appends turns via {@link addImageTurn} as answers complete.
 */
export function createImageSession(
  db: Db,
  dir: string,
  req: Pick<ImageAnalyzeRequest, 'imageBytes' | 'mimeType' | 'name' | 'width' | 'height'>,
  cipher: DocumentCipher | null
): string {
  const id = randomUUID()
  const ext = extForMime(req.mimeType)
  const now = new Date().toISOString()
  const bytes = Buffer.from(req.imageBytes)

  let storedName: string
  if (cipher) {
    // Encrypted vault: write a short-lived plaintext temp, encrypt it to the .enc sidecar,
    // then shred the temp — identical to how the document cache handles imported copies.
    storedName = `${id}${ext}${ENCRYPTED_DOC_SUFFIX}`
    const tmp = join(dir, `${id}.tmp`)
    writeFileSync(tmp, bytes)
    try {
      cipher.encryptFile(tmp, join(dir, storedName))
    } finally {
      shredFile(tmp)
    }
  } else {
    storedName = `${id}${ext}`
    writeFileSync(join(dir, storedName), bytes)
  }

  db.prepare(
    `INSERT INTO image_sessions
       (id, title, stored_name, mime_type, size_bytes, width, height, encrypted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.name && req.name.trim() ? req.name : 'image',
    storedName,
    req.mimeType,
    bytes.length,
    req.width ?? null,
    req.height ?? null,
    cipher ? 1 : 0,
    now,
    now
  )
  return id
}

/** Append a completed (non-empty) turn and bump the session's updated_at. */
export function addImageTurn(db: Db, sessionId: string, question: string, answer: string): void {
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO image_turns (id, session_id, question, answer, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), sessionId, question, answer, now)
  db.prepare('UPDATE image_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId)
}

/** List history entries, newest first. No image bytes — the row label uses the first question. */
export function listImageSessions(db: Db): ImageSessionSummary[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.mime_type, s.size_bytes, s.width, s.height,
              s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM image_turns t WHERE t.session_id = s.id) AS turn_count,
              (SELECT t.question FROM image_turns t WHERE t.session_id = s.id
                 ORDER BY t.rowid ASC LIMIT 1) AS first_question
         FROM image_sessions s
        ORDER BY s.updated_at DESC, s.rowid DESC`
    )
    .all() as Array<{
    id: string
    title: string
    mime_type: string
    size_bytes: number
    width: number | null
    height: number | null
    created_at: string
    updated_at: string
    turn_count: number
    first_question: string | null
  }>
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    width: r.width,
    height: r.height,
    turnCount: r.turn_count,
    firstQuestion: r.first_question ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

/**
 * Open one history entry: metadata + the DECRYPTED image bytes + all turns (oldest first).
 * `cipher` must be the active vault cipher when the session was stored encrypted (it always
 * is, since the workspace is unlocked to reach here). Returns null if the session is unknown
 * or its stored image is missing.
 */
export function getImageSession(
  db: Db,
  dir: string,
  id: string,
  cipher: DocumentCipher | null
): ImageSessionDetail | null {
  const row = getRow(db, id)
  if (!row) return null

  const stored = join(dir, row.stored_name)
  if (!existsSync(stored)) return null

  let imageBytes: Buffer
  if (row.encrypted) {
    // Decrypt to a short-lived temp, read it, then shred — mirrors document preview. Without
    // a cipher (vault somehow plaintext now) an encrypted entry cannot be read.
    if (!cipher) return null
    const tmp = join(dir, `${id}.read-${process.pid}.tmp`)
    try {
      cipher.decryptFile(stored, tmp)
      imageBytes = readFileSync(tmp)
    } finally {
      if (existsSync(tmp)) shredFile(tmp)
    }
  } else {
    imageBytes = readFileSync(stored)
  }

  const turns = db
    .prepare(
      'SELECT id, question, answer, created_at FROM image_turns WHERE session_id = ? ORDER BY rowid ASC'
    )
    .all(id) as Array<{ id: string; question: string; answer: string; created_at: string }>

  return {
    id: row.id,
    title: row.title,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    imageBytes: new Uint8Array(imageBytes),
    turns: turns.map((t) => ({
      id: t.id,
      question: t.question,
      answer: t.answer,
      createdAt: t.created_at
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Delete one history entry: shred the stored image (best-effort — a missing/locked copy must
 * not block the DB cleanup) then delete the row (turns cascade via ON DELETE CASCADE).
 */
export function deleteImageSession(db: Db, dir: string, id: string): void {
  const row = getRow(db, id)
  if (!row) return
  const stored = join(dir, row.stored_name)
  if (existsSync(stored)) shredFile(stored)
  db.prepare('DELETE FROM image_sessions WHERE id = ?').run(id)
}
