// Which requests did the browser engine send off the machine? (#567)
//
// A Chromium net log (`--log-net-log=<file>`) records the requests and host-name lookups of the
// browser process itself: the class of traffic that neither the page CSP nor the Node-side
// offline tripwire (`offlineGuard.ts`) can see, such as the spell checker's dictionary download
// and the WPAD proxy lookup. `remoteRequests` reads exactly two event types, never free text: a
// URL request that started (URL_REQUEST_START_JOB) and a host-name lookup
// (HOST_RESOLVER_MANAGER_REQUEST). Saved state that only NAMES a host, such as the QUIC hints
// Chromium keeps after an earlier download, is not a request and is not reported. Loopback and
// the app's own non-network schemes are not remote.
//
// Used by scripts/check-netlog.mjs; pinned by apps/desktop/tests/unit/netlog-remote.test.ts.

const LOCAL_SCHEME = /^(?:data|blob|about|chrome|devtools|hilbertraum):/i
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/i

/** `wpad:80`, `http://wpad`, `https://[::1]:9333/x` → `wpad`, `wpad`, `::1`. */
export function bareHost(value) {
  const hostPort = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '')
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(hostPort)
  if (bracketed) return bracketed[1].toLowerCase()
  // One colon = host:port; more = a bare IPv6 address, which has no port to strip.
  const host = (hostPort.match(/:/g) ?? []).length === 1 ? hostPort.replace(/:\d+$/, '') : hostPort
  return host.toLowerCase()
}

/** URL → count and host → count of everything that would have left the machine. */
export function remoteRequests(netlog) {
  const types = netlog?.constants?.logEventTypes ?? {}
  const urls = {}
  const hosts = {}
  for (const event of netlog?.events ?? []) {
    const params = event.params
    if (!params) continue
    if (event.type === types.URL_REQUEST_START_JOB && typeof params.url === 'string') {
      if (!LOCAL_SCHEME.test(params.url) && !LOOPBACK.test(bareHost(params.url)))
        urls[params.url] = (urls[params.url] ?? 0) + 1
    } else if (event.type === types.HOST_RESOLVER_MANAGER_REQUEST && typeof params.host === 'string') {
      const host = bareHost(params.host)
      if (!LOOPBACK.test(host)) hosts[host] = (hosts[host] ?? 0) + 1
    }
  }
  return { urls, hosts }
}

/** Parse a net log, including one a killed process left without its closing `]}`. */
export function parseNetLog(text) {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(text.replace(/,?\s*$/, '') + ']}')
  }
}
