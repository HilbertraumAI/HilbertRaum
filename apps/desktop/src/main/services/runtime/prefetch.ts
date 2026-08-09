import { open } from 'node:fs/promises'

// Concurrent sequential prefetch of the model weights (issue #114). llama-server's mmap
// load faults pages in its own non-sequential order, which slow removable media punishes
// (#107: ~2/3 of a stick's sequential throughput; far worse under memory pressure, where
// the measured cold load ran at 2.4× the pure-sequential time). A plain sequential read
// of the same file(s), running ALONGSIDE the load, primes the OS page cache at full media
// speed. The #114 on-hardware matrix (16 GB box, cold cache) measured: −49% cold start on
// a 23.5 MB/s stick (6.65 GB model: 680 s → 346 s), −36% on an 868 MB/s USB SSD
// (15.0 s → 9.6 s), and ~neutral everywhere else — the reader is either ahead of the load
// (its pages are cache hits) or starved by it (no added IO pressure), so it can never
// materially lose. The read data is DISCARDED — only the page-cache side effect matters.
// (`--no-mmap` was measured and rejected: fastest cold on the stick but it forfeits the
// page cache entirely — 292 s warm restarts vs 5 s, and the worst variant in every SSD
// cell. Full evidence: issue #114.)

/** 4 MiB: large enough to saturate sequential media, small enough that an abort
 *  (stop/lock — CODE-2) lands within one chunk (~half a second at USB-2 speeds). */
export const PREFETCH_CHUNK_BYTES = 4 * 1024 * 1024

export type PrefetchOutcome = 'done' | 'aborted' | 'failed'

export interface ModelPrefetch {
  /** Settles when every file is read to EOF ('done'), the prefetch is aborted, or a read
   *  fails. Never rejects — the prefetch is a best-effort accelerator, never a start
   *  dependency: a failure means the load simply proceeds unassisted. */
  done: Promise<PrefetchOutcome>
  /** Stop reading promptly (the load window ended, or a CODE-2 stop/lock cancel).
   *  Idempotent; `done` then settles 'aborted' unless it already settled. */
  abort: () => void
}

/**
 * Read `paths` sequentially, front to back, discarding the bytes. One reusable buffer,
 * plain positional reads — no readahead hints, no fs.createReadStream backpressure
 * machinery; the OS page cache is the only consumer.
 */
export function startModelPrefetch(paths: string[]): ModelPrefetch {
  let aborted = false
  const done = (async (): Promise<PrefetchOutcome> => {
    try {
      const buf = Buffer.allocUnsafe(PREFETCH_CHUNK_BYTES)
      for (const path of paths) {
        if (aborted) return 'aborted'
        const handle = await open(path, 'r')
        try {
          let pos = 0
          for (;;) {
            if (aborted) return 'aborted'
            const { bytesRead } = await handle.read(buf, 0, PREFETCH_CHUNK_BYTES, pos)
            if (bytesRead <= 0) break
            pos += bytesRead
          }
        } finally {
          await handle.close().catch(() => undefined)
        }
      }
      return aborted ? 'aborted' : 'done'
    } catch {
      return aborted ? 'aborted' : 'failed'
    }
  })()
  return {
    done,
    abort: () => {
      aborted = true
    }
  }
}
