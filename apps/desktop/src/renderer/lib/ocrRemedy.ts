import type { DocumentInfo } from '@shared/types'
import { displayMapKey } from './displayMap'

/**
 * Which in-app OCR remedy a row needs (#410), or null: a FAILED detected scan (`'scan'` — the
 * "Make searchable" path) or a FAILED photo whose stored error is the canonical
 * `main.ingest.imageNeedsOcr` (`'photo'` — "Try again" after the download). Matched through the
 * display map's canonical-English lookup; the stored text itself is never changed. Shared by
 * Documents and the Chat attach pointer (#570), which must read the flag, never its own stored
 * (localized) banner text.
 */
export function ocrRemedyKind(
  d: Pick<DocumentInfo, 'status' | 'scanDetected' | 'errorMessage'>
): 'scan' | 'photo' | null {
  if (d.status !== 'failed') return null
  if (d.scanDetected) return 'scan'
  return displayMapKey(d.errorMessage) === 'main.ingest.imageNeedsOcr' ? 'photo' : null
}
