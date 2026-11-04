import net from 'node:net'

// Startup offline self-check (spec §3.6 "no network calls by design").
//
// The core path makes no outbound network calls at all — this is a tripwire that
// LOGS (does not crash) if anything ever tries to reach a REMOTE host while the app
// is offline. Loopback (127.0.0.0/8, ::1, localhost) is explicitly NOT "network":
// the dev renderer loads from http://localhost today and the llama.cpp
// sidecar binds 127.0.0.1, so loopback connections must always be permitted.

/**
 * True when `host` is a loopback address (or unspecified, which `net` resolves to
 * localhost). Only genuinely remote hosts return false. Loopback is never treated as
 * a network call — see the module header.
 *
 * SECURITY (L-1): this is a DETECTION helper only — it must NEVER gate an
 * allowed-vs-blocked enforcement decision. The offline guard is detection-only by design
 * (audit M-S1; security-model.md "Detection-only, not enforcement"), so an over-match
 * here only ever costs an audit line, never an allowed remote connection. The IPv4 form
 * is anchored end-to-end (`/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/`) so a hostname like
 * `127.evil.com` / `127.0.0.1.evil.com` is NOT misclassified as loopback. IPv4-mapped loopback
 * comes in two spellings: dotted, and the hex one the URL parser turns `[::ffff:127.0.0.1]` into.
 */
export function isLoopbackHost(host?: string | null): boolean {
  if (!host) return true // net.connect() with no host defaults to localhost
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1) // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  if (/^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h)) return true
  return false
}

/**
 * Extract the target host from the arguments of `net.Socket.prototype.connect`. `net.connect`,
 * `http.request` and plain-http `fetch` hand over Node's normalized `[options, callback]` array
 * (#751); a direct `socket.connect(...)` and TLS pass the options or the positional form.
 */
function extractHost(args: unknown[]): string | undefined {
  const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (first && typeof first === 'object') {
    const opts = first as { host?: unknown; path?: unknown }
    if (typeof opts.path === 'string') return undefined // unix domain socket = local IPC
    return typeof opts.host === 'string' ? opts.host : undefined
  }
  // connect(port, host, ...)
  return typeof args[1] === 'string' ? args[1] : undefined
}

export interface OfflineGuardOptions {
  /**
   * Is the app offline right now? Asked at the connect, and only for a remote host (#758): the app's
   * offline state changes during a session (an unlock, the network setting, the policy file), so a
   * reading taken once at install recorded downloads the user accepted and missed a session that went
   * offline later. A throw counts as offline.
   */
  isOffline: () => boolean
  /** Called (once per offending connect) when a remote host is targeted while offline. */
  onViolation?: (host: string) => void
}

/** `read()`, with a throw counting as offline: a posture that cannot be read is not permission. */
function offlineNow(read: () => boolean): boolean {
  try {
    return read()
  } catch {
    return true
  }
}

/**
 * Install a defensive tripwire over `net.Socket.prototype.connect`. Any connection to a remote host
 * while `isOffline()` says so invokes `onViolation` (which logs). It NEVER blocks the connection or
 * throws — a wrong host guess must not break loopback IPC or the sidecars. Loopback is decided first,
 * so the posture is read only for a remote host. Returns an uninstaller (restores the original).
 */
export function installOfflineNetworkGuard(opts: OfflineGuardOptions): () => void {
  const proto = net.Socket.prototype as unknown as {
    connect: (...args: unknown[]) => unknown
  }
  const original = proto.connect
  proto.connect = function patchedConnect(this: unknown, ...args: unknown[]): unknown {
    try {
      const host = extractHost(args)
      if (host && !isLoopbackHost(host) && offlineNow(opts.isOffline)) opts.onViolation?.(host)
    } catch {
      /* a detector must never break the real connect */
    }
    return original.apply(this, args)
  }

  return () => {
    proto.connect = original
  }
}

/** The two `PolicyStatus` fields the self-check reads, so a `PolicyStatus` is a posture as it stands. */
export interface OfflinePosture {
  offlineMode: boolean
  networkAllowed: boolean
}

export interface AssertOfflinePostureDeps {
  /**
   * The app's offline posture right now: read once for the startup log line, then by the tripwire at
   * every remote connect (#758). Production passes `currentPolicyStatus`, the reading `getPolicy`
   * gives the Privacy screen. A throw reads as offline.
   */
  readPosture: () => OfflinePosture
  log: (msg: string, meta?: unknown) => void
  warn: (msg: string, meta?: unknown) => void
  /** Extra per-violation hook (feeds the audit log) — called alongside `warn`. */
  onViolation?: (host: string) => void
}

/**
 * Startup self-check: log the offline posture as it stands at startup, and install the tripwire for
 * the whole session. It is a loopback-exempt safety net in ALL builds, not a dev-only diagnostic.
 * Defensive — only logs; returns an uninstaller for the guard.
 */
export function assertOfflinePosture(deps: AssertOfflinePostureDeps): () => void {
  let atStartup: OfflinePosture
  try {
    atStartup = deps.readPosture()
  } catch (err) {
    // Fail closed, but say why: a reader that keeps throwing makes every remote connect read as offline.
    deps.warn('Offline posture could not be read; treated as offline', {
      error: err instanceof Error ? err.message : String(err)
    })
    atStartup = { offlineMode: true, networkAllowed: false }
  }
  deps.log('Offline posture', {
    offlineMode: atStartup.offlineMode,
    networkAllowed: atStartup.networkAllowed,
    note: 'At startup; re-read at every remote connect. No network in the core path; loopback (127.0.0.1/localhost) is exempt.'
  })
  return installOfflineNetworkGuard({
    isOffline: () => deps.readPosture().offlineMode,
    onViolation: (host) => {
      // Detection-only, by decision (audit M-S1; security-model.md "Detection-only, not
      // enforcement"): the connect is LOGGED + AUDITED, not blocked. Blocking net.Socket
      // app-wide could turn a host-extraction edge case into a hard offline failure that
      // breaks loopback IPC / the sidecar — strictly worse than logging. The offline
      // guarantee rests on the no-remote-code posture + the prod CSP; this is defence in
      // depth. The core path makes no remote calls, so a firing indicates a regression — or a
      // download or install the user started, still running after a lock or after the network
      // setting went off, opening a new connection (#758; known-limitations.md).
      deps.warn('Offline posture: remote connection attempt detected (logged, not blocked)', { host })
      deps.onViolation?.(host)
    }
  })
}
