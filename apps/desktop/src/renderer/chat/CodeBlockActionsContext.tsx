import { createContext, useContext } from 'react'

// #286 — "save a code block from an assistant reply as a file", renderer half.
//
// The per-code-block toolbar (Copy / Save) is opt-in via CONTEXT rather than a prop on
// AssistantMarkdown, because the block that needs it is rendered several layers down inside
// Streamdown's own component tree (our `pre` override), not by the caller.
//
// Scope (owner decision D3): the chat transcript's PERSISTED assistant turns only. Every other
// consumer of AssistantMarkdown (images AnswerThread, ReviewScreen, TranslateScreen, documents
// PreviewModal) and the live streaming bubble render WITHOUT a provider, so the default `null`
// keeps their DOM byte-identical to before this feature existed.
//
// This module deliberately imports nothing but React: Transcript.tsx (in the main renderer
// chunk) imports it to provide the value, and AssistantMarkdown (the lazily-loaded
// streamdown/katex chunk, FE-1 code-split) imports it to consume — pulling streamdown in here
// would drag that ~2 MB chunk back into the initial bundle.

export interface CodeBlockActions {
  /** Copy the block's exact code value to the clipboard (the transcript's own copy path). */
  onCopy: (content: string) => void
  /**
   * Save the block as a file. `language` is the fence language token (the info string's first
   * word, as remark keeps it in `language-<token>`; model output) — main maps it through the
   * fixed allowlist in `@shared/code-block-export`; the renderer never derives a filename from
   * it. The message id is bound by the provider.
   */
  onSave: (content: string, language: string) => void
}

/** Null (the default) ⇒ no toolbar: the code block renders exactly as Streamdown's default. */
export const CodeBlockActionsContext = createContext<CodeBlockActions | null>(null)

/** The block actions for the surrounding transcript turn, or null when there are none. */
export function useCodeBlockActions(): CodeBlockActions | null {
  return useContext(CodeBlockActionsContext)
}
