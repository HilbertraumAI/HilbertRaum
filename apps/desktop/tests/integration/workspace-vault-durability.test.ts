import { describe, it, expect, vi } from 'vitest'
import { existsSync, openSync, fsyncSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  createEncryptedVaultOnDisk,
  encryptFileAsync,
  unlockEncryptedVault,
  lockEncryptedVault,
  REKEY_SUFFIX,
  type WorkspaceController
} from '../../src/main/services/workspace-vault'
import { updateSettings } from '../../src/main/services/settings'
import { tempRoot } from '../helpers/db-fixtures'
import { FAST_KDF, freshVaultPaths, lockedVault, unlockedController } from '../helpers/vault-fixtures'

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

// The async twins (#860 V2) write through `node:fs/promises` FileHandles: record each handle's `sync()` (with the path
// it was opened on) and each `rename()`, in one ordered log. Pass-through like the `node:fs` mock above.
const asyncFs = vi.hoisted(() => ({ log: [] as Array<{ op: 'sync' | 'rename'; path: string }> }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args)
    const path = String(args[0])
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      asyncFs.log.push({ op: 'sync', path })
      return sync()
    }
    return handle
  }
  const rename: typeof actual.rename = async (from, to) => {
    asyncFs.log.push({ op: 'rename', path: String(to) })
    return actual.rename(from, to)
  }
  const mocked = { ...actual, open, rename }
  return { ...mocked, default: mocked }
})

const spies = {
  openSync: vi.mocked(openSync),
  fsyncSync: vi.mocked(fsyncSync),
  renameSync: vi.mocked(renameSync)
}

function clearSpies(): void {
  spies.openSync.mockClear()
  spies.fsyncSync.mockClear()
  spies.renameSync.mockClear()
}

/**
 * Since the last `clearSpies()`: an fd opened on `tmp` was fsynced after that open and BEFORE the rename that landed
 * `tmp` on `final`. Matched by call order, not by fd number alone: the OS hands a closed fd's number out again, so an
 * fsync of another file's fd (the create's staged `.enc` write, just before its descriptor) would otherwise count.
 * Each part is asserted on its own, so a missing open, fsync or rename reads as itself.
 */
function expectFsyncBeforeRename(tmp: string, final: string): void {
  const renameIdx = spies.renameSync.mock.calls.findIndex(([from, to]) => from === tmp && to === final)
  expect(renameIdx).toBeGreaterThanOrEqual(0)
  const renameOrder = spies.renameSync.mock.invocationCallOrder[renameIdx]
  const tmpOpens = spies.openSync.mock.calls
    .map((args, i) => ({
      path: args[0],
      fd: spies.openSync.mock.results[i]?.value as number,
      order: spies.openSync.mock.invocationCallOrder[i]
    }))
    .filter((c) => c.path === tmp && c.order < renameOrder)
  expect(tmpOpens.length).toBeGreaterThan(0)
  const fsynced = spies.fsyncSync.mock.calls.some((args, i) => {
    const order = spies.fsyncSync.mock.invocationCallOrder[i]
    return tmpOpens.some((open) => args[0] === open.fd && order > open.order && order < renameOrder)
  })
  expect(fsynced).toBe(true)
}

// The vault fixtures go through this file's mocked `node:fs` too (pass-through), so they are
// built ABOVE each `mockClear()`: only the measured call lands in the recorded calls.

describe('vault lock durability — fs-call wiring (full-audit 2026-07-11 CODE-10/14)', () => {
  it('CODE-10: lock fsyncs the freshly written .enc tmp before the atomic rename', () => {
    const vp = lockedVault('vault-durability', 'pw')
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 4096 })

    clearSpies()
    lockEncryptedVault(vp, db, key)

    // Every fd opened for the `.enc` write-temp must be fsynced BEFORE the atomic rename lands it
    // under its final name (TEETH: delete encryptFile's fsync → no tmp-fd fsync precedes the rename → red).
    expectFsyncBeforeRename(`${vp.encPath}.tmp`, vp.encPath)
  })

  // #860 V1: the descriptor holds the wrapped data key and its rename is the commit point of a create and of a
  // password change. Renamed into place before its bytes are durable, a power cut can leave it torn, and the vault
  // can no longer be opened.
  it.each<[string, () => { descriptorPath: string; run: () => void; done?: WorkspaceController }]>([
    [
      'a create',
      () => {
        const vp = freshVaultPaths('vault-durability')
        return { descriptorPath: vp.descriptorPath, run: () => createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF) }
      }
    ],
    [
      'a password change',
      () => {
        const vp = lockedVault('vault-durability', 'pw')
        const ctl = unlockedController(vp, 'pw')
        return {
          descriptorPath: vp.descriptorPath,
          run: () => ctl.changePassword('pw', 'next-password', FAST_KDF),
          done: ctl
        }
      }
    ]
  ])('CODE-14 (#860 V1): %s fsyncs the descriptor temp before the rename commits it', (_case, arrange) => {
    const { descriptorPath, run, done } = arrange()
    try {
      clearSpies()
      run()
      expectFsyncBeforeRename(`${descriptorPath}.tmp`, descriptorPath)
    } finally {
      done?.shutdown()
    }
  })

  // #860 V2: imported documents and image-history copies are written by the async encrypt, and a pasted image's
  // `.enc` can be the only copy. The frame must be durable before it lands under its final name (CODE-10's twin).
  it('CODE-10 (#860 V2): the async encrypt syncs its temp before the rename lands it', async () => {
    const root = tempRoot('vault-durability')
    const src = join(root, 'plain.bin')
    writeFileSync(src, randomBytes(4096))
    const dest = join(root, 'doc.bin.enc')
    asyncFs.log.length = 0
    await encryptFileAsync(src, dest, randomBytes(32))
    const syncAt = asyncFs.log.findIndex((e) => e.op === 'sync' && e.path === `${dest}.tmp`)
    const renameAt = asyncFs.log.findIndex((e) => e.op === 'rename' && e.path === dest)
    expect(syncAt).toBeGreaterThanOrEqual(0)
    expect(renameAt).toBeGreaterThan(syncAt)
  })

  it('CODE-14: creation stages the .enc and commits at the descriptor write (ordering pin)', () => {
    const vp = freshVaultPaths('vault-durability')
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
