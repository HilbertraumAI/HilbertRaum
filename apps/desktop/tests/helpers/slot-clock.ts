// An injected clock for ModelSlotArbiter (#399 D3(a)): a parked build resumes RESUME_AFTER_CHAT_DELAY_MS (90 s)
// after the last chat lets go, which no test can wait out. On this clock nothing sleeps: `advance()` is the ONLY
// thing that fires a resume, so one that comes too early or not at all is visible, and `pending()` shows an armed
// resume without firing it.
import type { ModelSlotArbiterDeps } from '../../src/main/services/analysis/model-slot-arbiter'

export interface SlotClock {
  /** Pass as `new ModelSlotArbiter(deps)` or as the manager's `slotArbiterDeps`. */
  deps: Required<Pick<ModelSlotArbiterDeps, 'now' | 'setTimer' | 'clearTimer'>>
  /** Move time forward and fire every timer now due. */
  advance: (ms: number) => void
  /** Timers armed and not yet fired or cleared. */
  pending: () => number
}

export function slotClock(): SlotClock {
  let nowMs = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    deps: {
      now: () => nowMs,
      setTimer: (fn, ms) => {
        const id = ++seq
        timers.set(id, { at: nowMs + ms, fn })
        return id
      },
      clearTimer: (h) => {
        timers.delete(h as number)
      }
    },
    advance: (ms) => {
      nowMs += ms
      for (const [id, e] of [...timers]) {
        if (e.at <= nowMs) {
          timers.delete(id)
          e.fn()
        }
      }
    },
    pending: () => timers.size
  }
}
