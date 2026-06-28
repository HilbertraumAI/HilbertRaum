import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// Image-analysis history storage (image-understanding history). Mirrors the documents
// encrypted-copy contract: the image rests ENCRYPTED on disk when a cipher is supplied (no
// plaintext leak), round-trips byte-for-byte, and deleting a session SHREDS the stored image
// and CASCADE-removes its turns. Plaintext mode stores a raw copy (same as documents).

import { openDatabase, type Db } from '../../src/main/services/db'
import {
  addImageTurn,
  createImageSession,
  deleteImageSession,
  getImageSession,
  imagesDir,
  listImageSessions
} from '../../src/main/services/vision/history'
import { encryptFile, decryptFile, type DocumentCipher } from '../../src/main/services/workspace-vault'

// A recognizable image-byte pattern no real PNG header would contain — lets us assert the
// ENCRYPTED copy never leaks the plaintext bytes to disk.
const SENTINEL = new Uint8Array([0xab, 0xcd, 0xef, 0x10, 0x20, 0x30, 0x40, 0x50])

function freshWorkspace(): { db: Db; workspacePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-imghist-'))
  return { db: openDatabase(join(root, 'hilbertraum.sqlite')), workspacePath: root }
}

function testCipher(): DocumentCipher {
  const key = randomBytes(32)
  return {
    encryptFile: (src, dest) => encryptFile(src, dest, key),
    decryptFile: (src, dest) => decryptFile(src, dest, key)
  }
}

function leaks(dir: string, needle: Uint8Array): string[] {
  const want = Buffer.from(needle)
  return readdirSync(dir).filter((name) => readFileSync(join(dir, name)).includes(want))
}

describe('image history — encrypted storage', () => {
  it('stores the image ENCRYPTED (no plaintext leak) and round-trips it byte-for-byte', () => {
    const { db, workspacePath } = freshWorkspace()
    const dir = imagesDir(workspacePath)
    const cipher = testCipher()

    const id = createImageSession(
      db,
      dir,
      { imageBytes: SENTINEL, mimeType: 'image/png', name: 'secret.png', width: 4, height: 2 },
      cipher
    )

    // On-disk: exactly one .enc sidecar, no transient temp, no plaintext leak.
    const stored = readdirSync(dir)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatch(/\.enc$/)
    expect(leaks(dir, SENTINEL)).toEqual([])

    // Reopening decrypts back to the original bytes.
    const detail = getImageSession(db, dir, id, cipher)
    expect(detail).not.toBeNull()
    expect(Buffer.from(detail!.imageBytes).equals(Buffer.from(SENTINEL))).toBe(true)
    expect(detail!.title).toBe('secret.png')
    expect(detail!.mimeType).toBe('image/png')
    expect(detail!.width).toBe(4)
    expect(detail!.height).toBe(2)
  })

  it('stores a RAW copy in plaintext mode (no cipher), like documents', () => {
    const { db, workspacePath } = freshWorkspace()
    const dir = imagesDir(workspacePath)

    const id = createImageSession(
      db,
      dir,
      { imageBytes: SENTINEL, mimeType: 'image/jpeg', name: 'plain.jpg' },
      null
    )
    const stored = readdirSync(dir)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatch(/\.jpg$/)

    const detail = getImageSession(db, dir, id, null)
    expect(Buffer.from(detail!.imageBytes).equals(Buffer.from(SENTINEL))).toBe(true)
  })
})

describe('image history — turns + list', () => {
  it('appends turns (oldest first) and lists sessions newest-first with a turn count', async () => {
    const { db, workspacePath } = freshWorkspace()
    const dir = imagesDir(workspacePath)

    const a = createImageSession(db, dir, { imageBytes: SENTINEL, mimeType: 'image/png', name: 'a.png' }, null)
    addImageTurn(db, a, 'q1', 'answer one')
    addImageTurn(db, a, 'q2', 'answer two')
    // A small gap so b's updated_at is strictly later (ISO-8601 ms resolution) — the list is
    // ordered newest-first by updated_at.
    await new Promise((r) => setTimeout(r, 5))
    const b = createImageSession(db, dir, { imageBytes: SENTINEL, mimeType: 'image/png', name: 'b.png' }, null)
    addImageTurn(db, b, 'only', 'b answer')

    const list = listImageSessions(db)
    expect(list).toHaveLength(2)
    // b was updated most recently → first.
    expect(list[0].title).toBe('b.png')
    expect(list[0].turnCount).toBe(1)
    expect(list[0].firstQuestion).toBe('only')
    const aRow = list.find((s) => s.id === a)!
    expect(aRow.turnCount).toBe(2)
    expect(aRow.firstQuestion).toBe('q1')

    const detail = getImageSession(db, dir, a, null)!
    expect(detail.turns.map((t) => t.question)).toEqual(['q1', 'q2'])
    expect(detail.turns.map((t) => t.answer)).toEqual(['answer one', 'answer two'])
  })
})

describe('image history — delete', () => {
  it('shreds the stored image and CASCADE-removes its turns', () => {
    const { db, workspacePath } = freshWorkspace()
    const dir = imagesDir(workspacePath)
    const cipher = testCipher()

    const id = createImageSession(db, dir, { imageBytes: SENTINEL, mimeType: 'image/png', name: 'gone.png' }, cipher)
    addImageTurn(db, id, 'q', 'a')
    const storedName = readdirSync(dir)[0]
    expect(existsSync(join(dir, storedName))).toBe(true)

    deleteImageSession(db, dir, id)

    // File shredded + unlinked; rows gone (turns cascade).
    expect(existsSync(join(dir, storedName))).toBe(false)
    expect(listImageSessions(db)).toHaveLength(0)
    const turns = db.prepare('SELECT COUNT(*) AS n FROM image_turns WHERE session_id = ?').get(id) as {
      n: number
    }
    expect(turns.n).toBe(0)
    // Reopening a deleted session is a clean null.
    expect(getImageSession(db, dir, id, cipher)).toBeNull()
  })

  it('REL-5: a failed row delete leaves the image intact — no undeletable ghost session', () => {
    // The fix deletes the ROW first, then shreds. Inject a failure on the row delete and assert the
    // file was NOT already shredded (the pre-fix shred-then-delete order would leave a row whose
    // image is gone — an unopenable, self-only-healing ghost). With the reorder, a failed delete
    // means nothing was destroyed: the session stays fully openable.
    const { db, workspacePath } = freshWorkspace()
    const dir = imagesDir(workspacePath)
    const id = createImageSession(
      db,
      dir,
      { imageBytes: SENTINEL, mimeType: 'image/png', name: 'keep.png' },
      null
    )
    const storedPath = join(dir, readdirSync(dir)[0])
    expect(existsSync(storedPath)).toBe(true)

    // Only the image_sessions DELETE throws; getRow's SELECT + BEGIN/ROLLBACK hit the real db.
    const wrapped = {
      exec: (sql: string) => db.exec(sql),
      prepare(sql: string) {
        if (sql.startsWith('DELETE FROM image_sessions')) {
          return {
            run: () => {
              throw new Error('injected: image_sessions delete failed')
            }
          }
        }
        return db.prepare(sql)
      }
    } as unknown as Db

    expect(() => deleteImageSession(wrapped, dir, id)).toThrow(/injected/)

    // File never shredded (delete ran first and failed) → the session is still whole + openable.
    expect(existsSync(storedPath)).toBe(true)
    expect(listImageSessions(db)).toHaveLength(1)
    expect(getImageSession(db, dir, id, null)).not.toBeNull()
  })
})
