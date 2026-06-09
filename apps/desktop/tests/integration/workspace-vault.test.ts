import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  WorkspaceController,
  WrongPasswordError,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import type { KdfParams } from '../../src/main/services/security/crypto'

// Fast KDF so the suite stays quick — unlock reads the params back from the descriptor,
// so creating with cheap params keeps the round-trip honest while shaving scrypt cost.
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }

/** Build a fresh temp workspace layout + its vault paths. */
function freshVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'paid-vault-'))
  const configPath = join(root, 'config')
  const workspacePath = join(root, 'workspace')
  mkdirSync(configPath, { recursive: true })
  mkdirSync(workspacePath, { recursive: true })
  return vaultPathsFrom({ configPath, dbPath: join(workspacePath, 'paid.sqlite') })
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
    expect(plaintextAllowed(DEFAULT_POLICY, { isDev: true, developerMode: false })).toBe(true)
    expect(plaintextAllowed(DEFAULT_POLICY, { isDev: false, developerMode: true })).toBe(true)
    // Not a developer at all → refused even when policy permits.
    expect(plaintextAllowed(DEFAULT_POLICY, { isDev: false, developerMode: false })).toBe(false)
  })

  it('refuses plaintext when encryption is required by policy', () => {
    expect(plaintextAllowed(ENCRYPTION_REQUIRED, { isDev: true, developerMode: true })).toBe(false)
  })

  it('refuses plaintext when the policy disables plaintext dev mode', () => {
    const policy: PrivacyPolicy = {
      ...DEFAULT_POLICY,
      workspace: { encryptionRequired: false, allowPlaintextDevMode: false }
    }
    expect(plaintextAllowed(policy, { isDev: true, developerMode: true })).toBe(false)
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
