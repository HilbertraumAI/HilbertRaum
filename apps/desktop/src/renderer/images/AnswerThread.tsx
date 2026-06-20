import { Banner, Button, Spinner } from '../components'
import { useT } from '../i18n'
import type { MessageKey } from '@shared/i18n'
import type { VisionErrorCode } from '@shared/types'

// Answer thread (§5.4): the ephemeral per-image turns. Each turn shows the user question
// (quiet) then the answer block, which carries the ambient "Generated locally from the
// selected image." note + Copy + Try again. While analyzing: a calm indeterminate line
// ("Starting the vision model…" / "Reading the image…") with a streaming caret and Stop —
// never a full-screen spinner. A failed turn shows friendly copy for the CODE (never raw
// model/runtime text); a user Stop reads as a quiet "Stopped." note, not an error.

export interface ImageTurn {
  id: string
  question: string
  answer: string
  state: 'starting' | 'analyzing' | 'done' | 'failed' | 'cancelled'
  error?: VisionErrorCode | null
}

// The runtime-side error codes a turn can surface (client-guard codes are screen-level
// banners). `cancelled` is handled separately as a quiet note, not an error.
const ERR_KEY: Partial<Record<VisionErrorCode, MessageKey>> = {
  runtimeFailed: 'images.err.runtimeFailed',
  emptyResponse: 'images.err.emptyResponse',
  busy: 'images.err.busy',
  tooLarge: 'images.err.tooLarge',
  unsupportedType: 'images.err.unsupported',
  decodeFailed: 'images.err.decodeFailed'
}

export function AnswerThread({
  turns,
  onCopy,
  onTryAgain,
  onStop
}: {
  turns: ImageTurn[]
  onCopy: (text: string) => void
  onTryAgain: (question: string) => void
  onStop: () => void
}): JSX.Element {
  const { t } = useT()
  return (
    <div className="image-thread">
      {turns.map((turn) => {
        const running = turn.state === 'starting' || turn.state === 'analyzing'
        return (
          <div className="image-turn" key={turn.id}>
            <p className="image-turn-question">{turn.question}</p>
            <div className="image-turn-answer">
              {turn.answer && (
                <p className="image-turn-text">
                  {turn.answer}
                  {running && <span className="stream-caret" aria-hidden="true">▍</span>}
                </p>
              )}
              {running && (
                <div className="image-turn-running" role="status">
                  {!turn.answer && (
                    <span className="image-turn-reading">
                      <Spinner />{' '}
                      {turn.state === 'starting'
                        ? t('images.answer.starting')
                        : t('images.answer.reading')}
                    </span>
                  )}
                  <Button size="sm" onClick={onStop}>
                    {t('images.answer.stop')}
                  </Button>
                </div>
              )}
              {turn.state === 'cancelled' && (
                <p className="hint image-turn-stopped">{t('images.answer.stopped')}</p>
              )}
              {turn.state === 'failed' && turn.error && turn.error !== 'cancelled' && (
                <Banner tone="error">{t(ERR_KEY[turn.error] ?? 'images.err.runtimeFailed')}</Banner>
              )}
              {turn.state === 'done' && (
                <>
                  <p className="hint image-local-note">{t('images.answer.localNote')}</p>
                  <div className="image-turn-actions">
                    <Button size="sm" onClick={() => onCopy(turn.answer)}>
                      {t('images.answer.copy')}
                    </Button>
                    <Button size="sm" onClick={() => onTryAgain(turn.question)}>
                      {t('images.answer.tryAgain')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
