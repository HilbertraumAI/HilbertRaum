import { describe, it, expect } from 'vitest'

// #498 — `truncationCause` is the ONE place that decides WHICH ceiling cut a reply short.
// llama-server reports the same `finish_reason: 'length'` for the model's context window and
// for a `max_tokens` cap the app itself sent, but only the first is fixed by raising the
// context size, so the transcript's remedy has to come from here and not from the reason alone.
// A pure function over (finishReason, the cap actually sent, the server's timings).

import { truncationCause } from '../../src/main/services/rag/whole-doc-tree'

describe('truncationCause (#498) — which ceiling ended the pass', () => {
  it('reports no cause for anything but a length cut', () => {
    expect(truncationCause('stop', 1024, { predicted_n: 40 })).toBeUndefined()
    expect(truncationCause(null, 1024)).toBeUndefined()
    expect(truncationCause('tool_calls', null)).toBeUndefined()
  })

  it("attributes a cut with NO cap sent to the context window — it was the only ceiling", () => {
    expect(truncationCause('length', null)).toBe('context')
    expect(truncationCause('length', undefined, { predicted_n: 900 })).toBe('context')
  })

  it('attributes a cut that stopped SHORT of its cap to the context window', () => {
    // The server was allowed 1024 tokens and produced 300: nothing but the window explains
    // stopping early, so "raise the context size" is the honest remedy here.
    expect(truncationCause('length', 1024, { predicted_n: 300 })).toBe('context')
  })

  it("attributes a cut that reached its cap to the app's own cap", () => {
    expect(truncationCause('length', 1024, { predicted_n: 1024 })).toBe('cap')
    // No timings at all (the mock runtime, an older server): a cap was sent and the reply hit a
    // ceiling — 'cap' is the honest default, and it never blames a window that may be near-empty.
    expect(truncationCause('length', 1024)).toBe('cap')
    expect(truncationCause('length', 1024, null)).toBe('cap')
    expect(truncationCause('length', 1024, {})).toBe('cap')
  })
})
