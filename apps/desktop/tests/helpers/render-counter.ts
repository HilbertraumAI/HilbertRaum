// A test-side render counter for a production `React.memo` component (PERF-5), so a memoization
// test needs no counter shipped in `src/`. Use the result in a `vi.mock` factory over the module
// that exports the component:
//
//   const rowRenders = vi.hoisted(() => new Map<string, number>())
//   vi.mock('../../src/renderer/screens/documents/DocRow', async (importOriginal) => {
//     const m = await importOriginal<typeof import('../../src/renderer/screens/documents/DocRow')>()
//     const { countMemoRenders } = await import('../helpers/render-counter')
//     return { ...m, DocRow: countMemoRenders(m.DocRow, (p) => p.d.id, rowRenders) }
//   })
//
// Why it measures production's memo and not a copy of it: React 18's `memo()` returns a plain
// `{ $$typeof: REACT_MEMO_TYPE, type, compare }` object (react.development.js `memo`). The wrapper
// keeps that object's own `$$typeof` and `compare` and swaps only `type` for a counting function
// that renders the original inner component, so React still runs production's memo bail-out on
// the same props — a render is counted only when production's memo lets it through. A component
// that is no longer a memo comes back as the bare counter, which every parent render reaches: the
// regression (memo dropped) shows as sibling counts that move.
import { createElement, type ComponentProps, type ComponentType, type MemoExoticComponent, type ReactElement } from 'react'

const REACT_MEMO_TYPE = Symbol.for('react.memo')

/** The `React.memo` object's own fields (React 18: { $$typeof, type, compare }) — read, never rebuilt. */
interface MemoParts {
  $$typeof: symbol
  type: ComponentType<object>
  compare: unknown
}

const isMemo = (c: unknown): c is MemoParts =>
  typeof c === 'object' && c !== null && (c as { $$typeof?: unknown }).$$typeof === REACT_MEMO_TYPE

/**
 * Count a production component's renders per `keyOf(props)` into `counts`, WITHOUT a production
 * seam. A memo object is kept as is — only its inner component is wrapped, so production's own
 * memo and compare still decide every re-render. Counts parent-driven renders only: a component's
 * own state updates re-render the inner component without passing the wrapper (DocRow has no hooks).
 */
export function countMemoRenders<C extends ComponentType<any> | MemoExoticComponent<ComponentType<any>>>(
  component: C,
  keyOf: (props: ComponentProps<C>) => string,
  counts: Map<string, number>
): C {
  const inner = isMemo(component) ? component.type : (component as ComponentType<object>)
  const Counted = (props: ComponentProps<C>): ReactElement => {
    const key = keyOf(props)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return createElement(inner, props)
  }
  return (isMemo(component) ? { ...component, type: Counted } : Counted) as unknown as C
}
