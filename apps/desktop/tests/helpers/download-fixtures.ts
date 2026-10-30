// Fake `fetch` seams and open gates for the downloader suites: nothing here reaches the network. Constraint: type-only
// imports from the services and no `node:fs`, so it is safe beside downloads.test's `vi.mock` of assets and beside a
// `vi.mock('node:fs')`.
import type { FetchFn } from '../../src/main/services/assets'
import type { DownloadGates } from '../../src/main/services/downloads'

/** Both network gates open. Replaces the suites' local `OPEN`. A closed-gate row spells its own gates. */
export const OPEN_GATES: DownloadGates = { policyAllows: true, settingAllows: true }

/**
 * Answers every request with `body` (200 + content-length). Ignores Range and the signal: `rangeFetch` and `hangingFetch`
 * are those. Replaces download-ipc's `okFetch` and fsync durability's `bodyFetch`.
 */
export function bodyFetch(body: string): FetchFn {
  return async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-length': String(body.length) }
    })
}

/**
 * Streams one chunk, then stays open until the request's signal aborts, when the body errors with an AbortError. Sends no
 * content-length. A signal already aborted when the fake is called is not noticed, as in every copy. Replaces
 * `hangingFetch` (downloads, download-ipc) and download-ipc's `hanging`, and download-fail-close's inline fake.
 */
export function hangingFetch(firstChunk: string): FetchFn {
  return async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstChunk))
        signal?.addEventListener('abort', () =>
          controller.error(new DOMException('aborted', 'AbortError'))
        )
      }
    })
    return new Response(stream, { status: 200 })
  }
}

/**
 * Serves `body`, honouring `Range: bytes=N-` with a 206 when `honourRange` (else a full 200), and records every request's
 * Range header. Replaces downloads.test's `rangeFetch`. It does not check the signal or send a Content-Range header.
 */
export function rangeFetch(
  body: string,
  o: { honourRange?: boolean } = {}
): { fetch: FetchFn; ranges: Array<string | null> } {
  const ranges: Array<string | null> = []
  const fetch: FetchFn = async (_url: unknown, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range')
    ranges.push(range)
    const m = range && o.honourRange ? /^bytes=(\d+)-$/.exec(range) : null
    const slice = m ? body.slice(Number(m[1])) : body
    return new Response(slice, {
      status: m ? 206 : 200,
      headers: { 'content-length': String(slice.length) }
    })
  }
  return { fetch, ranges }
}

/**
 * Serves one body per URL (404 for an unrouted one) and records every URL asked for. Replaces downloads.test's
 * `routedFetch`. It ignores Range and the signal.
 */
export function routedFetch(routes: Record<string, string>): { fetch: FetchFn; urls: string[] } {
  const urls: string[] = []
  const fetch: FetchFn = async (url: unknown) => {
    const u = String(url)
    urls.push(u)
    const body = routes[u]
    if (body == null) return new Response(null, { status: 404 })
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
  }
  return { fetch, urls }
}
