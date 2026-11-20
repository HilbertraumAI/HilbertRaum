// The ONE spelling of the vitest alias that points the lazy markdown wrapper at the synchronous renderer
// (#815, #832). `vitest.config.ts` uses it as the alias `find`; `tests/unit/lazy-wrapper-specifier.test.ts`
// checks every import of the wrapper under `src/` against it. A pure module (no vitest import): the config
// loads it before any test runs.

/**
 * The two whole specifiers the app imports `AssistantMarkdownLazy` by: './AssistantMarkdownLazy' (the chat
 * barrel, Transcript) and '../chat/AssistantMarkdownLazy' (ReviewScreen). Nothing longer matches, so the
 * wrapper's own test (which imports it by a full path) still drives the real React.lazy chunk.
 */
export const LAZY_WRAPPER_ALIAS = /^(?:\.\/|\.\.\/chat\/)AssistantMarkdownLazy$/
