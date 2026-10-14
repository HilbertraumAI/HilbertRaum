import { memo } from 'react'
import { Banner, Button, Spinner } from '../components'
import { AssistantMarkdown } from '../chat'
import type { I18n } from '../i18n'
import type { MessageKey } from '@shared/i18n'
import type { VisionErrorCode } from '@shared/types'
import type { ImageTurn } from './AnswerThread'

// One turn of the image answer thread (§5.4): the user question (quiet), then the answer block.
// AnswerThread renders one per turn.

// The runtime-side error codes a turn can surface (client-guard codes are screen-level
// banners). `cancelled` is handled separately as a quiet note, not an error. An UNKNOWN code
// (version skew) falls back to the runtimeFailed copy at the lookup site — keep that fallback:
// it is what makes adding codes main-side skew-safe (#123).
const ERR_KEY: Partial<Record<VisionErrorCode, MessageKey>> = {
  runtimeFailed: 'images.err.runtimeFailed',
  // #530: the OS refused to start the engine program — another model would not help.
  engineCannotRun: 'images.err.engineCannotRun',
  emptyResponse: 'images.err.emptyResponse',
  emptyQuestion: 'images.err.emptyQuestion',
  timedOut: 'images.err.timedOut',
  contextExceeded: 'images.err.contextExceeded',
  busy: 'images.err.busy',
  tooLarge: 'images.err.tooLarge',
  unsupportedType: 'images.err.unsupported',
  decodeFailed: 'images.err.decodeFailed'
}

// PERF-6: one memoized row per turn, keyed by turn id. While a turn is IN FLIGHT we render its
// answer as PLAIN TEXT (the streaming token deltas) and run the Markdown parser only ONCE, on
// completion — mirroring the chat-transcript FE-1 split — so a long answer isn't re-parsed on every
// stream flush. `memo` also keeps settled turns from re-rendering while a sibling streams (it bites
// when the parent passes referentially-stable handlers; the plain-text win holds regardless).
// DIVERGENCE NOTE: chat has since revised FE-1 to streaming Markdown via Streamdown
// (architecture.md §FE-1 revisited); this site deliberately keeps the plain-text-while-streaming
// split until it gets the same treatment.
export const TurnRow = memo(function TurnRow({
  turn,
  t,
  onCopy,
  onTryAgain,
  onStop,
  busy
}: {
  turn: ImageTurn
  t: I18n['t']
  onCopy: (text: string) => void
  onTryAgain: (question: string) => void
  onStop: () => void
  /** True while ANY turn is analyzing — vision is one-at-a-time, so a per-turn re-run is rejected. */
  busy: boolean
}): JSX.Element {
  const running = turn.state === 'starting' || turn.state === 'analyzing'
  return (
    <div className="image-turn">
      <p className="image-turn-question">{turn.question}</p>
      <div className="image-turn-answer">
        {turn.answer &&
          (running ? (
            // In-flight: plain text + caret. No per-flush Markdown re-parse; parsed once when done.
            <div className="image-turn-text">
              {turn.answer}
              <span className="stream-caret" aria-hidden="true">
                ▍
              </span>
            </div>
          ) : (
            // Settled: parse Markdown once (AssistantMarkdown is itself memoized on its text).
            <div className="image-turn-text md">
              <AssistantMarkdown text={turn.answer} />
            </div>
          ))}
        {running && (
          <div className="image-turn-running" role="status">
            {!turn.answer && (
              <span className="image-turn-reading">
                <Spinner />{' '}
                {turn.state === 'starting' ? t('images.answer.starting') : t('images.answer.reading')}
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
              {/* F4: vision is one-at-a-time. Disable "Try again" while any turn is analyzing,
                  mirroring the disabled QuestionComposer, so the re-run is never silently dropped
                  (the backend busy-rejects it). Copy stays live — it's a harmless read. */}
              <Button size="sm" disabled={busy} onClick={() => onTryAgain(turn.question)}>
                {t('images.answer.tryAgain')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
})
