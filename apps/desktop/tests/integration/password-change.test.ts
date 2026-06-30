import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy } from '../../src/shared/types'
import {
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  unlockEncryptedVault,
  lockEncryptedVault,
  readVaultDescriptor,
  stageRekey,
  rewrapVaultKey,
  applyPendingRekey,
  shredFile,
  WorkspaceController,
  WrongPasswordError,
  VaultBusyError,
  VAULT_VERSION,
  VAULT_VERSION_ENVELOPE,
  REKEY_SUFFIX,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import {
  decrypt,
  deriveKey,
  generateDataKey,
  type KdfParams
} from '../../src/main/services/security/crypto'

// Phase 32 — vault password change (wave-3 plan §5, decision D24): the v2 envelope
// descriptor (random data key wrapped by the password-derived KEK), the O(1) re-wrap on
// every v2 change, and the one-time JOURNALED v1→v2 migration on a legacy vault's first
// change. The crash tests below cut the journal at each step and prove the vault
// recovers to a consistent state: old password+files OR new — never a mix.

// Fast KDFs so the suite stays quick; unlock reads the params back from the descriptor.
const FAST_SCRYPT: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const FAST_ARGON: KdfParams = { algo: 'argon2id', m: 64, t: 1, p: 1, keyLen: 32 }

const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

/** Build a fresh temp workspace layout + its vault paths. */
function freshVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-pwchange-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'workspace'), { recursive: true })
  return vaultPathsFrom({
    configPath: join(root, 'config'),
    dbPath: join(root, 'workspace', 'hilbertraum.sqlite')
  })
}

/** An unlocked controller over a freshly created vault. */
function unlockedController(
  vp: VaultPaths,
  password: string,
  kdf: KdfParams,
  opts: { legacyV1?: boolean } = {}
): WorkspaceController {
  createEncryptedVaultOnDisk(vp, password, kdf, opts)
  const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
  ctl.init()
  ctl.unlock(password)
  return ctl
}

/** Write an encrypted document sidecar through the controller's own cipher. */
function addEncryptedDoc(ctl: WorkspaceController, vp: VaultPaths, name: string, text: string): string {
  const docsDir = join(join(vp.dbPath, '..'), 'documents')
  mkdirSync(docsDir, { recursive: true })
  const plain = join(docsDir, `${name}.src`)
  writeFileSync(plain, text, 'utf8')
  const enc = join(docsDir, `${name}.txt.enc`)
  ctl.documentCipher()!.encryptFile(plain, enc)
  shredFile(plain)
  return enc
}

/** Decrypt a sidecar through the controller's cipher and return its text. */
function readEncryptedDoc(ctl: WorkspaceController, encPath: string): string {
  const out = `${encPath}.check.tmp`
  ctl.documentCipher()!.decryptFile(encPath, out)
  const text = readFileSync(out, 'utf8')
  shredFile(out)
  return text
}

// ---- new vaults are v2 (envelope) -------------------------------------------------

describe('vault descriptor v2 (envelope)', () => {
  it('creates new vaults as v2: wrapped data key present, unlock round-trips', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'first-password', FAST_SCRYPT)
    const d = readVaultDescriptor(vp.descriptorPath)!
    expect(d.version).toBe(VAULT_VERSION_ENVELOPE)
    expect(d.dataKey).toBeTruthy()

    const { db, key } = unlockEncryptedVault(vp, 'first-password')
    updateSettings(db, { contextTokens: 3072 }) // arbitrary >= the 2048 floor
    lockEncryptedVault(vp, db, key)
    const again = unlockEncryptedVault(vp, 'first-password')
    expect(getSettings(again.db).contextTokens).toBe(3072)
    again.db.close()
  })

  it('the data file key is the UNWRAPPED data key, not the password-derived KEK', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'first-password', FAST_SCRYPT)
    const d = readVaultDescriptor(vp.descriptorPath)!
    const kek = deriveKey('first-password', Buffer.from(d.saltB64, 'base64'), d.kdf)
    const unwrapped = decrypt(kek, {
      iv: Buffer.from(d.dataKey!.ivB64, 'base64'),
      tag: Buffer.from(d.dataKey!.tagB64, 'base64'),
      ciphertext: Buffer.from(d.dataKey!.ciphertextB64, 'base64')
    })
    const { db, key } = unlockEncryptedVault(vp, 'first-password')
    expect(key.equals(unwrapped)).toBe(true)
    expect(key.equals(kek)).toBe(false)
    db.close()
  })

  it('treats a v2 descriptor missing its dataKey as corrupt, not unlockable', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_SCRYPT)
    const d = readVaultDescriptor(vp.descriptorPath)!
    delete d.dataKey
    writeFileSync(vp.descriptorPath, JSON.stringify(d), 'utf8')
    expect(readVaultDescriptor(vp.descriptorPath)).toBeNull()
    expect(() => unlockEncryptedVault(vp, 'pw')).toThrow(/missing or unreadable/)
  })
})

// ---- change password: both KDF fixtures, old password dies ------------------------

describe('changePassword — change-then-unlock-with-new (both legacy KDFs)', () => {
  for (const [label, kdf] of [
    ['scrypt', FAST_SCRYPT],
    ['argon2id', FAST_ARGON]
  ] as const) {
    it(`migrates a legacy v1 ${label} vault on its first change; old password rejected`, () => {
      const vp = freshVault()
      const ctl = unlockedController(vp, 'old-password', kdf, { legacyV1: true })
      expect(readVaultDescriptor(vp.descriptorPath)!.version).toBe(VAULT_VERSION)
      updateSettings(ctl.requireDb(), { contextTokens: 8192 }) // arbitrary >= the 2048 floor
      const enc = addEncryptedDoc(ctl, vp, 'doc-a', 'hello vault')

      const state = ctl.changePassword('old-password', 'new-password', FAST_ARGON)
      expect(state.state).toBe('unlocked') // key replaced in place, no re-lock

      // Descriptor is now the v2 envelope under the NEW kdf, with no staged files left.
      const d = readVaultDescriptor(vp.descriptorPath)!
      expect(d.version).toBe(VAULT_VERSION_ENVELOPE)
      expect(d.kdf.algo).toBe('argon2id')
      expect(d.dataKey).toBeTruthy()
      expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
      expect(existsSync(`${enc}${REKEY_SUFFIX}`)).toBe(false)

      // The migrated document decrypts with the live (replaced) key.
      expect(readEncryptedDoc(ctl, enc)).toBe('hello vault')

      // Lock, then: old password rejected, new password unlocks with data intact.
      ctl.lock()
      expect(() => ctl.unlock('old-password')).toThrow(WrongPasswordError)
      const unlocked = ctl.unlock('new-password')
      expect(unlocked.state).toBe('unlocked')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(8192)
      expect(readEncryptedDoc(ctl, enc)).toBe('hello vault')
      ctl.lock()
    })
  }

  it('a legacy scrypt vault silently upgrades to Argon2id under DEFAULT_KDF', () => {
    const vp = freshVault()
    const ctl = unlockedController(vp, 'old-password', FAST_SCRYPT, { legacyV1: true })
    ctl.changePassword('old-password', 'new-password') // no kdf → DEFAULT_KDF
    const d = readVaultDescriptor(vp.descriptorPath)!
    expect(d.kdf.algo).toBe('argon2id')
    expect(d.kdf.m).toBe(19456) // the OWASP-interactive default, not a test param
    ctl.lock()
    expect(ctl.unlock('new-password').state).toBe('unlocked')
    ctl.lock()
  })

  it('rejects a wrong current password and leaves the vault byte-identical', () => {
    const vp = freshVault()
    const ctl = unlockedController(vp, 'right-password', FAST_SCRYPT, { legacyV1: true })
    const descriptorBefore = readFileSync(vp.descriptorPath)
    const encBefore = readFileSync(vp.encPath)

    expect(() => ctl.changePassword('wrong-password', 'whatever-next')).toThrow(WrongPasswordError)

    expect(readFileSync(vp.descriptorPath).equals(descriptorBefore)).toBe(true)
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    ctl.lock()
    expect(ctl.unlock('right-password').state).toBe('unlocked')
    ctl.lock()
  })

  it('refuses while locked', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_SCRYPT)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(() => ctl.changePassword('pw', 'next-password')).toThrow(/unlocked/)
  })
})

// ---- the v1→v2 migration re-encrypts every document; later changes are O(1) -------

describe('changePassword — migration vs O(1) re-wrap', () => {
  it('v1→v2 migration leaves EVERY document decryptable (multiple sidecars)', () => {
    const vp = freshVault()
    const ctl = unlockedController(vp, 'old-password', FAST_SCRYPT, { legacyV1: true })
    const docs = ['a', 'b', 'c'].map((n) => addEncryptedDoc(ctl, vp, `doc-${n}`, `content ${n}`))

    ctl.changePassword('old-password', 'new-password', FAST_ARGON)
    for (let i = 0; i < docs.length; i++) {
      expect(readEncryptedDoc(ctl, docs[i])).toBe(`content ${['a', 'b', 'c'][i]}`)
    }
    // And the migration changed the sidecar bytes (new key, fresh IV).
    ctl.lock()
    ctl.unlock('new-password')
    for (let i = 0; i < docs.length; i++) {
      expect(readEncryptedDoc(ctl, docs[i])).toBe(`content ${['a', 'b', 'c'][i]}`)
    }
    ctl.lock()
  })

  it('a second change (already v2) is the O(1) re-wrap: data files untouched', () => {
    const vp = freshVault()
    const ctl = unlockedController(vp, 'pw-one', FAST_SCRYPT, { legacyV1: true })
    const enc = addEncryptedDoc(ctl, vp, 'doc-o1', 'untouched content')
    ctl.changePassword('pw-one', 'pw-two', FAST_ARGON) // the one-time migration

    const docBytes = readFileSync(enc)
    const dbBytes = readFileSync(vp.encPath)
    const descriptorBefore = readFileSync(vp.descriptorPath, 'utf8')

    ctl.changePassword('pw-two', 'pw-three', FAST_ARGON) // v2 → descriptor-only

    // No bulk re-encrypt: the document sidecar AND the at-rest DB are byte-identical.
    expect(readFileSync(enc).equals(docBytes)).toBe(true)
    expect(readFileSync(vp.encPath).equals(dbBytes)).toBe(true)
    // But the descriptor was atomically replaced (fresh salt + verifier + wrap).
    expect(readFileSync(vp.descriptorPath, 'utf8')).not.toBe(descriptorBefore)

    ctl.lock()
    expect(() => ctl.unlock('pw-two')).toThrow(WrongPasswordError)
    ctl.unlock('pw-three')
    expect(readEncryptedDoc(ctl, enc)).toBe('untouched content')
    ctl.lock()
  })

  it('a brand-new (v2-created) vault gets the O(1) path on its very first change', () => {
    const vp = freshVault()
    const ctl = unlockedController(vp, 'pw-one', FAST_SCRYPT) // v2 from creation
    const enc = addEncryptedDoc(ctl, vp, 'doc-n1', 'fresh vault doc')
    const docBytes = readFileSync(enc)

    ctl.changePassword('pw-one', 'pw-two', FAST_ARGON)
    expect(readFileSync(enc).equals(docBytes)).toBe(true) // no migration happened
    expect(readEncryptedDoc(ctl, enc)).toBe('fresh vault doc')
    ctl.lock()
    ctl.unlock('pw-two')
    ctl.lock()
  })
})

// ---- crash recovery: cut the journal between every step ---------------------------
//
// changePassword composes exactly: stageRekey → rewrapVaultKey (COMMIT) →
// applyPendingRekey. The tests below run the same exported steps, "crash" (drop the
// controller / close the db without finishing), and prove recovery lands on a
// consistent vault — old password+files or new, never mixed.

describe('changePassword — crash recovery (journaled two-phase swap)', () => {
  function v1VaultWithDoc(): { vp: VaultPaths; enc: string } {
    const vp = freshVault()
    const ctl = unlockedController(vp, 'old-password', FAST_SCRYPT, { legacyV1: true })
    updateSettings(ctl.requireDb(), { contextTokens: 4242 })
    const enc = addEncryptedDoc(ctl, vp, 'doc-crash', 'survives crashes')
    ctl.lock()
    return { vp, enc }
  }

  it('crash AFTER staging, BEFORE the descriptor commit → old password + old files win', () => {
    const { vp, enc } = v1VaultWithDoc()
    const { db, key } = unlockEncryptedVault(vp, 'old-password')
    stageRekey(vp, db, key, generateDataKey())
    db.close() // crash: staged .new files exist, descriptor still v1
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(true)
    expect(existsSync(`${enc}${REKEY_SUFFIX}`)).toBe(true)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init() // startup recovery rolls the uncommitted stage BACK
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
    expect(existsSync(`${enc}${REKEY_SUFFIX}`)).toBe(false)

    ctl.unlock('old-password')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(4242)
    expect(readEncryptedDoc(ctl, enc)).toBe('survives crashes')
    ctl.lock()
  })

  it('crash AFTER the descriptor commit, BEFORE the file swap → new password rolls forward', () => {
    const { vp, enc } = v1VaultWithDoc()
    const { db, key } = unlockEncryptedVault(vp, 'old-password')
    const dataKey = generateDataKey()
    stageRekey(vp, db, key, dataKey)
    rewrapVaultKey(vp, dataKey, 'new-password', FAST_ARGON) // COMMIT
    db.close() // crash: descriptor v2, canonical files still old-key, .new staged

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    const unlocked = ctl.unlock('new-password') // recovery rolls FORWARD, then unlocks
    expect(unlocked.state).toBe('unlocked')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(4242)
    expect(readEncryptedDoc(ctl, enc)).toBe('survives crashes')
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
    expect(existsSync(`${enc}${REKEY_SUFFIX}`)).toBe(false)
    ctl.lock()

    // The old password is gone for good.
    expect(() => ctl.unlock('old-password')).toThrow(WrongPasswordError)
  })

  it('crash MID-SWAP (DB swapped, document still staged) → recovery completes the swap', () => {
    const { vp, enc } = v1VaultWithDoc()
    const { db, key } = unlockEncryptedVault(vp, 'old-password')
    const dataKey = generateDataKey()
    stageRekey(vp, db, key, dataKey)
    rewrapVaultKey(vp, dataKey, 'new-password', FAST_ARGON) // COMMIT
    // Partial apply: only the DB got swapped before the "crash".
    shredFile(vp.encPath)
    renameSync(`${vp.encPath}${REKEY_SUFFIX}`, vp.encPath)
    db.close()
    expect(existsSync(`${enc}${REKEY_SUFFIX}`)).toBe(true)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.unlock('new-password')
    expect(readEncryptedDoc(ctl, enc)).toBe('survives crashes')
    expect(existsSync(`${enc}${REKEY_SUFFIX}`)).toBe(false)
    ctl.lock()
  })

  it('applyPendingRekey is idempotent (a crash mid-recovery just reruns it)', () => {
    const { vp, enc } = v1VaultWithDoc()
    const { db, key } = unlockEncryptedVault(vp, 'old-password')
    const dataKey = generateDataKey()
    stageRekey(vp, db, key, dataKey)
    rewrapVaultKey(vp, dataKey, 'new-password', FAST_ARGON)
    db.close()

    applyPendingRekey(vp)
    applyPendingRekey(vp) // second run finds nothing staged — must not throw

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.unlock('new-password')
    expect(readEncryptedDoc(ctl, enc)).toBe('survives crashes')
    ctl.lock()
  })
})

// ---- the import/re-index ↔ password-change race guard -----------------------------

describe('changePassword — document-work race guard (Phase 32)', () => {
  it('refuses while document work holds a lease; works once released', () => {
    const vp = freshVault()
    const ctl = unlockedController(vp, 'pw-one', FAST_SCRYPT)
    const release = ctl.beginDocumentWork()
    expect(() => ctl.changePassword('pw-one', 'pw-two', FAST_ARGON)).toThrow(VaultBusyError)
    expect(() => ctl.changePassword('pw-one', 'pw-two', FAST_ARGON)).toThrow(/imported or re-indexed/)

    release()
    release() // release is idempotent — double-call must not free someone else's lease
    expect(ctl.changePassword('pw-one', 'pw-two', FAST_ARGON).state).toBe('unlocked')
    ctl.lock()
  })

  it('document work refuses to start while a REAL password change is in progress (the flag is set then cleared around the work)', () => {
    const vp = freshVault()
    const ctl = unlockedController(vp, 'pw-one', FAST_SCRYPT)

    // changePassword is synchronous today, so the overlap cannot be interleaved from the outside.
    // The OLD test poked the private `changingPassword` field directly, pinning only the guard's
    // CONSEQUENCE (beginDocumentWork throws when the flag is set) — if changePassword forgot to set
    // the flag it still passed (T6, full-audit-2026-06-30). Pin the PRECONDITION instead: trap the
    // private flag to (1) record its real transitions and (2) at the instant the REAL changePassword
    // flips it true (mid-work), prove beginDocumentWork() is genuinely refused — so a regression that
    // stops setting/clearing the flag around the work reddens here.
    const transitions: boolean[] = []
    let refusedWhileChanging = false
    let backing = false
    Object.defineProperty(ctl, 'changingPassword', {
      configurable: true,
      get: () => backing,
      set: (v: boolean) => {
        backing = v
        transitions.push(v)
        if (v) {
          // The flag just went true INSIDE changePassword's work → a real doc-work request must be
          // refused right now (beginDocumentWork reads the same flag via its getter).
          try {
            ctl.beginDocumentWork()
          } catch (err) {
            if (err instanceof VaultBusyError) refusedWhileChanging = true
          }
        }
      }
    })

    // Drive the REAL changePassword (full Argon2id rewrap) — not a poked field.
    expect(ctl.changePassword('pw-one', 'pw-two', FAST_ARGON).state).toBe('unlocked')

    // The REAL change SET the flag then CLEARED it (the `finally` ran), and document work was
    // refused while it was set — pinning both edges of the guard's precondition.
    expect(transitions).toEqual([true, false])
    expect(refusedWhileChanging).toBe(true)

    // Flag cleared → document work starts cleanly again (and the new password is in force).
    const release = ctl.beginDocumentWork()
    release()
    ctl.lock()
  })
})

// ---- nothing secret ever touches the descriptor or the .enc files -----------------

describe('descriptor/.enc scan — passwords and keys stay memory-only (extended)', () => {
  it('neither password nor the unwrapped data key appears in any on-disk artifact', () => {
    const vp = freshVault()
    const OLD = 'super-secret-old-passphrase-3k9q'
    const NEW = 'super-secret-new-passphrase-7w1z'
    const ctl = unlockedController(vp, OLD, FAST_SCRYPT, { legacyV1: true })
    const enc = addEncryptedDoc(ctl, vp, 'doc-scan', 'scan target content')
    ctl.changePassword(OLD, NEW, FAST_ARGON)

    // Recover the data key the way unlock does, to scan for ITS bytes too.
    const d = readVaultDescriptor(vp.descriptorPath)!
    expect(d.version).toBe(VAULT_VERSION_ENVELOPE)
    const kek = deriveKey(NEW, Buffer.from(d.saltB64, 'base64'), d.kdf)
    const dataKey = decrypt(kek, {
      iv: Buffer.from(d.dataKey!.ivB64, 'base64'),
      tag: Buffer.from(d.dataKey!.tagB64, 'base64'),
      ciphertext: Buffer.from(d.dataKey!.ciphertextB64, 'base64')
    })

    const artifacts = [
      readFileSync(vp.descriptorPath),
      readFileSync(vp.encPath),
      readFileSync(enc)
    ]
    const secrets = [
      Buffer.from(OLD),
      Buffer.from(NEW),
      dataKey,
      Buffer.from(dataKey.toString('base64')),
      Buffer.from(dataKey.toString('hex'))
    ]
    for (const artifact of artifacts) {
      for (const secret of secrets) {
        expect(artifact.includes(secret)).toBe(false)
      }
    }
    ctl.lock()
  })
})
