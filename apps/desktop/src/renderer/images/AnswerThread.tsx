import { useT } from '../i18n'
import type { VisionErrorCode } from '@shared/types'
import { TurnRow } from './TurnRow'

// Answer thread (§5.4): the ephemeral per-image turns. Each turn shows the user question
// (quiet) then the answer block, which carries the ambient "Generated locally from the
// selected image." note + Copy + Try again. While analyzing: a calm indeterminate line
// ("Starting the vision model…" / "Reading the image…") with a streaming caret and Stop —
// never a full-screen spinner. A failed turn shows friendly copy for the CODE (never raw
// model/runtime text); a user Stop reads as a quiet "Stopped." note, not an error. Each turn
// is a memoized `TurnRow` (PERF-6, `./TurnRow`).

export interface ImageTurn {
  id: string
  question: string
  answer: string
  state: 'starting' | 'analyzing' | 'done' | 'failed' | 'cancelled'
  error?: VisionErrorCode | null
}

export function AnswerThread({
  turns,
  onCopy,
  onTryAgain,
  onStop,
  busy
}: {
  turns: ImageTurn[]
  onCopy: (text: string) => void
  onTryAgain: (question: string) => void
  onStop: () => void
  /** True while a turn is analyzing — disables the per-turn "Try again" (vision is one-at-a-time). */
  busy: boolean
}): JSX.Element {
  const { t } = useT()
  return (
    <div className="image-thread">
      {turns.map((turn) => (
        <TurnRow
          key={turn.id}
          turn={turn}
          t={t}
          onCopy={onCopy}
          onTryAgain={onTryAgain}
          onStop={onStop}
          busy={busy}
        />
      ))}
    </div>
  )
}
