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
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
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
import type { Db } from '../../src/main/services/db'
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
 * The existing vault at `vp` (created under `password`) whose database is a real SQLite file with a damaged first page
 * past its header (#844): `PRAGMA user_version` still reads (it is in the header), and the first statement that reads
 * the schema fails SQLITE_CORRUPT. Encrypted under the vault's real key, so the unlock authenticates and only SQLite
 * can tell. The working copy and the corrupted source are removed: the vault is left locked.
 */
export function corruptVault<T extends VaultPaths>(vp: T, password: string): T {
  const { db, key } = unlockEncryptedVault(vp, password)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  db.close()
  const bytes = readFileSync(vp.dbPath)
  bytes.fill(0xff, 100, 200) // the schema b-tree's page header and cell pointers
  const src = `${vp.dbPath}.corrupt-src`
  writeFileSync(src, bytes)
  encryptFile(src, vp.encPath, key)
  rmSync(src)
  rmSync(vp.dbPath)
  return vp
}

/**
 * #876's shape on the SQLite file at `path`: page 1 (the header and the schema root) kept, every byte after it
 * overwritten in place with random noise, as a write through another program's `r+` handle lands (#208). The first 16
 * bytes still read "SQLite format 3", so only a probe of the structure can tell. Call it on a file nothing else has
 * open for writing.
 */
export function noisePastPageOne(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    const head = Buffer.alloc(18)
    readSync(fd, head, 0, head.length, 0)
    const stored = head.readUInt16BE(16)
    const pageSize = stored === 1 ? 65_536 : stored
    const size = fstatSync(fd).size
    if (size > pageSize) writeSync(fd, randomBytes(size - pageSize), 0, size - pageSize, pageSize)
  } finally {
    closeSync(fd)
  }
}

/**
 * A table on the open database `db` that only `db` itself can read (#876 review round 2): a VIRTUAL generated column
 * calls a function registered on this connection alone, so any other connection reading a row fails with SQLite's
 * "unknown function" (SQLITE_ERROR), while the file stays a healthy database that `openDatabase` and every app query
 * handle as before. It stands in for a structural read the probe cannot run for a reason that is not damage (SQLite
 * cannot open the file through the URI, an I/O error, out of memory).
 */
export function plantProbeTrap(db: Db): void {
  db.function('w3_probe_trap', { deterministic: true }, (x: unknown) => x as number)
  db.exec('CREATE TABLE w3_probe_trap (a, b AS (w3_probe_trap(a)) VIRTUAL); INSERT INTO w3_probe_trap (a) VALUES (1);')
}

/** SQLite's varint: 7-bit groups, high bit set on all but the last (values below 2^56 here). */
function sqliteVarint(n: number): Buffer {
  const groups: number[] = []
  do {
    groups.unshift(n % 128)
    n = Math.floor(n / 128)
  } while (n > 0)
  return Buffer.from(groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)))
}

/**
 * Noise SQLite reports as SQLITE_TOOBIG, not CORRUPT (#876 review round 3): the first cell of the table leaf at
 * `rootPage` (4,096-byte pages) is rewritten into the page's free area as a record whose first column claims a TEXT value
 * longer than SQLite allows (1,000,000,001 bytes), inside a payload sized so that its on-page part and overflow pointer
 * still fit. Reading that row's first column fails "string or blob too big". The shape Fable's fuzz found (pages that
 * keep their 8-byte b-tree header over noise bodies), made deterministic.
 */
export function oversizedFirstCell(path: string, rootPage: number): void {
  const pageSize = 4096
  const minLocal = Math.floor(((pageSize - 12) * 32) / 255) - 23
  const payload = minLocal + Math.ceil((1e9 + 1 - minLocal) / (pageSize - 4)) * (pageSize - 4)
  const serial = sqliteVarint(2 * 1_000_000_001 + 13)
  const header = Buffer.concat([Buffer.from([1 + serial.length + 2]), serial, Buffer.from([0, 0])])
  const cell = Buffer.concat([
    sqliteVarint(payload),
    Buffer.from([1]),
    header,
    Buffer.alloc(minLocal - header.length, 0x41),
    Buffer.from([0, 0, 0, 2])
  ])
  const fd = openSync(path, 'r+')
  try {
    const page = Buffer.alloc(pageSize)
    readSync(fd, page, 0, pageSize, (rootPage - 1) * pageSize)
    if (page[0] !== 0x0d) throw new Error(`oversizedFirstCell: page ${rootPage} is no table leaf (type ${page[0]})`)
    const at = 8 + 2 * page.readUInt16BE(3) + 64 // in the free area, past the cell pointers
    cell.copy(page, at)
    page.writeUInt16BE(at, 8)
    writeSync(fd, page, 0, pageSize, (rootPage - 1) * pageSize)
  } finally {
    closeSync(fd)
  }
}

/**
 * The existing vault at `vp` (created under `password`) whose open cannot finish on a healthy database (#844): a
 * trigger aborts, with `abortMessage`, the next open's write at `at`. `'backfill'`: a document holds OCR pages but no
 * OCR summary, so `openDatabase`'s backfill updates it. `'settings'`: the unlock's own settings re-stamp after the open.
 * SQLite reports a constraint failure, not damage: the stand-in for a step that fails on a full drive or through a bug.
 * The vault is left locked.
 */
export function upgradeBlockedVault<T extends VaultPaths>(
  vp: T,
  password: string,
  opts: { abortMessage?: string; at?: 'backfill' | 'settings' } = {}
): T {
  const { db, key } = unlockEncryptedVault(vp, password)
  const table = opts.at === 'settings' ? 'settings' : 'documents'
  if (table === 'documents') {
    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO documents (id, title, status, created_at, updated_at, ocr_json) VALUES ('doc-844', 'scan', 'ready', ?, ?, ?)"
    ).run(now, now, JSON.stringify({ pages: [{ pageNumber: 1, text: 'page one' }] }))
  }
  const quoted = `'${(opts.abortMessage ?? 'blocked').replace(/'/g, "''")}'`
  db.prepare(`CREATE TRIGGER block_open BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, ${quoted}); END`).run()
  lockEncryptedVault(vp, db, key)
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
 * What `run` threw: its name and the newer-format fields of #845's `VaultNewerError` (`what`, `found`), or
 * `{ name: '(no error)' }`. Rows assert the NAME, never the class: on code without the class an import of it is
 * `undefined`, and `toThrowError(undefined)` passes for any error (#844's trap), which would make a control run green.
 */
export function thrownBy(run: () => unknown): { name: string; what?: unknown; found?: unknown } {
  try {
    run()
  } catch (err) {
    const e = err as { name?: unknown; what?: unknown; found?: unknown } | null
    return { name: String(e?.name), what: e?.what, found: e?.found }
  }
  return { name: '(no error)' }
}

/**
 * The descriptor at `vp` rewritten through `edit`, as the app writes it (2-space JSON): the fixture for a descriptor a
 * newer build wrote (#845: `version: 3`, an unknown `kdf.algo`, no `dataKey`).
 */
export function editDescriptor<T extends VaultPaths>(vp: T, edit: (d: Record<string, unknown>) => void): T {
  const d = JSON.parse(readFileSync(vp.descriptorPath, 'utf8')) as Record<string, unknown>
  edit(d)
  writeFileSync(vp.descriptorPath, JSON.stringify(d, null, 2), 'utf8')
  return vp
}

/**
 * The 8-byte frame magic at the start of `path` replaced by `magic`, the rest of the file left as it was (#845):
 * `HRAUMEN2` is a frame a newer build wrote, `PAIDENC1` the pre-0.1.10 format.
 */
export function setFrameMagic(path: string, magic: string): void {
  const bytes = readFileSync(path)
  Buffer.from(magic, 'latin1').copy(bytes, 0, 0, 8)
  writeFileSync(path, bytes)
}

/**
 * The existing vault at `vp` whose `.enc` fails its GCM tag (#860 V5b): one ciphertext byte of the last chunk
 * flipped. The password still verifies; only the decrypt can tell.
 */
export function tagFailingVault<T extends VaultPaths>(vp: T): T {
  const enc = readFileSync(vp.encPath)
  enc[enc.length - 20] ^= 0xff
  writeFileSync(vp.encPath, enc)
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
   * `embedder`, …), set after the defaults above. Never `db`: it is the controller's getter; never `paths`: it would
   * wake the post-unlock steps (see `workspaceIpcCtx`). The helper throws on either.
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
 * - the live `db` makes every SUCCESSFUL unlock or create through the IPC run the real post-unlock steps against this
 *   DB, some of them in the background after the handler has answered: the UI language, the engine-state heal, the
 *   first-run benchmark decision and its GPU probe, the model auto-start, the scheduled first-run measurement, the
 *   local API start and the knowledge-pack session. (The old `ctxWith` had no `db`, so each threw into its own catch
 *   at once.) They stay inert only through what this ctx LACKS, so keep these keys out of `extra` and off the result:
 *   `paths` (without it the probe throws into its catch and stores an empty `gpuProbe`, on a fresh workspace the one
 *   write these steps make; with it the probe would resolve the drive's engine binary; the helper throws on it),
 *   `runtime.isShutdown` / `runtime.beginStartRequest` (the measurement and an auto-start fail into their catches; a
 *   whole `runtime` in `extra` replaces the stub, so leave those two off it), `localApi` and `zim` (those steps return
 *   at once without them; a row that adds one for its lock teardown also wakes that step after each of its unlocks).
 *   Each of these steps only logs on the way out, e.g. a "GPU probe failed" warning.
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
    if (key === 'paths') {
      throw new Error('workspaceIpcCtx: `paths` would let the post-unlock steps reach the drive; do not pass it in `extra`')
    }
    ctx[key] = value
  }
  return ctx as unknown as AppContext
}
