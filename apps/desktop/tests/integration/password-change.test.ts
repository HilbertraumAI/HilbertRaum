import { describe, it, expect } from 'vitest'
import { mkdirSync, existsSync, linkSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import {
  unlockEncryptedVault,
  readVaultDescriptor,
  stageRekey,
  rewrapVaultKey,
  discardPendingRekey,
  listVaultKeyCiphertexts,
  encryptFile,
  decryptFile,
  shredFile,
  WorkspaceController,
  WrongPasswordError,
  VaultBusyError,
  VaultDescriptorMissingError,
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
import {
  ENCRYPTION_REQUIRED,
  FAST_ARGON,
  FAST_KDF,
  lockedVault,
  setFrameMagic,
  unlockedController,
  type FreshVaultPaths
} from '../helpers/vault-fixtures'
import { filesUnder } from '../helpers/repo-files'
import { tempRoot } from '../helpers/db-fixtures'

// Phase 32 — vault password change (wave-3 plan §5, decision D24): the v2 envelope
// descriptor (random data key wrapped by the password-derived KEK), the O(1) re-wrap on
// every v2 change, and the one-time JOURNALED v1→v2 migration on a legacy vault's first
// change. The crash tests below cut the journal at each step and prove the vault
// recovers to a consistent state: old password+files OR new — never a mix.
// Fast KDFs (vault-fixtures) keep the suite quick; unlock reads the params back from the descriptor.

/** A fresh vault under `password` (`kdf` for its descriptor, `legacyV1` for the pre-envelope format), unlocked. */
function unlockedVault(
  password: string,
  opts: { kdf?: KdfParams; legacyV1?: boolean } = {}
): { vp: FreshVaultPaths; ctl: WorkspaceController } {
  const vp = lockedVault('pwchange', password, opts)
  return { vp, ctl: unlockedController(vp, password) }
}

/** Write an encrypted document sidecar under the controller's live data key (the key its
 *  `documentCipher()` uses), via the sync file function so the helper stays synchronous. */
function addEncryptedDoc(ctl: WorkspaceController, vp: VaultPaths, name: string, text: string): string {
  const docsDir = join(join(vp.dbPath, '..'), 'documents')
  mkdirSync(docsDir, { recursive: true })
  const plain = join(docsDir, `${name}.src`)
  writeFileSync(plain, text, 'utf8')
  const enc = join(docsDir, `${name}.txt.enc`)
  encryptFile(plain, enc, ctl.encryptionKey()!)
  shredFile(plain)
  return enc
}

/** Decrypt a sidecar under the controller's live data key and return its text. */
function readEncryptedDoc(ctl: WorkspaceController, encPath: string): string {
  const out = `${encPath}.check.tmp`
  decryptFile(encPath, out, ctl.encryptionKey()!)
  const text = readFileSync(out, 'utf8')
  shredFile(out)
  return text
}

// ---- new vaults are v2 (envelope) -------------------------------------------------

describe('vault descriptor v2 (envelope)', () => {
  it('the data file key is the UNWRAPPED data key, not the password-derived KEK', () => {
    const vp = lockedVault('pwchange', 'first-password')
    const d = readVaultDescriptor(vp.descriptorPath)!
    expect(d.version).toBe(VAULT_VERSION_ENVELOPE) // a new vault is the v2 envelope
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
    const vp = lockedVault('pwchange', 'pw')
    const d = readVaultDescriptor(vp.descriptorPath)!
    delete d.dataKey
    writeFileSync(vp.descriptorPath, JSON.stringify(d), 'utf8')
    expect(readVaultDescriptor(vp.descriptorPath)).toBeNull()
    expect(() => unlockEncryptedVault(vp, 'pw')).toThrow(VaultDescriptorMissingError)
  })
})

// ---- change password: both KDF fixtures, old password dies ------------------------

describe('changePassword — change-then-unlock-with-new (both legacy KDFs)', () => {
  for (const [label, kdf] of [
    ['scrypt', FAST_KDF],
    ['argon2id', FAST_ARGON]
  ] as const) {
    it(`migrates a legacy v1 ${label} vault on its first change; old password rejected`, () => {
      const { vp, ctl } = unlockedVault('old-password', { kdf, legacyV1: true })
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
    const { vp, ctl } = unlockedVault('old-password', { legacyV1: true })
    ctl.changePassword('old-password', 'new-password') // no kdf → DEFAULT_KDF
    const d = readVaultDescriptor(vp.descriptorPath)!
    expect(d.kdf.algo).toBe('argon2id')
    expect(d.kdf.m).toBe(19456) // the OWASP-interactive default, not a test param
    ctl.lock()
    expect(ctl.unlock('new-password').state).toBe('unlocked')
    ctl.lock()
  })

  it('rejects a wrong current password and leaves the vault byte-identical', () => {
    const { vp, ctl } = unlockedVault('right-password', { legacyV1: true })
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
    const ctl = new WorkspaceController(lockedVault('pwchange', 'pw'), ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(() => ctl.changePassword('pw', 'next-password')).toThrow(/unlocked/)
  })
})

// ---- every change of a v2 vault is O(1); the v1 migration is covered per class (#241) below ----

describe('changePassword — migration vs O(1) re-wrap', () => {
  // Vaults created as v2 (every released build) and legacy v1 vaults after their one-time migration.
  it.each<[string, () => { vp: FreshVaultPaths; ctl: WorkspaceController; enc: string; current: string }]>([
    [
      'created as v2',
      () => {
        const { vp, ctl } = unlockedVault('pw-one')
        return { vp, ctl, enc: addEncryptedDoc(ctl, vp, 'doc-o1', 'untouched content'), current: 'pw-one' }
      }
    ],
    [
      'v2 after the one-time v1 migration',
      () => {
        const { vp, ctl } = unlockedVault('pw-one', { legacyV1: true })
        const enc = addEncryptedDoc(ctl, vp, 'doc-o1', 'untouched content')
        ctl.changePassword('pw-one', 'pw-two', FAST_ARGON) // the one-time migration
        return { vp, ctl, enc, current: 'pw-two' }
      }
    ]
  ])('the password change of a v2 vault is the O(1) re-wrap, data files untouched (%s)', (_origin, arrange) => {
    const { vp, ctl, enc, current } = arrange()
    const docBytes = readFileSync(enc)
    const dbBytes = readFileSync(vp.encPath)
    const descriptorBefore = readFileSync(vp.descriptorPath, 'utf8')

    ctl.changePassword(current, 'pw-next', FAST_ARGON) // v2 → descriptor-only

    // No bulk re-encrypt: the document sidecar AND the at-rest DB are byte-identical.
    expect(readFileSync(enc).equals(docBytes)).toBe(true)
    expect(readFileSync(vp.encPath).equals(dbBytes)).toBe(true)
    // But the descriptor was atomically replaced (fresh salt + verifier + wrap).
    expect(readFileSync(vp.descriptorPath, 'utf8')).not.toBe(descriptorBefore)

    ctl.lock()
    expect(() => ctl.unlock(current)).toThrow(WrongPasswordError)
    ctl.unlock('pw-next')
    expect(readEncryptedDoc(ctl, enc)).toBe('untouched content')
    ctl.lock()
  })
})

// ---- the import/re-index ↔ password-change race guard -----------------------------

describe('changePassword — document-work race guard (Phase 32)', () => {
  it('refuses while document work holds a lease; works once released', () => {
    const { ctl } = unlockedVault('pw-one')
    const releaseFirst = ctl.beginDocumentWork()
    const releaseSecond = ctl.beginDocumentWork()
    // The class is the contract here; its text is `tMain('main.workspace.busyDocumentWork')`, which
    // workspace-ipc.test.ts checks in every language (#807).
    expect(() => ctl.changePassword('pw-one', 'pw-two', FAST_ARGON)).toThrow(VaultBusyError)

    // A release is idempotent: releasing the first lease twice must not free the second one.
    releaseFirst()
    releaseFirst()
    expect(() => ctl.changePassword('pw-one', 'pw-two', FAST_ARGON)).toThrow(VaultBusyError)
    releaseSecond()
    expect(ctl.changePassword('pw-one', 'pw-two', FAST_ARGON).state).toBe('unlocked')
    ctl.lock()
  })
})

// ---- nothing secret ever touches the disk ---------------------------------------------

describe('descriptor/.enc scan — passwords and keys stay memory-only (extended)', () => {
  it('neither password nor the unwrapped data key appears in any on-disk artifact', () => {
    const OLD = 'super-secret-old-passphrase-3k9q'
    const NEW = 'super-secret-new-passphrase-7w1z'
    const { vp, ctl } = unlockedVault(OLD, { legacyV1: true })
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

    // Every file under the vault's root while it is open: the descriptor and `.enc`, the working DB and its WAL, the
    // document sidecars, and any `.tmp`, `.bak`, `.corrupt` or new sidecar a later change would add.
    const artifacts = filesUnder(vp.root, /./)
    expect(artifacts).toEqual(expect.arrayContaining([vp.descriptorPath, vp.encPath, enc]))
    const secrets = [
      Buffer.from(OLD),
      Buffer.from(NEW),
      dataKey,
      Buffer.from(dataKey.toString('base64')),
      Buffer.from(dataKey.toString('hex'))
    ]
    for (const artifact of artifacts) {
      const bytes = readFileSync(artifact)
      for (const secret of secrets) {
        expect(bytes.includes(secret), artifact).toBe(false)
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
  /** A second document sidecar: a migration must carry every one, not the first it lists. */
  doc2: string
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

/** Where a fixture's legacy out-of-store copy lies: under `workspace/` but outside its store, by default. */
type LegacyDirOf = (root: string) => string
const IN_WORKSPACE: LegacyDirOf = (root) => join(root, 'workspace', 'legacy-store')

/** A legacy v1 vault (its paths know `logs/`, the rotated-log class) carrying every vault-key ciphertext class, still
 *  unlocked. `legacyDirOf` places the out-of-store copy (#1014: also outside the workspace folder). */
async function v1VaultWithEveryClass(legacyDirOf: LegacyDirOf = IN_WORKSPACE): Promise<ClassFixture> {
  const vp = lockedVault('rekey-classes', 'old-password', { legacyV1: true, logs: true })
  const root = vp.root
  const ctl = unlockedController(vp, 'old-password')
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
  // Two ordinary document sidecars in the store.
  const doc = addEncryptedDoc(ctl, vp, 'doc-classes', 'DOCUMENT-SURVIVES')
  const doc2 = addEncryptedDoc(ctl, vp, 'doc-classes-2', 'SECOND-DOCUMENT-SURVIVES')
  // A legacy out-of-store copy: hand-encrypted under `workspace/legacy-store/` (or `legacyDirOf`'s folder) with a row
  // whose `stored_path` names it (the on-disk shape `locateStoredCopy`'s fallback reads).
  const legacyDir = legacyDirOf(root)
  mkdirSync(legacyDir, { recursive: true })
  const plain = join(legacyDir, 'outside.src')
  writeFileSync(plain, 'OUTSIDE-SURVIVES', 'utf8')
  const outside = join(legacyDir, 'outside.txt.enc')
  await ctl.documentCipher()!.encryptFileAsync(plain, outside)
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
    doc2,
    rotated
  }
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
  expect(readEncryptedDoc(ctl, f.doc2)).toBe('SECOND-DOCUMENT-SURVIVES')
  expect(transientNames(imagesDirOf(f.root))).toEqual([])
  expect(transientNames(join(f.root, 'workspace', 'documents'))).toEqual([])
  expect(transientNames(join(f.root, 'workspace', 'legacy-store'))).toEqual([])
  expect(existsSync(`${f.vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
  expect(existsSync(join(f.root, 'workspace', REKEY_JOURNAL))).toBe(false)
}

describe('changePassword — every vault-key ciphertext class survives the v1→v2 migration (#241)', () => {
  // The rotated log is not decrypted: the migration deletes it (the next row).
  it('images, an out-of-store copy and every document decrypt under the new password', async () => {
    const f = await v1VaultWithEveryClass()
    expect(readVaultDescriptor(f.vp.descriptorPath)!.version).toBe(VAULT_VERSION)
    // Byte-exact before the change (the fixture itself is sound).
    expect(await readImage(f.ctl, f.root, f.imageA)).toEqual(IMAGE_A)
    expect(await readImage(f.ctl, f.root, f.imageB)).toEqual(IMAGE_B)
    expect(rotatedLogText(f.ctl, f.rotated)).toBe('ROTATED-LOG')

    expect(f.ctl.changePassword('old-password', 'new-password', FAST_ARGON).state).toBe('unlocked')
    f.ctl.lock()

    const ctl = unlockedController(f.vp, 'new-password')
    expect(readVaultDescriptor(f.vp.descriptorPath)!.version).toBe(VAULT_VERSION_ENVELOPE)
    // The session rows survive and both images decrypt byte-exact under the NEW key.
    expect(listImageSessions(ctl.requireDb()).map((s) => s.id).sort()).toEqual([f.imageA, f.imageB].sort())
    await expectEveryClassReadable(f, ctl)
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
    expect(byKind('document')).toEqual([f.doc, f.doc2].sort())
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
    const expectedStaged = [f.vp.encPath, f.doc, f.doc2, f.outside, ...Object.values(f.imageFiles)]
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

// Crash at every cut of the journal, over every class. `changePassword` composes exactly
// stageRekey → rewrapVaultKey (the COMMIT) → applyPendingRekey; each row runs those exported steps, "crashes"
// (closes the DB without finishing) and leaves the swap where the cut says. Before the commit the OLD password and
// files win (rollback); from the commit on the NEW ones do (roll-forward), whichever files a crash left swapped or
// staged. Startup recovery (`init()`) resolves the journal on its own, before any unlock, so a vault that stays
// locked still rests consistent. `'every staged file'` swaps all of them: the crash between the last swap and the
// journal clear, where recovery runs with nothing left staged and only the journal's deletions to do.
type SwapClass = 'db' | 'document' | 'image' | 'outside'
const CUTS: Array<[string, { committed: boolean; swapped: SwapClass[] | 'every staged file' }]> = [
  ['after staging, before the commit', { committed: false, swapped: [] }],
  ['after the commit, before any swap', { committed: true, swapped: [] }],
  ['mid-swap: only the DB swapped', { committed: true, swapped: ['db'] }],
  ['mid-swap: only the document swapped', { committed: true, swapped: ['document'] }],
  ['mid-swap: only one image swapped', { committed: true, swapped: ['image'] }],
  ['mid-swap: only the out-of-store copy swapped', { committed: true, swapped: ['outside'] }],
  ['after every swap, before the journal is cleared', { committed: true, swapped: 'every staged file' }]
]

describe('changePassword — crash at every journal cut, every ciphertext class (#241)', () => {
  it.each(CUTS)('%s', async (_cut, { committed, swapped }) => {
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
    const stagedTargets = [f.vp.encPath, f.doc, f.doc2, f.outside, ...Object.values(f.imageFiles)]
    const toSwap = swapped === 'every staged file' ? stagedTargets : swapped.map((cls) => targetFor[cls])
    for (const target of toSwap) {
      shredFile(target)
      renameSync(`${target}${REKEY_SUFFIX}`, target)
    }
    // The rotated log is only ever removed by the roll-forward, never by a stage or a rollback.
    expect(existsSync(f.rotated)).toBe(true)
    // The crash left a real journal, and every file the cut did not swap still has its staged twin.
    const journalPath = join(f.root, 'workspace', REKEY_JOURNAL)
    expect(existsSync(journalPath)).toBe(true)
    for (const target of stagedTargets.filter((t) => !toSwap.includes(t))) {
      expect(existsSync(`${target}${REKEY_SUFFIX}`), target).toBe(true)
    }

    // Startup recovery ALONE resolves it: no staged twin and no journal left, before any unlock.
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    for (const target of stagedTargets) expect(existsSync(`${target}${REKEY_SUFFIX}`), target).toBe(false)
    expect(existsSync(journalPath)).toBe(false)

    if (committed) {
      ctl.unlock('new-password') // rolled FORWARD: the new password and files win
      await expectEveryClassReadable(f, ctl)
      expect(existsSync(f.rotated)).toBe(false)
      ctl.lock()
      expect(() => ctl.unlock('old-password')).toThrow(WrongPasswordError)
    } else {
      ctl.unlock('old-password') // rolled BACK: staged files discarded
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
    const vp = lockedVault('rekey-classes', 'old-password', { legacyV1: true, logs: true })
    const ctl = unlockedController(vp, 'old-password')
    const imgDir = imagesDirOf(vp.root)
    const saving = createImageSession(
      ctl.requireDb(),
      imgDir,
      { imageBytes: IMAGE_A, mimeType: 'image/png', name: 'a', width: 2, height: 2 },
      ctl.documentCipher(),
      () => ctl.beginDocumentWork()
    )
    expect(() => ctl.changePassword('old-password', 'new-password', FAST_ARGON)).toThrow(VaultBusyError)
    const id = await saving
    expect(await readImage(ctl, vp.root, id)).toEqual(IMAGE_A)
    expect(transientNames(imgDir)).toEqual([])
    // Lease released with the save → the change goes through and the image follows the key.
    expect(ctl.changePassword('old-password', 'new-password', FAST_ARGON).state).toBe('unlocked')
    expect(await readImage(ctl, vp.root, id)).toEqual(IMAGE_A)
    ctl.lock()
    const again = unlockedController(vp, 'new-password')
    expect(await readImage(again, vp.root, id)).toEqual(IMAGE_A)
    again.lock()
  })

  it('an image save admitted while a REAL password change runs is refused with VaultBusyError and writes nothing', async () => {
    const vp = lockedVault('rekey-classes', 'pw-one', { logs: true })
    const ctl = unlockedController(vp, 'pw-one')
    const imgDir = imagesDirOf(vp.root)
    // changePassword is synchronous, so nothing can interleave from the outside. Trap the private flag instead
    // (T6, full-audit-2026-06-30): record its real transitions, and at the instant the REAL changePassword flips it
    // true, start a save that takes the lease. A change that stops setting or clearing the flag around its work
    // reddens here.
    const transitions: boolean[] = []
    let backing = false
    let attempted: Promise<string> | null = null
    Object.defineProperty(ctl, 'changingPassword', {
      configurable: true,
      get: () => backing,
      set: (v: boolean) => {
        backing = v
        transitions.push(v)
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
    // SET then CLEARED around the real re-wrap (the `finally` ran).
    expect(transitions).toEqual([true, false])
    expect(attempted).not.toBeNull()
    await expect(attempted!).rejects.toBeInstanceOf(VaultBusyError)
    // Nothing partial: no session row, no `.enc`, no `<id>.tmp`.
    expect(listImageSessions(ctl.requireDb())).toEqual([])
    expect(existsSync(imgDir) ? readdirSync(imgDir) : []).toEqual([])
    // The flag is down again: document work starts cleanly.
    ctl.beginDocumentWork()()
    ctl.lock()
  })
})

/** Stage + commit a full-class v1 vault (a password change cut short right after its commit) and hand back the journal
 *  path. `legacyDirOf` places the out-of-store copy (see `v1VaultWithEveryClass`). */
async function committedStage(legacyDirOf: LegacyDirOf = IN_WORKSPACE): Promise<ClassFixture & { journalPath: string }> {
  const f = await v1VaultWithEveryClass(legacyDirOf)
  f.ctl.lock()
  const { db, key } = unlockEncryptedVault(f.vp, 'old-password')
  const dataKey = generateDataKey()
  stageRekey(f.vp, db, key, dataKey)
  rewrapVaultKey(f.vp, dataKey, 'new-password', FAST_ARGON) // COMMIT
  db.close()
  return { ...f, journalPath: join(f.root, 'workspace', REKEY_JOURNAL) }
}

// Journal edge cases from the #241 review: one physical file listed twice, an entry whose
// location is unreachable at recovery, and a journal that cannot be parsed.
describe('rekey journal — aliases, unreachable entries, corruption (#241)', () => {
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

    const ctl = unlockedController(f.vp, 'new-password') // a double swap would have shredded the DB itself
    await expectEveryClassReadable(f, ctl)
    ctl.lock()
  })

  it('an out-of-store copy on an unreachable location keeps the journal; a later recovery finishes the swap', async () => {
    const f = await committedStage()
    const legacyDir = dirname(f.outside)
    const away = `${legacyDir}.away`
    renameSync(legacyDir, away) // the legacy location is "detached" at recovery time

    const ctl = unlockedController(f.vp, 'new-password')
    expect(await readImage(ctl, f.root, f.imageA)).toEqual(IMAGE_A)
    expect(readEncryptedDoc(ctl, f.doc)).toBe('DOCUMENT-SURVIVES')
    expect(existsSync(f.rotated)).toBe(false)
    expect(existsSync(f.journalPath)).toBe(true) // kept: one entry could not be accounted for
    expect(existsSync(join(away, `outside.txt.enc${REKEY_SUFFIX}`))).toBe(true) // twin intact
    ctl.lock()

    renameSync(away, legacyDir) // the location returns → the next recovery completes it
    const again = unlockedController(f.vp, 'new-password')
    await expectEveryClassReadable(f, again)
    again.lock()
  })

  it('a journal that cannot be parsed is quarantined as .corrupt, never deleted; in-store classes still roll forward', async () => {
    const f = await committedStage()
    writeFileSync(f.journalPath, '{ not json', 'utf8')

    const ctl = unlockedController(f.vp, 'new-password')
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

// #1015: the start swaps in the stages a committed password change left, with no key at hand. A swap it cannot make (a
// folder at the stored copy's name, or a file another program holds) threw out of `init()`, and in the app out of the
// backend start before any IPC was registered: that run had no working back end. Now the start reports its recovery as
// blocked (the unlock answers "try again", the #242 answer), and a later start finishes the swap once the name is free.
describe('rekey journal — a swap the start cannot make (#1015)', () => {
  // Round 3: only a hold is "try again". A folder at a stored copy's name holds no data and does not go away by waiting,
  // so it no longer blocks every start and unlock: that one stage is left (counted, and the journal keeps listing it), the
  // rest of the change finishes and the workspace opens; once the folder is gone, the next start swaps that stage in.
  it("a folder at a stored copy's name: that stage is left, the rest finishes and the workspace opens; once the folder is gone the next start swaps it in", async () => {
    const f = await committedStage()
    const staged = `${f.doc}${REKEY_SUFFIX}`
    const stage = readFileSync(staged)
    rmSync(f.doc)
    mkdirSync(f.doc)
    writeFileSync(join(f.doc, 'held'), 'x')
    const first = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    expect(() => first.init()).not.toThrow()
    expect(first.isRecoveryBlocked()).toBe(false)
    expect(readFileSync(staged).equals(stage), 'the stage').toBe(true)
    expect(readdirSync(f.doc)).toEqual(['held'])
    expect(JSON.parse(readFileSync(f.journalPath, 'utf8')).staged, 'the journal lists that stage only').toEqual([staged])
    expect(first.takeJournalRefusals()).toBe(1)
    first.unlock('new-password')
    expect(readEncryptedDoc(first, f.doc2)).toBe('SECOND-DOCUMENT-SURVIVES')
    expect(await readImage(first, f.root, f.imageA)).toEqual(IMAGE_A)
    first.lock()

    rmSync(f.doc, { recursive: true })
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(existsSync(staged)).toBe(false)
    ctl.unlock('new-password')
    await expectEveryClassReadable(f, ctl)
    ctl.lock()
  })

  // The database is the exception: a folder at `.enc` itself is not one document left aside but the whole workspace, so
  // the swap of its stage still fails into the blocked recovery, and nothing is moved.
  it('a folder at the database name: the start is blocked, the staged database is left as it is', async () => {
    const f = await committedStage()
    const stagedDb = `${f.vp.encPath}${REKEY_SUFFIX}`
    const stage = readFileSync(stagedDb)
    rmSync(f.vp.encPath)
    mkdirSync(f.vp.encPath)
    writeFileSync(join(f.vp.encPath, 'held'), 'x')
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    expect(() => ctl.init()).not.toThrow()
    expect(ctl.isRecoveryBlocked()).toBe(true)
    expect(readFileSync(stagedDb).equals(stage), 'the staged database').toBe(true)
    expect(readdirSync(f.vp.encPath)).toEqual(['held'])
  })

  // A folder at one of the recovery's write temps (the staged database's, the journal's, a stage's) holds no data: it is
  // left as it is and counted, and neither the start nor the unlock is blocked by it.
  it.each<[string, (f: ClassFixture & { journalPath: string }) => string]>([
    ["the staged database's write temp", (f) => `${f.vp.encPath}${REKEY_SUFFIX}.tmp`],
    ["the journal's write temp", (f) => `${f.journalPath}.tmp`],
    ["a staged document's write temp", (f) => `${f.doc}${REKEY_SUFFIX}.tmp`]
  ])('a folder at %s: the start and the unlock go on, the folder stays as it is', async (_what, tempOf) => {
    const f = await committedStage()
    const temp = tempOf(f)
    mkdirSync(temp)
    writeFileSync(join(temp, 'held'), 'x')
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.isRecoveryBlocked()).toBe(false)
    expect(ctl.takeJournalRefusals()).toBe(1)
    ctl.unlock('new-password')
    expect(readdirSync(temp)).toEqual(['held'])
    expect(readEncryptedDoc(ctl, f.doc)).toBe('DOCUMENT-SURVIVES')
    expect(readEncryptedDoc(ctl, f.doc2)).toBe('SECOND-DOCUMENT-SURVIVES')
    expect(readEncryptedDoc(ctl, f.outside)).toBe('OUTSIDE-SURVIVES')
    expect(await readImage(ctl, f.root, f.imageA)).toEqual(IMAGE_A)
    expect(existsSync(f.journalPath)).toBe(false)
    ctl.lock()
  })
})

// #1014: the journal is plain JSON in the workspace folder, read at every start before any password, and its entries are
// absolute paths. The start used to delete every `remove` entry, delete `<staged>.tmp` and swap every `staged` entry,
// wherever they pointed. Now the start acts only on what lies inside the workspace folder; the rotated diagnostics log
// goes by the path the app computes for it; an out-of-store copy outside the workspace waits for the unlock, which swaps
// it in only when the open database lists its stored copy; anything else is left as it is and counted.
describe('rekey journal — entries outside the workspace (#1014)', () => {
  it('a journal that names files outside the workspace: the start and the unlock leave them byte for byte, every class still rolls forward', async () => {
    const f = await committedStage()
    const away = tempRoot('rekey-outside')
    const files: Record<string, string> = {
      removed: join(away, 'notes.txt'),
      target: join(away, 'letter.pdf.enc'),
      staged: join(away, `letter.pdf.enc${REKEY_SUFFIX}`),
      temp: join(away, `letter.pdf.enc${REKEY_SUFFIX}.tmp`)
    }
    for (const [name, path] of Object.entries(files)) writeFileSync(path, `outside: ${name}`)
    // And a stage that DOES open under the data key (a copy of one of the workspace's own stages) beside a file outside
    // the workspace that no document lists: only the database's word lets an outside stage replace anything.
    const foreign = join(away, 'report.pdf.enc')
    writeFileSync(foreign, 'outside: report')
    const foreignStage = readFileSync(`${f.doc}${REKEY_SUFFIX}`)
    writeFileSync(`${foreign}${REKEY_SUFFIX}`, foreignStage)
    const journal = JSON.parse(readFileSync(f.journalPath, 'utf8')) as { staged: string[]; remove: string[] }
    journal.remove.push(files.removed)
    journal.staged.push(files.staged, `${foreign}${REKEY_SUFFIX}`)
    writeFileSync(f.journalPath, JSON.stringify(journal), 'utf8')
    const untouched = (): void => {
      for (const [name, path] of Object.entries(files)) expect(readFileSync(path, 'utf8'), name).toBe(`outside: ${name}`)
      expect(readFileSync(foreign, 'utf8'), 'report').toBe('outside: report')
      expect(readFileSync(`${foreign}${REKEY_SUFFIX}`).equals(foreignStage), 'its stage').toBe(true)
    }

    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    untouched()
    ctl.unlock('new-password')
    untouched()
    await expectEveryClassReadable(f, ctl)
    expect(existsSync(f.rotated)).toBe(false)
    // Counted for the log, once each: the `remove` entry at the start (the stages wait for the database), then the two
    // stages whose stored copy no document lists, at the unlock.
    expect(ctl.takeJournalRefusals()).toBe(3)
    expect(ctl.takeJournalRefusals()).toBe(0)
    ctl.lock()
  })

  // An out-of-store copy (issue #188's absolute `stored_path`) can lie outside the workspace folder: elsewhere on the
  // drive, or on another drive. The start holds neither the key nor the database, so it cannot tell such an entry from any
  // other path a journal names: it leaves it, and the unlock swaps it in once the open database lists its stored copy and
  // the stage opens under the data key.
  it.each<[string, LegacyDirOf]>([
    ['elsewhere on the drive', (root) => join(root, 'legacy-store')],
    ['on another drive', () => join(tempRoot('rekey-other-drive'), 'legacy-store')]
  ])('an out-of-store copy %s: the start leaves it staged, the unlock swaps it in', async (_where, legacyDirOf) => {
    const f = await committedStage(legacyDirOf)
    const stagedOutside = `${f.outside}${REKEY_SUFFIX}`
    const before = [readFileSync(f.outside), readFileSync(stagedOutside)]
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(readFileSync(f.outside).equals(before[0]), 'the stored copy').toBe(true)
    expect(readFileSync(stagedOutside).equals(before[1]), 'its stage').toBe(true)
    ctl.unlock('new-password')
    await expectEveryClassReadable(f, ctl)
    expect(existsSync(stagedOutside)).toBe(false)
    expect(ctl.takeJournalRefusals()).toBe(0)
    ctl.lock()
  })

  // The database's word is not enough on its own: the unlock swaps a stage over a listed stored copy only when the stage
  // opens under the data key (the stored copy of a pending change does not). A stage from another workspace (a journal or
  // a folder restored from a backup) would otherwise shred that copy and put a file no key here opens in its place.
  it('an out-of-store copy outside the workspace beside a stage that does not open under the data key: both are left as they are', async () => {
    const f = await committedStage((root) => join(root, 'legacy-store'))
    const stagedOutside = `${f.outside}${REKEY_SUFFIX}`
    const src = join(f.root, 'foreign-src.txt')
    writeFileSync(src, 'OUTSIDE-SURVIVES')
    encryptFile(src, stagedOutside, generateDataKey()) // the same length, under a key nothing here holds
    rmSync(src)
    const before = [readFileSync(f.outside), readFileSync(stagedOutside)]
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.unlock('new-password')
    expect(readFileSync(f.outside).equals(before[0]), 'the stored copy').toBe(true)
    expect(readFileSync(stagedOutside).equals(before[1]), 'the foreign stage').toBe(true)
    expect(readEncryptedDoc(ctl, f.doc)).toBe('DOCUMENT-SURVIVES') // the rest rolled forward
    ctl.lock()
  })

  // Review R1: the journal is the only record of an outside stage, so the unlock keeps it until every stage it lists is
  // settled (swapped in, already in place, or proven foreign by its tag). A stage it may not judge yet (here a second
  // hard link to it, as a backup tool may leave; a link or a folder at either name is the same) is left with the journal,
  // and the next unlock swaps it in once that is gone. Clearing the journal there lost the document for good.
  it('an outside stage with a second hard link: the journal stays, and the next unlock swaps it in once the link is gone', async () => {
    const f = await committedStage((root) => join(root, 'legacy-store'))
    const stagedOutside = `${f.outside}${REKEY_SUFFIX}`
    const extra = join(f.root, 'backup-of-stage.bin')
    linkSync(stagedOutside, extra)
    const before = [readFileSync(f.outside), readFileSync(stagedOutside)]
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.unlock('new-password')
    expect(readFileSync(f.outside).equals(before[0]), 'the stored copy').toBe(true)
    expect(readFileSync(stagedOutside).equals(before[1]), 'its stage').toBe(true)
    expect(existsSync(f.journalPath), 'the journal').toBe(true)
    expect(readEncryptedDoc(ctl, f.doc)).toBe('DOCUMENT-SURVIVES') // the rest rolled forward
    ctl.lock()
    rmSync(extra)
    ctl.unlock('new-password')
    await expectEveryClassReadable(f, ctl)
    expect(existsSync(stagedOutside)).toBe(false)
    ctl.lock()
  })

  // Review R2: a stage in a frame a newer build wrote is that build's to finish: this build writes nothing there, and
  // keeps the journal that names it.
  it("an outside stage in a newer build's frame: the unlock leaves it, the stored copy and the journal as they are", async () => {
    const f = await committedStage((root) => join(root, 'legacy-store'))
    const stagedOutside = `${f.outside}${REKEY_SUFFIX}`
    setFrameMagic(stagedOutside, 'HRAUMEN2')
    const before = [readFileSync(f.outside), readFileSync(stagedOutside)]
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.unlock('new-password')
    expect(readFileSync(f.outside).equals(before[0]), 'the stored copy').toBe(true)
    expect(readFileSync(stagedOutside).equals(before[1]), 'its stage').toBe(true)
    expect(existsSync(f.journalPath), 'the journal').toBe(true)
    ctl.lock()
  })

  // Review R6: the edges of the deferral. A wrong password never reaches the step that holds the database: the outside
  // stage, its stored copy and the journal stay byte for byte, and the right password then swaps it in.
  it('a wrong password before the deferred step: the outside stage, its stored copy and the journal stay as they are', async () => {
    const f = await committedStage((root) => join(root, 'legacy-store'))
    const stagedOutside = `${f.outside}${REKEY_SUFFIX}`
    const files = [f.outside, stagedOutside, f.journalPath]
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    const before = files.map((path) => readFileSync(path))
    expect(() => ctl.unlock('old-password')).toThrow(WrongPasswordError)
    files.forEach((path, i) => expect(readFileSync(path).equals(before[i]), path).toBe(true))
    ctl.unlock('new-password')
    await expectEveryClassReadable(f, ctl)
    ctl.lock()
  })

  // A swap cut short between the shred of the outside stored copy and the rename of its stage leaves the stage alone,
  // the only copy: the next unlock renames it into place.
  it('a swap cut short between the shred and the rename: the next unlock renames the outside stage into place', async () => {
    const f = await committedStage((root) => join(root, 'legacy-store'))
    shredFile(f.outside) // the swap's first half; the crash lands before the rename
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.unlock('new-password')
    await expectEveryClassReadable(f, ctl)
    expect(existsSync(`${f.outside}${REKEY_SUFFIX}`)).toBe(false)
    ctl.lock()
  })

  // A change cut short before its commit (the descriptor still v1) rolls back at the start. Its stages inside the
  // workspace are removed as before; an outside one, and its write temp, cannot be judged without the database and are
  // left (ciphertext under a key nothing holds), and the journal goes. The old password opens everything as it was.
  it('a change rolled back before its commit: the outside stage and its temp stay, the journal goes, the old password opens it all', async () => {
    const f = await v1VaultWithEveryClass((root) => join(root, 'legacy-store'))
    f.ctl.lock()
    const { db, key } = unlockEncryptedVault(f.vp, 'old-password')
    stageRekey(f.vp, db, key, generateDataKey()) // staged, never committed
    db.close()
    const stagedOutside = `${f.outside}${REKEY_SUFFIX}`
    writeFileSync(`${stagedOutside}.tmp`, 'a write temp')
    const stage = readFileSync(stagedOutside)
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(readFileSync(stagedOutside).equals(stage), 'the outside stage').toBe(true)
    expect(readFileSync(`${stagedOutside}.tmp`, 'utf8')).toBe('a write temp')
    expect(existsSync(join(f.root, 'workspace', REKEY_JOURNAL))).toBe(false)
    expect(ctl.takeJournalRefusals()).toBe(1)
    ctl.unlock('old-password')
    await expectEveryClassReadable(f, ctl)
    expect(rotatedLogText(ctl, f.rotated)).toBe('ROTATED-LOG')
    ctl.lock()
  })

  // Round 3: the containment is judged on the disk, not only on the text. An entry under `documents/J/`, where `J` is a
  // junction (a folder link; no privilege needed on Windows) to a folder outside the workspace, reads as inside the
  // workspace, and the start shredded and replaced the file behind the link. A link anywhere between the workspace folder
  // and the entry now refuses it.
  it('a journal entry whose path runs through a junction inside the workspace: the files behind it stay byte for byte', () => {
    const vp = lockedVault('rekey-junction', 'pw')
    const away = tempRoot('rekey-junction-target')
    const victim = join(away, 'letter.pdf.enc')
    writeFileSync(victim, 'outside: letter')
    writeFileSync(`${victim}${REKEY_SUFFIX}`, 'outside: stage')
    const docs = join(dirname(vp.dbPath), 'documents')
    mkdirSync(docs, { recursive: true })
    const link = join(docs, 'J')
    symlinkSync(away, link, 'junction')
    const journalPath = join(dirname(vp.dbPath), REKEY_JOURNAL)
    writeFileSync(journalPath, JSON.stringify({ version: 1, staged: [join(link, `letter.pdf.enc${REKEY_SUFFIX}`)], remove: [] }))
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(readFileSync(victim, 'utf8')).toBe('outside: letter')
    expect(readFileSync(`${victim}${REKEY_SUFFIX}`, 'utf8')).toBe('outside: stage')
    expect(ctl.takeJournalRefusals()).toBe(1)
    expect(existsSync(journalPath)).toBe(false)
    expect(ctl.unlock('pw').state).toBe('unlocked')
    ctl.lock()
  })

  // Round 3: a journal kept for a later unlock vouches only for what still waits. It used to stay as written, listing the
  // staged database and every in-store stage it had already swapped in, so a stray `.enc.new` that turned up later (a
  // folder copied back, another workspace's file) was "listed" and rolled over `.enc` with no key check. Once the in-store
  // stages are settled the journal is rewritten to list only the outside stages still waiting, and such a stray is the
  // #973 doubt the unlock judges under the data key.
  it('a journal kept for an outside stage it cannot settle no longer vouches for a staged database that turns up later', async () => {
    const f = await committedStage((root) => join(root, 'legacy-store'))
    const stagedOutside = `${f.outside}${REKEY_SUFFIX}`
    linkSync(stagedOutside, join(f.root, 'backup-of-stage.bin')) // not judged while a second name shares it (review R1)
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.unlock('new-password')
    ctl.lock()
    const stray = `${f.vp.encPath}${REKEY_SUFFIX}`
    writeFileSync(stray, readFileSync(lockedVault('rekey-stray', 'other-password').encPath))
    const enc = readFileSync(f.vp.encPath)
    const next = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    next.init()
    expect(readFileSync(f.vp.encPath).equals(enc), '.enc after the start').toBe(true)
    next.unlock('new-password')
    expect(next.takeStageOutcome()).toBe('removed')
    expect(existsSync(stray)).toBe(false)
    expect(readEncryptedDoc(next, f.doc)).toBe('DOCUMENT-SURVIVES')
    expect(JSON.parse(readFileSync(f.journalPath, 'utf8'))).toEqual({ version: 1, staged: [stagedOutside], remove: [] })
    next.lock()
  })

  // A Kit that comes back under another drive letter or mount point carries a journal whose every entry names the old
  // root. Nothing under that root is touched: here a decoy tree holds a file at every name the rewritten journal lists,
  // and each stays byte for byte. The workspace's own stages roll forward anyway: none of them is listed by its full path
  // any more, so the unlock judges each one under the data key (#973, #1001); and the rotated log goes by the path the app
  // computes for it, never the one the journal wrote. (The out-of-store copy's row names its path as it was, as #188's
  // absolute paths do: it is not asserted here.)
  it('a journal written under another drive root: nothing there is touched, the stages roll forward at the unlock, the rotated log goes', async () => {
    const f = await committedStage()
    const oldRoot = tempRoot('rekey-old-root')
    const moved = (path: string): string => join(oldRoot, relative(f.root, path))
    const journal = JSON.parse(readFileSync(f.journalPath, 'utf8')) as { staged: string[]; remove: string[] }
    const rewritten = { version: 1, staged: journal.staged.map(moved), remove: journal.remove.map(moved) }
    expect(rewritten.remove).toHaveLength(1)
    writeFileSync(f.journalPath, JSON.stringify(rewritten), 'utf8')
    const decoys = [...rewritten.staged, ...rewritten.staged.map((s) => s.slice(0, -REKEY_SUFFIX.length)), ...rewritten.remove]
    const decoyText = (path: string): string => `decoy ${relative(oldRoot, path)}`
    for (const path of decoys) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, decoyText(path))
    }

    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.unlock('new-password')
    for (const path of decoys) expect(readFileSync(path, 'utf8'), path).toBe(decoyText(path))
    expect(await readImage(ctl, f.root, f.imageA)).toEqual(IMAGE_A)
    expect(await readImage(ctl, f.root, f.imageB)).toEqual(IMAGE_B)
    expect(readEncryptedDoc(ctl, f.doc)).toBe('DOCUMENT-SURVIVES')
    expect(readEncryptedDoc(ctl, f.doc2)).toBe('SECOND-DOCUMENT-SURVIVES')
    expect(existsSync(f.rotated)).toBe(false)
    ctl.lock()
  })
})
