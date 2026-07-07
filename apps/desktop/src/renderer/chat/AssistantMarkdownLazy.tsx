import { Suspense, lazy, memo } from 'react'

// Lazy boundary for the Streamdown/KaTeX markdown renderer (perf: renderer code-split). The heavy
// implementation (streamdown + katex + @streamdown/math, ~2 MB) lives in ./AssistantMarkdown and is
// pulled in a separate async chunk on first render of any assistant markdown — keeping it out of the
// initial app bundle. The barrel exports THIS wrapper as `AssistantMarkdown`, so every consumer
// (chat, translate, documents, images) gets the split for free with no call-site change.
const AssistantMarkdownImpl = lazy(() =>
  import('./AssistantMarkdown').then((m) => ({ default: m.AssistantMarkdown }))
)

// While the chunk loads (local disk, offline — a few ms) show the raw text in the same `.md`
// container: content stays visible and readable (no blank flash, no layout jump), then swaps to the
// typeset version. Once loaded, React caches the lazy component so every later instance resolves
// synchronously.
export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  streaming = false
}: {
  text: string
  streaming?: boolean
}): JSX.Element {
  return (
    <Suspense fallback={<div className="md">{text}</div>}>
      <AssistantMarkdownImpl text={text} streaming={streaming} />
    </Suspense>
  )
})
