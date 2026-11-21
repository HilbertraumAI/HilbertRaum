import { X509Certificate } from 'node:crypto'
import tls from 'node:tls'
import { log } from '../logging'

// The in-app downloads' TLS trust (#564). The main process's `fetch` (Node's undici) trusts Node's
// bundled roots plus NODE_EXTRA_CA_CERTS, never the operating system's certificate store. Antivirus
// that scans HTTPS (Norton, measured) and corporate proxies re-sign it with a root they install in
// the OS store, so once the packaged binary stopped reading NODE_EXTRA_CA_CERTS (the
// EnableNodeOptionsEnvironmentVariable fuse, off since #564) every download behind one would fail
// with "fetch failed". `ensureSystemTrust` adds the OS store's usable roots to Node's default list:
// - Filtered: Windows' store, as Node reads it, also holds intermediates, self-signed server
//   certificates, expired and 1024-bit roots and entries whose key does not even decode (measured
//   on one Windows machine: 26 of 120 entries left out). Only a certificate that parses, is a CA,
//   is self-signed, is inside its validity window and has an RSA key of at least 2048 bits or a
//   P-256/P-384/P-521 or Ed25519 key is added (`usableRoot`), and only when the default list lacks
//   it. Node's list does not say which Windows store a certificate came from, so a self-signed CA
//   from an Intermediate store, or the machine's Trusted People store, counts as well; Windows'
//   Disallowed store is not consulted (architecture.md "Electron fuses — design record (#562)" §8).
// - Additive: every certificate of the default list (bundled + NODE_EXTRA_CA_CERTS, where a build
//   still reads it) stays; a connection that verified before still does. Electron's SPKI blocklist
//   (the eMudhra intermediates) is a verify-time check, independent of this list.
// - Once, lazily: reading and filtering the OS store costs about 50–110 ms on the main thread
//   (Windows, measured: read, filter and set), so it runs right before the first download's first request, never at startup
//   (first paint). Its one caller is `downloadToFile` (assets.ts), which every remote request of
//   the main process goes through; the sidecar clients talk plain HTTP on loopback.
// - Never throws into a download: a store that cannot be read, one with no usable root (an empty
//   store on a minimal Linux) or a list Node refuses leaves today's trust as it is, with one log
//   line that carries counts or an error code, never a certificate.
// Node applies the new list to TLS connections opened afterwards on this thread; Chromium has its
// own verifier and is not affected. The two `tls` functions are read off the module at the call,
// not imported by name: on a Node without them (`getCACertificates` came in 22.15,
// `setDefaultCACertificates` in 24.5; the repo's floor is 22.12) the call fails and is caught,
// where a named import would fail to load every module that imports assets.ts.
// Record: architecture.md "Electron fuses — design record (#562)" §8 (#564 amendment).

/** Set once the first download asked, whatever came of it: the store is read once per process. */
let settled = false

/** RSA keys shorter than this are refused, as browsers refuse them. */
const MIN_RSA_BITS = 2048
/** The EC curves a root may use (P-256, P-384, P-521); an OpenSSL build of Node decodes weaker ones too. */
const EC_CURVES: ReadonlySet<string> = new Set(['prime256v1', 'secp384r1', 'secp521r1'])

/**
 * The certificate, when it may anchor a download's TLS chain: it parses, is a CA, is self-signed,
 * is valid now, and has an RSA key of at least 2048 bits or a P-256/P-384/P-521 or Ed25519 key.
 * Self-signed takes both checks: `checkIssued` against itself (its issuer name is its own subject,
 * the key identifiers agree, the key may sign certificates) never looks at the signature, so a
 * certificate that only names itself, signed by another key and without key identifiers, passes
 * it; `verify` with its own key is what proves the signature. Anything that throws on the way (a
 * body that does not parse, a key that does not decode) is not usable.
 */
function usableRoot(pem: string, now: number): X509Certificate | null {
  try {
    const cert = new X509Certificate(pem)
    if (!cert.ca) return null
    if (!cert.checkIssued(cert)) return null
    if (now < cert.validFromDate.getTime() || now > cert.validToDate.getTime()) return null
    const key = cert.publicKey
    const type = key.asymmetricKeyType
    const strongKey =
      type === 'rsa' || type === 'rsa-pss'
        ? (key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_RSA_BITS
        : type === 'ec'
          ? EC_CURVES.has(key.asymmetricKeyDetails?.namedCurve ?? '')
          : type === 'ed25519'
    if (!strongKey) return null
    return cert.verify(key) ? cert : null
  } catch {
    return null
  }
}

/** A certificate's identity for de-duplication; a PEM that does not parse is its own identity. */
function fingerprintOf(pem: string): string {
  try {
    return new X509Certificate(pem).fingerprint256
  } catch {
    return pem
  }
}

/** Trust the OS certificate store's usable roots too, from the first call on. Idempotent; never throws. */
export function ensureSystemTrust(): void {
  if (settled) return
  settled = true
  let system: string[]
  try {
    system = tls.getCACertificates('system')
  } catch (err) {
    log.warn('Download trust: the system certificate store could not be read; the default trust stays', {
      error: errorCode(err)
    })
    return
  }
  const now = Date.now()
  const usable = system.map((pem) => usableRoot(pem, now)).filter((cert): cert is X509Certificate => cert !== null)
  try {
    const current = tls.getCACertificates('default')
    const known = new Set(current.map(fingerprintOf))
    const added: string[] = []
    for (const cert of usable) {
      if (known.has(cert.fingerprint256)) continue
      known.add(cert.fingerprint256)
      added.push(cert.toString())
    }
    const counts = { read: system.length, kept: usable.length, added: added.length }
    // Nothing new (an empty store, no usable root, or only roots Node has already): the list stays as it is.
    if (added.length === 0) {
      log.info('Download trust: nothing to add from the system certificate store; the default trust stays', counts)
      return
    }
    tls.setDefaultCACertificates([...current, ...added])
    log.info('Download trust: the system certificate store is trusted too', counts)
  } catch (err) {
    log.warn('Download trust: the system certificates could not be added; the default trust stays', {
      error: errorCode(err)
    })
  }
}

/** The error's code or class name: never its message, which may quote a certificate or a path. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  return err instanceof Error ? err.name : typeof err
}
