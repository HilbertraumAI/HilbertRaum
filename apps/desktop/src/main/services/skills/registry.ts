// Skill registry (skills plan §8 / DS1, revised §0 — uniform disk reconcile of plain folders).
//
// Disk is the source of truth for BOTH sources (app-skills/ + user-skills/); the `skills` table
// is a derived index + state cache. This module mirrors the discover+validate shape of
// `services/models.ts` and the DB-index reconcile of doc-org `collections.ts`:
//   discover (read each folder's SKILL.md, validate) → reconcile against the DB (insert new,
//   update changed, MARK-UNAVAILABLE the vanished — never blind-delete) → list/get/enable.
//
// Trust is APP-ASSIGNED here: a skill found under app-skills/ is `app`, under user-skills/ is
// `user` (a self-declared `trust` in frontmatter is already ignored by the S2 parser). A folder a
// power user drops into user-skills/ installs DISABLED (DS19) — only a deliberate zip-import via
// the Skills view (S4) installs enabled-with-warning (DS7). A DB rebuild re-derives every skill
// from disk, so there is no orphan and no recovery path (revised §0). All synchronous SQLite +
// local file reads — no network, no model calls.

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db'
import {
  SKILL_ID_RE,
  type SkillKind,
  type SkillManifest,
  type SkillTrustedLevel
} from '../../../shared/skill-manifest'
import { parseSkillManifestFromDir } from './manifest'
import { resolveSkillLimits, type SkillLimits } from './limits'

/** A skill source folder + the trust level the registry assigns to everything found in it. */
export type SkillSource = SkillTrustedLevel // 'app' | 'user' — source folder == assigned trust in v1

/** The derived registry record for one installed skill (a `skills` row, decoded). */
export interface SkillRecord {
  /** Deterministic natural key `"<source>:<id>"` (the `skills` PK). */
  installId: string
  id: string
  title: string
  version: string
  kind: SkillKind
  source: SkillSource
  /** On-disk folder BASENAME, relative to the source dir (portable; resolved by the loader). */
  path: string
  enabled: boolean
  warningAck: boolean
  trustedLevel: SkillTrustedLevel
  manifest: SkillManifest
  /** NULL = folder present; ISO timestamp = the folder vanished (mark-unavailable). */
  unavailableAt: string | null
  installedAt: string
  updatedAt: string
}

/** One validated skill found on disk during discovery (pre-reconcile). */
export interface DiscoveredSkill {
  source: SkillSource
  /** The on-disk folder basename (already SKILL_ID_RE-validated). */
  folderName: string
  manifest: SkillManifest
}

export interface DiscoveryResult {
  skills: DiscoveredSkill[]
  /** One human-readable line per folder that exists but failed to parse/validate. */
  errors: string[]
}

export interface ReconcileResult {
  inserted: number
  updated: number
  markedUnavailable: number
  /** Total skills present on disk after reconcile. */
  present: number
  errors: string[]
}

export interface ReconcileOptions {
  appSkillsDir: string
  userSkillsDir: string
  limits?: SkillLimits
  /** Injectable clock for deterministic tests. */
  now?: () => string
}

/** The deterministic natural key for a skill (skills plan §8.2). */
export function skillInstallId(source: SkillSource, id: string): string {
  return `${source}:${id}`
}

interface SkillRow {
  install_id: string
  id: string
  title: string
  version: string
  kind: string
  source: string
  path: string
  enabled: number
  warning_ack: number
  trusted_level: string
  manifest_json: string
  unavailable_at: string | null
  installed_at: string
  updated_at: string
}

function rowToRecord(r: SkillRow): SkillRecord {
  return {
    installId: r.install_id,
    id: r.id,
    title: r.title,
    version: r.version,
    kind: r.kind as SkillKind,
    source: r.source as SkillSource,
    path: r.path,
    enabled: r.enabled === 1,
    warningAck: r.warning_ack === 1,
    trustedLevel: r.trusted_level as SkillTrustedLevel,
    manifest: JSON.parse(r.manifest_json) as SkillManifest,
    unavailableAt: r.unavailable_at,
    installedAt: r.installed_at,
    updatedAt: r.updated_at
  }
}

/**
 * Discover + validate every skill folder under one source directory. A subdirectory with no
 * SKILL.md is silently skipped (not every folder is a skill); a folder whose name is not a safe
 * skill id (SKILL_ID_RE — the on-disk-name safety check) or whose SKILL.md fails validation is
 * recorded as an error and skipped. Duplicate declared ids within the same source keep the first
 * (deterministic readdir order) and record an error for the rest — they cannot both own
 * `"<source>:<id>"`. An absent/unreadable directory yields zero skills (graceful — app-skills/ is
 * empty on a fresh install). Pure-ish: reads disk only, no DB.
 */
export function discoverSkillsInDir(
  dir: string,
  source: SkillSource,
  opts: { limits?: SkillLimits } = {}
): DiscoveryResult {
  const skills: DiscoveredSkill[] = []
  const errors: string[] = []
  const limits = opts.limits ?? resolveSkillLimits()

  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return { skills, errors } // absent/unreadable dir → no skills (not an error)
  }

  const seenIds = new Map<string, string>() // declared id → folder it was first claimed by
  for (const folderName of entries) {
    const full = join(dir, folderName)
    if (!existsSync(join(full, 'SKILL.md'))) continue // not a skill package — skip quietly
    if (!SKILL_ID_RE.test(folderName)) {
      errors.push(`${source}-skills/${folderName}: folder name is not a valid skill id (skipped)`)
      continue
    }
    const parsed = parseSkillManifestFromDir(full, { limits })
    if (!parsed.ok || !parsed.manifest) {
      errors.push(`${source}-skills/${folderName}: ${parsed.errors.join('; ')}`)
      continue
    }
    const id = parsed.manifest.id
    const dup = seenIds.get(id)
    if (dup) {
      errors.push(`${source}-skills/${folderName}: duplicate skill id "${id}" (also in ${dup}); skipped`)
      continue
    }
    seenIds.set(id, folderName)
    skills.push({ source, folderName, manifest: parsed.manifest })
  }
  return { skills, errors }
}

/**
 * Reconcile the `skills` table against the two source folders (disk is truth, DS1). For every
 * discovered skill: insert a NEW row (app → enabled; user drop-in → DISABLED, DS19) or update an
 * EXISTING row's derived fields while PRESERVING its user state (enabled, warning_ack) and
 * clearing any stale unavailable flag. Any DB row whose folder is gone is MARKED UNAVAILABLE — the
 * row is left in place (a transiently-unmounted drive must not lose the user's enable choice or
 * the conversations/messages references), never blind-deleted. Idempotent: a second run over the
 * same disk changes nothing observable.
 */
export function reconcileSkills(db: Db, opts: ReconcileOptions): ReconcileResult {
  const now = (opts.now ?? (() => new Date().toISOString()))()
  const limits = opts.limits ?? resolveSkillLimits()

  // user-skills/ is the read-write area the app owns; create it so a drop-in has somewhere to
  // land. app-skills/ is read-only product content — never created here.
  try {
    mkdirSync(opts.userSkillsDir, { recursive: true })
  } catch {
    /* best-effort; discovery tolerates an absent dir */
  }

  const app = discoverSkillsInDir(opts.appSkillsDir, 'app', { limits })
  const user = discoverSkillsInDir(opts.userSkillsDir, 'user', { limits })
  const discovered = [...app.skills, ...user.skills]
  const errors = [...app.errors, ...user.errors]

  const present = new Set<string>()
  let inserted = 0
  let updated = 0

  const selectStmt = db.prepare('SELECT * FROM skills WHERE install_id = ?')
  for (const d of discovered) {
    const installId = skillInstallId(d.source, d.manifest.id)
    present.add(installId)
    const manifestJson = JSON.stringify(d.manifest)
    const existing = selectStmt.get(installId) as unknown as SkillRow | undefined

    if (!existing) {
      // New discovery. A drop-in had no import-time permission confirmation, so user skills
      // install DISABLED (DS19); app skills are trusted product content and install enabled.
      const enabled = d.source === 'app' ? 1 : 0
      const warningAck = d.source === 'app' ? 1 : 0
      db.prepare(
        `INSERT INTO skills (install_id, id, title, version, kind, source, path, enabled,
           warning_ack, trusted_level, manifest_json, unavailable_at, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      ).run(
        installId,
        d.manifest.id,
        d.manifest.title,
        d.manifest.version,
        d.manifest.kind,
        d.source,
        d.folderName,
        enabled,
        warningAck,
        d.source,
        manifestJson,
        now,
        now
      )
      inserted++
      continue
    }

    // Existing row: re-derive cached fields from disk, but PRESERVE user state (enabled,
    // warning_ack, installed_at). Only write — and bump updated_at — when something actually
    // changed (incl. clearing a stale unavailable flag), so reconcile stays idempotent.
    const changed =
      existing.title !== d.manifest.title ||
      existing.version !== d.manifest.version ||
      existing.kind !== d.manifest.kind ||
      existing.path !== d.folderName ||
      existing.manifest_json !== manifestJson ||
      existing.trusted_level !== d.source ||
      existing.source !== d.source ||
      existing.unavailable_at !== null
    if (changed) {
      db.prepare(
        `UPDATE skills SET title = ?, version = ?, kind = ?, source = ?, path = ?,
           trusted_level = ?, manifest_json = ?, unavailable_at = NULL, updated_at = ?
         WHERE install_id = ?`
      ).run(
        d.manifest.title,
        d.manifest.version,
        d.manifest.kind,
        d.source,
        d.folderName,
        d.source,
        manifestJson,
        now,
        installId
      )
      updated++
    }
  }

  // Anything in the DB that disk no longer has → mark unavailable (never delete).
  let markedUnavailable = 0
  const rows = db.prepare('SELECT install_id FROM skills').all() as Array<{ install_id: string }>
  for (const { install_id } of rows) {
    if (present.has(install_id)) continue
    if (markSkillUnavailable(db, install_id, now)) markedUnavailable++
  }

  // Safety net for the one-active-per-id invariant (DS12). The enable IPC + import already enforce
  // it, but a DB rebuild — or an app skill shipped AFTER a user skill of the same id was enabled —
  // could leave two AVAILABLE rows of one declared id enabled at once. Collapse to one here.
  enforceOneActivePerId(db, now)

  return { inserted, updated, markedUnavailable, present: present.size, errors }
}

/** A row considered for the one-active-per-id check. */
interface ActiveRow {
  install_id: string
  id: string
  source: string
  version: string
  updated_at: string
}

/** Higher MAJOR.MINOR.PATCH first (−1 ⇒ a before b). Both are SKILL_SEMVER_RE-valid; coerce defensively. */
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return y - x
  }
  return 0
}

/**
 * Enforce one active row per declared id across AVAILABLE rows (DS12). Among the enabled, available
 * rows sharing a declared id, keep the highest-precedence one — trust (app > user) → higher version
 * → most-recently updated → install_id — and disable the rest. Unavailable rows keep their enabled
 * flag (so a remounted drive restores the user's choice) and are never treated as "active". Returns
 * how many rows it disabled (0 in the common single-owner case — idempotent).
 */
function enforceOneActivePerId(db: Db, now: string): number {
  const rows = db
    .prepare(
      'SELECT install_id, id, source, version, updated_at FROM skills WHERE enabled = 1 AND unavailable_at IS NULL'
    )
    .all() as unknown as ActiveRow[]
  const byId = new Map<string, ActiveRow[]>()
  for (const r of rows) {
    const list = byId.get(r.id)
    if (list) list.push(r)
    else byId.set(r.id, [r])
  }
  let disabled = 0
  for (const list of byId.values()) {
    if (list.length <= 1) continue
    list.sort(
      (a, b) =>
        (a.source === 'app' ? 0 : 1) - (b.source === 'app' ? 0 : 1) ||
        compareVersionDesc(a.version, b.version) ||
        (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0) ||
        (a.install_id < b.install_id ? -1 : 1)
    )
    for (const loser of list.slice(1)) {
      if (setSkillEnabled(db, loser.install_id, false, now)) disabled++
    }
  }
  return disabled
}

/**
 * Mark a skill unavailable: its folder vanished, so the row is flagged (not deleted) and the
 * referencing conversations/messages keep pointing at a known-but-unavailable skill. A NEW helper
 * (there is no availability-flag op in collections.ts). Sets `unavailable_at` only on first
 * detection (idempotent). Returns true if it flipped an available row to unavailable.
 */
export function markSkillUnavailable(db: Db, installId: string, now = new Date().toISOString()): boolean {
  const res = db
    .prepare('UPDATE skills SET unavailable_at = ?, updated_at = ? WHERE install_id = ? AND unavailable_at IS NULL')
    .run(now, now, installId)
  return Number(res.changes) > 0
}

/** All skills, app first then by title (stable list order for the picker/Settings). */
export function listSkills(db: Db): SkillRecord[] {
  const rows = db
    .prepare("SELECT * FROM skills ORDER BY CASE source WHEN 'app' THEN 0 ELSE 1 END, title ASC")
    .all() as unknown as SkillRow[]
  return rows.map(rowToRecord)
}

export function getSkill(db: Db, installId: string): SkillRecord | null {
  const row = db.prepare('SELECT * FROM skills WHERE install_id = ?').get(installId) as unknown as
    | SkillRow
    | undefined
  return row ? rowToRecord(row) : null
}

/** Every installed skill declaring `id` (the DS12 duplicate-id lookup, app then user). */
export function getSkillsByDeclaredId(db: Db, id: string): SkillRecord[] {
  const rows = db
    .prepare("SELECT * FROM skills WHERE id = ? ORDER BY CASE source WHEN 'app' THEN 0 ELSE 1 END")
    .all(id) as unknown as SkillRow[]
  return rows.map(rowToRecord)
}

/** Flip a skill's enabled flag (persisted). Returns false if the install id is unknown. */
export function setSkillEnabled(db: Db, installId: string, enabled: boolean, now = new Date().toISOString()): boolean {
  const res = db
    .prepare('UPDATE skills SET enabled = ?, updated_at = ? WHERE install_id = ?')
    .run(enabled ? 1 : 0, now, installId)
  return Number(res.changes) > 0
}

// ---- registry handle (wired into AppContext.skills) ---------------------------------

/** The registry object carried on `AppContext.skills` — bundles the resolved dirs + a DB getter. */
export interface SkillRegistry {
  readonly appSkillsDir: string
  readonly userSkillsDir: string
  reconcile(): ReconcileResult
  list(): SkillRecord[]
  get(installId: string): SkillRecord | null
  setEnabled(installId: string, enabled: boolean): boolean
}

export interface SkillRegistryDeps {
  /** Returns the live workspace DB (throws while the vault is locked — callers guard). */
  getDb: () => Db
  appSkillsDir: string
  userSkillsDir: string
  limits?: SkillLimits
}

/** Build the registry handle (the `services/models.ts`/manager shape, deps injected for tests). */
export function createSkillRegistry(deps: SkillRegistryDeps): SkillRegistry {
  const { getDb, appSkillsDir, userSkillsDir, limits } = deps

  // Post-unlock lazy reconcile (the RATIFIED S3 guidance, implemented in S4). The startup
  // reconcile in main/index.ts no-ops while an encrypted DB is locked; rather than hook the
  // unlock critical path, the FIRST registry read after unlock reconciles disk→DB exactly once
  // per session. The flag is set only on a SUCCESSFUL reconcile, so a read attempted while still
  // locked (reconcile throws) simply retries on the next read. The S4 importer/deleter mutate
  // disk and call `reconcile()` explicitly, which also arms the flag.
  let reconciledThisSession = false
  const doReconcile = (): ReconcileResult => {
    const result = reconcileSkills(getDb(), { appSkillsDir, userSkillsDir, limits })
    reconciledThisSession = true
    return result
  }
  const ensureReconciled = (): void => {
    if (reconciledThisSession) return
    try {
      doReconcile()
    } catch {
      /* DB still locked — leave the flag unset so the next read tries again */
    }
  }

  return {
    appSkillsDir,
    userSkillsDir,
    reconcile: doReconcile,
    list: () => {
      ensureReconciled()
      return listSkills(getDb())
    },
    get: (installId) => {
      ensureReconciled()
      return getSkill(getDb(), installId)
    },
    setEnabled: (installId, enabled) => setSkillEnabled(getDb(), installId, enabled)
  }
}
