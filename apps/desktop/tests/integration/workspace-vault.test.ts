import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy } from '../../src/shared/types'
import {
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  unlockEncryptedVault,
  lockEncryptedVault,
  plaintextAllowed,
  shredStalePlaintext,
  encryptFile,
  decryptFile,
  shredFile,
  applyPendingRekey,
  REKEY_SUFFIX,
  WorkspaceController,
  WrongPasswordError,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { randomBytes } from 'node:crypto'
import {
  encrypt,
  decrypt,
  serializeBlob,
  deserializeBlob,
  type KdfParams
} from '../../src/main/services/security/crypto'

// Fast KDF so the suite stays quick — unlock reads the params back from the descriptor,
// so creating with cheap params keeps the round-trip honest while shaving scrypt cost.
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }

/** Build a fresh temp workspace layout + its vault paths. */
function freshVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-vault-'))
  const configPath = join(root, 'config')
  const workspacePath = join(root, 'workspace')
  mkdirSync(configPath, { recursive: true })
  mkdirSync(workspacePath, { recursive: true })
  return vaultPathsFrom({ configPath, dbPath: join(workspacePath, 'hilbertraum.sqlite') })
}

const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- lock → encrypt → unlock round-trip -----------------------------------------

describe('encrypted vault lifecycle', () => {
  it('creates LOCKED on disk: descriptor + .enc exist, no plaintext working file', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    expect(existsSync(vp.descriptorPath)).toBe(true)
    expect(existsSync(vp.encPath)).toBe(true)
    expect(existsSync(vp.dbPath)).toBe(false)
  })

  it('round-trips data through lock and unlock; shreds the plaintext on lock', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)

    const first = unlockEncryptedVault(vp, 'pw')
    expect(existsSync(vp.dbPath)).toBe(true) // decrypted working file present while unlocked
    updateSettings(first.db, { contextTokens: 9999 })
    lockEncryptedVault(vp, first.db, first.key)

    // After lock: encrypted artifact remains; plaintext working file + WAL sidecars gone.
    expect(existsSync(vp.encPath)).toBe(true)
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    expect(existsSync(`${vp.dbPath}-shm`)).toBe(false)

    // Re-unlocking reads the same rows back.
    const second = unlockEncryptedVault(vp, 'pw')
    expect(getSettings(second.db).contextTokens).toBe(9999)
    second.db.close()
  })

  it('rejects a wrong password and never writes a plaintext working file', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    expect(() => unlockEncryptedVault(vp, 'wrong-password')).toThrow(WrongPasswordError)
    expect(existsSync(vp.dbPath)).toBe(false)
  })

  it('zeroes the KDF-derived key on the wrong-password path (L-6)', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const fillSpy = vi.spyOn(Buffer.prototype, 'fill')
    try {
      expect(() => unlockEncryptedVault(vp, 'wrong-password')).toThrow(WrongPasswordError)
      // The derived key buffer is zeroed (fill(0)) before the throw — for symmetry with
      // the data-key paths that zero the KEK/old keys after use.
      expect(fillSpy.mock.calls.some((args) => args[0] === 0)).toBe(true)
    } finally {
      fillSpy.mockRestore()
    }
  })

  // H4 (audit round 4): `.enc` IS the user's data; creating over it would irreversibly
  // replace chats/documents/settings with an empty vault.
  it('refuses to create over an existing .enc (the data must never be wiped)', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const encBefore = readFileSync(vp.encPath)
    expect(() => createEncryptedVaultOnDisk(vp, 'other-pw', FAST_KDF)).toThrow(/already exists/)
    // The original encrypted database is untouched.
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    const opened = unlockEncryptedVault(vp, 'pw')
    opened.db.close()
  })

  it('a corrupt descriptor with an intact .enc gives a restore hint, not "no workspace"', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    writeFileSync(vp.descriptorPath, '{ not json', 'utf8')
    expect(() => unlockEncryptedVault(vp, 'pw')).toThrow(/missing or unreadable/)
  })
})

// ---- M5: streaming file crypto stays byte-compatible with the framed blob format ---

describe('streaming file crypto (M5)', () => {
  function tmpFile(name: string, data: Buffer | string): string {
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-stream-'))
    const p = join(dir, name)
    writeFileSync(p, data)
    return p
  }

  it('streamed encryptFile output decrypts via the in-memory blob path (same frame)', () => {
    const key = randomBytes(32)
    const plaintext = randomBytes(3 * 1024 * 1024 + 17) // > one chunk boundary, odd size
    const src = tmpFile('plain.bin', plaintext)
    const enc = `${src}.enc`
    encryptFile(src, enc, key)

    const decrypted = decrypt(key, deserializeBlob(readFileSync(enc)))
    expect(decrypted.equals(plaintext)).toBe(true)
  })

  it('an in-memory serializeBlob file decrypts via the streamed decryptFile (old vaults)', () => {
    const key = randomBytes(32)
    const plaintext = randomBytes(1024 * 1024 + 3)
    const enc = tmpFile('old.enc', serializeBlob(encrypt(key, plaintext)))
    const out = `${enc}.plain`
    decryptFile(enc, out, key)
    expect(readFileSync(out).equals(plaintext)).toBe(true)
  })

  it('a tampered .enc fails decryption and leaves no plaintext output behind', () => {
    const key = randomBytes(32)
    const src = tmpFile('plain.bin', randomBytes(256 * 1024))
    const enc = `${src}.enc`
    encryptFile(src, enc, key)
    // Flip a ciphertext byte (past the 36-byte header) → GCM auth must fail.
    const blob = readFileSync(enc)
    blob[100] ^= 0xff
    writeFileSync(enc, blob)

    const out = `${enc}.plain`
    expect(() => decryptFile(enc, out, key)).toThrow()
    expect(existsSync(out)).toBe(false)
    expect(existsSync(`${out}.tmp`)).toBe(false) // the partial output was shredded
  })

  it('shredFile unlinks even large-ish files via chunked overwrite', () => {
    const p = tmpFile('shred-me.bin', randomBytes(1024 * 1024))
    shredFile(p)
    expect(existsSync(p)).toBe(false)
  })
})

// ---- H4: the controller must never offer a vault-wiping create flow ---------------

describe('WorkspaceController — create-over-existing-vault guard (H4)', () => {
  it('reports LOCKED (not uninitialized) when the descriptor is corrupt but .enc exists', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    writeFileSync(vp.descriptorPath, '{ corrupted-not-json', 'utf8')

    const ctl = new WorkspaceController(vp, DEFAULT_POLICY, true)
    ctl.init()
    // A corrupt descriptor used to surface `uninitialized`, putting the CREATE flow in
    // front of the user — one click away from wiping the intact .enc.
    expect(ctl.getState().state).toBe('locked')
    // init() must not have opened a plaintext DB over the vault either (dev policy).
    expect(ctl.isUnlocked()).toBe(false)
  })

  it('refuses create while a vault exists (locked state), keeping the data intact', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const ctl = new WorkspaceController(vp, DEFAULT_POLICY, true)
    ctl.init()
    expect(ctl.getState().state).toBe('locked')

    expect(() => ctl.create('new-password', 'encrypted')).toThrow(/already exists/)
    expect(() => ctl.create('', 'plaintext_dev')).toThrow(/already exists/)

    // The original vault still unlocks with its original password.
    const state = ctl.unlock('pw')
    expect(state.state).toBe('unlocked')
    ctl.lock()
  })
})

// ---- password is never persisted ------------------------------------------------

describe('no plaintext password persisted', () => {
  it('keeps the password out of the descriptor and the encrypted blob', () => {
    const vp = freshVault()
    const SECRET = 'super-secret-passphrase-9k2x'
    createEncryptedVaultOnDisk(vp, SECRET, FAST_KDF)

    const descriptor = readFileSync(vp.descriptorPath, 'utf8')
    expect(descriptor).not.toContain(SECRET)
    // Descriptor stores only salt + KDF params + an authenticated verifier.
    const parsed = JSON.parse(descriptor)
    expect(parsed.saltB64).toBeTruthy()
    expect(parsed.kdf.algo).toBe('scrypt')
    expect(parsed.verifier).toBeTruthy()

    const enc = readFileSync(vp.encPath)
    expect(enc.includes(Buffer.from(SECRET))).toBe(false)
  })
})

// ---- plaintext gating -----------------------------------------------------------

describe('plaintextAllowed gating', () => {
  it('allows plaintext only when policy permits AND the caller is a developer', () => {
    expect(plaintextAllowed(DEFAULT_POLICY, { isDev: true })).toBe(true)
    // Not a developer → refused even when policy permits.
    expect(plaintextAllowed(DEFAULT_POLICY, { isDev: false })).toBe(false)
  })

  it('refuses plaintext when encryption is required by policy', () => {
    expect(plaintextAllowed(ENCRYPTION_REQUIRED, { isDev: true })).toBe(false)
  })

  it('refuses plaintext when the policy disables plaintext dev mode', () => {
    const policy: PrivacyPolicy = {
      ...DEFAULT_POLICY,
      workspace: { encryptionRequired: false, allowPlaintextDevMode: false }
    }
    expect(plaintextAllowed(policy, { isDev: true })).toBe(false)
  })
})

// ---- WorkspaceController state derivation ---------------------------------------

describe('WorkspaceController', () => {
  it('opens plaintext immediately in dev (no descriptor needed)', () => {
    const vp = freshVault()
    const ctrl = new WorkspaceController(vp, DEFAULT_POLICY, true)
    ctrl.init()
    const s = ctrl.getState()
    expect(s.state).toBe('unlocked')
    expect(s.mode).toBe('plaintext_dev')
    expect(ctrl.requireDb()).toBeTruthy()
    expect(existsSync(vp.descriptorPath)).toBe(false) // plaintext needs no vault descriptor
  })

  it('drives the encrypted uninitialized → unlocked → locked → unlocked lifecycle', () => {
    const vp = freshVault()
    // Commercial posture: encryption required, not a dev build → onboarding, no plaintext.
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    expect(ctrl.getState().state).toBe('uninitialized')
    expect(ctrl.isUnlocked()).toBe(false)
    expect(() => ctrl.requireDb()).toThrow()

    const created = ctrl.create('master-pass', 'encrypted')
    expect(created.state).toBe('unlocked')
    expect(created.mode).toBe('encrypted')
    updateSettings(ctrl.requireDb(), { contextTokens: 4242 })

    const locked = ctrl.lock()
    expect(locked.state).toBe('locked')
    expect(() => ctrl.requireDb()).toThrow()
    expect(existsSync(vp.dbPath)).toBe(false)

    const unlocked = ctrl.unlock('master-pass')
    expect(unlocked.state).toBe('unlocked')
    expect(getSettings(ctrl.requireDb()).contextTokens).toBe(4242)
    ctrl.lock()
  })

  it('refuses plaintext creation when policy forbids it', () => {
    const vp = freshVault()
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, true)
    ctrl.init()
    expect(() => ctrl.create('x', 'plaintext_dev')).toThrow(/not permitted/i)
  })

  it('re-reading an existing encrypted vault starts LOCKED', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    expect(ctrl.getState().state).toBe('locked')
    expect(ctrl.getState().mode).toBe('encrypted')
  })

  it('shreds a leftover plaintext DB from a crash on startup, staying LOCKED (H1)', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    // Simulate a hard crash before lock-on-quit: a decrypted working file + WAL/SHM are
    // left next to the .enc.
    writeFileSync(vp.dbPath, 'leftover plaintext database bytes')
    writeFileSync(`${vp.dbPath}-wal`, 'wal')
    writeFileSync(`${vp.dbPath}-shm`, 'shm')

    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()

    // The stray plaintext (+ sidecars) must be gone; the encrypted artifact is untouched;
    // the workspace stays locked until the user provides the password.
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    expect(existsSync(`${vp.dbPath}-shm`)).toBe(false)
    expect(existsSync(vp.encPath)).toBe(true)
    expect(ctrl.getState().state).toBe('locked')
    // And it still unlocks correctly afterwards.
    const u = ctrl.unlock('pw')
    expect(u.state).toBe('unlocked')
    ctrl.lock()
  })

  it('shredStalePlaintext removes the working file + WAL/SHM', () => {
    const vp = freshVault()
    writeFileSync(vp.dbPath, 'x')
    writeFileSync(`${vp.dbPath}-wal`, 'x')
    writeFileSync(`${vp.dbPath}-shm`, 'x')
    shredStalePlaintext(vp)
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    expect(existsSync(`${vp.dbPath}-shm`)).toBe(false)
  })

  it('shredStalePlaintext sweeps crash-left .parse/.tmp transients under documents/ AND images/, keeping stored copies', () => {
    const vp = freshVault()
    const workspaceDir = dirname(vp.dbPath)
    const docsDir = join(workspaceDir, 'documents')
    const imagesDir = join(workspaceDir, 'images')
    mkdirSync(docsDir, { recursive: true })
    mkdirSync(imagesDir, { recursive: true })

    // Transient plaintext copies a killed run can leave behind.
    writeFileSync(join(docsDir, 'doc1.parsepdf'), 'x') // re-index parse temp
    writeFileSync(join(imagesDir, 'img1.tmp'), 'x') // image-history write temp
    writeFileSync(join(imagesDir, 'img2.read-1234.tmp'), 'x') // image-history read temp
    // Stored encrypted copies must SURVIVE the sweep (they match neither pattern).
    writeFileSync(join(docsDir, 'doc1.pdf.enc'), 'x')
    writeFileSync(join(imagesDir, 'img1.png.enc'), 'x')

    shredStalePlaintext(vp)

    expect(existsSync(join(docsDir, 'doc1.parsepdf'))).toBe(false)
    expect(existsSync(join(imagesDir, 'img1.tmp'))).toBe(false)
    expect(existsSync(join(imagesDir, 'img2.read-1234.tmp'))).toBe(false)
    expect(existsSync(join(docsDir, 'doc1.pdf.enc'))).toBe(true)
    expect(existsSync(join(imagesDir, 'img1.png.enc'))).toBe(true)
  })

  it('applyPendingRekey swaps every swappable sidecar even when one is stuck (BUG vuln-scan-2026-06-21)', () => {
    const vp = freshVault()
    const docsDir = join(dirname(vp.dbPath), 'documents')
    mkdirSync(docsDir, { recursive: true })
    // Two normal staged sidecars: target = old ciphertext, `.new` = the freshly re-keyed one.
    writeFileSync(join(docsDir, `a.enc`), 'OLD-A')
    writeFileSync(join(docsDir, `a.enc${REKEY_SUFFIX}`), 'NEW-A')
    writeFileSync(join(docsDir, `c.enc`), 'OLD-C')
    writeFileSync(join(docsDir, `c.enc${REKEY_SUFFIX}`), 'NEW-C')
    // A staged sidecar whose target is a NON-EMPTY DIRECTORY ⇒ renameSync fails for THIS file
    // only (shredFile's non-recursive rmSync can't remove a non-empty dir either). Simulates a
    // persistently locked/unswappable file mid-rekey.
    mkdirSync(join(docsDir, `bad.enc`))
    writeFileSync(join(docsDir, `bad.enc`, 'keep'), 'x')
    writeFileSync(join(docsDir, `bad.enc${REKEY_SUFFIX}`), 'NEW-BAD')

    // It surfaces the incomplete swap (the caller logs/recovers) …
    expect(() => applyPendingRekey(vp)).toThrow()

    // … but the swappable sidecars completed — the old code abandoned them after the first
    // failure, leaving them under the retired key (transiently undecryptable mid-session).
    expect(readFileSync(join(docsDir, `a.enc`), 'utf8')).toBe('NEW-A')
    expect(existsSync(join(docsDir, `a.enc${REKEY_SUFFIX}`))).toBe(false)
    expect(readFileSync(join(docsDir, `c.enc`), 'utf8')).toBe('NEW-C')
    expect(existsSync(join(docsDir, `c.enc${REKEY_SUFFIX}`))).toBe(false)
    // The stuck file stays staged for recoverPendingRekey on the next unlock (old-or-new, never mixed).
    expect(existsSync(join(docsDir, `bad.enc${REKEY_SUFFIX}`))).toBe(true)
  })
})

// ---- no network across the unlock/lock path -------------------------------------

describe('offline guarantee (vault create + unlock + lock)', () => {
  it('makes zero network calls', () => {
    const httpSpy = vi.spyOn(http, 'request')
    const httpsSpy = vi.spyOn(https, 'request')
    const connectSpy = vi.spyOn(net, 'connect')
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    lockEncryptedVault(vp, db, key)

    expect(httpSpy).not.toHaveBeenCalled()
    expect(httpsSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
    expect(socketConnectSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
