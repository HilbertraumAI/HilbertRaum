// A llama-server that is still loading its model — the cold-start fake shared by the suites of the
// lazily started sidecars (the embedder and the reranker since #635, vision and translation since
// #637).

/**
 * Wrap a sidecar's fake `fetch` so `/health` answers 503 until `state.loaded`, as a llama-server
 * loading its model does, while every other request goes to `serve`. `state.probes` counts the
 * health polls, so a test knows the start is in flight once it is above zero.
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
