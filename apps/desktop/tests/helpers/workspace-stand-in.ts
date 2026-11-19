// The workspace stand-in for a partial AppContext (#897): every member `workspaceAdmitsWork` reads, the unlock-session
// counter the epoch-guarded paths read, the lock latch the lock and quit paths arm, and the document-work members.
// `WorkspaceStandIn` picks each signature off the real `WorkspaceController`, so a member the product starts to read, or
// one whose signature changes, fails the typecheck HERE, once: the suites' `as unknown as AppContext` casts hide a
// partial literal from the typecheck, and a product `try`/`catch` can turn its TypeError into a silent skip. Type-only
// imports, so it loads in any suite, with or without a hoisted `vi.mock('electron', …)`.
import type { DocumentCipher, WorkspaceAdmission, WorkspaceController } from '../../src/main/services/workspace-vault'

/** A fixed answer, or a function read on every call (a row that flips its own `let`). */
type Flag = boolean | (() => boolean)

export interface WorkspaceStandInOptions {
  /** `isUnlocked()`; default true. */
  unlocked?: Flag
  /** `isLocking()`, the AUD-02 latch; default false. */
  locking?: Flag
  /** `unlockEpoch()`, the AUD-03 session counter; default 1. */
  epoch?: number | (() => number)
  /** `documentCipher()`; default null (plaintext stored copies). */
  documentCipher?: DocumentCipher | null
}

/** The controller members a partial context's `workspace` is read for, plus two moves of a whole lock or unlock. */
export type WorkspaceStandIn = Pick<
  WorkspaceController,
  'isUnlocked' | 'isLocking' | 'unlockEpoch' | 'beginLock' | 'cancelLock' | 'shutdown' | 'documentCipher' | 'beginDocumentWork'
> & {
  /** The lock handler's whole path: the latch armed first, the DB closed last (the epoch stays). */
  completeLock(): void
  /** The next unlock: the latch cleared, the DB open, a new session (epoch + 1). */
  completeUnlock(): void
}

const read = <T>(v: T | (() => T)): T => (typeof v === 'function' ? (v as () => T)() : v)

/**
 * The real controller's state machine over three flags. `beginLock` arms the latch (the DB stays open: the mid-teardown
 * state), `cancelLock` disarms it, `shutdown` closes the DB and leaves the latch as its caller armed it (the quit
 * paths arm it first, as on the controller), `beginDocumentWork` hands out a no-op release. `overrides` are spread
 * last (a spy, a counter, a throwing `shutdown`) and replace the default outright: an overridden `isUnlocked` no
 * longer follows `completeLock`. Every member is an own property, so a row may also reassign one on a built context.
 */
export function workspaceStandIn(
  o: WorkspaceStandInOptions = {},
  overrides: Partial<WorkspaceStandIn> = {}
): WorkspaceStandIn {
  let unlocked: Flag = o.unlocked ?? true
  let locking: Flag = o.locking ?? false
  let epoch: number | (() => number) = o.epoch ?? 1
  const ws: WorkspaceStandIn = {
    isUnlocked: () => read(unlocked),
    isLocking: () => read(locking),
    unlockEpoch: () => read(epoch),
    beginLock: () => {
      locking = true
    },
    cancelLock: () => {
      locking = false
    },
    shutdown: () => {
      unlocked = false
    },
    documentCipher: () => o.documentCipher ?? null,
    beginDocumentWork: () => () => {},
    completeLock: () => {
      locking = true
      unlocked = false
    },
    completeUnlock: () => {
      locking = false
      unlocked = true
      epoch = read(epoch) + 1
    },
    ...overrides
  }
  return ws satisfies WorkspaceAdmission
}
