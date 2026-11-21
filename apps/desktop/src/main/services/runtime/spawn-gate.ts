// Engine spawn gate (#516; architecture.md "In-app engine updates" §3). While an engine install
// replaces a family's files — since #986 the swap's two renames, which put a staged, marked copy in
// place of the installed one — a spawn of that family's
// programs waits until the swap is over instead of running what is half there. Without it a helper
// that restarts by itself (the embedder on a search, a vision analyze) or a model start that was still
// hashing its weights when the pause ran could launch a half-extracted `llama-server`, and on Windows
// hold a file in the folder the swap is about to move. The gate covers every install, not only updates: a first
// install or a #532 reinstall replaces the same folder.
//
// Module-level and session-scoped, like the verdict store (engine-load.ts). The installer holds it for
// its swap phase (`holdEngineSpawns`); every spawn site of the family awaits `waitForEngineSpawns`
// before it verifies and spawns. The wait is bounded by `ENGINE_SPAWN_MAX_WAIT_MS` so a wedged swap can
// delay a spawn but never hang it. The bound is NOT the job's worst case (#986 review): one step can take
// the extractor's 5-minute deadline plus several 12 s rename-retry budgets (the archive's move, the
// flatten, the swap's renames, a move back, the `cpu/` carry), the hashing and the flush, and a job has up
// to two steps per family. It does not need to be: since #986 the install folder changes only in the
// swap's renames, so a spawn that stops waiting meets a complete copy, old or new, with two gaps (#986
// review 3): between the swap's two renames the install folder does not exist, for up to one 12 s
// rename-retry budget (the spawn finds no program and reports the engine missing, as with no engine); and
// between the main build's swap and its carry the new copy has no `cpu/` net for a moment. What a spawn let through
// early can do is run the old copy, which the swap then moves to `.old`, where Windows cannot delete it
// while it runs; the next swap or start deletes it.

/** Longest a spawn waits for a swap: the extractor's 5-minute deadline plus a margin (enough: see above). */
export const ENGINE_SPAWN_MAX_WAIT_MS = 6 * 60 * 1000

const held = new Map<string, { done: Promise<void>; release: () => void }>()

/**
 * Hold every spawn of `family` until the returned release is called (idempotent). A second hold of
 * the same family joins the first, which one install at a time makes the only case.
 */
export function holdEngineSpawns(family: string): () => void {
  const existing = held.get(family)
  if (existing) return existing.release
  let resolve: () => void = () => undefined
  const done = new Promise<void>((r) => {
    resolve = r
  })
  const release = (): void => {
    if (held.get(family)?.done !== done) return
    held.delete(family)
    resolve()
  }
  held.set(family, { done, release })
  return release
}

/** Resolve once no install is replacing `family`'s files (at once when none is), bounded. */
export async function waitForEngineSpawns(
  family: string,
  maxWaitMs: number = ENGINE_SPAWN_MAX_WAIT_MS
): Promise<void> {
  const hold = held.get(family)
  if (!hold) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((r) => {
    timer = setTimeout(r, maxWaitMs)
    timer.unref?.()
  })
  try {
    await Promise.race([hold.done, bound])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** True while an install is replacing `family`'s files (for logs and tests). */
export function engineSpawnsHeld(family: string): boolean {
  return held.has(family)
}
