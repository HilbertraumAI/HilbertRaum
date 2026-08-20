import { canonicalLeafFor, storedCopyLeaf } from '../../src/main/services/ingestion/stored-copy'

// Issue #190 — the PURE half of the stored-copy diagnostic: given the `documents` rows and a
// listing of `workspace/documents/`, decide what is stale, what is healable, what is genuinely
// missing, and which `.enc` files on disk have no owning row (the ORPHAN count left behind by the
// pre-#189 delete no-op). No fs, no crypto, no I/O — every fact this module needs is handed in,
// so CI can prove it against a synthetic vault with exact counts. The read-only collector that
// feeds it lives in `stored-copy-audit-run.ts`; the operator shell in
// `tests/manual/stored-copy-diagnostic.test.ts`.
//
// WHY THIS FILE EXISTS AT ALL: `docs/architecture.md` "Portable stored copies" §6 claimed a
// diagnostic "was written and smoke-tested against a synthetic vault". It was not — it lived in
// the git-excluded working paper and was deleted with it. Nothing matching it was ever committed.
// This is the rebuild, and the §6 correction lands with it.
//
// OUTPUT CONTRACT (the reason for the shape of every field below): the report is designed to be
// pasted into a PUBLIC GitHub issue. It therefore carries NO titles, NO content, NO user paths and
// NO file names — only counts, histograms, and "shape tokens" (an 8-char id prefix + an extension
// CLASS drawn from a closed allowlist + flag letters). `stored-copy-audit.test.ts` asserts that a
// report rendered from a vault full of distinctive secrets contains none of them.
//
// It reuses the shipped `canonicalLeafFor` rather than re-deriving "where would this document's
// bytes be" — the diagnostic's whole value is that its verdict is the app's verdict, so a
// divergence between the two would be the one bug that makes the numbers meaningless. That is
// worth the import graph `stored-copy.ts` drags in; nothing in it runs at import time.

/**
 * What a file in `workspace/documents/` is, by NAME alone.
 *
 * The distinction that matters is `stored-copy` vs everything else: only a `stored-copy` with no
 * owning row is an orphan, and the orphan count is what a future cleanup decision (issue #190
 * checkbox 2) would rest on. Mistaking a staged rekey file or an in-flight import transient for an
 * orphan is exactly the D4 race the wave-188 record refuses to build a sweep around — so the
 * classes below are ordered most-specific-first and the tests pin the ordering.
 */
export type FileClass =
  /** `<id><ext>[.enc]` — a document's workspace copy (or something shaped exactly like one). */
  | 'stored-copy'
  /** `*.parse*` — an ingest/preview/export/dictation/doc-task transient. Shredded by the sweep. */
  | 'parse-transient'
  /** `<file>.enc.new` — `stageRekey` staging for an in-flight or interrupted password change. */
  | 'rekey-staged'
  /** `*.tmp` — `encryptFile`'s atomic-write temp, incl. `.enc.tmp` / `.enc.new.tmp` / `.rekey.tmp`. */
  | 'write-temp'
  /** Anything else. Never counted as an orphan; reported so an unknown writer cannot hide. */
  | 'unknown'

/** One file in `workspace/documents/`, as the collector saw it. */
export interface AuditDirEntry {
  /** Bare leaf name. */
  name: string
  /** Size on disk in bytes. */
  bytes: number
}

/**
 * The `documents` columns the audit reads. Deliberately a narrow projection: `title`,
 * `error_message` and every `*_json` column can carry user content and are never selected.
 * `mime_type` is a class, not content, and is the only extension source a row keeps once its
 * stored copy is gone.
 */
export interface AuditRow {
  id: string
  status: string
  stored_path: string | null
  /**
   * `undefined` when the DB has no `stored_name` column at all — the reporting drive predates
   * #189 and the column is only added by `ensureColumn` at open, which the diagnostic must never
   * trigger. `null` means the column exists but this row has not been healed yet.
   */
  stored_name?: string | null
  original_path: string | null
  mime_type: string | null
}

/** At-rest artifacts that each mean an unclean last session or an interrupted password change. */
export interface AtRestFlags {
  /** `<db>.recovery` — a failed lock left the working file as the only fresh copy (CODE-1b). */
  recovery: boolean
  /** `<db>-wal` at rest — the last session did not check-point/close cleanly. */
  wal: boolean
  /** `<db>-shm` at rest — same. */
  shm: boolean
  /** `<db>.enc.new` — a password change was interrupted after staging the database. */
  dbRekeyStaged: boolean
}

export interface AuditInput {
  /** Every row of `documents`. */
  rows: readonly AuditRow[]
  /** Files (not directories) in `workspace/documents/`, leaf names + sizes. */
  dirEntries: readonly AuditDirEntry[]
  /**
   * The subset of recorded `stored_path` values that exist on disk EXACTLY as recorded. Handed
   * in rather than derived, because a legacy row can name a path OUTSIDE the store dir, which the
   * directory listing cannot answer. Keeps this module I/O-free.
   */
  existingRecordedPaths: readonly string[]
  /** Whether `PRAGMA table_info(documents)` lists `stored_name`. */
  storedNameColumn: boolean
  /** Vault descriptor version (1 = direct key, 2 = envelope), or null for `plaintext_dev`. */
  descriptorVersion: number | null
  atRest: AtRestFlags
}

/** Per-class file tally. */
export interface ClassTally {
  count: number
  bytes: number
}

export interface StoredCopyAuditReport {
  /** (1) Row counts. */
  documents: {
    total: number
    byStatus: Record<string, number>
  }
  rows: {
    /** (2) Rows whose recorded `stored_path` does not exist as recorded. */
    stale: number
    /** (3) Of the stale rows, how many resolve at the canonical location — the healable set. */
    healable: number
    /** Stale rows the canonical-leaf SAFETY guard refuses to name (`canonicalLeafFor` → null). */
    staleUnnameable: number
    /** (4) Rows that claim a stored copy but have none anywhere. */
    missingEverywhere: number
    /** Rows that never recorded a stored copy at all (queued / failed-before-copy). Not a defect. */
    neverStored: number
    /** Rows whose copy is where the row says it is. */
    resolvedAsRecorded: number
  }
  /** (5) `stored-copy`-shaped files in `workspace/documents/` claimed by no row. */
  orphans: {
    count: number
    bytes: number
    /** Shape tokens, one per orphan. */
    tokens: string[]
  }
  /** (6) File-class histogram over `workspace/documents/`. */
  fileClasses: Record<FileClass, ClassTally>
  /** (7) Extension-CLASS histogram over rows. Required: it is what settles the #190 contradiction. */
  extensions: Record<string, number>
  /** Rows whose extension class is audio — the leading hypothesis for "Vorschau works". */
  audioRows: number
  /** (8) `stored_name` adoption. */
  storedName: {
    column: boolean
    populated: number
  }
  /** (9) Vault descriptor version — decides the rekey blast radius. */
  vault: {
    descriptorVersion: number | null
    mode: 'encrypted' | 'plaintext_dev'
  }
  /** (10) Unclean-session / interrupted-password-change findings. */
  atRest: AtRestFlags
  /** Shape tokens, one per row. */
  rowTokens: string[]
}

// ---- extension classes -----------------------------------------------------------
//
// A CLOSED allowlist. An extension is normally harmless, but "the one .p7s on the drive" is
// identifying and this text is meant for a public issue — so anything off the list collapses to
// `other`. The list is exactly `MIME_BY_EXT` from `ingestion/index.ts` (what the app can import),
// which is also why it is complete enough to answer the audio question.

const EXT_CLASSES = [
  'txt',
  'md',
  'pdf',
  'docx',
  'csv',
  'wav',
  'mp3',
  'flac',
  'ogg',
  'png',
  'jpg'
] as const

/** Extension classes that are audio — the #190 contradiction hinges on this set. */
const AUDIO_CLASSES = new Set<string>(['wav', 'mp3', 'flac', 'ogg'])

const EXT_ALIASES: Record<string, string> = {
  text: 'txt',
  log: 'txt',
  markdown: 'md',
  mdown: 'md',
  tsv: 'csv',
  jpeg: 'jpg'
}

const MIME_TO_CLASS: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/csv': 'csv',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'image/png': 'png',
  'image/jpeg': 'jpg'
}

const allowed = new Set<string>(EXT_CLASSES)

function normalizeExt(raw: string): string {
  const lower = raw.replace(/^\./, '').toLowerCase()
  const aliased = EXT_ALIASES[lower] ?? lower
  return allowed.has(aliased) ? aliased : 'other'
}

/**
 * Extension class of a stored-copy leaf: strip a trailing `.enc`, strip the `<id>` prefix when the
 * name carries one, and classify what is left. Returns null when the leaf has no extension at all.
 */
function extClassFromLeaf(leaf: string, id?: string): string | null {
  let name = leaf
  if (name.toLowerCase().endsWith('.enc')) name = name.slice(0, -4)
  if (id && name.startsWith(id)) name = name.slice(id.length)
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return null
  return normalizeExt(name.slice(dot + 1))
}

/**
 * Extension class of a ROW. The stored-copy leaf is preferred (it is what the bytes on disk are
 * actually called); `mime_type` is the fallback that keeps the histogram complete for a row whose
 * copy is gone. `none` when neither says anything.
 */
export function extClassOf(row: AuditRow): string {
  const leaf = row.stored_name ?? (row.stored_path ? storedCopyLeaf(row.stored_path) : null)
  if (leaf) {
    const fromLeaf = extClassFromLeaf(leaf, row.id)
    if (fromLeaf) return fromLeaf
  }
  if (row.mime_type) {
    const fromMime = MIME_TO_CLASS[row.mime_type.toLowerCase()]
    if (fromMime) return fromMime
    return 'other'
  }
  return 'none'
}

// ---- file classification ---------------------------------------------------------

/** A leading RFC-4122-shaped id, which is what every writer into the store dir prefixes with. */
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * Classify one file in `workspace/documents/` by name.
 *
 * ORDER IS LOAD-BEARING and the tests pin it. The full set of writers into this directory:
 *   • ingest re-index            `<id>.parse<ext>`
 *   • preview / export           `<id>.parse-preview-<uuid><ext>`, `<id>.parse-export[-bin]-<uuid><ext>`
 *   • dictation                  `<uuid>.parse-dictation.wav`
 *   • transcription              `<uuid>.parse-transcript*`
 *   • doc tasks                  `<jobId>.parse.md`, `<id>.parse-ocr.pdf`
 *   • `encryptFile`              `<dest>.tmp`  (so `<id><ext>.enc.tmp`, `<id><ext>.enc.new.tmp`)
 *   • `stageRekey`               `<id><ext>.enc.new`, and `<id><ext>.enc.rekey.tmp` in between
 *   • the stored copy itself     `<id><ext>.enc` (encrypted) or `<id><ext>` (plaintext_dev)
 *
 * A `.enc.new` is a LIVE staged rekey of a LIVE document. Classifying it as a stored copy would
 * park it in the orphan bucket and hand a future cleanup a file whose deletion loses the user's
 * data mid-password-change. `.parse` is checked first because a transient can end in `.enc`-ish
 * shapes, and `.tmp` before `.enc` for the same reason.
 */
export function classifyFile(name: string): FileClass {
  const lower = name.toLowerCase()
  if (lower.includes('.parse')) return 'parse-transient'
  if (lower.endsWith('.enc.new')) return 'rekey-staged'
  if (lower.endsWith('.tmp')) return 'write-temp'
  if (lower.endsWith('.enc')) return 'stored-copy'
  // plaintext_dev workspaces store `<id><ext>` with no suffix at all; an id-shaped prefix is the
  // only thing that separates such a copy from a stray file somebody dropped in the directory.
  if (UUID_PREFIX.test(name)) return 'stored-copy'
  return 'unknown'
}

// ---- shape tokens ----------------------------------------------------------------

/** First 8 characters of an id — enough to correlate two lines of the report, useless alone. */
function idPrefix(id: string): string {
  return id.slice(0, 8).toLowerCase()
}

/**
 * Row flags:
 *   E  the stored copy rests encrypted (`.enc` leaf)
 *   N  `stored_name` is populated (the row has been healed, or was written post-#189)
 *   O  an `original_path` is recorded
 *   P  the copy is exactly where the row says it is
 *   S  STALE — the recorded `stored_path` does not exist as recorded
 *   H  HEALABLE — a stale row whose copy is at the canonical location
 *   M  MISSING — the row claims a copy and there is none anywhere
 *   X  the canonical-leaf safety guard refuses this row's name (`canonicalLeafFor` → null)
 *   -  the row never recorded a stored copy (queued / failed before the copy was made)
 */
function rowFlags(f: {
  encrypted: boolean
  storedName: boolean
  original: boolean
  present: boolean
  stale: boolean
  healable: boolean
  missing: boolean
  unnameable: boolean
  neverStored: boolean
}): string {
  let s = ''
  if (f.neverStored) s += '-'
  if (f.encrypted) s += 'E'
  if (f.storedName) s += 'N'
  if (f.original) s += 'O'
  if (f.present) s += 'P'
  if (f.stale) s += 'S'
  if (f.healable) s += 'H'
  if (f.missing) s += 'M'
  if (f.unnameable) s += 'X'
  return s === '' ? '.' : s
}

/** Coarse size bucket for an orphan — an exact byte count of one file is more identifying. */
function sizeBucket(bytes: number): string {
  if (bytes < 64 * 1024) return '<64K'
  if (bytes < 1024 * 1024) return '<1M'
  if (bytes < 8 * 1024 * 1024) return '<8M'
  if (bytes < 64 * 1024 * 1024) return '<64M'
  return '>=64M'
}

// ---- the audit -------------------------------------------------------------------

function emptyClasses(): Record<FileClass, ClassTally> {
  return {
    'stored-copy': { count: 0, bytes: 0 },
    'parse-transient': { count: 0, bytes: 0 },
    'rekey-staged': { count: 0, bytes: 0 },
    'write-temp': { count: 0, bytes: 0 },
    unknown: { count: 0, bytes: 0 }
  }
}

/**
 * Classify a whole workspace. Pure: same input, same report, no clock and no randomness — the
 * report is stable enough to diff between two runs of the same drive.
 */
export function auditStoredCopies(input: AuditInput): StoredCopyAuditReport {
  const present = new Set(input.existingRecordedPaths)
  const onDisk = new Set(input.dirEntries.map((e) => e.name))

  // Every leaf any row could be referring to. DELIBERATELY GENEROUS: a name claimed by a row is
  // never an orphan, so all three sources count — the healed `stored_name`, the leaf of the
  // recorded `stored_path` (which the safety guard may refuse, but a refused name is still
  // evidence that a row is about that file), and the canonical leaf. Over-claiming produces an
  // UNDER-count of orphans; under-claiming produces a false orphan, and a false orphan is the one
  // that could get a live document deleted.
  const claimed = new Set<string>()
  for (const row of input.rows) {
    if (row.stored_name) claimed.add(row.stored_name)
    if (row.stored_path) claimed.add(storedCopyLeaf(row.stored_path))
    const canonical = canonicalLeafFor(row)
    if (canonical) claimed.add(canonical)
  }
  // The fourth, and the one that closes the false-orphan hole the first three leave open: a row
  // whose recorded strings are corrupt or unnameable (`canonicalLeafFor` → null) names NOTHING, so
  // its perfectly healthy `<id><ext>.enc` on disk would be reported as an orphan. But the store's
  // naming is `<documentId><ext>[.enc]` and the id is a never-reused UUID primary key — so a file
  // whose LEADING id is a live row's id belongs to that row, whatever the row happens to have
  // recorded. Found by the first end-to-end operator smoke, where a deliberately mangled
  // `stored_path` turned a live document into a phantom orphan.
  const rowIds = new Set(input.rows.map((r) => r.id.toLowerCase()))

  const byStatus: Record<string, number> = {}
  const extensions: Record<string, number> = {}
  const rowTokens: string[] = []
  let stale = 0
  let healable = 0
  let staleUnnameable = 0
  let missingEverywhere = 0
  let neverStored = 0
  let resolvedAsRecorded = 0
  let storedNamePopulated = 0
  let audioRows = 0

  for (const row of input.rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    const cls = extClassOf(row)
    extensions[cls] = (extensions[cls] ?? 0) + 1
    if (AUDIO_CLASSES.has(cls)) audioRows++
    if (row.stored_name) storedNamePopulated++

    const claimsCopy = Boolean(row.stored_path) || Boolean(row.stored_name)
    const recordedPresent = Boolean(row.stored_path) && present.has(row.stored_path as string)
    const canonical = canonicalLeafFor(row)
    const canonicalPresent = canonical !== null && onDisk.has(canonical)

    // "Stale" is strictly about the RECORDED string: a row that names a path which is not there.
    // A row with no `stored_path` at all cannot be stale — it never recorded one.
    const isStale = Boolean(row.stored_path) && !recordedPresent
    const isHealable = isStale && canonicalPresent
    const isUnnameable = isStale && canonical === null
    const isMissing = claimsCopy && !recordedPresent && !canonicalPresent
    const isNeverStored = !claimsCopy

    if (isStale) stale++
    if (isHealable) healable++
    if (isUnnameable) staleUnnameable++
    if (isMissing) missingEverywhere++
    if (isNeverStored) neverStored++
    if (recordedPresent) resolvedAsRecorded++

    const leafForEnc = row.stored_name ?? (row.stored_path ? storedCopyLeaf(row.stored_path) : '')
    rowTokens.push(
      `${idPrefix(row.id)} ${cls} ${rowFlags({
        encrypted: leafForEnc.toLowerCase().endsWith('.enc'),
        storedName: Boolean(row.stored_name),
        original: Boolean(row.original_path),
        present: recordedPresent || canonicalPresent,
        stale: isStale,
        healable: isHealable,
        missing: isMissing,
        unnameable: isUnnameable,
        neverStored: isNeverStored
      })}`
    )
  }

  const fileClasses = emptyClasses()
  const orphanTokens: string[] = []
  let orphanCount = 0
  let orphanBytes = 0

  for (const entry of input.dirEntries) {
    const cls = classifyFile(entry.name)
    fileClasses[cls].count++
    fileClasses[cls].bytes += entry.bytes
    if (cls !== 'stored-copy') continue
    if (claimed.has(entry.name)) continue
    const prefixMatch = UUID_PREFIX.exec(entry.name)
    if (prefixMatch && rowIds.has(prefixMatch[0].toLowerCase())) continue // owned by id
    orphanCount++
    orphanBytes += entry.bytes
    const prefix = prefixMatch ? idPrefix(prefixMatch[0]) : '????????'
    const ext = extClassFromLeaf(entry.name) ?? 'none'
    orphanTokens.push(`${prefix} ${ext} ${sizeBucket(entry.bytes)}`)
  }

  return {
    documents: { total: input.rows.length, byStatus },
    rows: {
      stale,
      healable,
      staleUnnameable,
      missingEverywhere,
      neverStored,
      resolvedAsRecorded
    },
    orphans: { count: orphanCount, bytes: orphanBytes, tokens: orphanTokens.sort() },
    fileClasses,
    extensions,
    audioRows,
    storedName: { column: input.storedNameColumn, populated: storedNamePopulated },
    vault: {
      descriptorVersion: input.descriptorVersion,
      mode: input.descriptorVersion === null ? 'plaintext_dev' : 'encrypted'
    },
    atRest: input.atRest,
    rowTokens: rowTokens.sort()
  }
}

// ---- rendering -------------------------------------------------------------------

function histogram(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([k, v]) => `    ${k.padEnd(16)} ${String(v)}`)
}

/** Human size. Small totals render in KiB so a real finding never prints as "0.0 MiB". */
function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

/**
 * Render the report as the text an operator pastes into issue #190.
 *
 * Everything printed comes from `StoredCopyAuditReport` — counts, class names from the two closed
 * allowlists, and shape tokens. No caller-supplied string reaches this function, which is what
 * makes "safe to paste in public" a property of the code rather than of the operator's care.
 */
export function formatStoredCopyAuditReport(report: StoredCopyAuditReport): string {
  const L: string[] = []
  L.push('HilbertRaum stored-copy audit (issue #190) — read-only, no titles, no content, no paths')
  L.push('')
  L.push(`workspace mode          ${report.vault.mode}`)
  L.push(
    `vault descriptor        ${report.vault.descriptorVersion === null ? 'n/a' : `v${String(report.vault.descriptorVersion)}`}`
  )
  L.push(`stored_name column      ${report.storedName.column ? 'present' : 'ABSENT (pre-#189 schema)'}`)
  L.push(
    `stored_name populated   ${String(report.storedName.populated)} / ${String(report.documents.total)}`
  )
  L.push('')
  L.push(`(1) documents rows      ${String(report.documents.total)}`)
  L.push(...histogram(report.documents.byStatus))
  L.push('')
  L.push(`(2) stale stored_path   ${String(report.rows.stale)}   (recorded path not present as recorded)`)
  L.push(`(3)   of those healable ${String(report.rows.healable)}   (copy IS at the canonical location)`)
  L.push(`      of those unnamed  ${String(report.rows.staleUnnameable)}   (safety guard refuses the leaf)`)
  L.push(`(4) no copy anywhere    ${String(report.rows.missingEverywhere)}`)
  L.push(`    never stored a copy ${String(report.rows.neverStored)}   (queued / failed before the copy)`)
  L.push(`    resolved as recorded ${String(report.rows.resolvedAsRecorded)}`)
  L.push('')
  L.push(
    `(5) ORPHAN .enc files   ${String(report.orphans.count)}   ${size(report.orphans.bytes)} unreferenced`
  )
  for (const t of report.orphans.tokens) L.push(`    ${t}`)
  if (report.rows.staleUnnameable > 0) {
    L.push(
      `    NOTE: ${String(report.rows.staleUnnameable)} row(s) record a leaf the safety guard refuses; ` +
        'their copies are attributed by id, not by name.'
    )
  }
  L.push('')
  L.push('(6) file classes in workspace/documents/')
  for (const [k, v] of Object.entries(report.fileClasses)) {
    L.push(`    ${k.padEnd(16)} ${String(v.count).padStart(5)}  ${size(v.bytes)}`)
  }
  L.push('')
  L.push('(7) extension classes over rows')
  L.push(...histogram(report.extensions))
  L.push(`    -> audio rows    ${String(report.audioRows)}   (#190 checkbox 3 hypothesis)`)
  L.push('')
  L.push('(10) at rest')
  L.push(`    .recovery        ${report.atRest.recovery ? 'PRESENT — a lock failed' : 'no'}`)
  L.push(`    -wal             ${report.atRest.wal ? 'PRESENT — unclean last session' : 'no'}`)
  L.push(`    -shm             ${report.atRest.shm ? 'PRESENT — unclean last session' : 'no'}`)
  L.push(
    `    db .enc.new      ${report.atRest.dbRekeyStaged ? 'PRESENT — interrupted password change' : 'no'}`
  )
  L.push('')
  L.push('row shape tokens  <id8> <ext-class> <flags>')
  L.push('  flags: E encrypted  N stored_name set  O original_path set  P copy found')
  L.push('         S stale  H healable  M missing everywhere  X leaf refused by the guard')
  L.push('         - never stored a copy   . none of the above')
  for (const t of report.rowTokens) L.push(`  ${t}`)
  L.push('')
  L.push('orphan shape tokens  <id8> <ext-class> <size-bucket>')
  L.push('')
  return L.join('\n')
}
