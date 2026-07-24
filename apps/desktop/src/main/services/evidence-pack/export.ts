import { randomUUID } from 'node:crypto'
import {
  open as openFileAsync,
  readFile as readFileAsync,
  rename as renameAsync,
  rm as rmAsync
} from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { EvidenceExportFormat, EvidenceExportRecord } from '../../../shared/types'
import { sha256Of } from '../assets'
import { getEvidenceReview, recordEvidenceExport } from '../evidence-reviews'
import type { Db } from '../db'
import { computeEvidenceReviewFreshness } from './freshness'
import {
  buildEvidencePackModel,
  resolveEvidencePackOptions,
  EVIDENCE_PACK_SCHEMA_VERSION
} from './pack-model'
import { renderEvidencePackHtml } from './render-html'

// Evidence-pack export pipeline (EP-1 plan §8.3 + §11, spec §20.1):
//   load persisted review → refresh freshness (P4 — the §20.1 step; stored-fact comparison
//   only, no re-hashing §21.2; refuses an OUTDATED review whose drift is unacknowledged,
//   §28.6) → resolve format + options → mint packId + generatedAt (pre-dialog, the P4
//   TOCTOU posture) → choose destination (both format filters offered; the extension
//   decides the EFFECTIVE format) → build model (freshness + format INJECTED — the model
//   stays pure) → render fixed template ONCE → [PDF only: print the SAME HTML via the
//   injected hidden-window harness, P6/D-1] → write tmp sibling → fsync → hash the
//   ON-DISK bytes → atomic rename → record `evidence_exports` row. Cancel renders nothing.
// No model runtime, no network, no re-retrieval anywhere on this path (spec FR-2/FR-12 —
// pinned by the no-model/no-network test assertions).
//
// CONCURRENCY (AUD-17): every transient file an export creates beside the destination — the
// PDF print source and the atomic writer's tmp sibling — is named from the export's own
// pack id (`printSourcePath` / `packTmpPath`), never from the destination alone. Two exports
// saving to the SAME path therefore share no file at all. They used to share both, and the
// collision was documented here as failing cleanly; it did not. The loser did not lose — both
// exports succeeded, and one wrote a file whose bytes belonged to the OTHER review while its
// `evidence_exports` row named its own, silently. That is provenance corruption of a
// signed-off artifact, so the shared resources were removed rather than contended on. What
// two same-destination exports still share is the DESTINATION itself: the later rename
// replaces the earlier file, exactly as any second save to one path does. That is the user's
// own instruction, and each row still records the hash of the bytes its own export wrote.
//
// Failure semantics (spec §20.2/§20.3/
// §28.9): any failure or cancel UP TO AND INCLUDING the rename leaves NO destination file
// and NO export row — the tmp sibling is removed best-effort, the rename is the single
// commit point for the file, and the row is written only AFTER the final file exists with
// its hash calculated. A failure AFTER the rename (the row cannot be written — workspace-DB
// error, or the review was deleted in another window while the save dialog was open)
// UNLINKS the just-created destination file to restore the invariant: the file is our own
// creation moments old, its own integrity section promises a recorded hash, and an
// unrecorded pack would make that printed promise false — worse than no file (rename onto
// an existing path had already replaced it, so keeping ours restores nothing either). Both
// post-rename outcomes throw DISTINCT named errors — `EvidencePackRecordError` (file
// removed, nothing recorded) / `EvidencePackUnrecordedFileError` (the unlink itself failed:
// the file EXISTS but is NOT in the export history) — which the IPC layer maps to honest
// localized copy; a real export is never reported as a user cancel. The destination PATH is
// never persisted and never audited (D-8/spec §18.1); only the bare file name enters
// `evidence_exports`. Audit stays at the IPC call site (the save-export precedent),
// carrying {reviewId, format} ONLY.

/** Post-rename record failure, file REMOVED: the pack could not be recorded in
 *  `evidence_exports`, so the freshly-written destination file was unlinked — nothing
 *  exists afterwards (the spec §28.9 invariant restored). Message is ids-only English;
 *  the IPC layer localizes. */
export class EvidencePackRecordError extends Error {}

/** Post-rename record failure AND the cleanup unlink failed: the destination file EXISTS
 *  but is NOT recorded — its hash is not on record and the pack's printed integrity note
 *  does not hold for it. Distinct so the user can be told exactly that. */
export class EvidencePackUnrecordedFileError extends Error {}

/** P4 (spec §28.6): the review is OUTDATED and the drift has not been acknowledged —
 *  export refuses BEFORE any dialog/file work. The renderer gates the button too; this is
 *  the authoritative main-side enforcement. The IPC layer localizes. */
export class EvidencePackOutdatedError extends Error {}

/** Injected seams: the native dialog AND the hidden-window PDF printer live at the IPC
 *  layer so this module stays electron-free and the atomic pipeline is testable against
 *  plain paths (the P6 print harness is `print-pdf.ts`). */
export interface EvidencePackExportDeps {
  /** Show the save-file UI for `suggestedFileName`; absolute destination path, or null on
   *  cancel. `format` is the REQUESTED format — the dialog offers both formats with the
   *  requested one first (its filter list is the format's UI voice on Windows/Linux). */
  chooseDestination: (
    suggestedFileName: string,
    format: EvidenceExportFormat
  ) => Promise<string | null>
  /**
   * Print the rendered pack HTML (fed UNCHANGED) to PDF bytes — the P6 hidden-window
   * harness (`printEvidencePackHtmlToPdf`). REQUIRED, not optional: the pipeline cannot
   * be wired without deciding PDF, so a missing printer can never silently degrade a
   * requested PDF into something else. Only called when the effective format is 'pdf'.
   * `sourceHtmlPath` is the transient print-source sibling this pipeline chose — unique per
   * export (`printSourcePath`), so concurrent prints share no file; the printer owns its
   * write→load→remove lifecycle.
   */
  renderPdf: (html: string, opts: { packId: string; sourceHtmlPath: string }) => Promise<Buffer>
  /** Pack-id mint (defaults to randomUUID) — injectable for deterministic goldens. */
  newPackId?: () => string
  /** Generation timestamp (defaults to now, ISO) — injectable for deterministic goldens. */
  now?: () => string
}

/** File extension per export format (P6: PDF joins HTML — plan §11). */
export const PACK_FILE_EXTENSION: Record<EvidenceExportFormat, string> = {
  html: '.html',
  pdf: '.pdf'
}

/**
 * Untrusted-boundary resolver for the renderer's requested export format (the
 * `resolveEvidencePackOptions` idiom, same wire object): 'pdf' only when literally 'pdf',
 * anything else — absent, malformed, unknown — reads as the established default 'html'.
 * Deliberately NOT part of `EvidencePackOptions`: the recorded format has its own
 * `evidence_exports.format` column, so it never enters `options_json` (the resolved
 * option set structurally excludes unknown keys).
 */
export function resolvePackExportFormat(raw: unknown): EvidenceExportFormat {
  return raw && typeof raw === 'object' && (raw as Record<string, unknown>).format === 'pdf'
    ? 'pdf'
    : 'html'
}

/**
 * The EFFECTIVE format for a chosen destination: the file's extension wins — `.pdf` ⇒
 * PDF, `.html`/`.htm` ⇒ HTML — falling back to the requested format when the extension
 * decides nothing. The save dialog offers BOTH filters (plan §11: "the export dialog
 * offers PDF and HTML"), so a user who flips the dialog's type dropdown genuinely gets
 * that format: file content, extension, and the recorded `format` row always agree — a
 * `.pdf` file can never contain HTML bytes.
 */
export function packFormatForDestination(
  destPath: string,
  requested: EvidenceExportFormat
): EvidenceExportFormat {
  const ext = extname(destPath).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.html' || ext === '.htm') return 'html'
  return requested
}

/** Filename-safe slug from the review title (the exportConversation idiom): letters,
 *  numbers, space, `_`, `-`; empty → the neutral fallback. The extension follows the
 *  requested format (P6). The title is CONTENT — it may end up in the user-chosen file
 *  name, which is exactly why the path/name never reaches audit or logs. */
export function suggestedPackFileName(title: string, format: EvidenceExportFormat): string {
  const safe = title
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .slice(0, 60)
  return `${safe.length > 0 ? safe : 'evidence-pack'}${PACK_FILE_EXTENSION[format]}`
}

/**
 * The per-export uniqueness token every transient sibling of the destination carries
 * (AUD-17). One helper, so the print source and the atomic writer's tmp file cannot drift
 * apart in how they are named or sanitised.
 *
 * It can never leak content: only the pack id's ALPHANUMERICS are used (a random UUID
 * reduces to its 32 hex characters), capped to that length so no id can grow the path
 * without bound, and an id that sanitises away entirely — only reachable through an injected
 * mint — falls back to a fresh random token instead of reaching the file system verbatim.
 */
function exportToken(packId: string): string {
  const token = packId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
  return token.length > 0 ? token : randomUUID().replace(/-/g, '')
}

/**
 * The transient print-source sibling for ONE export (AUD-17).
 *
 * This used to be a fixed `${destPath}.print.tmp.html`, derived from the DESTINATION alone —
 * so two exports running at the same time against the same destination wrote, loaded and
 * printed the SAME file. `loadFile` resolving is not the moment Chromium is finished with
 * the document: an overwrite that lands in a later main-process turn is picked up and
 * printed successfully. The loser therefore did not "fail cleanly": BOTH exports succeeded,
 * and one produced a file whose bytes were the other review's pack while the
 * `evidence_exports` row it recorded named its own review — silent provenance corruption of
 * a signed-off artifact. Removing the shared resource is preferable to contending on it, so
 * the name now carries the per-export token.
 *
 * The `.print.tmp.html` tail is unchanged: the `.html` extension is load-bearing for
 * file:// MIME sniffing, and crash residue stays recognisable as the same class the atomic
 * writer's tmp sibling belongs to.
 */
export function printSourcePath(destPath: string, packId: string): string {
  return `${destPath}.${exportToken(packId)}.print.tmp.html`
}

/**
 * The atomic writer's tmp sibling for ONE export (AUD-17, second seam).
 *
 * Same defect, same shape, one seam later: while the print source was shared, `${destPath}.tmp`
 * was too — and unlike the print source this one is on the path of EVERY export, HTML
 * included (an HTML export renders no print source at all, so the fix above cannot reach
 * it). Two concurrent exports to one destination raced inside `writePackFileAtomic`: the
 * second `open(tmp, 'w')` truncates the first's bytes, so the first can read back — and
 * hash, and rename onto the destination — content it never wrote. Its `evidence_exports`
 * row then names its own review while the recorded SHA-256 describes the other review's
 * pack, with no error on either side. Making the name unique per export removes the shared
 * resource instead of contending on it; nothing else about the write→fsync→hash→rename
 * sequence changes, and the sibling still lives in the destination's directory so the
 * rename stays same-volume and therefore atomic.
 */
export function packTmpPath(destPath: string, packId: string): string {
  return `${destPath}.${exportToken(packId)}.tmp`
}

/**
 * Write `content` to `destPath` ATOMICALLY (the workspace-vault descriptor idiom): tmp
 * sibling (same directory ⇒ same volume ⇒ atomic rename) → fsync → rename. Returns the
 * SHA-256 of the bytes READ BACK from disk after the fsync — the hash provably describes
 * the durable file, not the in-memory buffer. Any failure removes the tmp sibling
 * (best-effort) and rethrows; the destination is never left half-written. P6: a `Buffer`
 * (the printToPDF bytes) is written verbatim — the SAME tail serves both formats.
 *
 * `packId` names the tmp sibling (`packTmpPath`) and is REQUIRED for that reason — the
 * read-back hash is only trustworthy if nothing else can write the file between the fsync
 * and the read, and a destination-derived name did not give that (AUD-17).
 *
 * AUD-15 — ASYNC, on `fs.promises` (the same port the image-history store/open path took):
 * the contract is byte-for-byte the one above, but a multi-megabyte pack used to run its
 * write + fsync + full read-back on the SYNCHRONOUS fs API, and this runs on the Electron
 * MAIN thread — the whole process (every window, every IPC reply, the tray) stalled for the
 * duration of the tail, worst on the slow USB drives this app targets. Nothing about the
 * durability changed: the tmp sibling is still fsynced through its own handle BEFORE the
 * rename, and the recorded hash is still computed from the bytes read back OFF DISK, never
 * from the in-memory buffer. The handle is closed on EVERY path including failure (Windows
 * keeps a deleted-but-open file locked, which would defeat the cleanup below).
 *
 * Encoding note (string content): UTF-8 WITHOUT a BOM — deliberately unlike the
 * md/txt/csv exports (`bomFor`): the pack declares `<meta charset="utf-8">` in its first
 * bytes, every browser honors it, and a BOM would be one more byte class for hash
 * consumers to trip over.
 */
export async function writePackFileAtomic(
  destPath: string,
  content: string | Buffer,
  packId: string
): Promise<string> {
  const tmpPath = packTmpPath(destPath, packId)
  try {
    const fd = await openFileAsync(tmpPath, 'w')
    try {
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
      const { bytesWritten } = await fd.write(bytes, 0, bytes.length, null)
      // POSIX permits short writes; hashing a truncated file would produce a
      // self-consistent hash of the WRONG bytes — refuse instead.
      if (bytesWritten !== bytes.length) {
        throw new Error(`evidence export: short write (${bytesWritten}/${bytes.length} bytes)`)
      }
      await fd.sync()
    } finally {
      // Never `.catch(() => {})` here: an unclosed handle would keep the tmp sibling locked
      // on Windows and defeat the cleanup below. A close failure is a real failure.
      await fd.close()
    }
    const onDisk = await readFileAsync(tmpPath)
    const hash = sha256Of(onDisk)
    await renameAsync(tmpPath, destPath)
    return hash
  } catch (err) {
    try {
      await rmAsync(tmpPath, { force: true })
    } catch {
      /* best-effort cleanup — the original failure is the error that matters */
    }
    throw err
  }
}

/**
 * Run the full export (plan §8.3; PDF per §11/D-1). Returns the recorded export row, or
 * null when the review id is unknown or the user cancelled the destination dialog — in
 * both cases (and on any thrown failure up to the rename, INCLUDING a failed or killed
 * PDF print) NO file and NO row exist afterwards (spec §28.9). A post-rename record
 * failure unlinks the file and throws a distinct error (see the module header) — a null
 * return NEVER means "exported but unrecorded". Works on draft AND ready reviews: the
 * ready-state write-guard covers item/selection/link mutations only; recording an export
 * is not a review edit (P2 handoff, verified by test).
 *
 * Order (P4/P6 invariant, wire-pinned): freshness is computed ONCE, and the
 * outdated-unacknowledged refusal fires BEFORE any dialog or hidden-window work; the PDF
 * print runs AFTER the destination is chosen (no hidden window lives across the
 * unbounded dialog wait, and a cancel spins none up) and BEFORE the atomic write — both
 * formats share the identical tail from `writePackFileAtomic` on.
 */
export async function exportEvidencePackToFile(
  db: Db,
  reviewId: string,
  rawOptions: unknown,
  deps: EvidencePackExportDeps
): Promise<EvidenceExportRecord | null> {
  const detail = getEvidenceReview(db, reviewId)
  if (!detail) return null
  // P4 — the spec §20.1 "refresh source availability/freshness" step, IN the pipeline:
  // a comparison of stored facts only (no re-hashing, spec §21.2 — trivially cheap), so
  // every pack records availability AT EXPORT (§16.1.7) and every mismatch (§28.6/§28.7).
  // An outdated review exports ONLY after the drift was acknowledged (§28.6) — refused
  // here, before any dialog opens; a deleted/unverifiable source never blocks (§28.7),
  // it is represented as a limitation in the pack.
  const freshness = computeEvidenceReviewFreshness(db, reviewId)
  if (freshness?.outdated && !freshness.acknowledgedAt) {
    throw new EvidencePackOutdatedError(
      `evidence export: review is outdated and the change is not acknowledged (${reviewId})`
    )
  }
  const requestedFormat = resolvePackExportFormat(rawOptions)
  const options = resolveEvidencePackOptions(rawOptions)
  // PRE-dialog stamps — the P4 TOCTOU posture is preserved: the freshness verdict,
  // `packId` and `generatedAt` are all minted BEFORE the dialog opens (spec §20.1 order;
  // the pack's generation stamp is the pre-dialog check time, and its wording is
  // accurate for exactly that). The detail was loaded above, pre-dialog, likewise.
  const packId = deps.newPackId?.() ?? randomUUID()
  const generatedAt = deps.now?.() ?? new Date().toISOString()
  const destPath = await deps.chooseDestination(
    suggestedPackFileName(detail.title, requestedFormat),
    requestedFormat
  )
  if (!destPath) return null
  const format = packFormatForDestination(destPath, requestedFormat)
  // Build + render AFTER the destination decided the EFFECTIVE format (FIX-1): the ONE
  // format-dependent line (cover/integrity "Format") must state what the artifact IS —
  // a .pdf that self-describes as "Self-contained HTML" would be a false claim right
  // next to the hash note. Still ONE template rendered ONCE per export: 'html' packs are
  // byte-identical to before (goldens prove it), and the print harness receives this
  // render output UNCHANGED. A cancel above renders nothing at all.
  const model = buildEvidencePackModel(detail, options, { packId, generatedAt, format }, freshness)
  const html = renderEvidencePackHtml(model)
  const content =
    format === 'pdf'
      ? await deps.renderPdf(html, {
          packId: model.packId,
          // A SIBLING of the destination: the transient print source lives in the one
          // directory the user already sanctioned for this content (never an OS temp dir).
          // Named per EXPORT, not per destination — see `printSourcePath` (AUD-17).
          sourceHtmlPath: printSourcePath(destPath, model.packId)
        })
      : html
  const fileSha256 = await writePackFileAtomic(destPath, content, model.packId)
  // Row only AFTER the final file exists and is hashed (spec §20.3). Bare name only —
  // the directory may reveal private workstation structure (spec §18.1).
  let record: EvidenceExportRecord | null = null
  let recordFailure: unknown = null
  try {
    record = recordEvidenceExport(db, {
      reviewId,
      format,
      schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
      fileName: basename(destPath),
      fileSha256,
      // Spread: the resolved flags persist as a plain record (`options_json`, D-4). The
      // format is deliberately NOT among them — `evidence_exports.format` is its column.
      options: { ...options }
    })
  } catch (err) {
    recordFailure = err
  }
  if (record) return record
  // Post-rename record failure: thrown (workspace-DB error) or null (the review vanished
  // while the save dialog was open — the service's no-orphan-rows guard). Restore the
  // §28.9 invariant by unlinking our own moments-old creation; see the module header for
  // why keep-the-file loses either way. Never fall through to null — that reads as a
  // user cancel.
  const causeSuffix = recordFailure instanceof Error ? `: ${recordFailure.message}` : ''
  try {
    await rmAsync(destPath, { force: true })
  } catch {
    throw new EvidencePackUnrecordedFileError(
      `evidence export: pack written but not recorded, and cleanup failed — the destination file exists without an export-history record (${reviewId})${causeSuffix}`
    )
  }
  throw new EvidencePackRecordError(
    `evidence export: pack could not be recorded — the destination file was removed, nothing was exported (${reviewId})${causeSuffix}`
  )
}
