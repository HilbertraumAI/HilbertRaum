import type { ComponentProps } from 'react'
import { render, type RenderResult } from '@testing-library/react'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { I18nProvider } from '../../src/renderer/i18n'
import type { UiLanguage } from '../../src/shared/i18n'
import { renderInLanguage } from './render-language'

// The Transcript render baseline (chat-ui campaign, lane C). Replaces the copies the chat-transcript
// suites each spelled out: `renderTranscript` in CodeBlockActions, CitationMarkers, SourcesProvenance,
// TruncatedNotice, TranscriptReviewUndoGuard and TranscriptA11y (×2, plus its `ThinkingHarness` and
// `renderWithMarker`), and TranscriptMemo's inline `props`. Pair it with chat-fixtures' `makeMessage` /
// `userMsg` / `assistantMsg` / `makeCitations`.
//
// The no-op handlers are module-level, so every render gets the SAME function objects and Transcript's
// React.memo (and MessageBlock's) holds across rerenders: TranscriptMemo's re-parse counts rely on it.
// `I18nProvider` calls no `window.api`, so a suite that ends with `assertNoUnexpectedApiCalls()` stays clean;
// without a stored UI-language mirror it resolves jsdom's `navigator.language` ('en-US'), i.e. English.

export type TranscriptProps = ComponentProps<typeof Transcript>

const noop = (): void => {}
const noopCopy = (_content: string): void => {}

/** An idle transcript: no messages, no stream, stable no-op handlers. Override any prop. */
export function transcriptProps(over: Partial<TranscriptProps> = {}): TranscriptProps {
  return {
    messages: [],
    streamingHere: false,
    streamText: '',
    streamThinking: '',
    thinkingOpen: false,
    onThinkingOpenChange: noop,
    emptyState: null,
    onCopy: noopCopy,
    onSave: noop,
    actionsDisabled: false,
    ...over
  }
}

/** A Transcript under `I18nProvider` (the RTL `wrapper`); `lang` goes through `renderInLanguage`, which sets
 *  the UI-language mirror first (the caller clears localStorage in its own afterEach). */
export function renderTranscript(over: Partial<TranscriptProps> = {}, lang?: UiLanguage): RenderResult {
  const ui = <Transcript {...transcriptProps(over)} />
  return lang ? renderInLanguage(ui, lang) : render(ui, { wrapper: I18nProvider })
}
