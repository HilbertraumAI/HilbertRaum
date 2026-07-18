import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename } from 'node:path'
import type { EvidenceExportRecord } from '../../../shared/types'
import { sha256Of } from '../assets'
import { getEvidenceReview, recordEvidenceExport } from '../evidence-reviews'
import type { Db } from '../db'
import {
  buildEvidencePackModel,
  resolveEvidencePackOptions,
  EVIDENCE_PACK_SCHEMA_VERSION
} from './pack-model'
import { renderEvidencePackHtml } from './render-html'

// Evidence-pack export pipeline (EP-1 plan §8.3, spec §20.1):
//   load persisted review → resolve options → build model → render fixed template →
//   choose destination → write tmp sibling → fsync → hash the ON-DISK bytes → atomic
//   rename → record `evidence_exports` row.
// No model runtime, no network, no re-retrieval anywhere on this path (spec FR-2/FR-12 —
// pinned by the no-model/no-network test assertions). Failure semantics (spec §20.2/§20.3/
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

/** Injected seams: the native dialog lives at the IPC layer so this module stays
 *  electron-free and the atomic pipeline is testable against plain paths. */
export interface EvidencePackExportDeps {
  /** Show the save-file UI for `suggestedFileName`; absolute destination path, or null on
   *  cancel. */
  chooseDestination: (suggestedFileName: string) => Promise<string | null>
  /** Pack-id mint (defaults to randomUUID) — injectable for deterministic goldens. */
  newPackId?: () => string
  /** Generation timestamp (defaults to now, ISO) — injectable for deterministic goldens. */
  now?: () => string
}

/** Filename-safe slug from the review title (the exportConversation idiom): letters,
 *  numbers, space, `_`, `-`; empty → the neutral fallback. The title is CONTENT — it may
 *  end up in the user-chosen file name, which is exactly why the path/name never reaches
 *  audit or logs. */
export function suggestedPackFileName(title: string): string {
  const safe = title
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .slice(0, 60)
  return `${safe.length > 0 ? safe : 'evidence-pack'}.html`
}

/**
 * Write `content` to `destPath` ATOMICALLY (the workspace-vault descriptor idiom): tmp
 * sibling (same directory ⇒ same volume ⇒ atomic rename) → fsync → rename. Returns the
 * SHA-256 of the bytes READ BACK from disk after the fsync — the hash provably describes
 * the durable file, not the in-memory buffer. Any failure removes the tmp sibling
 * (best-effort) and rethrows; the destination is never left half-written.
 *
 * Encoding note: UTF-8 WITHOUT a BOM — deliberately unlike the md/txt/csv exports
 * (`bomFor`): the pack declares `<meta charset="utf-8">` in its first bytes, every browser
 * honors it, and a BOM would be one more byte class for hash consumers to trip over.
 */
export function writePackFileAtomic(destPath: string, content: string): string {
  const tmpPath = `${destPath}.tmp`
  try {
    const fd = openSync(tmpPath, 'w')
    try {
      const bytes = Buffer.from(content, 'utf8')
      const written = writeSync(fd, bytes)
      // POSIX permits short writes; hashing a truncated file would produce a
      // self-consistent hash of the WRONG bytes — refuse instead.
      if (written !== bytes.length) {
        throw new Error(`evidence export: short write (${written}/${bytes.length} bytes)`)
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const onDisk = readFileSync(tmpPath)
    const hash = sha256Of(onDisk)
    renameSync(tmpPath, destPath)
    return hash
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      /* best-effort cleanup — the original failure is the error that matters */
    }
    throw err
  }
}

/**
 * Run the full export (plan §8.3). Returns the recorded export row, or null when the
 * review id is unknown or the user cancelled the destination dialog — in both cases (and
 * on any thrown failure up to the rename) NO file and NO row exist afterwards (spec
 * §28.9). A post-rename record failure unlinks the file and throws a distinct error (see
 * the module header) — a null return NEVER means "exported but unrecorded". Works on
 * draft AND ready reviews: the ready-state write-guard covers item/selection/link
 * mutations only; recording an export is not a review edit (P2 handoff, verified by test).
 */
export async function exportEvidencePackToFile(
  db: Db,
  reviewId: string,
  rawOptions: unknown,
  deps: EvidencePackExportDeps
): Promise<EvidenceExportRecord | null> {
  const detail = getEvidenceReview(db, reviewId)
  if (!detail) return null
  const options = resolveEvidencePackOptions(rawOptions)
  const model = buildEvidencePackModel(detail, options, {
    packId: deps.newPackId?.() ?? randomUUID(),
    generatedAt: deps.now?.() ?? new Date().toISOString()
  })
  const html = renderEvidencePackHtml(model)
  const destPath = await deps.chooseDestination(suggestedPackFileName(detail.title))
  if (!destPath) return null
  const fileSha256 = writePackFileAtomic(destPath, html)
  // Row only AFTER the final file exists and is hashed (spec §20.3). Bare name only —
  // the directory may reveal private workstation structure (spec §18.1).
  let record: EvidenceExportRecord | null = null
  let recordFailure: unknown = null
  try {
    record = recordEvidenceExport(db, {
      reviewId,
      format: 'html',
      schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
      fileName: basename(destPath),
      fileSha256,
      // Spread: the resolved flags persist as a plain record (`options_json`, D-4).
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
    rmSync(destPath, { force: true })
  } catch {
    throw new EvidencePackUnrecordedFileError(
      `evidence export: pack written but not recorded, and cleanup failed — the destination file exists without an export-history record (${reviewId})${causeSuffix}`
    )
  }
  throw new EvidencePackRecordError(
    `evidence export: pack could not be recorded — the destination file was removed, nothing was exported (${reviewId})${causeSuffix}`
  )
}
