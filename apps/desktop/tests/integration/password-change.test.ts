import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
  discardPendingRekey,
  listVaultKeyCiphertexts,
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
  encrypt,
  serializeBlob,
  deserializeBlob,
  deriveKey,
  generateDataKey,
  type KdfParams
} from '../../src/main/services/security/crypto'
import {
  createImageSession,
  getImageSession,
  imagesDir,
  listImageSessions
} from '../../src/main/services/vision/history'

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

// ---- every vault-key ciphertext class survives the v1→v2 rekey (#241) --------------------
//
// The v1→v2 migration used to stage `documents/*.enc` only. Image-history sidecars under
// `images/`, legacy stored copies whose `stored_path` lies outside the store, and the rotated
// diagnostics log all share the vault key, so the first password change of a v1 vault left
// them under a zeroed key. These tests drive the REAL `changePassword` over a `legacyV1`
// vault that carries one of each class. They do not prove that any real user holds a v1 vault.

const IMAGE_A = new Uint8Array([0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8])
const IMAGE_B = new Uint8Array([0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9])
/** On-disk names this test pins: the rotated diagnostics log and the rekey journal file. */
const ROTATED_LOG = 'app.1.log.enc'
const REKEY_JOURNAL = 'rekey-journal.json'

/** A temp workspace layout whose vault paths also know the `logs/` dir (rotated log class). */
function freshVaultWithLogs(): { vp: VaultPaths; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-rekey-classes-'))
  for (const d of ['config', 'workspace', 'logs']) mkdirSync(join(root, d), { recursive: true })
  const logsPath = join(root, 'logs')
  const vp: VaultPaths = {
    ...vaultPathsFrom({ configPath: join(root, 'config'), dbPath: join(root, 'workspace', 'hilbertraum.sqlite') }),
    logsPath
  }
  return { vp, root }
}

interface ClassFixture {
  vp: VaultPaths
  root: string
  ctl: WorkspaceController
  imageA: string
  imageB: string
  /** `<images dir>/<stored_name>` of each image session. */
  imageFiles: Record<string, string>
  outside: string
  doc: string
  rotated: string
}

function imagesDirOf(root: string): string {
  return imagesDir(join(root, 'workspace'))
}

function imageFile(ctl: WorkspaceController, root: string, id: string): string {
  const row = ctl.requireDb().prepare('SELECT stored_name FROM image_sessions WHERE id = ?').get(id) as
    | { stored_name: string }
    | undefined
  return join(imagesDirOf(root), row!.stored_name)
}

async function readImage(ctl: WorkspaceController, root: string, id: string): Promise<Uint8Array | null> {
  const detail = await getImageSession(ctl.requireDb(), imagesDirOf(root), id, ctl.documentCipher())
  return detail ? detail.imageBytes : null
}

/** Names under a dir that are rekey staging or transient plaintext leftovers. */
function transientNames(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith(REKEY_SUFFIX) || n.endsWith('.tmp'))
}

/** A legacy v1 vault carrying one of every vault-key ciphertext class, still unlocked. */
async function v1VaultWithEveryClass(): Promise<ClassFixture> {
  const { vp, root } = freshVaultWithLogs()
  const ctl = unlockedController(vp, 'old-password', FAST_SCRYPT, { legacyV1: true })
  const db = ctl.requireDb()
  const imgDir = imagesDirOf(root)
  // Two images through the REAL history writer (encrypt-then-write under the vault cipher).
  const imageA = await createImageSession(
    db,
    imgDir,
    { imageBytes: IMAGE_A, mimeType: 'image/png', name: 'a', width: 2, height: 2 },
    ctl.documentCipher()
  )
  const imageB = await createImageSession(
    db,
    imgDir,
    { imageBytes: IMAGE_B, mimeType: 'image/jpeg', name: 'b', width: 3, height: 3 },
    ctl.documentCipher()
  )
  // An ordinary document sidecar in the store.
  const doc = addEncryptedDoc(ctl, vp, 'doc-classes', 'DOCUMENT-SURVIVES')
  // A legacy out-of-store copy: hand-encrypted under `workspace/legacy-store/` with a row whose
  // `stored_path` names it (the on-disk shape `locateStoredCopy`'s fallback reads).
  const legacyDir = join(root, 'workspace', 'legacy-store')
  mkdirSync(legacyDir, { recursive: true })
  const plain = join(legacyDir, 'outside.src')
  writeFileSync(plain, 'OUTSIDE-SURVIVES', 'utf8')
  const outside = join(legacyDir, 'outside.txt.enc')
  ctl.documentCipher()!.encryptFile(plain, outside)
  shredFile(plain)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO documents (id, title, original_path, stored_path, mime_type, size_bytes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('doc-outside', 'outside', null, outside, 'text/plain', 16, 'indexed', now, now)
  // The rotated diagnostics log: the logging module's own frame (one AEAD blob under the vault key).
  const rotated = join(vp.logsPath!, ROTATED_LOG)
  writeFileSync(rotated, serializeBlob(encrypt(ctl.encryptionKey()!, Buffer.from('ROTATED-LOG', 'utf8'))))
  return {
    vp,
    root,
    ctl,
    imageA,
    imageB,
    imageFiles: { [imageA]: imageFile(ctl, root, imageA), [imageB]: imageFile(ctl, root, imageB) },
    outside,
    doc,
    rotated
  }
}

function reopen(vp: VaultPaths, password: string): WorkspaceController {
  const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
  ctl.init()
  ctl.unlock(password)
  return ctl
}

function rotatedLogText(ctl: WorkspaceController, rotated: string): string {
  return decrypt(ctl.encryptionKey()!, deserializeBlob(readFileSync(rotated))).toString('utf8')
}

/** Every class readable through a controller holding the CURRENT key; nothing staged anywhere. */
async function expectEveryClassReadable(f: ClassFixture, ctl: WorkspaceController): Promise<void> {
  expect(await readImage(ctl, f.root, f.imageA)).toEqual(IMAGE_A)
  expect(await readImage(ctl, f.root, f.imageB)).toEqual(IMAGE_B)
  expect(readEncryptedDoc(ctl, f.outside)).toBe('OUTSIDE-SURVIVES')
  expect(readEncryptedDoc(ctl, f.doc)).toBe('DOCUMENT-SURVIVES')
  expect(transientNames(imagesDirOf(f.root))).toEqual([])
  expect(transientNames(join(f.root, 'workspace', 'documents'))).toEqual([])
  expect(transientNames(join(f.root, 'workspace', 'legacy-store'))).toEqual([])
  expect(existsSync(`${f.vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
  expect(existsSync(join(f.root, 'workspace', REKEY_JOURNAL))).toBe(false)
}

describe('changePassword — every vault-key ciphertext class survives the v1→v2 migration (#241)', () => {
  it('images, an out-of-store copy, a document and the rotated log all decrypt under the new password', async () => {
    const f = await v1VaultWithEveryClass()
    expect(readVaultDescriptor(f.vp.descriptorPath)!.version).toBe(VAULT_VERSION)
    // Byte-exact before the change (the fixture itself is sound).
    expect(await readImage(f.ctl, f.root, f.imageA)).toEqual(IMAGE_A)
    expect(await readImage(f.ctl, f.root, f.imageB)).toEqual(IMAGE_B)
    expect(rotatedLogText(f.ctl, f.rotated)).toBe('ROTATED-LOG')

    expect(f.ctl.changePassword('old-password', 'new-password', FAST_ARGON).state).toBe('unlocked')
    f.ctl.lock()

    const ctl = reopen(f.vp, 'new-password')
    expect(readVaultDescriptor(f.vp.descriptorPath)!.version).toBe(VAULT_VERSION_ENVELOPE)
    // The session rows survive and both images decrypt byte-exact under the NEW key.
    expect(listImageSessions(ctl.requireDb()).map((s) => s.id).sort()).toEqual([f.imageA, f.imageB].sort())
    await expectEveryClassReadable(f, ctl)
    // The rotated log is either gone or readable under the new key — never stranded.
    if (existsSync(f.rotated)) expect(rotatedLogText(ctl, f.rotated)).toBe('ROTATED-LOG')
    ctl.lock()
  })

  it('the rotated log is deleted by the v1→v2 change (nothing reads it) and untouched by a v2 re-wrap', async () => {
    const f = await v1VaultWithEveryClass()
    f.ctl.changePassword('old-password', 'new-password', FAST_ARGON)
    expect(existsSync(f.rotated)).toBe(false)
    // A v2→v2 change keeps the data key, so a rotated generation written afterwards stays.
    writeFileSync(f.rotated, serializeBlob(encrypt(f.ctl.encryptionKey()!, Buffer.from('AGAIN', 'utf8'))))
    f.ctl.changePassword('new-password', 'third-password', FAST_ARGON)
    expect(rotatedLogText(f.ctl, f.rotated)).toBe('AGAIN')
    f.ctl.lock()
  })

  it('listVaultKeyCiphertexts enumerates the four classes; stageRekey journals every staged path', async () => {
    const f = await v1VaultWithEveryClass()
    const db = f.ctl.requireDb()
    const listed = listVaultKeyCiphertexts(f.vp, db)
    const byKind = (kind: string): string[] =>
      listed
        .filter((c) => c.kind === kind)
        .map((c) => c.path)
        .sort()
    expect(byKind('document')).toEqual([f.doc])
    expect(byKind('image')).toEqual(Object.values(f.imageFiles).sort())
    expect(byKind('out-of-store')).toEqual([f.outside])
    expect(byKind('rotated-log')).toEqual([f.rotated])
    expect(listed.filter((c) => c.action === 'delete').map((c) => c.path)).toEqual([f.rotated])
    f.ctl.lock()

    const { db: db2, key } = unlockEncryptedVault(f.vp, 'old-password')
    stageRekey(f.vp, db2, key, generateDataKey())
    db2.close()
    const journalPath = join(f.root, 'workspace', REKEY_JOURNAL)
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { staged: string[]; remove: string[] }
    const expectedStaged = [f.vp.encPath, f.doc, f.outside, ...Object.values(f.imageFiles)]
      .map((p) => `${p}${REKEY_SUFFIX}`)
      .sort()
    expect([...journal.staged].sort()).toEqual(expectedStaged)
    for (const staged of expectedStaged) expect(existsSync(staged)).toBe(true)
    expect(journal.remove).toEqual([f.rotated])
    // The rotated log is still there: nothing is deleted before the commit point.
    expect(existsSync(f.rotated)).toBe(true)

    discardPendingRekey(f.vp)
    expect(existsSync(journalPath)).toBe(false)
    for (const staged of expectedStaged) expect(existsSync(staged)).toBe(false)
    expect(existsSync(f.rotated)).toBe(true)
  })
})

// Crash at every cut of the journal, over every class. Before the commit the OLD password and
// files win (rollback); from the commit on the NEW ones do (roll-forward), whichever files a
// crash left swapped or staged.
type SwapClass = 'db' | 'document' | 'image' | 'outside'
const CUTS: Array<{ cut: string; committed: boolean; swapped: SwapClass[] }> = [
  { cut: 'after staging, before the commit', committed: false, swapped: [] },
  { cut: 'after the commit, before any swap', committed: true, swapped: [] },
  { cut: 'mid-swap: only the DB swapped', committed: true, swapped: ['db'] },
  { cut: 'mid-swap: only the document swapped', committed: true, swapped: ['document'] },
  { cut: 'mid-swap: only one image swapped', committed: true, swapped: ['image'] },
  { cut: 'mid-swap: only the out-of-store copy swapped', committed: true, swapped: ['outside'] },
  { cut: 'after every swap, before the journal is cleared', committed: true, swapped: ['db', 'document', 'image', 'outside'] }
]

describe('changePassword — crash at every journal cut, every ciphertext class (#241)', () => {
  it.each(CUTS)('$cut', async ({ committed, swapped }) => {
    const f = await v1VaultWithEveryClass()
    f.ctl.lock()
    const { db, key } = unlockEncryptedVault(f.vp, 'old-password')
    const dataKey = generateDataKey()
    stageRekey(f.vp, db, key, dataKey)
    if (committed) rewrapVaultKey(f.vp, dataKey, 'new-password', FAST_ARGON) // COMMIT
    db.close()
    const targetFor: Record<SwapClass, string> = {
      db: f.vp.encPath,
      document: f.doc,
      image: f.imageFiles[f.imageA],
      outside: f.outside
    }
    for (const cls of swapped) {
      shredFile(targetFor[cls])
      renameSync(`${targetFor[cls]}${REKEY_SUFFIX}`, targetFor[cls])
    }
    // The rotated log is only ever removed by the roll-forward, never by a stage or a rollback.
    expect(existsSync(f.rotated)).toBe(true)

    if (committed) {
      const ctl = reopen(f.vp, 'new-password') // recovery rolls FORWARD before the unlock decrypt
      await expectEveryClassReadable(f, ctl)
      expect(existsSync(f.rotated)).toBe(false)
      ctl.lock()
      expect(() => ctl.unlock('old-password')).toThrow(WrongPasswordError)
    } else {
      const ctl = reopen(f.vp, 'old-password') // recovery rolls BACK: staged files discarded
      await expectEveryClassReadable(f, ctl)
      expect(rotatedLogText(ctl, f.rotated)).toBe('ROTATED-LOG')
      ctl.lock()
    }
  })
})

// An image save cannot straddle the swap: the write holds the document-work lease, so a
// password change refuses while a save is in flight, and a save refuses while a change runs.
describe('image writes vs the password change — the document-work lease (#241)', () => {
  it('a password change is refused while an image save is in flight; the save completes and later rekeys cleanly', async () => {
    const { vp, root } = freshVaultWithLogs()
    const ctl = unlockedController(vp, 'old-password', FAST_SCRYPT, { legacyV1: true })
    const imgDir = imagesDirOf(root)
    const saving = createImageSession(
      ctl.requireDb(),
      imgDir,
      { imageBytes: IMAGE_A, mimeType: 'image/png', name: 'a', width: 2, height: 2 },
      ctl.documentCipher(),
      () => ctl.beginDocumentWork()
    )
    expect(() => ctl.changePassword('old-password', 'new-password', FAST_ARGON)).toThrow(VaultBusyError)
    const id = await saving
    expect(await readImage(ctl, root, id)).toEqual(IMAGE_A)
    expect(transientNames(imgDir)).toEqual([])
    // Lease released with the save → the change goes through and the image follows the key.
    expect(ctl.changePassword('old-password', 'new-password', FAST_ARGON).state).toBe('unlocked')
    expect(await readImage(ctl, root, id)).toEqual(IMAGE_A)
    ctl.lock()
    const again = reopen(vp, 'new-password')
    expect(await readImage(again, root, id)).toEqual(IMAGE_A)
    again.lock()
  })

  it('an image save admitted while a REAL password change runs is refused with VaultBusyError and writes nothing', async () => {
    const { vp, root } = freshVaultWithLogs()
    const ctl = unlockedController(vp, 'pw-one', FAST_SCRYPT)
    const imgDir = imagesDirOf(root)
    // Trap the private flag (the idiom of the race-guard test above): at the instant the REAL
    // changePassword flips it true, start a save that takes the lease.
    let backing = false
    let attempted: Promise<string> | null = null
    Object.defineProperty(ctl, 'changingPassword', {
      configurable: true,
      get: () => backing,
      set: (v: boolean) => {
        backing = v
        if (v && !attempted) {
          attempted = createImageSession(
            ctl.requireDb(),
            imgDir,
            { imageBytes: IMAGE_B, mimeType: 'image/png', name: 'b', width: 3, height: 3 },
            ctl.documentCipher(),
            () => ctl.beginDocumentWork()
          )
          attempted.catch(() => undefined) // asserted below; keep the rejection from going unhandled
        }
      }
    })
    expect(ctl.changePassword('pw-one', 'pw-two', FAST_ARGON).state).toBe('unlocked')
    expect(attempted).not.toBeNull()
    await expect(attempted!).rejects.toBeInstanceOf(VaultBusyError)
    // Nothing partial: no session row, no `.enc`, no `<id>.tmp`.
    expect(listImageSessions(ctl.requireDb())).toEqual([])
    expect(existsSync(imgDir) ? readdirSync(imgDir) : []).toEqual([])
    ctl.lock()
  })
})

// Journal edge cases from the #241 review: one physical file listed twice, an entry whose
// location is unreachable at recovery, and a journal that cannot be parsed.
describe('rekey journal — aliases, unreachable entries, corruption (#241)', () => {
  /** Stage + commit a full-class v1 vault and hand back the journal path. */
  async function committedStage(): Promise<ClassFixture & { journalPath: string }> {
    const f = await v1VaultWithEveryClass()
    f.ctl.lock()
    const { db, key } = unlockEncryptedVault(f.vp, 'old-password')
    const dataKey = generateDataKey()
    stageRekey(f.vp, db, key, dataKey)
    rewrapVaultKey(f.vp, dataKey, 'new-password', FAST_ARGON) // COMMIT
    db.close()
    return { ...f, journalPath: join(f.root, 'workspace', REKEY_JOURNAL) }
  }

  it('a journal entry that spells a staged file differently is swapped once, never shredded by its twin', async () => {
    const f = await committedStage()
    const journal = JSON.parse(readFileSync(f.journalPath, 'utf8')) as { staged: string[]; remove: string[] }
    // The same physical files through a `..` segment (and, on Windows, a different case).
    const alias = (p: string): string => {
      const viaParent = join(dirname(p), '..', basename(dirname(p)), basename(p))
      return process.platform === 'win32' ? viaParent.toUpperCase() : viaParent
    }
    journal.staged.push(alias(`${f.vp.encPath}${REKEY_SUFFIX}`), alias(`${f.imageFiles[f.imageA]}${REKEY_SUFFIX}`))
    writeFileSync(f.journalPath, JSON.stringify(journal), 'utf8')

    const ctl = reopen(f.vp, 'new-password') // a double swap would have shredded the DB itself
    await expectEveryClassReadable(f, ctl)
    ctl.lock()
  })

  it('an out-of-store copy on an unreachable location keeps the journal; a later recovery finishes the swap', async () => {
    const f = await committedStage()
    const legacyDir = dirname(f.outside)
    const away = `${legacyDir}.away`
    renameSync(legacyDir, away) // the legacy location is "detached" at recovery time

    const ctl = reopen(f.vp, 'new-password')
    expect(await readImage(ctl, f.root, f.imageA)).toEqual(IMAGE_A)
    expect(readEncryptedDoc(ctl, f.doc)).toBe('DOCUMENT-SURVIVES')
    expect(existsSync(f.rotated)).toBe(false)
    expect(existsSync(f.journalPath)).toBe(true) // kept: one entry could not be accounted for
    expect(existsSync(join(away, `outside.txt.enc${REKEY_SUFFIX}`))).toBe(true) // twin intact
    ctl.lock()

    renameSync(away, legacyDir) // the location returns → the next recovery completes it
    const again = reopen(f.vp, 'new-password')
    await expectEveryClassReadable(f, again)
    again.lock()
  })

  it('a journal that cannot be parsed is quarantined as .corrupt, never deleted; in-store classes still roll forward', async () => {
    const f = await committedStage()
    writeFileSync(f.journalPath, '{ not json', 'utf8')

    const ctl = reopen(f.vp, 'new-password')
    expect(await readImage(ctl, f.root, f.imageA)).toEqual(IMAGE_A)
    expect(await readImage(ctl, f.root, f.imageB)).toEqual(IMAGE_B)
    expect(readEncryptedDoc(ctl, f.doc)).toBe('DOCUMENT-SURVIVES')
    expect(existsSync(f.journalPath)).toBe(false)
    expect(readFileSync(`${f.journalPath}.corrupt`, 'utf8')).toBe('{ not json')
    // The out-of-store twin was only ever named by the journal: it stays staged beside the
    // original (nothing lost) until someone acts on the quarantined file.
    expect(existsSync(`${f.outside}${REKEY_SUFFIX}`)).toBe(true)
    expect(existsSync(f.outside)).toBe(true)
    ctl.lock()
  })
})
