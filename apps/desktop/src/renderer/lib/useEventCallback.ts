import { useCallback, useRef } from 'react'

/**
 * Stable-identity wrapper for an event handler (perf audit FE-3). Returns a function whose
 * identity never changes but which always invokes the LATEST closure passed in — so a handler can
 * be passed to a `React.memo` child without busting the memo on every keystroke / streaming flush
 * (ChatScreen) or every task-progress tick (DocumentsScreen), yet never captures stale state. The
 * standard "latest ref" pattern.
 */
export function useEventCallback<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => void {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: A) => {
    ref.current(...args)
  }, [])
}
