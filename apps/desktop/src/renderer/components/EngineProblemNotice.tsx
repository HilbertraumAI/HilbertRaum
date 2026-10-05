import { useState, type ReactNode } from 'react'
import type { EngineProblem, EngineRecheckResult } from '@shared/types'
import { engineProblemCopy } from '@shared/engine-problem'
import { Banner } from './Banner'
import { Button } from './Button'
import { Spinner } from './Spinner'
import { useToast } from './Toast'
import { englishTranslator, type Translator } from './translator'

// "The AI engine can't run on this computer" (#530; design-guidelines §11.17). Two shapes:
//  - `banner` — the AI Model screen, chat engine: the strong state, in the place the missing-engine
//    banner occupies (same Banner + `.engine-install` layout), because models answer in demo mode
//    until it is fixed. One action: Check again.
//  - `hint` — under the speech-model card, voice engine: a quiet line (the #527
//    `engineUnsupported` shape) plus the same small action; chat is unaffected.
// The reason sentence names the library and the package; commands and exit codes stay out of it
// (§7: error codes only in Diagnostics, commands in the troubleshooting guide). Pure like every
// shared component: the screen supplies the re-check (`onRecheck`), this renders its outcome.
// #532: for damaged engine files the screen may also supply an "Install … again" control (it owns
// the engine job, its progress and the download gate); it leads the actions, Check again follows.

/** #532: the reinstall the screen offers beside Check again (design-guidelines §11.17 #532 amendment). */
export interface EngineProblemReinstall {
  /** The control: the button, or the job's progress and Cancel while it runs. */
  control: ReactNode
  /** The drive's policy allows the download, so the reason sentence names the reinstall. */
  policyAllows: boolean
  /** The reinstall job is running: Check again would only test a program being replaced. */
  live: boolean
}

export interface EngineProblemNoticeProps {
  problem: EngineProblem
  variant: 'banner' | 'hint'
  /**
   * Run "Check again" (`window.api.recheckEngine`). Resolves the problems still present; a
   * rejection's `message` is shown as-is, so the caller passes friendly text.
   */
  onRecheck: () => Promise<EngineRecheckResult>
  /**
   * Banner only: say that models answer in demo mode (default true). False when a real runtime is
   * answering anyway — a Windows Kit's `cpu/` build can run beside a damaged main folder.
   */
  demoNote?: boolean
  /** #532: offer "Install … again" (damaged engine files only). Absent = no reinstall here. */
  reinstall?: EngineProblemReinstall
  t?: Translator
}

export function EngineProblemNotice({
  problem,
  variant,
  onRecheck,
  demoNote = true,
  reinstall,
  t = englishTranslator
}: EngineProblemNoticeProps): JSX.Element {
  const showToast = useToast()
  const [checking, setChecking] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const copy = engineProblemCopy(problem, { reinstall: reinstall?.policyAllows === true })
  const reason = t(copy.key, copy.params)

  const recheck = async (): Promise<void> => {
    setChecking(true)
    setOutcome(null)
    try {
      const result = await onRecheck()
      if (result.problems.some((p) => p.family === problem.family)) {
        setOutcome(t('models.engineProblem.stillFailing'))
      } else {
        // The verdict is gone: the `engine:problemsChanged` push unmounts this notice, and the
        // toast (a polite live region, §6) is the confirmation that outlives it.
        showToast(t(problem.family === 'whisper_cpp' ? 'models.engineProblem.voiceFixed' : 'models.engineProblem.fixed'))
      }
    } catch (err) {
      setOutcome(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  const check = (
    <Button size="sm" disabled={checking || reinstall?.live === true} onClick={() => void recheck()}>
      {checking ? (
        <>
          <Spinner /> {t('models.engineProblem.checking')}
        </>
      ) : (
        t('models.engineProblem.check')
      )}
    </Button>
  )
  // #532: the reinstall leads (it is the fix); Check again stays beside it for a fix made elsewhere.
  const actions = reinstall ? (
    <div className="engine-problem-actions">
      {reinstall.control}
      {check}
    </div>
  ) : (
    check
  )

  if (variant === 'hint') {
    // The card is no live region, so the outcome line is its own — ALWAYS mounted (empty until a
    // check finishes): a status region inserted already holding its text is missed (§6, M-U1).
    return (
      <div className="engine-problem-hint">
        <p className="hint">
          {t('models.engineProblem.voiceTitle')} {reason}
        </p>
        <p className="hint mt-0" role="status">
          {outcome}
        </p>
        {actions}
      </div>
    )
  }

  return (
    <Banner tone="warning" t={t}>
      <div className="engine-install">
        <strong>{t('models.engineProblem.title')}</strong>
        <p className="hint hint-lede">{reason}</p>
        {demoNote && <p className="hint mt-0">{t('models.engineProblem.demoNote')}</p>}
        {outcome && <p className="hint mt-0">{outcome}</p>}
        {actions}
      </div>
    </Banner>
  )
}
