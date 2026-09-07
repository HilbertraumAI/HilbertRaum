// Shared download-job predicates. The Models screen and the main-process DownloadManager
// both have to decide "is this finished job still the user's problem?" — #314 gave the
// manager a `list()` that answers it, so the predicate lives HERE and the two can never
// drift apart (the renderer used to own a private copy).

import type { DownloadJob } from './types'

/**
 * A finished download the user still has to act on: it failed, or it completed but could not
 * be verified. These keep the Models screen's independent download panel (named, with Retry /
 * Dismiss) so a search, a task/family/view filter or a collapsed group cannot swallow the
 * outcome, and they are what `downloads:list` returns after a renderer reload (#314). A
 * VERIFIED `done` and a `cancelled` job need no panel — the model row carries their state.
 */
export function isUnresolvedDownloadResult(job: DownloadJob | null | undefined): boolean {
  return job != null && (job.status === 'failed' || (job.status === 'done' && job.unverified === true))
}
