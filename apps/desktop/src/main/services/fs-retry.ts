import { rename } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

// A rename that Windows refuses for a moment (#986). An antivirus scan of a file it just saw being
// written, the search indexer or a backup tool holds a handle in the folder, and while it does Windows
// answers a folder rename with EPERM, EACCES or EBUSY (measured on NTFS: a file open in the folder or in
// a sub-folder → EPERM; a process whose working folder is inside → EBUSY). The holder lets go within
// seconds, so the rename is tried again for a bounded time instead of failing the operation. On macOS
// and Linux these codes mean a real permission or mount problem that waiting does not change, so
// there the first refusal stands. Shared by the engine swap (`runtime-download.ts`); the app-update
// plan's file moves (W-5) are meant to reuse it.

/** The codes a held handle on Windows produces; any other error is final at once. */
const HELD_HANDLE_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * The total wait across the retries of ONE rename, about 12 s. A scan of a freshly written file ends
 * well within it. An engine install step makes several renames (the archive's move, the flatten, the
 * swap's two, a move back, the `cpu/` carry), so its worst case is several of these budgets on top of
 * the extractor's 5-minute deadline, and can outlast the spawn gate's 6-minute bound: a spawn that
 * waited that long goes ahead, which since #986 meets a complete copy (`runtime/spawn-gate.ts`).
 */
export const RENAME_RETRY_BUDGET_MS = 12_000
const FIRST_WAIT_MS = 50
const LONGEST_WAIT_MS = 1_000

/** Would another attempt at this rename have a chance: a held handle on Windows. */
export function renameMayClear(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return platform === 'win32' && typeof code === 'string' && HELD_HANDLE_CODES.has(code)
}

/**
 * `rename(from, to)`, tried again while Windows reports a held handle: waits of 50 ms doubling to 1 s,
 * until the next wait would pass {@link RENAME_RETRY_BUDGET_MS}; then the last refusal is thrown. Any
 * other error, and every error on another platform, is thrown at once. The bound is the sum of the
 * waits, not the clock, so the number of attempts is fixed.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  let waited = 0
  let wait = FIRST_WAIT_MS
  for (;;) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      if (!renameMayClear(err, platform) || waited + wait > RENAME_RETRY_BUDGET_MS) throw err
      await sleep(wait)
      waited += wait
      wait = Math.min(wait * 2, LONGEST_WAIT_MS)
    }
  }
}

/**
 * The retry options for a recursive delete (`rm`/`rmSync`) of a folder a scanner may still hold (#986
 * review): Node retries EBUSY, EPERM and ENOTEMPTY itself, waiting `retryDelay` ms longer on each try, so
 * 15 tries of 100 ms add up to 12 s, the rename's budget. On Windows only, like the rename's retries.
 */
export function removeRetry(platform: NodeJS.Platform = process.platform): { maxRetries: number; retryDelay: number } {
  return platform === 'win32' ? { maxRetries: 15, retryDelay: 100 } : { maxRetries: 0, retryDelay: 100 }
}
