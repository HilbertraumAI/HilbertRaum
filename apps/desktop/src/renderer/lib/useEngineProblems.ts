import { useEffect, useState } from 'react'
import type { EngineProblem } from '@shared/types'

/**
 * #530: the session's engine verdicts (`AppStatus.engineProblems`), kept live: read on mount and
 * again on every `engine:problemsChanged` push — a refusal found after the screen mounted (the
 * startup check is still running), or a "Check again" that healed it. Null until the first read
 * lands, or when it could not be read (an older bridge, a failed read): callers show nothing then.
 */
export function useEngineProblems(): EngineProblem[] | null {
  const [problems, setProblems] = useState<EngineProblem[] | null>(null)
  useEffect(() => {
    let active = true
    const read = (): void => {
      // `Promise.resolve(...)`: an older preload (or a test harness that does not stub the
      // channel) hands back `undefined` — "could not ask" reads as "nothing to report".
      Promise.resolve(window.api?.getAppStatus?.())
        .then((s) => active && setProblems(s ? (s.engineProblems ?? []) : null))
        .catch(() => active && setProblems(null))
    }
    read()
    const off = window.api?.onEngineProblemsChanged?.(read)
    return () => {
      active = false
      off?.()
    }
  }, [])
  return problems
}
