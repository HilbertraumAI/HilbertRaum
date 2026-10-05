import { useEffect, useState } from 'react'
import type { EngineProblem } from '@shared/types'

/** The session's engine verdicts, and whether the first read has come back (#532). */
export interface EngineProblemsRead {
  /** As {@link useEngineProblems}: null until the first read lands, or when it could not be read. */
  problems: EngineProblem[] | null
  /**
   * True once the first read finished — with an answer, or with none (an older bridge, a failed
   * read). Lets a one-shot decision (the AI Model screen's deep-link scroll) wait for the verdict
   * without waiting forever where there is none to wait for.
   */
  settled: boolean
}

/**
 * #530: the session's engine verdicts (`AppStatus.engineProblems`), kept live: read on mount and
 * again on every `engine:problemsChanged` push — a refusal found after the screen mounted (the
 * startup check is still running), or a "Check again" that healed it. `problems` is null until the
 * first read lands, or when it could not be read (an older bridge, a failed read): callers show
 * nothing then.
 */
export function useEngineProblemsRead(): EngineProblemsRead {
  const [read, setRead] = useState<EngineProblemsRead>({ problems: null, settled: false })
  useEffect(() => {
    let active = true
    const readStatus = (): void => {
      // `Promise.resolve(...)`: an older preload (or a test harness that does not stub the
      // channel) hands back `undefined` — "could not ask" reads as "nothing to report".
      Promise.resolve(window.api?.getAppStatus?.())
        .then((s) => active && setRead({ problems: s ? (s.engineProblems ?? []) : null, settled: true }))
        .catch(() => active && setRead({ problems: null, settled: true }))
    }
    readStatus()
    const off = window.api?.onEngineProblemsChanged?.(readStatus)
    return () => {
      active = false
      off?.()
    }
  }, [])
  return read
}

/** #530: the live verdicts only — see {@link useEngineProblemsRead}. */
export function useEngineProblems(): EngineProblem[] | null {
  return useEngineProblemsRead().problems
}
