// Scratch-vault fixtures for the main-side vault, workspace-IPC and password-change suites: the KDF params, the
// encryption-required policy, the temp vault layout and the on-disk vault states those suites each declared locally
// (vault + local API test campaign, 2026-11-16). At 3776db77: `FAST_KDF` / `FAST_SCRYPT` in 15 files,
// `ENCRYPTION_REQUIRED` in 12, a `freshVault*()` in 9, the workspace `ctxWith` in 3. Roots come from db-fixtures
// `tempRoot`, the only mkdtemp (#335).
//
// Safe inside the two `vi.mock('node:fs')` suites (workspace-vault-durability, vault-recovery-guards): this module's
// fs calls go through the mocked module like the suites' own, every wrapper there is pass-through until armed, and
// the vault primitives below DO reach the recorded `openSync` / `renameSync` / `fsyncSync`. So build the vault state
// above the `mockClear()` lines (and before arming a failure), never between a `mockClear()` and the measured call.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { SCHEMA_VERSION } from '../../src/main/services/db'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import { updateSettings } from '../../src/main/services/settings'
import {
  WorkspaceController,
  createEncryptedVaultOnDisk,
  encryptFile,
  lockEncryptedVault,
  unlockEncryptedVault,
  vaultPathsFrom,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import type { KdfParams } from '../../src/main/services/security/crypto'
import type { AppContext } from '../../src/main/services/context'
import type { PrivacyPolicy } from '../../src/shared/types'
import { openRawDb, tempRoot } from './db-fixtures'
import { ANY_SENDER } from './ipc'

/**
 * Cheap scrypt (N=1024) so a suite stays quick. Unlock reads the params back from the descriptor, so a vault created
 * with these round-trips honestly. password-change.test.ts and crypto.test.ts called it `FAST_SCRYPT`.
 */
export const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }

/**
 * Cheap argon2id (m=256 KiB, t=1, p=1). crypto.test.ts used m: 256; password-change.test.ts used m: 64. No row
 * asserts the fast `m` (password-change reads only `kdf.algo` and the shipped default's 19456), so 256 serves both.
 */
export const FAST_ARGON: KdfParams = { algo: 'argon2id', m: 256, t: 1, p: 1, keyLen: 32 }

/**
 * `DEFAULT_POLICY` with an encrypted workspace required. Trap: it flips TWO flags,
 * `encryptionRequired: true` AND `allowPlaintextDevMode: false`, as every local copy did. A row about the
 * `encryptionRequired` veto alone (`plaintextAllowed`) needs its own `{ encryptionRequired: true,
 * allowPlaintextDevMode: true }`: under this policy the `allowPlaintextDevMode` check refuses plaintext as well, so
 * deleting the veto leaves such a row green.
 */
export const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

/** A scratch vault layout: `VaultPaths` plus the temp root it lives under. */
export type FreshVaultPaths = VaultPaths & { root: string }

/**
 * A fresh vault layout with no vault in it: `<root>/config/` and `<root>/workspace/` created, the DB at
 * `<root>/workspace/hilbertraum.sqlite`, the root `tempRoot(label)` (`hilbertraum-<label>-XXXXXX`, so the copies'
 * `hilbertraum-wsipc-` is `'wsipc'`). `logs: true` also creates `<root>/logs/` and sets `logsPath`, so the v1→v2
 * rekey re-encrypts a rotated log there. Off by default ON PURPOSE: password-change's ciphertext enumeration
 * (`listVaultKeyCiphertexts`) changes with a `logsPath`.
 */
export function freshVaultPaths(label: string, opts: { logs?: boolean } = {}): FreshVaultPaths {
  const root = tempRoot(label)
  const configPath = join(root, 'config')
  const workspacePath = join(root, 'workspace')
  mkdirSync(configPath, { recursive: true })
  mkdirSync(workspacePath, { recursive: true })
  let logsPath: string | undefined
  if (opts.logs) {
    logsPath = join(root, 'logs')
    mkdirSync(logsPath, { recursive: true })
  }
  return { ...vaultPathsFrom({ configPath, dbPath: join(workspacePath, 'hilbertraum.sqlite'), logsPath }), root }
}

/**
 * `freshVaultPaths(label, { logs })` with an encrypted vault created LOCKED under `password`: the descriptor and `.enc`
 * on disk, no working file. `kdf` defaults to `FAST_KDF`; `legacyV1` writes the pre-envelope v1 descriptor
 * (password-change's migration rows).
 */
export function lockedVault(
  label: string,
  password: string,
  opts: { kdf?: KdfParams; legacyV1?: boolean; logs?: boolean } = {}
): FreshVaultPaths {
  const vp = freshVaultPaths(label, { logs: opts.logs })
  createEncryptedVaultOnDisk(vp, password, opts.kdf ?? FAST_KDF, opts.legacyV1 ? { legacyV1: true } : {})
  return vp
}

/**
 * A `WorkspaceController` over the EXISTING vault at `vp`, under `ENCRYPTION_REQUIRED` and not dev, `init()`ed and
 * unlocked with `password`: what `new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)` + `init()` + `unlock()` did
 * inline (vault-lock-cipher's `unlockedController` minus its create, password-change's `reopen`). Pair it with
 * `lockedVault` for a new vault. A row that needs another policy, dev mode or the `encryptFileImpl` seam builds its
 * own controller.
 */
export function unlockedController(vp: VaultPaths, password: string): WorkspaceController {
  const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
  ctl.init()
  ctl.unlock(password)
  return ctl
}

/** Set `path`'s atime and mtime `ageMs` (default 60 s) in the past: a deterministic mtime order on coarse clocks. */
export function backdate(path: string, ageMs = 60_000): void {
  const past = new Date(Date.now() - ageMs)
  utimesSync(path, past, past)
}

/**
 * The disk state a failed lock leaves behind, on the existing vault at `vp` (created under `password`): a
 * checkpointed, cleanly CLOSED plaintext working file (no -wal/-shm) holding `contextTokens: marker`, NEWER than the
 * `.enc`, which is backdated 60 s. Unlocks through `unlockEncryptedVault`, so in the fs-mocked suites the calls land in
 * the spies: call it before a `mockClear()` and before arming a failure.
 */
export function failedLockState(vp: VaultPaths, marker = 7171, password = 'pw'): void {
  const { db } = unlockEncryptedVault(vp, password)
  updateSettings(db, { contextTokens: marker })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  db.close()
  backdate(vp.encPath)
}

/**
 * #208's on-disk state on the existing vault at `vp` (created under `password`): the password verifies and `.enc`
 * authenticates, but it holds the app's own encryption of `noiseBytes` random bytes under the real key, not a
 * database. No default size ON PURPOSE: workspace-vault-destruction's #208 row reproduces the reporter's 483,328 bytes
 * (and asserts `.enc` is left byte for byte), workspace-ipc uses 64 KiB. The noise source stays on disk at
 * `<dbPath>.noise-src`, as in both copies.
 */
export function damagedVault<T extends VaultPaths>(vp: T, password: string, noiseBytes: number): T {
  const { db, key } = unlockEncryptedVault(vp, password)
  lockEncryptedVault(vp, db, key)
  const noise = `${vp.dbPath}.noise-src`
  writeFileSync(noise, randomBytes(noiseBytes))
  encryptFile(noise, vp.encPath, key)
  return vp
}

/**
 * The existing vault at `vp` (created under `password`) re-stamped as written by a NEWER build: its database carries
 * `user_version = SCHEMA_VERSION + 1`, then the vault is locked again (#247). workspace-newer's
 * `newerEncryptedVault` and workspace-ipc's `newerVault`.
 */
export function newerVault<T extends VaultPaths>(vp: T, password: string): T {
  const { db, key } = unlockEncryptedVault(vp, password)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`)
  lockEncryptedVault(vp, db, key)
  return vp
}

/**
 * A plaintext workspace DB at `vp.dbPath` that a NEWER build stamped (`user_version = SCHEMA_VERSION + 1`), written
 * through a raw handle (no migrations) that is closed again (#247). The plaintext twin of `newerVault`.
 */
export function newerPlaintext<T extends VaultPaths>(vp: T): T {
  const raw = openRawDb(vp.dbPath)
  try {
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`)
  } finally {
    raw.close()
  }
  return vp
}

export interface WorkspaceIpcCtxOptions {
  /** `ctx.runtime.stop` (default: resolves at once). */
  stopRuntime?: () => Promise<void>
  /** `ctx.embedder.stop` (default: resolves at once). */
  stopEmbedder?: () => Promise<void>
  /**
   * Adds `ctx.embedder.suspend`. Absent by default ON PURPOSE: the lock teardown runs
   * `ctx.embedder.suspend?.() ?? ctx.embedder.stop?.()`, so the default ctx drives the `stop()` fallback the mock
   * embedder takes. Trap: a fake that returns `undefined` (a bare `vi.fn()`) falls through `??` and calls `stop()` too;
   * make it async.
   */
  suspendEmbedder?: () => Promise<void>
  /** Adds `ctx.vision = { stop }` (absent by default). */
  stopVision?: () => Promise<void>
  /**
   * More context members (`translator`, `ocrEngine`, `docTasks`, `skillRuns`, `cancelBenchmark`, a whole `runtime` or
   * `embedder`, …), set after the defaults above. Never `db`: it is the controller's getter (the helper throws).
   */
  extra?: Record<string, unknown>
}

/**
 * The minimal `AppContext` the workspace IPC handlers read (the `ctxWith` of workspace-ipc, workspace-newer and
 * vault-recovery-guards): every sender trusted, `workspace` = `ctrl`, a runtime with a no-op `stop` and no active
 * model, an embedder with `stop` only.
 *
 * `ctx.db` is the production getter (main/index.ts): `ctrl.requireDb()` on every read, so it throws once the
 * controller locks, and a handler reading it after `lock()` goes red as it would in the app. Traps:
 * - never spread the result: `{ ...workspaceIpcCtx(ctrl), db }` reads the getter once and pins a static db (the
 *   blind spot this getter closes); pass members through `extra`, or set them on the returned object;
 * - `ctx.db` has no setter: assigning it throws;
 * - with a real `db`, a SUCCESSFUL unlock or create through the IPC runs the post-unlock seams (UI language from the
 *   stored setting, the engine-state heal, the first-run benchmark decision) against this DB; the old `ctxWith` had
 *   no `db`, so each threw into its own catch at once. They still end in their own catches (this ctx has no `paths`
 *   and no `runtime.isShutdown`) and only log, e.g. a "GPU probe failed" warning.
 *
 * The workspace is `ctrl` itself, so `isLocking()` is the controller's own: false until a lock is under way. The
 * helper never stubs it (a stub would blind the AUD-02 latch). A stand-in cast to `WorkspaceController` works while no
 * handler reads `ctx.db`.
 */
export function workspaceIpcCtx(ctrl: WorkspaceController, opts: WorkspaceIpcCtxOptions = {}): AppContext {
  const ctx: Record<string, unknown> = {
    trustedSenders: ANY_SENDER,
    workspace: ctrl,
    get db() {
      return ctrl.requireDb()
    },
    runtime: { stop: opts.stopRuntime ?? (async () => {}), activeModelId: () => null },
    embedder: {
      stop: opts.stopEmbedder ?? (async () => {}),
      ...(opts.suspendEmbedder ? { suspend: opts.suspendEmbedder } : {})
    },
    ...(opts.stopVision ? { vision: { stop: opts.stopVision } } : {})
  }
  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (key === 'db') throw new Error('workspaceIpcCtx: ctx.db is the controller getter; do not pass `db` in `extra`')
    ctx[key] = value
  }
  return ctx as unknown as AppContext
}
