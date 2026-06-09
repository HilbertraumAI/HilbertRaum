import net from 'node:net'

// Startup offline self-check (spec §3.6 "no network calls by design").
//
// The core path makes no outbound network calls at all — this is a tripwire that
// LOGS (does not crash) if anything ever tries to reach a REMOTE host while the app
// is offline. Loopback (127.0.0.0/8, ::1, localhost) is explicitly NOT "network":
// the dev renderer loads from http://localhost today and the Phase-10 llama.cpp
// sidecar binds 127.0.0.1, so loopback connections must always be permitted.

/**
 * True when `host` is a loopback address (or unspecified, which `net` resolves to
 * localhost). Only genuinely remote hosts return false. Loopback is never treated as
 * a network call — see the module header.
 */
export function isLoopbackHost(host?: string | null): boolean {
  if (!host) return true // net.connect() with no host defaults to localhost
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1) // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '::ffff:127.0.0.1') return true
  if (/^127\./.test(h)) return true
  return false
}

export interface OutboundCheck {
  host: string
  violation: boolean
}

/**
 * Decide whether an outbound connection to `host` violates the offline posture.
 * A violation requires BOTH offline mode AND a remote (non-loopback) host.
 */
export function checkOutboundHost(host: string | undefined | null, offline: boolean): OutboundCheck {
  const loopback = isLoopbackHost(host)
  return { host: host ?? '(default localhost)', violation: offline && !loopback }
}

/** Extract the target host from the arguments of `net.Socket.prototype.connect`. */
function extractHost(args: unknown[]): string | undefined {
  const first = args[0]
  if (first && typeof first === 'object') {
    const opts = first as { host?: unknown; path?: unknown }
    if (typeof opts.path === 'string') return undefined // unix domain socket = local IPC
    return typeof opts.host === 'string' ? opts.host : undefined
  }
  // connect(port, host, ...)
  return typeof args[1] === 'string' ? args[1] : undefined
}

export interface OfflineGuardOptions {
  offline: boolean
  /** Called (once per offending connect) when a remote host is targeted while offline. */
  onViolation?: (host: string) => void
}

/**
 * Install a defensive tripwire over `net.Socket.prototype.connect`. While offline, any
 * connection to a remote host invokes `onViolation` (which logs). It NEVER blocks the
 * connection or throws — a wrong host guess must not break loopback IPC or the future
 * sidecar. A no-op when `offline` is false. Returns an uninstaller (restores the original).
 */
export function installOfflineNetworkGuard(opts: OfflineGuardOptions): () => void {
  if (!opts.offline) return () => {}

  const proto = net.Socket.prototype as unknown as {
    connect: (...args: unknown[]) => unknown
  }
  const original = proto.connect
  proto.connect = function patchedConnect(this: unknown, ...args: unknown[]): unknown {
    try {
      const { host, violation } = checkOutboundHost(extractHost(args), true)
      if (violation) opts.onViolation?.(host)
    } catch {
      /* a detector must never break the real connect */
    }
    return original.apply(this, args)
  }

  return () => {
    proto.connect = original
  }
}

export interface OfflinePosture {
  offline: boolean
  networkAllowed: boolean
}

export interface AssertOfflinePostureDeps {
  posture: OfflinePosture
  /** Whether to install the live connect tripwire (gated to dev / developer mode). */
  installGuard: boolean
  log: (msg: string, meta?: unknown) => void
  warn: (msg: string, meta?: unknown) => void
}

/**
 * Startup self-check: log the offline posture and, when enabled, install the tripwire.
 * Defensive — only logs; returns an uninstaller for the guard (no-op if not installed).
 */
export function assertOfflinePosture(deps: AssertOfflinePostureDeps): () => void {
  const { posture } = deps
  deps.log('Offline posture', {
    offlineMode: posture.offline,
    networkAllowed: posture.networkAllowed,
    note: 'No network in the core path; loopback (127.0.0.1/localhost) is exempt.'
  })
  if (!posture.offline) return () => {}
  if (!deps.installGuard) return () => {}
  return installOfflineNetworkGuard({
    offline: true,
    onViolation: (host) =>
      deps.warn('Offline posture: blocked-by-design remote connection attempt detected', { host })
  })
}
