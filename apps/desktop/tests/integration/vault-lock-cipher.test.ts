import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  decryptFile,
  WorkspaceController,
  ENCRYPTED_DOC_SUFFIX,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import {
  createQueuedDocument,
  prepareDocument,
  documentsDir
} from '../../src/main/services/ingestion'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy } from '../../src/shared/types'
import type { KdfParams } from '../../src/main/services/security/crypto'

// full-audit 2026-07-12 SEC-1 — a DocumentCipher captured BEFORE "Lock now" must fail closed
// when invoked AFTER lock() zeroed the vault key. Previously `documentCipher()` closed over the
// key Buffer object itself; `lock()` fills it with zeros in place, so a cipher captured by an
// in-flight import kept "working" — encrypting the document sidecar under 32 zero bytes: a
// GCM-valid `.enc` anyone can decrypt, resting inside the locked workspace. The closures now
// re-read the live key PER INVOCATION and throw a typed, content-free `VaultLockedError`.
//
// The import-across-lock test gates `sha256File` (the audit's real park point: seconds–minutes
// for a large file on USB) — mirroring the gated-embedder idiom: everything else is REAL
// (vault, crypto, DB, ingestion); the gate only controls WHEN the hash resolves, so the lock
// deterministically lands inside the window. Kept in its own file because the module mock
// must not leak into the behavioral ingestion/vault suites.

const gate = vi.hoisted(() => {
  const state = {
    enabled: false,
    entered: undefined as Promise<void> | undefined,
    open: undefined as Promise<void> | undefined,
    signalEntered: () => {},
    release: () => {},
    arm(): void {
      state.enabled = true
      state.entered = new Promise<void>((r) => (state.signalEntered = r))
      state.open = new Promise<void>((r) => (state.release = r))
    }
  }
  return state
})

vi.mock('../../src/main/services/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/models')>()
  return {
    ...actual,
    sha256File: async (
      ...args: Parameters<typeof actual.sha256File>
    ): ReturnType<typeof actual.sha256File> => {
      if (gate.enabled) {
        gate.enabled = false // one-shot: only the armed import parks
        gate.signalEntered()
        await gate.open
      }
      return actual.sha256File(...args)
    }
  }
})

// Fast KDF so the suite stays quick (the workspace-vault.test.ts fixture).
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const SECRET_TEXT = 'strictly confidential: the vault must not leak this after Lock now'
const ZERO_KEY = Buffer.alloc(32)

const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

/** Build a fresh temp workspace layout + its vault paths. */
function freshVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-lock-cipher-'))
  const configPath = join(root, 'config')
  const workspacePath = join(root, 'workspace')
  mkdirSync(configPath, { recursive: true })
  mkdirSync(workspacePath, { recursive: true })
  return vaultPathsFrom({ configPath, dbPath: join(workspacePath, 'hilbertraum.sqlite') })
}

/** An unlocked controller over a fresh encrypted vault. */
function unlockedController(vp: VaultPaths): WorkspaceController {
  createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
  const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
  ctl.init()
  ctl.unlock('pw')
  return ctl
}

describe('documentCipher across lock() (full-audit 2026-07-12 SEC-1)', () => {
  it('a captured cipher THROWS the typed error after lock() instead of encrypting under the zeroed key', () => {
    const vp = freshVault()
    const ctl = unlockedController(vp)
    const cipher = ctl.documentCipher()
    expect(cipher).not.toBeNull()

    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-lock-cipher-files-'))
    const plain = join(dir, 'note.txt')
    writeFileSync(plain, SECRET_TEXT)

    // Sanity: the captured cipher works while unlocked (happy path unchanged).
    const encBefore = join(dir, 'before.enc')
    cipher!.encryptFile(plain, encBefore)
    expect(readFileSync(encBefore).includes(Buffer.from(SECRET_TEXT))).toBe(false)

    ctl.lock()

    // RED on pre-fix code: the closure captured the key Buffer that lock() zeroed in place,
    // so this WROTE a zero-key-decryptable file instead of throwing.
    const encAfter = join(dir, 'after.enc')
    let thrown: unknown = null
    try {
      cipher!.encryptFile(plain, encAfter)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).name).toBe('VaultLockedError')
    expect((thrown as Error).message).not.toContain('note.txt') // content-free
    expect(existsSync(encAfter)).toBe(false) // nothing was written

    // All four closures fail closed the same way (per-invocation key read).
    expect(() => cipher!.encryptFileAsync(plain, encAfter)).toThrow(/locked/i)
    expect(() => cipher!.decryptFile(encBefore, join(dir, 'out.txt'))).toThrow(/locked/i)
    expect(() => cipher!.decryptFileAsync(encBefore, join(dir, 'out.txt'))).toThrow(/locked/i)
    expect(existsSync(join(dir, 'out.txt'))).toBe(false)
  })

  it('a cipher captured across lock → unlock reads the LIVE key again (per-invocation read)', () => {
    const vp = freshVault()
    const ctl = unlockedController(vp)
    const cipher = ctl.documentCipher()!

    ctl.lock()
    ctl.unlock('pw')

    // Fix-impact Q3 decision: no consumer legitimately spans a lock/unlock cycle (each IPC
    // call / import job captures a fresh cipher), but one that did now picks up the live
    // data key — the SAME key bytes the fresh cipher would use — instead of a zeroed Buffer.
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-lock-cipher-relock-'))
    const plain = join(dir, 'note.txt')
    writeFileSync(plain, SECRET_TEXT)
    const enc = join(dir, 'note.enc')
    cipher.encryptFile(plain, enc)
    const back = join(dir, 'back.txt')
    ctl.documentCipher()!.decryptFile(enc, back) // decrypts under a FRESH capture too
    expect(readFileSync(back, 'utf8')).toBe(SECRET_TEXT)
    ctl.lock()
  })
})

describe('lock landing mid-import (full-audit 2026-07-12 SEC-1, drained prepare)', () => {
  it('a lock during the pre-encrypt hash fails the prepare cleanly — no zero-key sidecar lands', async () => {
    const vp = freshVault()
    const ctl = unlockedController(vp)
    const db = ctl.requireDb()
    const cipher = ctl.documentCipher()!
    const store = documentsDir(dirname(vp.dbPath))

    const srcDir = mkdtempSync(join(tmpdir(), 'hilbertraum-lock-cipher-src-'))
    const file = join(srcDir, 'contract.txt')
    writeFileSync(file, SECRET_TEXT)
    const doc = createQueuedDocument(db, file)

    // Park the prepare inside `await sha256File(origin)` — the audit's lock window — then
    // lock the vault (closes the DB, zeroes the key) and let the drained prepare resume.
    gate.arm()
    const prepare = prepareDocument(db, store, doc.id, { cipher })
    await gate.entered
    ctl.lock()
    gate.release()

    // The drained prepare FAILS (its row-capture hits the closed DB — the import loop's
    // drain swallows this, registerDocsIpc.ts) …
    await expect(prepare).rejects.toThrow()

    // … and the store holds NO sidecar at all — in particular nothing a 32-zero-byte key
    // can decrypt. RED on pre-fix code: `<id>.txt.enc` existed AND decrypted under ZERO_KEY.
    const leftovers = readdirSync(store)
    for (const name of leftovers.filter((n) => n.endsWith(ENCRYPTED_DOC_SUFFIX))) {
      const out = join(srcDir, `${name}.zero-key-plain`)
      expect(() => decryptFile(join(store, name), out, ZERO_KEY)).toThrow()
      expect(existsSync(out)).toBe(false)
    }
    expect(leftovers).toEqual([]) // the guard threw BEFORE anything was written
  })

  it('an ordinary unlocked import still writes a real-key sidecar (happy path unchanged)', async () => {
    const vp = freshVault()
    const ctl = unlockedController(vp)
    const db = ctl.requireDb()
    const cipher = ctl.documentCipher()!
    const store = documentsDir(dirname(vp.dbPath))

    const srcDir = mkdtempSync(join(tmpdir(), 'hilbertraum-lock-cipher-src2-'))
    const file = join(srcDir, 'contract.txt')
    writeFileSync(file, SECRET_TEXT)
    const doc = createQueuedDocument(db, file)

    const prepared = await prepareDocument(db, store, doc.id, { cipher })
    expect(prepared.ready).toBe(true)

    const stored = readdirSync(store)
    expect(stored).toHaveLength(1)
    expect(stored[0].endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)
    // Encrypted under the REAL vault key: the vault cipher round-trips it, the zero key can't.
    const back = join(srcDir, 'back.txt')
    cipher.decryptFile(join(store, stored[0]), back)
    expect(readFileSync(back, 'utf8')).toBe(SECRET_TEXT)
    expect(() => decryptFile(join(store, stored[0]), join(srcDir, 'zk.txt'), ZERO_KEY)).toThrow()
    ctl.lock()
  })
})
