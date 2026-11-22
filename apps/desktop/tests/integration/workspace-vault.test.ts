import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync
} from 'node:fs'
import { join, dirname } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'
import { openDatabase } from '../../src/main/services/db'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import { DEFAULT_SETTINGS, type PrivacyPolicy } from '../../src/shared/types'
import {
  createEncryptedVaultOnDisk,
  unlockEncryptedVault,
  lockEncryptedVault,
  plaintextAllowed,
  readVaultDescriptor,
  shredStalePlaintext,
  encryptFile,
  decryptFile,
  encryptFileAsync,
  decryptFileAsync,
  FILE_CHUNK_BYTES,
  shredFile,
  shredFileAsync,
  shredFileWithin,
  rewrapVaultKey,
  stageRekey,
  applyPendingRekey,
  REKEY_SUFFIX,
  RECOVERY_SUFFIX,
  PlaintextNotAllowedError,
  VaultDescriptorMissingError,
  VaultOpenFailedError,
  WORKING_COPY_LOST_MARKER,
  WorkspaceController,
  WorkspaceExistsError,
  WrongPasswordError,
  vaultPathsFrom,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { randomBytes } from 'node:crypto'
import { encrypt, decrypt, serializeBlob, deserializeBlob, generateDataKey } from '../../src/main/services/security/crypto'
import * as vaultCrypto from '../../src/main/services/security/crypto'
import * as settingsModule from '../../src/main/services/settings'
import { openRawDb, tempRoot } from '../helpers/db-fixtures'
import {
  ENCRYPTION_REQUIRED,
  FAST_KDF,
  backdate,
  damagedVault,
  endedUnlocked,
  failedLockState,
  freshVaultPaths,
  leaveAsKilled,
  lockedVault,
  newerPlaintext,
  noisePastPageOne,
  plantProbeTrap,
  tagFailingVault,
  thrownBy,
  unlockedController,
  type FreshVaultPaths
} from '../helpers/vault-fixtures'

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- lock → encrypt → unlock round-trip -----------------------------------------

describe('encrypted vault lifecycle', () => {
  it('creates LOCKED on disk: descriptor + .enc exist, no plaintext working file', () => {
    const vp = freshVaultPaths('vault')
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    expect(existsSync(vp.descriptorPath)).toBe(true)
    expect(existsSync(vp.encPath)).toBe(true)
    expect(existsSync(vp.dbPath)).toBe(false)
  })

  it('round-trips data through lock and unlock; shreds the plaintext on lock', () => {
    const vp = lockedVault('vault', 'pw')

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

  it('rejects a wrong password with WrongPasswordError, writes no plaintext working file, and zeroes the derived key (L-6)', () => {
    const vp = lockedVault('vault', 'right-password')
    // TEST-N5: assert the OBSERVABLE (the actual key bytes are all zero after the throw), not the
    // zeroing MECHANISM. A passthrough spy captures the very Buffer deriveKey returned — which the
    // unlock path zeroes IN PLACE before throwing — so this holds for fill(0)/.set/randomFill alike
    // and fails if the key is left intact. (The old test spied Buffer.prototype.fill and passed on
    // ANY fill(0) anywhere, while breaking on a non-fill zeroing — both wrong.)
    const deriveSpy = vi.spyOn(vaultCrypto, 'deriveKey')
    try {
      expect(() => unlockEncryptedVault(vp, 'wrong-password')).toThrow(WrongPasswordError)
      // The verifier refuses before any decrypt, so nothing plaintext reached the disk.
      expect(existsSync(vp.dbPath)).toBe(false)
      const derived = deriveSpy.mock.results.find((r) => r.type === 'return')?.value as Buffer | undefined
      expect(derived).toBeInstanceOf(Buffer)
      expect(derived!.length).toBe(FAST_KDF.keyLen)
      expect(derived!.every((b) => b === 0)).toBe(true)
    } finally {
      deriveSpy.mockRestore()
    }
  })

  // #858: the same observable for the failures AFTER the password verified. A pass-through spy keeps the very
  // Buffers the unlock derived (the KEK) and unwrapped (the data key); each must be all zero once the unlock
  // throws, and no decrypted working file may stay on disk.
  describe('a failure after the password verified zeroes the keys (#858)', () => {
    const zeroed = (b: Buffer | undefined): boolean => b instanceof Buffer && b.length === FAST_KDF.keyLen && b.every((x) => x === 0)
    const returned = (spy: { mock: { results: Array<{ type: string; value: unknown }> } }, i = 0): Buffer | undefined =>
      spy.mock.results.filter((r) => r.type === 'return')[i]?.value as Buffer | undefined
    /** The data key the unwrap returned: the `decrypt` call whose blob is the descriptor's wrapped key. */
    const unwrapped = (
      spy: { mock: { calls: unknown[][]; results: Array<{ type: string; value: unknown }> } },
      vp: { descriptorPath: string }
    ): Buffer | undefined => {
      const iv = Buffer.from(JSON.parse(readFileSync(vp.descriptorPath, 'utf8')).dataKey.ivB64, 'base64')
      const i = spy.mock.calls.findIndex((c) => (c[1] as { iv?: Buffer } | undefined)?.iv?.equals(iv))
      const r = spy.mock.results[i]
      return r?.type === 'return' ? (r.value as Buffer) : undefined
    }

    it('a corrupt wrapped data key: the derived key is zeroed', () => {
      const vp = lockedVault('vault', 'pw')
      const descriptor = JSON.parse(readFileSync(vp.descriptorPath, 'utf8'))
      const ct = Buffer.from(descriptor.dataKey.ciphertextB64, 'base64')
      ct[0] ^= 0xff
      descriptor.dataKey.ciphertextB64 = ct.toString('base64')
      writeFileSync(vp.descriptorPath, JSON.stringify(descriptor))
      const deriveSpy = vi.spyOn(vaultCrypto, 'deriveKey')
      try {
        expect(() => unlockEncryptedVault(vp, 'pw')).toThrow()
        expect(() => unlockEncryptedVault(vp, 'pw')).not.toThrow(WrongPasswordError)
        expect(zeroed(returned(deriveSpy))).toBe(true)
        expect(existsSync(vp.dbPath)).toBe(false)
      } finally {
        deriveSpy.mockRestore()
      }
    })

    it('an .enc that fails its tag check: the derived key and the unwrapped data key are zeroed', () => {
      const vp = lockedVault('vault', 'pw')
      const enc = readFileSync(vp.encPath)
      enc[enc.length - 20] ^= 0xff // inside the last chunk's ciphertext
      writeFileSync(vp.encPath, enc)
      const deriveSpy = vi.spyOn(vaultCrypto, 'deriveKey')
      const decryptSpy = vi.spyOn(vaultCrypto, 'decrypt')
      try {
        expect(() => unlockEncryptedVault(vp, 'pw')).toThrow()
        expect(zeroed(returned(deriveSpy))).toBe(true)
        expect(zeroed(unwrapped(decryptSpy, vp))).toBe(true)
        expect(existsSync(vp.dbPath)).toBe(false)
      } finally {
        deriveSpy.mockRestore()
        decryptSpy.mockRestore()
      }
    })

    it('a failure after the database opened: the data key is zeroed and the plaintext working file shredded', () => {
      const vp = lockedVault('vault', 'pw')
      const decryptSpy = vi.spyOn(vaultCrypto, 'decrypt')
      const seedSpy = vi.spyOn(settingsModule, 'seedSettings').mockImplementationOnce(() => {
        throw new Error('disk I/O error')
      })
      try {
        // A write of the unlock's own after the open: reported as an open that could not finish (#844).
        expect(() => unlockEncryptedVault(vp, 'pw')).toThrowError(VaultOpenFailedError)
        expect(zeroed(unwrapped(decryptSpy, vp))).toBe(true)
        expect(existsSync(vp.dbPath)).toBe(false)
        // The vault is untouched: the next unlock opens it normally.
        const next = unlockEncryptedVault(vp, 'pw')
        next.db.close()
      } finally {
        seedSpy.mockRestore()
        decryptSpy.mockRestore()
      }
    })

    it('a roll-forward that cannot write: the data key is zeroed and the snapshot survives', () => {
      const vp = lockedVault('vault', 'pw')
      // A failed lock's salvage: a real database newer than `.enc`, waiting as `.recovery`.
      const first = unlockEncryptedVault(vp, 'pw')
      first.db.close()
      renameSync(vp.dbPath, `${vp.dbPath}${RECOVERY_SUFFIX}`)
      const past = new Date(Date.now() - 60_000)
      utimesSync(vp.encPath, past, past)
      // The roll-forward writes `<enc>.tmp` first: a directory there makes that write fail.
      mkdirSync(`${vp.encPath}.tmp`)
      const decryptSpy = vi.spyOn(vaultCrypto, 'decrypt')
      try {
        expect(() => unlockEncryptedVault(vp, 'pw')).toThrow()
        expect(zeroed(unwrapped(decryptSpy, vp))).toBe(true)
        expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(true)
      } finally {
        decryptSpy.mockRestore()
      }
    })

    it('a v1 vault whose .enc fails its tag check: the derived key, which is its file key, is zeroed', () => {
      const vp = lockedVault('vault', 'pw', { legacyV1: true })
      const enc = readFileSync(vp.encPath)
      enc[enc.length - 20] ^= 0xff
      writeFileSync(vp.encPath, enc)
      const deriveSpy = vi.spyOn(vaultCrypto, 'deriveKey')
      try {
        expect(() => unlockEncryptedVault(vp, 'pw')).toThrow()
        expect(zeroed(returned(deriveSpy))).toBe(true)
        expect(existsSync(vp.dbPath)).toBe(false)
      } finally {
        deriveSpy.mockRestore()
      }
    })
  })

  // H4 (audit round 4): `.enc` IS the user's data; creating over it would irreversibly
  // replace chats/documents/settings with an empty vault.
  it('refuses to create over an existing .enc (the data must never be wiped)', () => {
    const vp = lockedVault('vault', 'pw')
    const encBefore = readFileSync(vp.encPath)
    expect(() => createEncryptedVaultOnDisk(vp, 'other-pw', FAST_KDF)).toThrow(WorkspaceExistsError)
    // The original encrypted database is untouched.
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    const opened = unlockEncryptedVault(vp, 'pw')
    opened.db.close()
  })

  // #954: nor over a key file whose `.enc` is elsewhere (copied back while the app was open): it holds the only wrapped
  // copy of that workspace's data key. Refused before anything is opened or staged: the create's first step opens the
  // database at the working file's name, so a working file that came back with the key file (the newest data of that
  // workspace) would be seeded, encrypted under the new key and shredded before any later check could refuse.
  it('refuses to create over a key file with no .enc beside it, touching the working file beside it not at all (#954)', () => {
    const src = lockedVault('vault-src', 'pw')
    failedLockState(src, 7171, 'pw') // a closed working file holding the newest data
    const vp = freshVaultPaths('vault')
    copyFileSync(src.descriptorPath, vp.descriptorPath)
    copyFileSync(src.dbPath, vp.dbPath)
    const descriptor = readFileSync(vp.descriptorPath)
    const workingFile = readFileSync(vp.dbPath)
    expect(thrownBy(() => createEncryptedVaultOnDisk(vp, 'brand-new-pw', FAST_KDF)).name).toBe('WorkspaceExistsError')
    expect(readFileSync(vp.descriptorPath).equals(descriptor)).toBe(true)
    expect(readFileSync(vp.dbPath).equals(workingFile)).toBe(true)
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
  })

  // #954 S-1: the create stages its database as `.enc.new` before its commit (the descriptor write). A failure between
  // the two used to leave that file, and the next start's rekey recovery rolls ANY `.enc.new` forward under a v2
  // descriptor: a workspace put back into the same folder (troubleshooting's "go back" step) had its `.enc` shredded and
  // replaced by the failed create's empty database, under a key nobody has. A directory where the descriptor's temp
  // goes fails the commit's first write for real (EISDIR), after the stage.
  it('a create that fails before its commit leaves no staged file, so a workspace put back later opens intact (#954 S-1)', () => {
    const vp = freshVaultPaths('vault')
    mkdirSync(`${vp.descriptorPath}.tmp`)
    expect(() => createEncryptedVaultOnDisk(vp, 'brand-new-pw', FAST_KDF)).toThrow(/EISDIR/)
    expect(existsSync(vp.descriptorPath)).toBe(false) // not committed
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
    rmSync(`${vp.descriptorPath}.tmp`, { recursive: true })

    // The previous workspace, a marker in its data, put back by hand while the app is closed.
    const old = lockedVault('vault-old', 'old-pw')
    const before = unlockedController(old, 'old-pw')
    updateSettings(before.requireDb(), { contextTokens: 5151 })
    before.lock()
    copyFileSync(old.descriptorPath, vp.descriptorPath)
    copyFileSync(old.encPath, vp.encPath)
    const enc = readFileSync(vp.encPath)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init() // the next start: nothing staged is rolled over the put-back `.enc`
    expect(readFileSync(vp.encPath).equals(enc)).toBe(true)
    ctl.unlock('old-pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
    ctl.lock()
  })

  // Review V F-5 (probe P5): the cleanup removes `.enc.new` only once this create's encrypt returned. An encrypt that
  // fails replaced nothing there (it writes `.enc.new.tmp`, renamed only at its end; a directory at that name fails
  // its first open), so a staged file that was already there is not this create's to remove.
  it('a create whose encrypt fails leaves a staged file that was there before it alone (#954 S-1)', () => {
    const vp = freshVaultPaths('vault')
    const staged = `${vp.encPath}${REKEY_SUFFIX}`
    writeFileSync(staged, 'a staged file this create did not write')
    mkdirSync(`${staged}.tmp`)
    expect(thrownBy(() => createEncryptedVaultOnDisk(vp, 'brand-new-pw', FAST_KDF)).name).not.toBe('(no error)')
    expect(existsSync(vp.descriptorPath)).toBe(false)
    expect(readFileSync(staged, 'utf8')).toBe('a staged file this create did not write')
  })

  // #860 V5b: past the verifier, a tag failure is damage too, and the error says which damage it is (its message
  // reaches only the log; the user copy is `vault_damaged`'s either way), never that the data decrypted. (A descriptor
  // that lost its `version` but kept `dataKey` reads as unreadable instead, workspace-vault-format-guard.test.ts:
  // only the descriptor needs restoring.)
  it.each<[string, (vp: FreshVaultPaths) => void, RegExp]>([
    ['an .enc that fails its tag', (vp) => void tagFailingVault(vp), /failed its authentication check/],
    ['an .enc that decrypts to noise (#208)', (vp) => void damagedVault(vp, 'pw', 64 * 1024), /not a database/]
  ])('a verified password over damaged data throws VaultDamagedError naming the damage: %s', (_case, damage, message) => {
    const vp = lockedVault('vault', 'pw')
    damage(vp)
    let thrown: unknown
    try {
      unlockEncryptedVault(vp, 'pw')
    } catch (err) {
      thrown = err
    }
    expect((thrown as Error | undefined)?.name).toBe('VaultDamagedError')
    expect((thrown as Error).message).toMatch(message)
    expect(existsSync(vp.dbPath)).toBe(false)
  })

  it('a corrupt descriptor with an intact .enc gives a restore hint, not "no workspace"', () => {
    const vp = lockedVault('vault', 'pw')
    writeFileSync(vp.descriptorPath, '{ not json', 'utf8')
    expect(() => unlockEncryptedVault(vp, 'pw')).toThrow(VaultDescriptorMissingError)
  })
})

// ---- M5: streaming file crypto stays byte-compatible with the framed blob format ---

describe('streaming file crypto (M5)', () => {
  function tmpFile(name: string, data: Buffer | string): string {
    const p = join(tempRoot('stream'), name)
    writeFileSync(p, data)
    return p
  }

  it('streamed encryptFile output decrypts via the in-memory blob path (same frame)', () => {
    const key = randomBytes(32)
    const plaintext = randomBytes(3 * 1024 * 1024 + 17) // odd size, inside one 8 MiB chunk
    const src = tmpFile('plain.bin', plaintext)
    const enc = `${src}.enc`
    encryptFile(src, enc, key)

    const decrypted = decrypt(key, deserializeBlob(readFileSync(enc)))
    expect(decrypted.equals(plaintext)).toBe(true)
  })

  // Walk round (#956's lock line in the real app): an encrypt that fails removes its temp best-effort. A directory at
  // the temp's name failed the open (EISDIR), and the cleanup's own `rm` of that directory threw `ERR_FS_EISDIR` over
  // it, so the lock's log line named the cleanup, not the cause.
  it('an encrypt whose temp is a directory rethrows the open error, not the cleanup’s', () => {
    const src = tmpFile('plain.bin', randomBytes(64))
    const enc = `${src}.enc`
    mkdirSync(`${enc}.tmp`)
    let thrown: NodeJS.ErrnoException | null = null
    try {
      encryptFile(src, enc, randomBytes(32))
    } catch (err) {
      thrown = err as NodeJS.ErrnoException
    }
    expect({ code: thrown?.code, syscall: thrown?.syscall }).toEqual({ code: 'EISDIR', syscall: 'open' })
    expect(existsSync(enc)).toBe(false)
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

  // A frame of a format this build does not write is refused by name before any decrypt, by both
  // readers. Past the magic check its next 28 bytes would be taken as `iv | tag`, and only the GCM
  // tag failure would stop it, under a misleading message. A frame a NEWER build wrote (`HRAUMEN` +
  // a higher version byte) is refused as newer (#845); any other magic stays "unrecognised".
  it('a frame a newer build wrote (HRAUMEN2) is refused as newer before any decrypt, by the sync and the async reader (#845)', async () => {
    const enc = tmpFile('future.enc', Buffer.concat([Buffer.from('HRAUMEN2'), randomBytes(12 + 16 + 64)]))
    const out = `${enc}.plain`
    expect(thrownBy(() => decryptFile(enc, out, randomBytes(32)))).toEqual({
      name: 'VaultNewerError',
      what: 'frame',
      found: '2'
    })
    await expect(decryptFileAsync(enc, out, randomBytes(32))).rejects.toMatchObject({
      name: 'VaultNewerError',
      what: 'frame',
      found: '2'
    })
    expect(existsSync(out)).toBe(false)
    expect(existsSync(`${out}.tmp`)).toBe(false)
  })

  it('a frame of another format (PAIDENC1, before 0.1.10) is refused as unrecognised, not newer, by the sync and the async reader', async () => {
    const enc = tmpFile('older.enc', Buffer.concat([Buffer.from('PAIDENC1'), randomBytes(12 + 16 + 64)]))
    const out = `${enc}.plain`
    expect(() => decryptFile(enc, out, randomBytes(32))).toThrow(/unrecognised header/)
    expect(thrownBy(() => decryptFile(enc, out, randomBytes(32))).name).toBe('Error')
    await expect(decryptFileAsync(enc, out, randomBytes(32))).rejects.toThrow(/unrecognised header/)
    expect(existsSync(out)).toBe(false)
    expect(existsSync(`${out}.tmp`)).toBe(false)
  })
})

// #860 V6: the secure delete overwrites in FILE_CHUNK_BYTES chunks, and every other row shreds a file smaller than one
// chunk, so a loop that stopped after the first chunk passed. A descriptor held open across the shred keeps the
// overwritten bytes readable after the unlink: every chunk, the last partial one included, must differ from the
// plaintext. (#1014: the row watched through a hard link before; a name another name shares is now only unlinked.)
describe('secure delete past one chunk (shredFile / shredFileAsync)', () => {
  it.each([
    ['shredFile', async (p: string) => shredFile(p)],
    ['shredFileAsync', shredFileAsync]
  ])('%s overwrites every chunk of a file larger than FILE_CHUNK_BYTES, then unlinks it', async (_name, shred) => {
    const dir = tempRoot('shred')
    const path = join(dir, 'plain.bin')
    const plain = Buffer.alloc(2 * FILE_CHUNK_BYTES + 1024 * 1024, 0xa5)
    writeFileSync(path, plain)
    const view = openSync(path, 'r')
    try {
      await shred(path)
      expect(existsSync(path)).toBe(false)
      const after = Buffer.alloc(plain.length + 1)
      expect(readSync(view, after, 0, after.length, 0)).toBe(plain.length)
      for (const start of [0, FILE_CHUNK_BYTES, 2 * FILE_CHUNK_BYTES]) {
        const end = Math.min(start + FILE_CHUNK_BYTES, plain.length)
        expect(after.subarray(start, end).equals(plain.subarray(start, end))).toBe(false)
      }
    } finally {
      closeSync(view)
    }
  })
})

/** Can this account make a symbolic link? (A Windows account without the privilege, and without developer mode,
 *  cannot; there the hard-link rows below stand for it.) */
const canSymlink = ((): boolean => {
  const dir = tempRoot('shred-symlink-probe')
  writeFileSync(join(dir, 'target'), 'x')
  try {
    symlinkSync(join(dir, 'target'), join(dir, 'link'), 'file')
    return true
  } catch {
    return false
  }
})()

// #1014: the secure delete judges the NAME by `lstat`, which never follows a link, and overwrites only a regular file
// that no other name shares. A symbolic link or a hard link at a name the app shreds was written THROUGH before: the
// random bytes landed in the file the link reaches, which may lie anywhere (the rekey journal's swap shreds the names it
// lists, and a deleted document's out-of-store copy is an absolute path). Such a name is now only unlinked.
describe('secure delete never writes through a link (#1014)', () => {
  const twins: Array<[string, (path: string) => Promise<unknown>]> = [
    ['shredFile', async (path) => shredFile(path)],
    ['shredFileAsync', shredFileAsync],
    ['shredFileWithin', async (path) => shredFileWithin(path, { deadline: Number.MAX_SAFE_INTEGER, now: () => 0 })]
  ]

  it.each(twins)('%s on a hard link removes that name only: the other name keeps every byte', async (_name, shred) => {
    const dir = tempRoot('shred-hardlink')
    const other = join(dir, 'outside.bin')
    const bytes = randomBytes(64 * 1024)
    writeFileSync(other, bytes)
    const name = join(dir, 'name.bin')
    linkSync(other, name)
    await shred(name)
    expect(existsSync(name)).toBe(false)
    expect(readFileSync(other).equals(bytes)).toBe(true)
  })

  // A junction (on Windows; a link to a folder elsewhere) needs no privilege, so this row runs for every account. `rm`
  // refuses one as a folder, so it stayed before, and a password change's swap onto that name then blocked every start.
  it.each(twins)('%s on a junction removes the link only: the folder it reaches keeps its file', async (_name, shred) => {
    const dir = tempRoot('shred-junction')
    const target = join(dir, 'outside')
    mkdirSync(target)
    writeFileSync(join(target, 'kept.txt'), 'kept')
    const name = join(dir, 'name.enc')
    symlinkSync(target, name, 'junction')
    await shred(name)
    expect(() => lstatSync(name)).toThrow()
    expect(readFileSync(join(target, 'kept.txt'), 'utf8')).toBe('kept')
  })

  it.runIf(canSymlink).each(twins)(
    '%s on a symbolic link removes the link only: the file it reaches keeps every byte',
    async (_name, shred) => {
      const dir = tempRoot('shred-symlink')
      const other = join(dir, 'outside.bin')
      const bytes = randomBytes(64 * 1024)
      writeFileSync(other, bytes)
      const name = join(dir, 'name.bin')
      symlinkSync(other, name, 'file')
      await shred(name)
      expect(() => lstatSync(name)).toThrow()
      expect(readFileSync(other).equals(bytes)).toBe(true)
    }
  )
})

// #1014 round 6: the rekey journal's rewrite (round 3's settle) opened its write temp with 'w', which follows a link at
// that name: a hard or symbolic link there had the journal's JSON written into the file it reaches, elsewhere on the
// drive, and a junction made every rewrite fail, so the journal went on listing what that pass had already settled. The
// write now removes whatever is at the temp name first (a link by `unlink`) and creates it fresh ('wx').
describe("the rekey journal's write temp is never written through a link (#1014)", () => {
  type LinkAtTemp = (temp: string, root: string) => () => void
  const plantedAs: Array<[string, LinkAtTemp]> = [
    [
      'a hard link to a file elsewhere',
      (temp, root) => {
        const other = join(root, 'elsewhere.txt')
        writeFileSync(other, 'a file elsewhere')
        linkSync(other, temp)
        return () => expect(readFileSync(other, 'utf8')).toBe('a file elsewhere')
      }
    ],
    [
      'a junction to a folder elsewhere',
      (temp, root) => {
        const other = join(root, 'elsewhere')
        mkdirSync(other)
        writeFileSync(join(other, 'kept.txt'), 'kept')
        symlinkSync(other, temp, 'junction')
        return () => expect(readdirSync(other).map((name) => [name, readFileSync(join(other, name), 'utf8')])).toEqual([['kept.txt', 'kept']])
      }
    ]
  ]
  const symbolic: Array<[string, LinkAtTemp]> = [
    [
      'a symbolic link to a file elsewhere',
      (temp, root) => {
        const other = join(root, 'elsewhere.txt')
        writeFileSync(other, 'a file elsewhere')
        symlinkSync(other, temp, 'file')
        return () => expect(readFileSync(other, 'utf8')).toBe('a file elsewhere')
      }
    ]
  ]

  /** A recovery pass whose journal must be rewritten: it swaps the one in-store stage in and keeps the entry outside
   *  the workspace folder for the unlock, with `plant` at the journal's write temp. */
  function rewriteWithLinkAtTemp(plant: LinkAtTemp): void {
    const vp = freshVaultPaths('vault-journal-temp')
    const docs = join(dirname(vp.dbPath), 'documents')
    mkdirSync(docs, { recursive: true })
    writeFileSync(join(docs, 'a.enc'), 'OLD-A')
    writeFileSync(join(docs, `a.enc${REKEY_SUFFIX}`), 'NEW-A')
    const outside = join(vp.root, 'legacy', `x.enc${REKEY_SUFFIX}`)
    const journal = join(dirname(vp.dbPath), 'rekey-journal.json')
    writeFileSync(journal, JSON.stringify({ version: 1, staged: [join(docs, `a.enc${REKEY_SUFFIX}`), outside], remove: [] }))
    const untouched = plant(`${journal}.tmp`, vp.root)
    applyPendingRekey(vp)
    untouched()
    expect(readFileSync(join(docs, 'a.enc'), 'utf8')).toBe('NEW-A')
    expect(JSON.parse(readFileSync(journal, 'utf8')).staged, 'the journal lists only what waits').toEqual([outside])
    expect(lstatSync(journal).isFile() && lstatSync(journal).nlink <= 1).toBe(true)
  }

  it.each(plantedAs)('%s at the write temp: the rewrite goes on, and the file or folder it reaches keeps its bytes', (_case, plant) =>
    rewriteWithLinkAtTemp(plant)
  )

  it.runIf(canSymlink).each(symbolic)('%s at the write temp: the rewrite goes on, and the file it reaches keeps its bytes', (_case, plant) =>
    rewriteWithLinkAtTemp(plant)
  )
})

// ---- PERF-1: async vault crypto — byte-identical frame + yields to the event loop ----
//
// The async twins (encryptFileAsync/decryptFileAsync) MUST produce/consume the EXACT same
// on-disk frame as the sync ones (the on-disk format is load-bearing — old vaults must still
// read), and must NOT block the main thread (the whole point). These tests pin both.

describe('async vault crypto (PERF-1)', () => {
  function tmpFile(name: string, data: Buffer | string): string {
    const p = join(tempRoot('async-crypto'), name)
    writeFileSync(p, data)
    return p
  }

  it('async-encrypted file decrypts via the SYNC path AND the in-memory blob path (identical frame)', async () => {
    const key = randomBytes(32)
    const plaintext = randomBytes(2 * FILE_CHUNK_BYTES + 11) // spans multiple chunk boundaries
    const src = tmpFile('plain.bin', plaintext)
    const enc = `${src}.enc`
    await encryptFileAsync(src, enc, key)

    // The OLD synchronous reader decrypts what the NEW async writer produced …
    const out = `${enc}.plain`
    decryptFile(enc, out, key)
    expect(readFileSync(out).equals(plaintext)).toBe(true)
    // … and so does the in-memory framed-blob path (same MAGIC|iv|tag|ct layout).
    expect(decrypt(key, deserializeBlob(readFileSync(enc))).equals(plaintext)).toBe(true)
  })

  it('SYNC-encrypted file (old vaults) decrypts via the async path', async () => {
    const key = randomBytes(32)
    const plaintext = randomBytes(FILE_CHUNK_BYTES + 5)
    const src = tmpFile('plain2.bin', plaintext)
    const enc = `${src}.enc`
    encryptFile(src, enc, key) // OLD synchronous writer
    const out = `${enc}.plain`
    await decryptFileAsync(enc, out, key) // NEW async reader
    expect(readFileSync(out).equals(plaintext)).toBe(true)
  })

  it('async round-trips its own output and rejects a tampered .enc (GCM auth), leaving no plaintext', async () => {
    const key = randomBytes(32)
    const plaintext = randomBytes(256 * 1024)
    const src = tmpFile('plain3.bin', plaintext)
    const enc = `${src}.enc`
    await encryptFileAsync(src, enc, key)

    // The async reader decrypts what the async writer produced …
    const back = `${enc}.back`
    await decryptFileAsync(enc, back, key)
    expect(readFileSync(back).equals(plaintext)).toBe(true)

    // … and refuses it once a ciphertext byte past the 36-byte header is flipped (GCM auth).
    const blob = readFileSync(enc)
    blob[100] ^= 0xff
    writeFileSync(enc, blob)
    const out = `${enc}.plain`
    await expect(decryptFileAsync(enc, out, key)).rejects.toThrow()
    expect(existsSync(out)).toBe(false)
    expect(existsSync(`${out}.tmp`)).toBe(false) // partial output shredded
  })

  // The async encrypt must not hold the main thread for the whole file: a macrotask queued just
  // before it runs before it finishes. (The sync twin needs no row: no timer can pre-empt
  // synchronous JS.) This proves the encrypt yields, not that it yields between every pair of
  // chunks. A 0 ms timer, not a setImmediate counter: that one starves the poll phase the fs
  // callbacks land in (#258).
  it('the async encrypt yields to the event loop while it runs (a timer queued first fires before it finishes)', async () => {
    const key = randomBytes(32)
    const data = randomBytes(FILE_CHUNK_BYTES * 3 + 7) // several chunk boundaries → several awaits
    const src = tmpFile('big.bin', data)

    let fired = false
    const t = setTimeout(() => {
      fired = true
    }, 0)
    await encryptFileAsync(src, `${src}.a.enc`, key)
    clearTimeout(t)
    expect(fired).toBe(true)
  })
})

// ---- H4: the controller must never offer a vault-wiping create flow ---------------

describe('WorkspaceController — create-over-existing-vault guard (H4)', () => {
  it('reports LOCKED (not uninitialized) when the descriptor is corrupt but .enc exists', () => {
    const vp = lockedVault('vault', 'pw')
    writeFileSync(vp.descriptorPath, '{ corrupted-not-json', 'utf8')

    const ctl = new WorkspaceController(vp, DEFAULT_POLICY, true)
    ctl.init()
    // A corrupt descriptor used to surface `uninitialized`, putting the CREATE flow in
    // front of the user — one click away from wiping the intact .enc.
    expect(ctl.getState().state).toBe('locked')
    // init() must not have opened a plaintext DB over the vault either (dev policy).
    expect(ctl.isUnlocked()).toBe(false)
  })

  // #860 V4: the row above has `.enc` on disk, which alone keeps the create flow away. Without it the corrupt
  // descriptor is the only sign of a vault, and the stored documents need the wrapped data key only it holds: a
  // create would replace it with a fresh vault's. Review V F-3: with no `.enc`, the refusal is the unlock's own
  // (`VaultDescriptorUnreadableError`: no password opens anything here, don't delete the key file).
  it.each<[string, (vp: FreshVaultPaths) => void, string]>([
    ['.enc present', () => {}, 'WorkspaceExistsError'],
    [
      '.enc gone, an encrypted document left in documents/',
      (vp) => {
        rmSync(vp.encPath)
        const docs = join(dirname(vp.dbPath), 'documents')
        mkdirSync(docs, { recursive: true })
        writeFileSync(join(docs, 'doc.txt.enc'), randomBytes(64))
      },
      'VaultDescriptorUnreadableError'
    ]
  ])('a corrupt descriptor keeps the create flow away (%s)', (_case, arrange, refusal) => {
    const vp = lockedVault('vault', 'pw')
    arrange(vp)
    writeFileSync(vp.descriptorPath, '{ corrupted-not-json', 'utf8')
    const descriptor = readFileSync(vp.descriptorPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.getState().state).toBe('locked')
    expect(thrownBy(() => ctl.create('another-password', 'encrypted')).name).toBe(refusal)
    expect(readFileSync(vp.descriptorPath).equals(descriptor)).toBe(true)
    expect(ctl.isUnlocked()).toBe(false)
  })

  it('refuses create while a vault exists (locked state), keeping the data intact', () => {
    const vp = lockedVault('vault', 'pw')
    const ctl = new WorkspaceController(vp, DEFAULT_POLICY, true)
    ctl.init()
    // Re-reading an existing encrypted vault starts LOCKED and says it is encrypted.
    expect(ctl.getState().state).toBe('locked')
    expect(ctl.getState().mode).toBe('encrypted')

    expect(() => ctl.create('new-password', 'encrypted')).toThrow(WorkspaceExistsError)
    expect(() => ctl.create('', 'plaintext_dev')).toThrow(WorkspaceExistsError)

    // The original vault still unlocks with its original password.
    const state = ctl.unlock('pw')
    expect(state.state).toBe('unlocked')
    ctl.lock()
  })
})

// ---- password is never persisted; the locked vault holds no plaintext -------------

describe('no plaintext password persisted', () => {
  it('keeps the password out of the descriptor, and the locked .enc holds no plaintext database bytes', () => {
    const SECRET = 'super-secret-passphrase-9k2x'
    const MARKER = 'at-rest-marker-7f3c9e1a'
    const vp = lockedVault('vault', SECRET)

    const descriptor = readFileSync(vp.descriptorPath, 'utf8')
    expect(descriptor).not.toContain(SECRET)
    // The descriptor is the v2 envelope: salt + KDF params + an authenticated verifier + the
    // data key wrapped under the password key. Nothing else.
    const parsed = JSON.parse(descriptor)
    expect(Object.keys(parsed).sort()).toEqual(['dataKey', 'kdf', 'mode', 'saltB64', 'verifier', 'version'])
    expect(parsed.version).toBe(2)
    expect(parsed.kdf).toEqual(FAST_KDF)

    // At rest the database is ciphertext: a value written while unlocked is in neither the
    // locked `.enc` nor does the file carry SQLite's header (a copy-instead-of-encrypt would).
    const { db, key } = unlockEncryptedVault(vp, SECRET)
    updateSettings(db, { activeModelId: MARKER })
    lockEncryptedVault(vp, db, key)
    const enc = readFileSync(vp.encPath)
    expect(enc.includes(Buffer.from(MARKER))).toBe(false)
    expect(enc.includes(Buffer.from('SQLite format 3'))).toBe(false)
    expect(enc.includes(Buffer.from(SECRET))).toBe(false)
    // Positive control: the marker IS in the plaintext the next unlock decrypts.
    const again = unlockEncryptedVault(vp, SECRET)
    expect(readFileSync(vp.dbPath).includes(Buffer.from(MARKER))).toBe(true)
    again.db.close()
  })
})

// ---- plaintext gating -----------------------------------------------------------

describe('plaintextAllowed gating', () => {
  it('allows plaintext only when policy permits AND the caller is a developer', () => {
    expect(plaintextAllowed(DEFAULT_POLICY, { isDev: true })).toBe(true)
    // Not a developer → refused even when policy permits.
    expect(plaintextAllowed(DEFAULT_POLICY, { isDev: false })).toBe(false)
  })

  // The absolute veto, alone: this policy still ALLOWS plaintext dev mode, so only
  // `encryptionRequired` can refuse. (ENCRYPTION_REQUIRED flips both flags, and its
  // `allowPlaintextDevMode: false` would refuse with the veto deleted.)
  it('refuses plaintext when encryption is required by policy, even with plaintext dev mode allowed (the absolute veto)', () => {
    const policy: PrivacyPolicy = {
      ...DEFAULT_POLICY,
      workspace: { encryptionRequired: true, allowPlaintextDevMode: true }
    }
    expect(plaintextAllowed(policy, { isDev: true })).toBe(false)
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
    const vp = freshVaultPaths('vault')
    const ctrl = new WorkspaceController(vp, DEFAULT_POLICY, true)
    ctrl.init()
    const s = ctrl.getState()
    expect(s.state).toBe('unlocked')
    expect(s.mode).toBe('plaintext_dev')
    expect(ctrl.requireDb()).toBeTruthy()
    expect(existsSync(vp.descriptorPath)).toBe(false) // plaintext needs no vault descriptor
  })

  // Issue #51: a clean quit must leave NO `-wal`/`-shm` on the drive at rest — on a
  // non-journaling exFAT stick, at-rest WAL sidecars mean the last session never closed
  // cleanly and worsen hard-unplug outcomes. lock() is a deliberate no-op for
  // plaintext_dev, so the quit path calls shutdown() (checkpoint + close) instead.
  it('shutdown() closes a plaintext_dev DB so no -wal/-shm sidecars remain at rest (issue #51)', () => {
    const vp = freshVaultPaths('vault')
    const ctrl = new WorkspaceController(vp, DEFAULT_POLICY, true)
    ctrl.init()
    // A write guarantees the WAL sidecars exist on disk during the session.
    updateSettings(ctrl.requireDb(), { contextTokens: 6144 })
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(true)

    ctrl.shutdown()

    // The main DB stays (plaintext IS the working copy); the sidecars are gone.
    expect(existsSync(vp.dbPath)).toBe(true)
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    expect(existsSync(`${vp.dbPath}-shm`)).toBe(false)
    // Quit-only teardown: the DB is closed for good in this process…
    expect(() => ctrl.requireDb()).toThrow()

    // …and the next launch reads the same data back.
    const reopened = new WorkspaceController(vp, DEFAULT_POLICY, true)
    reopened.init()
    expect(getSettings(reopened.requireDb()).contextTokens).toBe(6144)
    reopened.shutdown()
  })

  it('shutdown() locks an unlocked encrypted vault and is safe to call when already locked (issue #51)', () => {
    const vp = lockedVault('vault', 'pw')
    const ctrl = unlockedController(vp, 'pw')
    updateSettings(ctrl.requireDb(), { contextTokens: 7777 })

    ctrl.shutdown()

    // Same disk posture the lock() path guarantees: encrypted artifact only.
    expect(existsSync(vp.encPath)).toBe(true)
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    expect(existsSync(`${vp.dbPath}-shm`)).toBe(false)
    expect(ctrl.getState().state).toBe('locked')
    ctrl.shutdown() // idempotent on an already-locked vault

    const again = unlockedController(vp, 'pw')
    expect(getSettings(again.requireDb()).contextTokens).toBe(7777)
    again.lock()
  })

  it('unlock re-stamps workspaceMode, so a wrong stored mode heals at the next unlock (#858)', () => {
    const vp = freshVaultPaths('vault-mode')
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.create('master-pass', 'encrypted')
    updateSettings(ctrl.requireDb(), { workspaceMode: 'plaintext_dev' }) // e.g. an older build's renderer
    ctrl.lock()
    ctrl.unlock('master-pass')
    expect(getSettings(ctrl.requireDb()).workspaceMode).toBe('encrypted')
    ctrl.lock()
  })

  it('drives the encrypted uninitialized → unlocked → locked → unlocked lifecycle', () => {
    const vp = freshVaultPaths('vault')
    // Commercial posture: encryption required, not a dev build → onboarding, no plaintext.
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    expect(ctrl.getState().state).toBe('uninitialized')
    expect(ctrl.isUnlocked()).toBe(false)
    expect(() => ctrl.requireDb()).toThrow()

    const created = ctrl.create('master-pass', 'encrypted')
    expect(created.state).toBe('unlocked')
    expect(created.mode).toBe('encrypted')
    // A NEW vault is a v2 envelope under the shipped default KDF (argon2id, m 19 MiB, t 2, p 1;
    // docs/security-model.md), recorded in its descriptor so every later unlock re-derives the key.
    const descriptor = readVaultDescriptor(vp.descriptorPath)
    expect(descriptor?.version).toBe(2)
    expect(descriptor?.kdf).toEqual({ algo: 'argon2id', m: 19456, t: 2, p: 1, keyLen: 32 })
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
    const vp = freshVaultPaths('vault')
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, true)
    ctrl.init()
    expect(() => ctrl.create('x', 'plaintext_dev')).toThrow(PlaintextNotAllowedError)
  })

  it('shreds a leftover plaintext DB from a crash on startup, staying LOCKED (H1)', () => {
    const vp = lockedVault('vault', 'pw')
    // Simulate a hard crash before lock-on-quit: a decrypted working file + WAL/SHM are
    // left next to the .enc, and so is decryptFile's whole-DB temp from before its atomic rename.
    writeFileSync(vp.dbPath, 'leftover plaintext database bytes')
    writeFileSync(`${vp.dbPath}.tmp`, 'leftover decrypt temp')
    writeFileSync(`${vp.dbPath}-wal`, 'wal')
    writeFileSync(`${vp.dbPath}-shm`, 'shm')

    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()

    // The stray plaintext (+ sidecars) must be gone; the encrypted artifact is untouched;
    // the workspace stays locked until the user provides the password. (Checked before the
    // unlock below, which writes its own `<db>.tmp` again.)
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}.tmp`)).toBe(false)
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    expect(existsSync(`${vp.dbPath}-shm`)).toBe(false)
    expect(existsSync(vp.encPath)).toBe(true)
    expect(ctrl.getState().state).toBe('locked')
    // #892: that leftover is no database, so no session was lost with it, and the start says nothing.
    expect(ctrl.getState()).not.toHaveProperty('lockNotice')
    // And it still unlocks correctly afterwards.
    const u = ctrl.unlock('pw')
    expect(u.state).toBe('unlocked')
    ctrl.lock()
  })

  it('shredStalePlaintext sweeps crash-left .parse/.tmp transients under documents/ AND images/, keeping stored copies', () => {
    const vp = freshVaultPaths('vault')
    const workspaceDir = dirname(vp.dbPath)
    const docsDir = join(workspaceDir, 'documents')
    const imagesDir = join(workspaceDir, 'images')
    mkdirSync(docsDir, { recursive: true })
    mkdirSync(imagesDir, { recursive: true })

    // Transient plaintext copies a killed run can leave behind.
    writeFileSync(join(docsDir, 'doc1.parsepdf'), 'x') // re-index parse temp
    writeFileSync(join(docsDir, 'doc1.parse.pdf'), 'x') // re-index transient <id>.parse<ext>
    writeFileSync(join(docsDir, 'doc1.pdf.enc.tmp'), 'x') // encryptFile's atomic-write temp under documents/
    writeFileSync(join(imagesDir, 'img1.tmp'), 'x') // image-history write temp
    writeFileSync(join(imagesDir, 'img2.read-1234.tmp'), 'x') // image-history read temp
    // Stored encrypted copies must SURVIVE the sweep (they match neither pattern).
    writeFileSync(join(docsDir, 'doc1.pdf.enc'), 'x')
    writeFileSync(join(imagesDir, 'img1.png.enc'), 'x')

    shredStalePlaintext(vp)

    expect(existsSync(join(docsDir, 'doc1.parsepdf'))).toBe(false)
    expect(existsSync(join(docsDir, 'doc1.parse.pdf'))).toBe(false)
    expect(existsSync(join(docsDir, 'doc1.pdf.enc.tmp'))).toBe(false)
    expect(existsSync(join(imagesDir, 'img1.tmp'))).toBe(false)
    expect(existsSync(join(imagesDir, 'img2.read-1234.tmp'))).toBe(false)
    expect(existsSync(join(docsDir, 'doc1.pdf.enc'))).toBe(true)
    expect(existsSync(join(imagesDir, 'img1.png.enc'))).toBe(true)
  })

  // 'applyPendingRekey swaps every swappable sidecar even when one is stuck (BUG vuln-scan-2026-06-21)' moved to
  // vault-recovery-guards.test.ts (#1015 round 3): its stand-in for a stuck file was a folder at the target's name, which
  // the swap now leaves aside without failing; there a held file stands in, through that file's `node:fs` stand-in.
})

// ---- vault lock durability (full-audit 2026-07-11 CODE-1 / CODE-10 / CODE-14) -----
//
// CODE-1 (High): a failed re-encrypt on lock (ENOSPC is realistic — during lock the
// plaintext DB + old `.enc` + new `.enc.tmp` coexist) must never strand the controller
// half-locked (1a; driven through a real full-drive write in vault-recovery-guards.test.ts),
// and the next launch's crash sweep must never shred a working file that is NEWER than
// `.enc` — the only fresh copy of the session's data (1b).
// CODE-10: the re-encrypt fsyncs before its atomic rename, so quit → unplug-without-eject
// cannot leave a truncated `.enc` after the plaintext was already durably shredded.
// CODE-14: fresh-vault creation commits at the DESCRIPTOR write (the rekey-journal
// ordering) — a crash mid-create leaves `uninitialized`, never a bricked onboarding.

describe('vault lock durability (full-audit 2026-07-11 CODE-1/10/14)', () => {
  it('CODE-1b: init() preserves a working file newer than .enc; unlock rolls it forward', () => {
    const vp = lockedVault('vault', 'pw')
    failedLockState(vp)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    // NOT shredded: moved aside as the recovery snapshot; the workspace stays locked.
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(true)
    expect(ctl.getState().state).toBe('locked')

    // Unlock rolls the newer data FORWARD (re-encrypts it over the stale `.enc`) and consumes it.
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(false)
    ctl.lock()
    // The roll-forward is durable: a later plain unlock still has the salvaged data.
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
    ctl.lock()
  })

  it('CODE-1b: a wrong password neither consumes nor destroys the recovery snapshot', () => {
    const vp = lockedVault('vault', 'pw')
    failedLockState(vp)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()

    expect(() => ctl.unlock('wrong-password')).toThrow(WrongPasswordError)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(true) // still there for the retry

    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
    ctl.lock()
  })

  it('CODE-1b: a STALE working file (older than .enc) is still shredded as today', () => {
    const vp = lockedVault('vault', 'pw')
    // A leftover OLDER than the at-rest snapshot (e.g. crash after lock's encryptFile
    // succeeded but before the shred) is derived data — shredding loses nothing. The fixture is
    // a real, cleanly closed SQLite file with no sidecars (holding 7171), so the header and
    // sidecar checks would both let it through: only the mtime guard refuses it.
    failedLockState(vp) // `.enc` backdated 60 s …
    backdate(vp.dbPath, 120_000) // … and the working file older still

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(false)
    expect(ctl.unlock('pw').state).toBe('unlocked')
    // The `.enc` snapshot opened, not the shredded leftover.
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(DEFAULT_SETTINGS.contextTokens)
    ctl.lock()
  })

  // #955 item 3, S-2: the unlock of a vault the start never saw skipped the start's salvage, so the `.enc` was
  // decrypted over a working file newer than it (a failed lock's session). Both ways in: a whole workspace copied back
  // under the create form, and the #807 copy's own advice ("put the file back") while the lock screen is up.
  it.each<[string, () => { vp: FreshVaultPaths; ctl: WorkspaceController }]>([
    [
      'a key file, its .enc and a newer working file put back under the create form',
      () => {
        const src = lockedVault('vault-src', 'pw')
        failedLockState(src, 7171, 'pw')
        const vp = freshVaultPaths('vault')
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init() // an empty layout: the lock screen's create form
        expect(ctl.getState().state).toBe('uninitialized')
        copyFileSync(src.descriptorPath, vp.descriptorPath)
        copyFileSync(src.encPath, vp.encPath)
        backdate(vp.encPath)
        copyFileSync(src.dbPath, vp.dbPath)
        return { vp, ctl }
      }
    ],
    [
      'a missing key file put back while the lock screen is up, beside a newer working file',
      () => {
        const vp = lockedVault('vault', 'pw')
        failedLockState(vp, 7171, 'pw')
        const descriptor = readFileSync(vp.descriptorPath)
        rmSync(vp.descriptorPath)
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init() // `.enc` without its key file: locked, nothing judged
        expect(ctl.getState().state).toBe('locked')
        writeFileSync(vp.descriptorPath, descriptor)
        return { vp, ctl }
      }
    ]
  ])('S-2: %s: the unlock in the same session keeps the newer data', (_case, arrange) => {
    const { ctl } = arrange()
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
    ctl.lock()
  })

  it('CODE-1b: a mid-session crash leftover (live -wal/-shm) is still shredded — the documented power-cut trade-off', () => {
    const vp = lockedVault('vault', 'pw')
    failedLockState(vp)
    // Live WAL sidecars = the mid-session crash state: the main file can be mid-checkpoint
    // (torn), so it must NOT be rolled forward over the intact stale `.enc`.
    writeFileSync(`${vp.dbPath}-wal`, 'wal')
    writeFileSync(`${vp.dbPath}-shm`, 'shm')

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(false)
    // #892: what the sweep shredded was a real working copy of a session that changed something after the last lock
    // (a database, newer than `.enc`), so the lock screen says the app did not lock the workspace when it closed, and a
    // restart before the unlock still says so.
    expect(ctl.getState()).toMatchObject({ state: 'locked', lockNotice: 'session_not_closed' })
    const restarted = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    restarted.init()
    expect(restarted.getState()).toMatchObject({ state: 'locked', lockNotice: 'session_not_closed' })
    // The stale `.enc` snapshot wins (the 7171 write is gone — the accepted trade-off).
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(DEFAULT_SETTINGS.contextTokens)
    // The unlock consumed the notice, once, for the IPC to record (the marker's time is when the start saw the loss).
    expect(ctl.takeWorkingCopyLost()).toEqual({ cause: 'unclean', lostAt: expect.any(String) })
    expect(ctl.lock()).not.toHaveProperty('lockNotice')
    const after = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    after.init()
    expect(after.getState()).not.toHaveProperty('lockNotice')
  })

  // #892: the notice may only ADD a report of a proven loss. Beside live sidecars the sweep shreds the working file in
  // every case, as before; it says so only for a real working copy (a database, or one torn mid-checkpoint) newer than
  // `.enc`. Each row has exactly one reason to stay silent: `.enc` is backdated where the mtime alone would decide.
  it.each<[string, (vp: FreshVaultPaths) => void]>([
    [
      // What a lock that SUCCEEDED leaves when the unlink after each shred fails (a hold on Windows): random bytes under
      // all three names, newer than `.enc`. Our shred never leaves a header, so nothing was lost.
      'a shred survivor (random bytes in the working file and both sidecars)',
      (vp) => {
        for (const path of [vp.dbPath, `${vp.dbPath}-wal`, `${vp.dbPath}-shm`]) writeFileSync(path, randomBytes(64 * 1024))
        backdate(vp.encPath)
      }
    ],
    [
      // A real database, but neither it nor its `-wal` is newer than the snapshot that opens: derived data.
      'a working file and -wal older than .enc',
      (vp) => {
        failedLockState(vp) // `.enc` backdated 60 s …
        writeFileSync(`${vp.dbPath}-wal`, 'wal')
        writeFileSync(`${vp.dbPath}-shm`, 'shm')
        backdate(vp.dbPath, 120_000) // … the working file and its -wal older still (the -shm's time is not read)
        backdate(`${vp.dbPath}-wal`, 120_000)
      }
    ],
    [
      // The SQLite magic and nothing after it: shorter than a database header, so no database to the probe either.
      'a working file cut short inside the database header',
      (vp) => {
        writeFileSync(vp.dbPath, Buffer.concat([Buffer.from('SQLite format 3', 'latin1'), Buffer.alloc(1)]))
        writeFileSync(`${vp.dbPath}-wal`, 'wal')
        writeFileSync(`${vp.dbPath}-shm`, 'shm')
        backdate(vp.encPath)
      }
    ],
    [
      // Newer means strictly newer: a working file and `-wal` exactly as old as `.enc` prove no change after it.
      'a working file and -wal exactly as old as .enc',
      (vp) => {
        failedLockState(vp)
        writeFileSync(`${vp.dbPath}-wal`, 'wal')
        writeFileSync(`${vp.dbPath}-shm`, 'shm')
        const sameTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000) // whole seconds: every file system keeps them
        for (const path of [vp.dbPath, `${vp.dbPath}-wal`, vp.encPath]) utimesSync(path, sameTime, sameTime)
      }
    ],
    [
      // The probe cannot read it (`unknown`: a hold, a permission error); a folder under its name stands in on every OS.
      'a working file the probe cannot read',
      (vp) => {
        mkdirSync(vp.dbPath)
        writeFileSync(`${vp.dbPath}-wal`, 'wal')
        writeFileSync(`${vp.dbPath}-shm`, 'shm')
        backdate(vp.encPath)
      }
    ],
    [
      // A real working copy, newer than an `.enc` cut short after its frame magic: there is no snapshot to name, and the
      // notice's "your workspace opens as it was when it was last locked" cannot hold, so nothing is said (review N-2).
      'a working copy whose .enc has no readable frame',
      (vp) => {
        failedLockState(vp)
        writeFileSync(`${vp.dbPath}-wal`, 'wal')
        writeFileSync(`${vp.dbPath}-shm`, 'shm')
        writeFileSync(vp.encPath, readFileSync(vp.encPath).subarray(0, 'HRAUMEN1'.length))
        backdate(vp.encPath)
      }
    ]
  ])('CODE-1b / #892: live sidecars beside %s: swept as before, and no notice', (_what, plant) => {
    const vp = lockedVault('vault', 'pw')
    plant(vp)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.isRecoveryBlocked()).toBe(false)
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    expect(existsSync(`${vp.dbPath}-shm`)).toBe(false)
    expect(ctl.getState().state).toBe('locked')
    expect(ctl.getState()).not.toHaveProperty('lockNotice')
    const restarted = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    restarted.init()
    expect(restarted.getState()).not.toHaveProperty('lockNotice')
  })

  // #892: …and it does say so for the session's own file in the other states an unclean end leaves it in: torn where a
  // checkpoint stopped (its header reads, its structure does not), or older than `.enc` while its `-wal`, which holds
  // the session's commits, is newer (the drive moved to a computer whose clock is behind the one that locked it last).
  it.each<[string, (vp: FreshVaultPaths) => void]>([
    ['torn mid-checkpoint', (vp) => noisePastPageOne(vp.dbPath)],
    ['older than .enc while its -wal is newer', (vp) => backdate(vp.dbPath, 120_000)]
  ])('#892: live sidecars beside the session’s working file %s: swept as before, and the notice', (_what, plant) => {
    const vp = lockedVault('vault', 'pw')
    failedLockState(vp) // `.enc` backdated 60 s
    writeFileSync(`${vp.dbPath}-wal`, 'wal')
    writeFileSync(`${vp.dbPath}-shm`, 'shm')
    plant(vp)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(false)
    expect(ctl.getState()).toMatchObject({ state: 'locked', lockNotice: 'session_not_closed' })
  })

  // #892: the check asks only whether the working file starts like a database (the SQLite header), so a structure the
  // probe could not read for a reason that is not damage (here a table only the session's own connection could read)
  // counts like any other, and nothing is noted as a salvage fallback: the check salvages nothing.
  it('#892: live sidecars beside a working file whose structure the probe could not read: the notice, no fallback noted', () => {
    const vp = lockedVault('vault', 'pw')
    const { db } = unlockEncryptedVault(vp, 'pw')
    plantProbeTrap(db)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()
    writeFileSync(`${vp.dbPath}-wal`, 'wal')
    writeFileSync(`${vp.dbPath}-shm`, 'shm')
    backdate(vp.encPath)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(ctl.getState()).toMatchObject({ state: 'locked', lockNotice: 'session_not_closed' })
    expect(ctl.takeProbeFallbacks()).toEqual([])
  })

  // #892 (e): a lock that the full drive refused needed room for its checkpoint (the main file grows by what the `-wal`
  // holds) and for its encrypt (a new snapshot the size of the working file). Less free space than the working file and
  // its `-wal` together, measured before the sweep frees them, names that cause, so the user frees space before the next
  // session ends the same way. A drive that cannot say how much is free is not called full.
  it.each<[string, number, (workingCopy: number, encSize: number) => number | null, string, string]>([
    ['one byte less than the working file and its -wal', 0, (workingCopy) => workingCopy - 1, 'session_not_closed_full', 'unclean-full'],
    ['exactly the working file and its -wal', 0, (workingCopy) => workingCopy, 'session_not_closed', 'unclean'],
    // The last lock's snapshot is small and the session grew far past it in the `-wal`: room for another `.enc` of that
    // size is not room for this session's lock.
    [
      'enough for .enc but not for a -wal that grew far past it',
      1024 * 1024,
      (workingCopy, encSize) => encSize + Math.floor((workingCopy - encSize) / 2),
      'session_not_closed_full',
      'unclean-full'
    ],
    ['no answer from the drive', 0, () => null, 'session_not_closed', 'unclean'],
    // A read that fails sits in front of the sweep: it must neither stop the start nor keep the plaintext at rest.
    [
      'a read that fails',
      0,
      () => {
        throw Object.assign(new Error('EIO: i/o error, statfs'), { code: 'EIO' })
      },
      'session_not_closed',
      'unclean'
    ]
  ])('#892: a mid-session crash on a drive whose free space is %s', (_what, walBytes, free, notice, cause) => {
    const vp = lockedVault('vault', 'pw')
    failedLockState(vp)
    writeFileSync(`${vp.dbPath}-wal`, walBytes > 0 ? randomBytes(walBytes) : 'wal')
    writeFileSync(`${vp.dbPath}-shm`, 'shm')
    const workingCopy = statSync(vp.dbPath).size + statSync(`${vp.dbPath}-wal`).size
    const encSize = statSync(vp.encPath).size
    const drive = (): number | null => free(workingCopy, encSize)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false, encryptFile, drive)
    ctl.init()
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(ctl.getState()).toMatchObject({ state: 'locked', lockNotice: notice })
    // The marker carries the cause across a restart (on any drive: the next start does not measure again).
    const restarted = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    restarted.init()
    expect(restarted.getState()).toMatchObject({ lockNotice: notice })
    restarted.unlock('pw')
    expect(restarted.takeWorkingCopyLost()).toEqual({ cause, lostAt: expect.any(String) })
    restarted.lock()
  })

  // #892: a password change (the v1 → v2 migration) cut short after its commit, with the session's sidecars still live:
  // the start's rekey recovery rolls the new password's files forward, and the staged database holds the session, so
  // nothing was lost. The working copy beside the sidecars was judged against the snapshot that was there before the
  // recovery swapped `.enc`; it proves no loss of the one that opens, so the start says nothing.
  it('#892: a crash right after a v1 password change committed (sidecars live): rolled forward, the session kept, no notice', () => {
    const vp = lockedVault('vault', 'pw', { legacyV1: true })
    backdate(vp.encPath)
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 5151 })
    const dataKey = generateDataKey()
    stageRekey(vp, db, key, dataKey)
    rewrapVaultKey(vp, dataKey, 'new-password', FAST_KDF) // the COMMIT; the crash comes before the swap
    db.close()
    writeFileSync(`${vp.dbPath}-wal`, 'wal') // the open session's sidecars, left by the crash
    writeFileSync(`${vp.dbPath}-shm`, 'shm')

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(existsSync(vp.dbPath)).toBe(false) // swept, as before
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false) // rolled forward
    expect(ctl.getState()).not.toHaveProperty('lockNotice')
    const restarted = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    restarted.init()
    expect(restarted.getState()).not.toHaveProperty('lockNotice')
    ctl.unlock('new-password')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
    expect(ctl.takeWorkingCopyLost()).toBeNull()
    ctl.lock()
  })

  it.each<[string, (vp: FreshVaultPaths) => void, boolean]>([
    [
      'a non-SQLite (garbage)',
      (vp) => {
        // E.g. a failed shred's random-overwrite survived its unlink: newer than `.enc`, no
        // sidecars — but rolling THAT forward would replace the intact `.enc` with garbage.
        writeFileSync(vp.dbPath, 'garbage that is not a database')
        backdate(vp.encPath)
      },
      // That is what a SUCCESSFUL lock leaves when its shred's unlink fails: nothing was lost, so no notice.
      false
    ],
    [
      // #876: the failed-lock signature holds (newer, cleanly closed, the SQLite header), but past page 1 it is no
      // longer a database: rolled forward, it would be encrypted over `.enc` and the next unlock would find it damaged.
      'a header-bearing but structurally broken',
      (vp) => {
        failedLockState(vp)
        noisePastPageOne(vp.dbPath)
      },
      // #875: our own shred never leaves a header, so this was the last session's only fresh copy, and it is lost: the
      // lock screen says so (the same notice as a lock that finished at the last snapshot).
      true
    ]
  ])('CODE-1b: %s newer working file is still shredded, never rolled forward', (_what, plant, lost) => {
    const vp = lockedVault('vault', 'pw')
    plant(vp)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(false)
    if (lost) expect(ctl.getState()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })
    else expect(ctl.getState()).not.toHaveProperty('lockNotice')
    // A restart before the unlock still says so: the start wrote it down, not only into this run's memory.
    const restarted = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    restarted.init()
    if (lost) expect(restarted.getState()).toMatchObject({ lockNotice: 'working_copy_lost' })
    else expect(restarted.getState()).not.toHaveProperty('lockNotice')
    expect(ctl.unlock('pw').state).toBe('unlocked')
    // The `.enc` snapshot opened.
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(DEFAULT_SETTINGS.contextTokens)
    expect(ctl.lock()).not.toHaveProperty('lockNotice')
  })

  // #242 / #876: a newer working file the probe cannot read (a hold, a permission error) may be the only fresh copy of
  // the last session. The start must neither move nor sweep it, and refuses to open over it until a retry can read it.
  // A directory under the file's name stands in for the unreadable file on every OS.
  it('CODE-1b: a newer working file the probe cannot read is never swept: the start refuses to open over it (#242, #876)', () => {
    const vp = lockedVault('vault', 'pw')
    backdate(vp.encPath)
    mkdirSync(vp.dbPath)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.isRecoveryBlocked()).toBe(true)
    expect(existsSync(vp.dbPath)).toBe(true)
    expect(thrownBy(() => ctl.unlock('pw')).name).toBe('VaultRecoveryBlockedError')
  })

  // #876 round 1: SQLite cannot open a path of 260 characters or more on Windows unless it is written in the `\\?\`
  // long form; `node:fs` can. With a working file of 251 characters (which SQLite opens), the `.recovery` beside it is
  // 260. The old header read rolled it forward; a probe that answered `unknown` there would refuse every unlock.
  it('CODE-1b: a recovery snapshot whose path is past Windows MAX_PATH still rolls forward (#876)', () => {
    const root = tempRoot('vault-long')
    const configPath = join(root, 'config')
    mkdirSync(configPath)
    const dirLength = 251 - 1 - 'hilbertraum.sqlite'.length
    let dir = root
    while (dirLength - dir.length > 62) dir = join(dir, 'w'.repeat(60))
    dir = join(dir, 'x'.repeat(dirLength - dir.length - 1))
    mkdirSync(dir, { recursive: true })
    const vp = vaultPathsFrom({ configPath, dbPath: join(dir, 'hilbertraum.sqlite') })
    expect(vp.dbPath.length).toBe(251)
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    failedLockState(vp) // a cleanly closed working file holding 7171, newer than `.enc`

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    expect(recoveryPath.length).toBe(260)
    expect(existsSync(recoveryPath)).toBe(true)
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
    expect(existsSync(recoveryPath)).toBe(false)
    ctl.lock()
  })

  // #876 review round 2: the startup salvage and the unlock's roll-forward judge a file the probe cannot read for a
  // reason that is not damage by its header, as before the probe existed (a hold, which the header read itself hits,
  // still refuses as before). `plantProbeTrap` stands in for that failure: a table only its creating connection reads.
  it.each<[string, boolean, string[]]>([
    ['a failed lock’s working file (the start moves it aside, the unlock rolls it forward)', false, ['salvage', 'recovery']],
    ['a .recovery snapshot (the unlock rolls it forward)', true, ['recovery']]
  ])('CODE-1b: %s whose structure the probe cannot read is judged by its header, as before (#876)', (_what, asRecovery, sites) => {
    const vp = lockedVault('vault', 'pw')
    const { db } = unlockEncryptedVault(vp, 'pw')
    plantProbeTrap(db)
    updateSettings(db, { contextTokens: 7171 })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()
    if (asRecovery) renameSync(vp.dbPath, `${vp.dbPath}${RECOVERY_SUFFIX}`)
    backdate(vp.encPath)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.isRecoveryBlocked()).toBe(false)
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
    expect(ctl.takeProbeFallbacks().map((f) => f.site)).toEqual(sites)
    ctl.lock()
  })

  // #875 review round 2: a broken `.recovery` the unlock has to discard is the evidence of a lost session. It is shredded
  // only once the unlock has succeeded: an unlock that fails after it (a full drive at the open) keeps it, and the
  // unlock that finally succeeds records the loss.
  it('a broken .recovery the unlock discards stays until an unlock succeeds, and that unlock records the loss (#875)', () => {
    const vp = lockedVault('vault', 'pw')
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 6161 })
    lockEncryptedVault(vp, db, key)
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    decryptFile(vp.encPath, recoveryPath, key)
    noisePastPageOne(recoveryPath)
    backdate(vp.encPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    vi.spyOn(settingsModule, 'seedSettings').mockImplementationOnce(() => {
      throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })
    })

    expect(thrownBy(() => ctl.unlock('pw')).name).toBe('VaultOpenFailedError')
    expect(existsSync(recoveryPath)).toBe(true)
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(6161)
    expect(existsSync(recoveryPath)).toBe(false)
    expect(ctl.takeWorkingCopyLost()).toEqual({ cause: 'recovery', lostAt: null })
    ctl.lock()
  })

  // …but one OLDER than `.enc` is a spent leftover that later went bad: nothing of the last session is in it, so it is
  // shredded and no loss is recorded (a false `workspace_working_copy_lost` would reach the audit log otherwise).
  it('a broken .recovery older than .enc is shredded as a spent leftover, and no loss is recorded (#875)', () => {
    const vp = lockedVault('vault', 'pw')
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 6161 })
    lockEncryptedVault(vp, db, key)
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    decryptFile(vp.encPath, recoveryPath, key)
    noisePastPageOne(recoveryPath)
    backdate(recoveryPath, 120_000)

    const ctl = unlockedController(vp, 'pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(6161)
    expect(existsSync(recoveryPath)).toBe(false)
    expect(ctl.takeWorkingCopyLost()).toBeNull()
    ctl.lock()
  })

  // CODE-1 review follow-up F1: shredFile is best-effort, so a CONSUMED `.recovery` can
  // outlive its unlink (Windows: AV/search indexer holding the file without
  // FILE_SHARE_DELETE). The unlock-side roll-forward must apply the same freshness +
  // header guards as the init() salvage — unguarded, the leftover silently rolls the
  // vault BACK (stale snapshot re-encrypted on every later unlock) or destroys it
  // (shred-garbage encrypted over the good `.enc`).

  it('CODE-1b guard (F1): a stale .recovery that outlived its shred never rolls back a fresher .enc', () => {
    const vp = lockedVault('vault', 'pw')
    failedLockState(vp) // `.enc` stale; the working file holds 7171
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init() // → `.recovery` snapshot (7171)
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    const staleSnapshot = readFileSync(recoveryPath)

    ctl.unlock('pw') // the roll-forward consumes the snapshot …
    updateSettings(ctl.requireDb(), { contextTokens: 9292 }) // … and the session moves ON
    ctl.lock() // `.enc` now holds the FRESHER 9292

    // The failed-unlink aftermath: the spent snapshot re-appears, OLDER than `.enc`.
    writeFileSync(recoveryPath, staleSnapshot)
    backdate(recoveryPath)

    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(9292) // NOT rolled back to 7171
    expect(existsSync(recoveryPath)).toBe(false) // and the leftover was cleaned up
    ctl.lock()
    // Durable: the fresher data still unlocks after the leftover is gone.
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(9292)
    ctl.lock()
  })

  it.each<[string, (recoveryPath: string, vp: FreshVaultPaths, key: Buffer) => void, boolean]>([
    [
      'a garbage (shred-overwritten)',
      // The failed-unlink aftermath of a shred whose OVERWRITE ran: random bytes, newer than
      // `.enc`, no SQLite header.
      (recoveryPath) => writeFileSync(recoveryPath, randomBytes(4096)),
      // A spent leftover: nothing was lost, so nothing is recorded.
      false
    ],
    [
      // #876: a real copy of the database whose pages past page 1 are noise: the header reads, the structure does not.
      'a header-bearing but structurally broken',
      (recoveryPath, vp, key) => {
        decryptFile(vp.encPath, recoveryPath, key)
        noisePastPageOne(recoveryPath)
      },
      // #875: no shred of ours leaves a header, so this was a failed lock's session, lost now: the unlock records it
      // for the IPC to log and audit (cause 'recovery'; the event's own time is when).
      true
    ]
  ])('CODE-1b guard (F1): %s .recovery is never encrypted over the good .enc', (_what, plant, lost) => {
    const vp = lockedVault('vault', 'pw')
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 6161 })
    lockEncryptedVault(vp, db, key)

    // Unguarded, unlock would encrypt this over `.enc` (GCM verifies fine — it is our own
    // ciphertext) and openDatabase would then fail: the workspace destroyed.
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    plant(recoveryPath, vp, key)
    // `.enc` backdated, so the leftover is strictly NEWER and the freshness check lets it
    // through: only the database check stands between it and the vault (an mtime tie on a coarse
    // clock would let the freshness check refuse it instead).
    backdate(vp.encPath)

    const ctl = unlockedController(vp, 'pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(6161) // data intact
    expect(existsSync(recoveryPath)).toBe(false) // leftover shredded, not rolled forward
    expect(ctl.takeWorkingCopyLost()).toEqual(lost ? { cause: 'recovery', lostAt: null } : null)
    ctl.lock()
  })

  // NB: the CODE-10 fsync-before-rename and CODE-14 rename-ordering WIRING pins, and the
  // CODE-14 end state after a create, live in workspace-vault-durability.test.ts — they need
  // `vi.mock('node:fs')` (a plain spy on the externalized builtin does not intercept the
  // module's internal calls).

  it('CODE-14: crash BEFORE the descriptor write → still uninitialized; onboarding retries cleanly', () => {
    const vp = freshVaultPaths('vault')
    // Replicate createEncryptedVaultOnDisk up to but NOT including the descriptor write
    // (the commit point): seeded DB → staged `.enc.new` → plaintext shredded.
    const db = openDatabase(vp.dbPath)
    seedSettings(db)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()
    encryptFile(vp.dbPath, `${vp.encPath}${REKEY_SUFFIX}`, randomBytes(32))
    shredFile(vp.dbPath)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    // NOT locked/bricked: no descriptor and no `.enc` committed → the create flow is offered.
    expect(ctl.getState().state).toBe('uninitialized')
    // …and the retry works cleanly over the stray staged file (encryptFile overwrites it).
    expect(ctl.create('fresh-password', 'encrypted').state).toBe('unlocked')
    ctl.lock()
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false) // consumed by the retry's swap
    expect(ctl.unlock('fresh-password').state).toBe('unlocked')
    ctl.lock()
  })

  it('CODE-14: crash AFTER the descriptor commit, BEFORE the swap → rolls forward on next start', () => {
    const vp = lockedVault('vault', 'pw')
    // Undo the final swap — exactly the disk state of a crash between the descriptor
    // commit and the staged rename.
    renameSync(vp.encPath, `${vp.encPath}${REKEY_SUFFIX}`)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init() // recoverPendingRekey: v2 descriptor + staged file = committed → roll FORWARD
    expect(existsSync(vp.encPath)).toBe(true)
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
    expect(ctl.getState().state).toBe('locked')
    expect(ctl.unlock('pw').state).toBe('unlocked')
    ctl.lock()
  })
})

// ---- #954, #955: a workspace put back while the app is open ------------------------

describe('a workspace put back after the start (#954, #955)', () => {
  /** A controller started on an empty layout: `uninitialized`, the lock screen's create form. */
  function startedEmpty(): { vp: FreshVaultPaths; ctl: WorkspaceController } {
    const vp = freshVaultPaths('vault')
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.getState().state).toBe('uninitialized')
    return { vp, ctl }
  }

  // #954: the refusal trusted the descriptor read at the start, so a valid key file copied in while the create form was
  // up (its `.enc` still elsewhere) was replaced by the new workspace's, and with it the only wrapped copy of that
  // workspace's data key. S-4: a plaintext (developer) create opened a database beside it, which the next start then
  // treated as the only copy of the encrypted workspace. The plaintext form is reachable when a newer build's plaintext
  // database kept the start on the create form (#247) and was moved away.
  it.each<[string, () => { vp: FreshVaultPaths; ctl: WorkspaceController; args: [string, 'encrypted' | 'plaintext_dev'] }]>([
    ['an encrypted create', () => ({ ...startedEmpty(), args: ['brand-new-pw', 'encrypted'] })],
    [
      'a plaintext create (S-4)',
      () => {
        const vp = newerPlaintext(freshVaultPaths('vault'))
        const ctl = new WorkspaceController(vp, DEFAULT_POLICY, true)
        ctl.init()
        expect(ctl.getState().state).toBe('uninitialized')
        for (const path of [vp.dbPath, `${vp.dbPath}-wal`, `${vp.dbPath}-shm`]) rmSync(path, { force: true })
        return { vp, ctl, args: ['', 'plaintext_dev'] }
      }
    ]
  ])('a valid key file put back under the create form: %s is refused, the file unchanged, the state locked', (_case, arrange) => {
    const { vp, ctl, args } = arrange()
    copyFileSync(lockedVault('vault-src', 'pw').descriptorPath, vp.descriptorPath)
    const descriptor = readFileSync(vp.descriptorPath)
    expect(thrownBy(() => ctl.create(...args)).name).toBe('WorkspaceExistsError')
    expect(readFileSync(vp.descriptorPath).equals(descriptor)).toBe(true)
    expect(ctl.isUnlocked()).toBe(false)
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
    // What the lock screen re-reads: a workspace is here, so it shows the unlock form.
    expect(ctl.getState().state).toBe('locked')
  })

  // #955 item 2: the create committed its key file, and its last step (the staged `.enc.new` onto `.enc`) failed: an
  // antivirus holding the new file. A retry in the same session used to rewrite the key file it had just committed. Now
  // it is refused, the unlock runs the start's steps (they roll the staged file into place), and the password chosen
  // the first time opens the workspace.
  it('after a create whose last rename failed, the retry is refused and the password just chosen opens it (#955 item 2)', () => {
    const { vp, ctl } = startedEmpty()
    createEncryptedVaultOnDisk(vp, 'just-chosen-pw', FAST_KDF)
    renameSync(vp.encPath, `${vp.encPath}${REKEY_SUFFIX}`) // that disk state, without an fs mock
    const committed = readFileSync(vp.descriptorPath)
    expect(thrownBy(() => ctl.create('typed-again-pw', 'encrypted')).name).toBe('WorkspaceExistsError')
    expect(readFileSync(vp.descriptorPath).equals(committed)).toBe(true)
    expect(ctl.getState().state).toBe('locked')
    expect(ctl.unlock('just-chosen-pw').state).toBe('unlocked')
    ctl.lock()
  })

  // #955 item 3, review V F-1: a refused create writes nothing, also over a vault that appeared after the start; the
  // unlock that follows runs the start's steps. Here a key file and a working file came back without their `.enc`: the
  // refusal leaves both byte for byte, and the unlock keeps the working file as the only copy (#911) and encrypts it.
  it('a refused create over a vault that appeared writes nothing; the unlock runs the start steps (#955 item 3)', () => {
    const src = lockedVault('vault-src', 'pw')
    failedLockState(src, 7171, 'pw') // a closed working file holding the newest data
    const { vp, ctl } = startedEmpty()
    copyFileSync(src.descriptorPath, vp.descriptorPath)
    copyFileSync(src.dbPath, vp.dbPath)
    const descriptor = readFileSync(vp.descriptorPath)
    const workingFile = readFileSync(vp.dbPath)
    expect(thrownBy(() => ctl.create('brand-new-pw', 'encrypted')).name).toBe('WorkspaceExistsError')
    expect(readFileSync(vp.descriptorPath).equals(descriptor)).toBe(true)
    expect(readFileSync(vp.dbPath).equals(workingFile)).toBe(true)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(false)
    expect(ctl.getState().state).toBe('locked')
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
    expect(ctl.takeRestoredMissingEnc()).toBe(true)
    ctl.lock()
  })

  // Review V F-1 (probe P4): a create killed between its stage and its commit leaves a `.enc.new` (the crash variant
  // of S-1, its own issue). With the old workspace copied back whole under the create form, a refused create that ran
  // the start's steps rolled that leftover over the put-back `.enc`, in a call that says nothing was created.
  it('a refused create never rolls a leftover .enc.new over a workspace put back under the create form', () => {
    const { vp, ctl } = startedEmpty()
    copyFileSync(lockedVault('vault-leftover', 'other-pw').encPath, `${vp.encPath}${REKEY_SUFFIX}`)
    const old = lockedVault('vault-old', 'old-pw')
    copyFileSync(old.descriptorPath, vp.descriptorPath)
    copyFileSync(old.encPath, vp.encPath)
    const enc = readFileSync(vp.encPath)
    const leftover = readFileSync(`${vp.encPath}${REKEY_SUFFIX}`)
    expect(thrownBy(() => ctl.create('brand-new-pw', 'encrypted')).name).toBe('WorkspaceExistsError')
    expect(readFileSync(vp.encPath).equals(enc)).toBe(true)
    expect(readFileSync(`${vp.encPath}${REKEY_SUFFIX}`).equals(leftover)).toBe(true)
  })

  // Security review V S-1 (probe S9; the first review's N-1): the start found a newer build's rekey journal and skipped
  // its steps (#845). The journal goes away, and a create (a direct IPC call: the lock screen offers none while locked)
  // clears the verdict through `readFormat()`, adopts the descriptor and is refused. The unlock after it must still run
  // the start's salvage, or it decrypts `.enc` over the newer working file of the last session.
  it('a newer verdict that clears, then a refused create: the unlock still keeps the newer working file (#845)', () => {
    const vp = lockedVault('vault', 'pw')
    failedLockState(vp, 7171, 'pw') // a working file newer than `.enc`: the only copy of the last session
    const journal = join(dirname(vp.encPath), 'rekey-journal.json')
    writeFileSync(journal, JSON.stringify({ version: 99 }))
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.newerVaultFormat()).not.toBeNull()
    rmSync(journal) // a backup restored, the newer copy rolled back
    expect(thrownBy(() => ctl.create('brand-new-pw', 'encrypted')).name).toBe('WorkspaceExistsError')
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
    ctl.lock()
  })

  // Review V F-3 (probe P2): an unreadable key file that appears under the create form, with no `.enc`. The create
  // answered "unlock it with its password" and every unlock then said no password can open it; the create now answers
  // what the unlock answers, and the file stays as it was.
  it('an unreadable key file under the create form: the create answers what the unlock answers, the file unchanged', () => {
    const { vp, ctl } = startedEmpty()
    writeFileSync(vp.descriptorPath, '{ not json', 'utf8')
    const descriptor = readFileSync(vp.descriptorPath)
    expect(thrownBy(() => ctl.create('brand-new-pw', 'encrypted')).name).toBe('VaultDescriptorUnreadableError')
    expect(thrownBy(() => ctl.unlock('pw')).name).toBe('VaultDescriptorUnreadableError')
    expect(readFileSync(vp.descriptorPath).equals(descriptor)).toBe(true)
  })

  /** A workspace whose last session ended without a lock (#892: working file + `-wal`), copied under `vp`'s create form. */
  function putBackEndedUnlocked(vp: FreshVaultPaths): void {
    const src = lockedVault('vault-src', 'pw')
    backdate(src.encPath)
    endedUnlocked(src, 4242, 'pw')
    copyFileSync(src.descriptorPath, vp.descriptorPath)
    copyFileSync(src.encPath, vp.encPath)
    backdate(vp.encPath)
    for (const suffix of ['', '-wal', '-shm']) copyFileSync(`${src.dbPath}${suffix}`, `${vp.dbPath}${suffix}`)
  }

  // Review V F-2 (probe P1, on the unlock path): the start's steps judge the session an unclean end left, sweep it, and
  // record the loss at their end. The variant whose first unlock stops after the sweep needs a hold the rekey recovery
  // waits on; since #1015 round 3 a folder at a temp name (the hold this row used) no longer stops it, so that variant
  // moved to vault-recovery-guards.test.ts, whose `node:fs` stand-in holds a staged file the way an antivirus does.
  it.each<[string, boolean]>([['with nothing in the way', false]])(
    'an unclean end put back under the create form: the unlock records the lost session %s',
    () => {
      const { vp, ctl } = startedEmpty()
      putBackEndedUnlocked(vp)
      ctl.unlock('pw')
      expect(['unclean', 'unclean-full']).toContain(ctl.takeWorkingCopyLost()?.cause)
      ctl.lock()
    }
  )
})

// ---- #911: the encrypted file missing from the drive ------------------------------

describe('the encrypted file missing from the drive (#911)', () => {
  const recoveryOf = (vp: VaultPaths): string => `${vp.dbPath}${RECOVERY_SUFFIX}`
  const sidecarsOf = (vp: VaultPaths): string[] => [`${vp.dbPath}-wal`, `${vp.dbPath}-shm`]
  const markerOf = (vp: VaultPaths): string => join(dirname(vp.descriptorPath), WORKING_COPY_LOST_MARKER)
  const LOCKED = { state: 'locked', mode: 'encrypted', plaintextAllowed: false, encryptionRequired: true }

  // With no encrypted snapshot on the drive the working file is the only copy of the workspace, and the start used to
  // shred it. Now it is kept as `.recovery`, which the unlock with the right password rolls forward over the missing
  // `.enc`. An unclean end leaves the session's last commit in the `-wal` only, so the start replays it first; a failed
  // lock and quit leaves a cleanly closed file. The notice is read from the disk, so a restart before the unlock still
  // shows it, and no #875 marker is written: it names a snapshot, and there is none.
  it.each<[string, (vp: VaultPaths) => void]>([
    ['a session the app ended without locking (main file, -wal, -shm)', (vp) => endedUnlocked(vp, 9119)],
    ['a failed lock and quit (a cleanly closed working file)', (vp) => failedLockState(vp, 9119)]
  ])('#911: .enc removed after %s: the start keeps the only copy, and the right password restores all of it', (_what, end) => {
    const vp = lockedVault('vault-911', 'pw')
    end(vp)
    rmSync(vp.encPath)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.isRecoveryBlocked()).toBe(false)
    expect(existsSync(recoveryOf(vp))).toBe(true)
    for (const path of [vp.dbPath, ...sidecarsOf(vp)]) expect(existsSync(path), path).toBe(false)
    expect(existsSync(markerOf(vp))).toBe(false)
    expect(ctl.getState()).toEqual({ ...LOCKED, lockNotice: 'encrypted_file_missing' })
    const restarted = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    restarted.init()
    expect(restarted.getState()).toEqual({ ...LOCKED, lockNotice: 'encrypted_file_missing' })
    expect(existsSync(recoveryOf(vp))).toBe(true)

    // The password is checked against the descriptor, so a wrong one is still told apart and keeps the copy.
    expect(thrownBy(() => ctl.unlock('wrong-password')).name).toBe('WrongPasswordError')
    expect(existsSync(recoveryOf(vp))).toBe(true)
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(9119) // the session's last commit included
    expect(existsSync(vp.encPath)).toBe(true)
    expect(existsSync(recoveryOf(vp))).toBe(false)
    expect(ctl.takeWorkingCopyLost()).toBeNull() // nothing was lost
    expect(ctl.takeRestoredMissingEnc()).toBe(true) // for the IPC's one log line, once
    expect(ctl.takeRestoredMissingEnc()).toBe(false)
    expect(ctl.lock()).not.toHaveProperty('lockNotice')
    const next = unlockedController(vp, 'pw')
    expect(getSettings(next.requireDb()).contextTokens).toBe(9119)
    expect(next.takeRestoredMissingEnc()).toBe(false)
    next.lock()
  })

  // #1014 round 3 (pre-existing): a folder at the staged database's name is no snapshot. The start counted it as one by
  // its existence, left the working file to the sweep, and the sweep shredded the only copy of the workspace.
  it('#911: .enc removed and a folder at the staged name: the start keeps the only copy, and the right password restores it', () => {
    const vp = lockedVault('vault-911', 'pw')
    failedLockState(vp, 9119)
    rmSync(vp.encPath)
    const folder = `${vp.encPath}${REKEY_SUFFIX}`
    mkdirSync(folder)
    writeFileSync(join(folder, 'held'), 'x')
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(existsSync(recoveryOf(vp)), 'the kept copy').toBe(true)
    expect(ctl.getState()).toEqual({ ...LOCKED, lockNotice: 'encrypted_file_missing' })
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(9119)
    expect(readdirSync(folder)).toEqual(['held'])
    ctl.lock()
  })

  // Nothing left to keep (the session was locked, then `.enc` removed): the right password names the missing file
  // instead of failing raw ("Could not open the workspace." on every try), a wrong one is still a wrong password, and
  // nothing is written. Create stays refused: the descriptor holds the data key the stored documents need (#860 V4).
  it('#911: .enc removed with nothing to keep: the right password says the file is missing, a wrong one is still wrong', () => {
    const vp = lockedVault('vault-911', 'pw')
    rmSync(vp.encPath)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.getState()).toEqual(LOCKED)
    expect(thrownBy(() => ctl.unlock('wrong-password')).name).toBe('WrongPasswordError')
    expect(thrownBy(() => ctl.unlock('pw')).name).toBe('VaultMissingError')
    expect(readdirSync(dirname(vp.dbPath))).toEqual([])
    expect(ctl.getState()).toEqual(LOCKED)
    expect(() => ctl.create('another-password', 'encrypted')).toThrow(WorkspaceExistsError)
    expect(ctl.discardedOnlyCopy()).toBe(false) // nothing was there to discard
  })

  // Code review: the notice promises a copy to encrypt again, so it needs one that starts like a database (the #892
  // header read). A `.recovery` that does not (here noise, as a failed shred leaves) is no copy: no notice, and the
  // right password shreds it and says the file is missing.
  it('#911: .enc removed and a .recovery that does not start like a database: no notice, and the unlock says the file is missing', () => {
    const vp = lockedVault('vault-911', 'pw')
    rmSync(vp.encPath)
    writeFileSync(recoveryOf(vp), randomBytes(8192))

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.getState()).toEqual(LOCKED)
    expect(thrownBy(() => ctl.unlock('pw')).name).toBe('VaultMissingError')
    expect(existsSync(recoveryOf(vp))).toBe(false)
  })

  // Owner decision D3: a copy that is no database after the replay (torn past page one, its `-wal` intact: SQLite calls
  // it corrupt) is not kept. The sweep shreds it, as before, and the unlock then says the encrypted file is missing.
  it('#911: .enc removed and the working file torn past page one: not kept, and the unlock says the file is missing', () => {
    const vp = lockedVault('vault-911', 'pw')
    endedUnlocked(vp, 9119)
    rmSync(vp.encPath)
    noisePastPageOne(vp.dbPath)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.isRecoveryBlocked()).toBe(false)
    for (const path of [vp.dbPath, ...sidecarsOf(vp), recoveryOf(vp)]) expect(existsSync(path), path).toBe(false)
    expect(ctl.getState()).toEqual(LOCKED)
    // Code review: the one trace of it, for main/index.ts's content-free log line; this start's only (no marker).
    expect(ctl.discardedOnlyCopy()).toBe(true)
    const restarted = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    restarted.init()
    expect(restarted.discardedOnlyCopy()).toBe(false)
    expect(thrownBy(() => ctl.unlock('pw')).name).toBe('VaultMissingError')
  })

  // Owner decision D4: a replay that cannot finish (here another connection reads the session, as a second account's
  // app on the same drive would; a full drive ends the same way) leaves the `-wal` holding commits. The start then
  // touches nothing and refuses to open (#242's state). Once the hold is gone the unlock's retry keeps and restores it.
  it('#911: .enc removed and the -wal held so its replay cannot finish: nothing is moved or shredded until the retry', () => {
    const vp = lockedVault('vault-911', 'pw')
    endedUnlocked(vp, 9119)
    rmSync(vp.encPath)
    const walBefore = readFileSync(`${vp.dbPath}-wal`)
    const reader = openRawDb(vp.dbPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    try {
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) AS n FROM settings').get()
      ctl.init()
      expect(ctl.isRecoveryBlocked()).toBe(true)
      expect(existsSync(vp.dbPath)).toBe(true)
      expect(readFileSync(`${vp.dbPath}-wal`).equals(walBefore)).toBe(true)
      expect(existsSync(recoveryOf(vp))).toBe(false)
      expect(thrownBy(() => ctl.unlock('pw')).name).toBe('VaultRecoveryBlockedError')
    } finally {
      reader.close()
    }
    ctl.unlock('pw')
    expect(ctl.isRecoveryBlocked()).toBe(false)
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(9119)
    expect(existsSync(vp.encPath)).toBe(true)
    ctl.lock()
  })

  // F-10's boundary (declined by the owner): the start keeps the working copy only when NO encrypted snapshot exists.
  // A v1 → v2 password change cut between the old `.enc`'s shred and the staged `.enc.new`'s rename leaves no `.enc`
  // beside a live session: the staged snapshot rolls forward and the working copy is swept, as before. A commit made
  // after the change is lost (the power-cut trade-off) instead of being rolled forward over that snapshot.
  // Review SF-2 (D3): a kept copy that is damaged by the time of the unlock cannot be rolled forward, and with no `.enc`
  // no unlock can ever succeed, so #875's "keep the evidence until an unlock succeeds" would leave it in plaintext for
  // ever under a notice that says to unlock. The right password shreds it and says the file is missing, and the notice
  // goes with the file. Only the password's owner can do that: a wrong password touches nothing (the next row).
  it('#911: a kept copy damaged before the unlock: the right password shreds it, says the file is missing, and the notice goes', () => {
    const vp = lockedVault('vault-911', 'pw')
    endedUnlocked(vp, 9119)
    rmSync(vp.encPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    noisePastPageOne(recoveryOf(vp))
    expect(ctl.getState()).toEqual({ ...LOCKED, lockNotice: 'encrypted_file_missing' })

    expect(thrownBy(() => ctl.unlock('pw')).name).toBe('VaultMissingError')
    expect(existsSync(recoveryOf(vp))).toBe(false)
    expect(readdirSync(dirname(vp.dbPath))).toEqual([])
    expect(ctl.getState()).toEqual(LOCKED)
    const restarted = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    restarted.init()
    expect(restarted.getState()).toEqual(LOCKED)
  })

  it('#911: a kept copy damaged before the unlock: a wrong password touches nothing', () => {
    const vp = lockedVault('vault-911', 'pw')
    endedUnlocked(vp, 9119)
    rmSync(vp.encPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    noisePastPageOne(recoveryOf(vp))
    const damaged = readFileSync(recoveryOf(vp))

    expect(thrownBy(() => ctl.unlock('wrong-password')).name).toBe('WrongPasswordError')
    expect(readFileSync(recoveryOf(vp)).equals(damaged)).toBe(true)
    expect(ctl.getState()).toEqual({ ...LOCKED, lockNotice: 'encrypted_file_missing' })
  })

  // Review SF-1 (orchestrator decision: documented and pinned, no behaviour change). The start never replaces a
  // snapshot, but an `.enc` that comes back between the start and the unlock (a sync tool restoring it, a user putting
  // an older copy back) is judged by the CODE-1b roll-forward rule, which cannot tell the kept copy from a failed lock's:
  // the kept copy is newer, so it wins and replaces the returned file. security-model.md "Encrypted file missing" says
  // so, and what a returned `.enc` with a newer mtime does instead (it wins, the kept copy is shredded).
  it.each<[string, boolean]>([
    ['in the same run', false],
    ['after a restart', true]
  ])('#911: an older .enc put back before the unlock (%s) is replaced by the kept copy, by the CODE-1b rule', (_when, restart) => {
    const vp = lockedVault('vault-911', 'pw')
    endedUnlocked(vp, 9119)
    const encBytes = readFileSync(vp.encPath)
    rmSync(vp.encPath)
    let ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(existsSync(recoveryOf(vp))).toBe(true)
    writeFileSync(vp.encPath, encBytes)
    backdate(vp.encPath) // an older copy: its own time, before the session the start kept
    if (restart) {
      ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      expect(ctl.getState()).toEqual(LOCKED) // `.enc` is there: no notice
      expect(existsSync(recoveryOf(vp))).toBe(true)
    }
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(9119)
    expect(readFileSync(vp.encPath).equals(encBytes)).toBe(false)
    expect(existsSync(recoveryOf(vp))).toBe(false)
    ctl.lock()
  })

  it('#911 guard: a password change cut short with a staged .enc.new and no .enc opens the staged snapshot, not the session', () => {
    const vp = lockedVault('vault-911', 'pw', { legacyV1: true })
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 9119 })
    const dataKey = generateDataKey()
    stageRekey(vp, db, key, dataKey)
    rewrapVaultKey(vp, dataKey, 'new-password', FAST_KDF) // the COMMIT
    shredFile(vp.encPath) // applyPendingRekey's swap, first half: the cut lands before the rename
    updateSettings(db, { ragTopKInitial: DEFAULT_SETTINGS.ragTopKInitial + 5 }) // a commit after the change
    key.fill(0)
    leaveAsKilled(vp, db)
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(true)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(recoveryOf(vp))).toBe(false)
    expect(existsSync(vp.encPath)).toBe(true)
    expect(ctl.getState()).toEqual(LOCKED)
    ctl.unlock('new-password')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(9119)
    expect(getSettings(ctl.requireDb()).ragTopKInitial).toBe(DEFAULT_SETTINGS.ragTopKInitial)
    ctl.lock()
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

    const vp = freshVaultPaths('vault')
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
