import { statSync } from 'node:fs'
import { shredFile } from '../workspace-vault'

// Registry of the operations that materialise DECRYPTED document content on the drive
// (`.parse*` transients under `workspace/documents/`) or hold decoded text in flight: the
// preview, a re-index, an import's prepare phase, a dictation and the two export readers.
// "Lock now" and quit used to await chat streams, doc tasks and sidecar stops but held no
// handle on these, so a parse that straddled the boundary kept a plaintext file on the drive
// after the workspace reported locked (#237). Every such operation now registers here before
// it writes, releases in its `finally`, and the lock/quit teardowns abort the registry, await
// its settle within a bound, then shred whatever is still registered.
//
// Parsers that honour the abort signal (photo OCR, audio transcription) stop early; the
// text parsers (pdfjs, mammoth, txt/csv/markdown) cannot be cancelled and are bounded by the
// sweep instead — their transient is shredded under them at the settle bound.

export type PlaintextOpKind =
  | 'preview'
  | 'reindex'
  | 'import-prepare'
  | 'dictation'
  | 'export'
  /** A doc-task's own transient (the OCR source PDF, a materialised output's `.parse.md`). */
  | 'doc-task'
  // Knowledge packs (#301, finding H4). These run on a SECOND instance of this registry
  // (`ctx.zimOps`), so the ZIM settle/sweep is its own bounded lock step and the paths it
  // tracks are only ZIM transients (`library.<n>.xml` / `meta-<n>/library.xml` under the
  // workspace's own `zim-transient/` dir). Same contract, different instance.
  /** One ask's retrieval arm — registered with the ask's own signal as its parent. */
  | 'zim-ask'
  /** One article read for the citation viewer. */
  | 'zim-article'
  /** A registration (the native picker wait AND the per-file registration under it) and the
   *  user's remove / enable mutations. */
  | 'zim-register'
  /** The background pack reconciliation (session start, explicit Refresh). */
  | 'zim-reconcile'

/** One registered operation. Obtained from `PlaintextOpsRegistry.register()`. */
export interface PlaintextOp {
  readonly id: string
  readonly kind: PlaintextOpKind
  /** Aborted by `abortAll()` (lock/quit) or by the parent signal the op was registered under. */
  readonly signal: AbortSignal
  /** Record a transient's path BEFORE writing it, so the lock/quit sweep can shred it. */
  track(path: string): void
  /** The operation is over (its own `finally` shredded its transients). Idempotent. */
  release(): void
}

export interface PlaintextOpsRegistry {
  /** Register an operation; `parent` (an import job's abort, a dictation's timeout) aborts it too. */
  register(kind: PlaintextOpKind, parent?: AbortSignal): PlaintextOp
  /** Live (registered, not yet released) operations. */
  size(): number
  /** Abort every live operation. Idempotent; never throws. */
  abortAll(): void
  /**
   * Wait until every live operation has released, at most `boundMs`. Resolves `true` when all
   * settled inside the bound, `false` when the bound elapsed first. Never rejects.
   */
  awaitSettled(boundMs: number): Promise<boolean>
  /**
   * Shred every tracked transient of every live operation that is still on disk (and its
   * `.tmp` decrypt stage). Touches ONLY registered paths — never a stored copy. Returns the
   * number of files removed. Never throws.
   */
  sweepRegistered(): number
}

interface LiveOp {
  readonly op: PlaintextOp
  readonly controller: AbortController
  readonly paths: Set<string>
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
  readonly detachParent: () => void
}

export function createPlaintextOps(): PlaintextOpsRegistry {
  const live = new Map<string, LiveOp>()
  let seq = 0

  const register = (kind: PlaintextOpKind, parent?: AbortSignal): PlaintextOp => {
    const id = `${kind}-${++seq}`
    const controller = new AbortController()
    let resolveSettled!: () => void
    const settled = new Promise<void>((r) => (resolveSettled = r))
    const paths = new Set<string>()
    const onParentAbort = (): void => controller.abort(parent?.reason)
    let detachParent = (): void => undefined
    if (parent) {
      if (parent.aborted) controller.abort(parent.reason)
      else {
        parent.addEventListener('abort', onParentAbort, { once: true })
        detachParent = () => parent.removeEventListener('abort', onParentAbort)
      }
    }
    const op: PlaintextOp = {
      id,
      kind,
      signal: controller.signal,
      track: (path) => {
        paths.add(path)
      },
      release: () => {
        const entry = live.get(id)
        if (!entry) return
        live.delete(id)
        entry.detachParent()
        entry.resolveSettled()
      }
    }
    live.set(id, { op, controller, paths, settled, resolveSettled, detachParent })
    return op
  }

  const abortAll = (): void => {
    for (const entry of live.values()) {
      try {
        if (!entry.controller.signal.aborted) entry.controller.abort(new Error('Workspace is locking'))
      } catch {
        /* best-effort */
      }
    }
  }

  const awaitSettled = async (boundMs: number): Promise<boolean> => {
    if (live.size === 0) return true
    const pending = [...live.values()].map((e) => e.settled)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), boundMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([Promise.all(pending).then(() => true as const), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const sweepRegistered = (): number => {
    let swept = 0
    for (const entry of live.values()) {
      for (const path of entry.paths) {
        for (const candidate of [path, `${path}.tmp`]) {
          try {
            if (!existsFile(candidate)) continue
            shredFile(candidate)
            if (!existsFile(candidate)) swept++
          } catch {
            /* best-effort — the lock must proceed */
          }
        }
      }
    }
    return swept
  }

  return { register, size: () => live.size, abortAll, awaitSettled, sweepRegistered }
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
