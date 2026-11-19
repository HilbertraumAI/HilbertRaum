// The workspace stand-in for a partial AppContext (#897): every member `workspaceAdmitsWork` reads, the unlock-session
// counter the epoch-guarded paths read, the lock latch the lock and quit paths arm, and the document-work members.
// `WorkspaceStandIn` picks each signature off the real `WorkspaceController`, so a member whose signature changes fails the
// typecheck HERE, once; a member the product starts to read must be added to the pick (and then to every suite at once,
// through this one helper), since the suites' `as unknown as AppContext` casts hide a
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
/** A state move: a fixed flag takes the new value; a function-valued one stays the caller's (it owns that state). */
const move = <T>(v: T | (() => T), next: T): T | (() => T) => (typeof v === 'function' ? v : next)

/**
 * The real controller's state machine over three flags. `beginLock` arms the latch (the DB stays open: the mid-teardown
 * state), `cancelLock` disarms it, `shutdown` closes the DB and leaves the latch as its caller armed it (the quit
 * paths arm it first, as on the controller), `beginDocumentWork` hands out a no-op release. `overrides` are spread
 * last (a spy, a counter, a throwing `shutdown`) and replace the default outright: an overridden `isUnlocked` no
 * longer follows `completeLock`. An option given as a function is the caller's state: the moves above leave it alone,
 * so `locking: () => rowLocking` keeps reading the row's variable after a `cancelLock()`. Every member is an own property, so a row may also reassign one on a built context.
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
      locking = move(locking, true)
    },
    cancelLock: () => {
      locking = move(locking, false)
    },
    shutdown: () => {
      unlocked = move(unlocked, false)
    },
    documentCipher: () => o.documentCipher ?? null,
    beginDocumentWork: () => () => {},
    completeLock: () => {
      locking = move(locking, true)
      unlocked = move(unlocked, false)
    },
    completeUnlock: () => {
      locking = move(locking, false)
      unlocked = move(unlocked, true)
      epoch = move(epoch, read(epoch) + 1)
    },
    ...overrides
  }
  return ws satisfies WorkspaceAdmission
}
