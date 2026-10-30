/** A promise the test settles by hand: a parked send, a gated read, a held start. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve(v: T): void
  reject(e: unknown): void
}

/**
 * The one hand-settled promise, in a module with no imports, so a suite can have it without pulling
 * in ChatScreen (`chat-screen.tsx`) or the runtime ladder (`ladder-harness.ts`), which re-export it.
 * `T` defaults to `void`, so a bare gate is `const gate = deferred()` … `gate.resolve()`.
 *
 * It does not guard a rejection: a test that rejects a promise nothing awaits yet adds its own
 * `.catch(() => undefined)`, or the run reports an unhandled rejection.
 */
export function deferred<T = void>(): Deferred<T> {
  let resolve: (v: T) => void = () => {}
  let reject: (e: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
