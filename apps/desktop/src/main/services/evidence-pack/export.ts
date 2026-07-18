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
// §28.9): any failure or cancel leaves NO destination file and NO export row — the tmp
// sibling is removed best-effort, the rename is the single commit point for the file, and
// the row is written only AFTER the final file exists with its hash calculated. The
// destination PATH is never persisted and never audited (D-8/spec §18.1); only the bare
// file name enters `evidence_exports`. Audit stays at the IPC call site (the save-export
// precedent), carrying {reviewId, format} ONLY.

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
      writeSync(fd, Buffer.from(content, 'utf8'))
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
 * on any thrown failure) NO file and NO row exist afterwards (spec §28.9). Works on draft
 * AND ready reviews: the ready-state write-guard covers item/selection/link mutations
 * only; recording an export is not a review edit (P2 handoff, verified by test).
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
  return recordEvidenceExport(db, {
    reviewId,
    format: 'html',
    schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
    fileName: basename(destPath),
    fileSha256,
    // Spread: the resolved flags persist as a plain record (`options_json`, D-4).
    options: { ...options }
  })
}
