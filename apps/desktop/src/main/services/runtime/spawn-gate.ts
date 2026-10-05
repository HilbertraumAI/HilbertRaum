// Engine spawn gate (#516; architecture.md "In-app engine updates" §3). While an engine install
// replaces a family's files — the pre-clean, the extraction, the marker — a spawn of that family's
// programs waits until the swap is over instead of running what is half there. Without it a helper
// that restarts by itself (the embedder on a search, a vision analyze) or a model start that was still
// hashing its weights when the pause ran could launch a half-extracted `llama-server`, and on Windows
// hold a file the clean is about to delete. The gate covers every install, not only updates: a first
// install or a #532 reinstall replaces the same folder.
//
// Module-level and session-scoped, like the verdict store (engine-load.ts). The installer holds it for
// its swap phase (`holdEngineSpawns`); every spawn site of the family awaits `waitForEngineSpawns`
// before it verifies and spawns. The wait is bounded by `ENGINE_SPAWN_MAX_WAIT_MS`, just above the
// extractor's own deadline, so a wedged swap can delay a spawn but never hang it.

/** Longest a spawn waits for a swap: the extractor's 5-minute deadline plus a margin. */
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
