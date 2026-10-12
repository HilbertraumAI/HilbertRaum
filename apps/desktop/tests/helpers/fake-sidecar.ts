import { EventEmitter } from 'node:events'
import type { ChildProcessLike } from '../../src/main/services/runtime/sidecar'

// Fakes shared by the suites of the lazily started llama-server sidecars (the embedder, the
// reranker, vision and translation): a spawned child, a spawn recorder, a one-chunk SSE body, an
// idle clock fired by hand, and a llama-server that is still loading its model. Each suite drives
// its real service class through these, over the injected `spawn` / `fetchImpl` seams.

/** A child that exits cleanly right after `kill()`, as llama-server does. */
export class FakeChild extends EventEmitter implements ChildProcessLike {
  pid = 9
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }
  /** A mid-session crash: the child exits without going through `kill()`. */
  crash(code = 1): void {
    this.emit('exit', code, null)
  }
}

/** A child whose exit after `kill()` waits for `releaseExit()`, so a test can hold a teardown
 *  open (for example to watch a second caller join it). */
export class GatedChild extends EventEmitter implements ChildProcessLike {
  pid = 9
  killed = false
  private wantExit = false
  private released = false
  kill(): boolean {
    this.killed = true
    this.wantExit = true
    if (this.released) this.emit('exit', 0, null)
    return true
  }
  releaseExit(): void {
    this.released = true
    if (this.wantExit) this.emit('exit', 0, null)
  }
}

/** A spawn that records each argv and hands out a fresh child per call (a `FakeChild` unless
 *  `make` says otherwise). */
export function fakeSpawn<T extends ChildProcessLike = FakeChild>(
  make: () => T = () => new FakeChild() as unknown as T
): {
  spawn: (command: string, args: string[]) => ChildProcessLike
  calls: Array<{ args: string[] }>
  children: T[]
} {
  const calls: Array<{ args: string[] }> = []
  const children: T[] = []
  const spawn = (_command: string, args: string[]): ChildProcessLike => {
    calls.push({ args })
    const child = make()
    children.push(child)
    return child
  }
  return { spawn, calls, children }
}

/** A `ReadableStream` that delivers the whole SSE text as one chunk; the readers under test do
 *  their own framing. */
export function sseBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.close()
      sent = true
      controller.enqueue(bytes)
    }
  })
}

/**
 * An idle clock for the runtimes' `idleClock` option. It keeps the latest scheduled callback
 * (`state.fire`, called by hand) and counts set / clear / unref, so a re-arm or a cancel is
 * observable without a wall-clock wait.
 */
export function fakeIdleClock(): {
  clock: { set(cb: () => void): { clear(): void; unref(): void } }
  state: { fire: (() => void) | null; setCount: number; clearCount: number; unrefCount: number }
} {
  const state = { fire: null as (() => void) | null, setCount: 0, clearCount: 0, unrefCount: 0 }
  const clock = {
    set(cb: () => void) {
      state.setCount++
      state.fire = cb
      return {
        clear: () => {
          state.clearCount++
          if (state.fire === cb) state.fire = null
        },
        unref: () => {
          state.unrefCount++
        }
      }
    }
  }
  return { clock, state }
}

/**
 * The cold-start fake (#635, #637). Wrap a sidecar's fake `fetch` so `/health` answers 503 until
 * `state.loaded`, as a llama-server loading its model does, while every other request goes to
 * `serve`. `state.probes` counts the health polls, so a test knows the start is in flight once it
 * is above zero.
 *
 * A start that never gets healthy is modelled as 503, never as a `/health` that hangs:
 * `LlamaServer.waitForHealthy` reads the start's abort signal only between probes, so a hanging
 * probe would hide a mutation that cancels the start.
 */
export function loadingSidecar(serve: typeof fetch): {
  fetchImpl: typeof fetch
  state: { loaded: boolean; probes: number }
} {
  const state = { loaded: false, probes: 0 }
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/health')) {
      state.probes++
      return { ok: state.loaded, status: state.loaded ? 200 : 503 } as Response
    }
    return serve(url, init)
  }) as typeof fetch
  return { fetchImpl, state }
}
