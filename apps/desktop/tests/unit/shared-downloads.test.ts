import { describe, it, expect } from 'vitest'
import { isUnresolvedDownloadResult } from '../../src/shared/downloads'
import type { DownloadJob, DownloadJobStatus } from '../../src/shared/types'

// #314: the ONE predicate the Models screen's result panel and the main-process
// `DownloadManager.list()` both use to decide "is this finished job still the user's
// problem?". The truth table below is the contract both sides depend on.

function job(status: DownloadJobStatus, unverified = false): DownloadJob {
  return {
    jobId: `job-${status}-${unverified}`,
    modelId: 'test-model-q4',
    status,
    receivedBytes: 10,
    totalBytes: 100,
    unverified,
    error: status === 'failed' ? 'disk full' : null
  }
}

describe('isUnresolvedDownloadResult (#314)', () => {
  it.each([
    ['failed', false, true],
    ['failed', true, true],
    ['done', true, true],
    ['done', false, false],
    ['cancelled', false, false],
    ['cancelled', true, false],
    ['queued', false, false],
    ['downloading', false, false],
    ['verifying', false, false]
  ] as Array<[DownloadJobStatus, boolean, boolean]>)(
    'a %s job with unverified=%s is unresolved: %s',
    (status, unverified, expected) => {
      expect(isUnresolvedDownloadResult(job(status, unverified))).toBe(expected)
    }
  )

  it('treats no job at all as resolved (null and undefined)', () => {
    expect(isUnresolvedDownloadResult(null)).toBe(false)
    expect(isUnresolvedDownloadResult(undefined)).toBe(false)
  })

  it('needs unverified to be exactly true — a missing flag never keeps a done job open', () => {
    const partial = { ...job('done'), unverified: undefined } as unknown as DownloadJob
    expect(isUnresolvedDownloadResult(partial)).toBe(false)
  })
})
