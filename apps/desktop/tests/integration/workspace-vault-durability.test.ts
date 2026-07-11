import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, openSync, fsyncSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  unlockEncryptedVault,
  lockEncryptedVault,
  REKEY_SUFFIX,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { updateSettings } from '../../src/main/services/settings'
import type { KdfParams } from '../../src/main/services/security/crypto'

// full-audit 2026-07-11 CODE-10 / CODE-14 — WIRING pins with teeth, in the spirit of
// binary-verify-spawn.test.ts: they drive the REAL vault functions and assert the
// durability-critical fs call ORDER (fsync before the atomic rename; descriptor commit
// between the staged encrypt and the final swap). A plain `vi.spyOn` on the externalized
// `node:fs` builtin does NOT intercept the module's internal named-import calls, so this
// file mocks `node:fs` with pass-through `vi.fn` wrappers around the three functions the
// pins observe — everything still hits the real filesystem; the mock only RECORDS.
// Kept separate from workspace-vault.test.ts so the module mock cannot leak into the
// behavioral suites there.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const mocked = {
    ...actual,
    openSync: vi.fn(actual.openSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync)
  }
  return { ...mocked, default: mocked }
})

const spies = {
  openSync: vi.mocked(openSync),
  fsyncSync: vi.mocked(fsyncSync),
  renameSync: vi.mocked(renameSync)
}

// Fast KDF so the suite stays quick (same fixture as workspace-vault.test.ts).
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }

/** Build a fresh temp workspace layout + its vault paths. */
function freshVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-vault-durability-'))
  const configPath = join(root, 'config')
  const workspacePath = join(root, 'workspace')
  mkdirSync(configPath, { recursive: true })
  mkdirSync(workspacePath, { recursive: true })
  return vaultPathsFrom({ configPath, dbPath: join(workspacePath, 'hilbertraum.sqlite') })
}

describe('vault lock durability — fs-call wiring (full-audit 2026-07-11 CODE-10/14)', () => {
  it('CODE-10: lock fsyncs the freshly written .enc tmp before the atomic rename', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 4096 })

    spies.openSync.mockClear()
    spies.fsyncSync.mockClear()
    spies.renameSync.mockClear()
    lockEncryptedVault(vp, db, key)

    // Every fd opened for the `.enc` write-temp …
    const tmpFds = spies.openSync.mock.calls
      .map((args, i) => ({ path: args[0], fd: spies.openSync.mock.results[i]?.value as number }))
      .filter((c) => c.path === `${vp.encPath}.tmp`)
      .map((c) => c.fd)
    expect(tmpFds.length).toBeGreaterThan(0)
    // … must be fsynced BEFORE the atomic rename lands it under its final name
    // (TEETH: delete encryptFile's fsync → no tmp-fd fsync precedes the rename → red).
    const renameIdx = spies.renameSync.mock.calls.findIndex(([, to]) => to === vp.encPath)
    expect(renameIdx).toBeGreaterThanOrEqual(0)
    const renameOrder = spies.renameSync.mock.invocationCallOrder[renameIdx]
    const fsyncOrders = spies.fsyncSync.mock.calls
      .map((args, i) => ({ fd: args[0], order: spies.fsyncSync.mock.invocationCallOrder[i] }))
      .filter((c) => tmpFds.includes(c.fd as number))
    expect(fsyncOrders.length).toBeGreaterThan(0)
    expect(Math.min(...fsyncOrders.map((c) => c.order))).toBeLessThan(renameOrder)
  })

  it('CODE-14: creation stages the .enc and commits at the descriptor write (ordering pin)', () => {
    const vp = freshVault()
    spies.renameSync.mockClear()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)

    const targets = spies.renameSync.mock.calls.map(([, to]) => String(to))
    const stagedIdx = targets.indexOf(`${vp.encPath}${REKEY_SUFFIX}`) // encryptFile tmp → staged
    const descriptorIdx = targets.indexOf(vp.descriptorPath) // the COMMIT POINT
    const finalIdx = targets.lastIndexOf(vp.encPath) // staged → final swap
    expect(stagedIdx).toBeGreaterThanOrEqual(0)
    expect(descriptorIdx).toBeGreaterThan(stagedIdx) // the encrypted DB exists BEFORE the commit
    expect(finalIdx).toBeGreaterThan(descriptorIdx) // …and swaps in only after it
    // End state unchanged: descriptor + `.enc`, no staged leftovers, no plaintext.
    expect(existsSync(vp.encPath)).toBe(true)
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
    expect(existsSync(vp.dbPath)).toBe(false)
  })
})
