import { beforeEach, describe, expect, it, vi } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchFn } from '../../src/main/services/assets'

// #564: the in-app downloads trust the operating system's certificate store as well as Node's default list
// (services/net/trust.ts): its usable roots only, added once, before `downloadToFile`'s first request, so the
// packaged binary can stop reading NODE_EXTRA_CA_CERTS. `node:tls` is faked and fed the certificates in
// tests/fixtures/certs (one per filter rule, see its README): no row reads this machine's store or changes the
// worker's trust, and nothing reaches the network. Each row loads the modules fresh, because the trust is set once
// per process. That the main process's real `fetch` honours `tls.setDefaultCACertificates` was measured on Electron
// 43.8.6's Node against a loopback TLS server (architecture.md "Electron fuses — design record (#562)" §8).
const tlsFake = vi.hoisted(() => {
  const stores: Record<string, string[]> = {}
  return {
    stores,
    getCACertificates: vi.fn((type: string = 'default') => [...(stores[type] ?? [])]),
    setDefaultCACertificates: vi.fn((_certs: readonly string[]) => undefined)
  }
})
vi.mock('node:tls', () => {
  const api = {
    getCACertificates: tlsFake.getCACertificates,
    setDefaultCACertificates: tlsFake.setDefaultCACertificates
  }
  return { ...api, default: api }
})
const logFake = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../src/main/services/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/services/logging')>()),
  log: logFake
}))

const cert = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', 'certs', `${name}.pem`), 'utf8')
const fingerprint = (pem: string): string => new X509Certificate(pem).fingerprint256

const DEFAULT_ROOT = cert('default-root')
const RSA_ROOT = cert('root-rsa2048')
const EC_ROOT = cert('root-ec-p256')
const ED25519_ROOT = cert('root-ed25519')
/** Node's list, as a stand-in: its own root plus the RSA root the OS store holds too. */
const DEFAULT_CERTS = [DEFAULT_ROOT, RSA_ROOT]
/** The OS store's copy of the RSA root, written differently (CRLF): the same certificate, another string. */
const RSA_ROOT_FROM_OS = RSA_ROOT.replace(/\n/g, '\r\n')

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  tlsFake.stores.default = [...DEFAULT_CERTS]
  tlsFake.stores.system = [RSA_ROOT_FROM_OS, EC_ROOT, ED25519_ROOT]
  tlsFake.getCACertificates.mockImplementation((type: string = 'default') => [...(tlsFake.stores[type] ?? [])])
  tlsFake.setDefaultCACertificates.mockImplementation(() => undefined)
})

const loadTrust = (): Promise<typeof import('../../src/main/services/net/trust')> =>
  import('../../src/main/services/net/trust')

/** Every line the module logged, at any level. */
const logged = (): unknown[][] => [...logFake.info.mock.calls, ...logFake.warn.mock.calls, ...logFake.error.mock.calls]

/** The one list handed to Node, by certificate. */
const trustedFingerprints = (): string[] => {
  expect(tlsFake.setDefaultCACertificates).toHaveBeenCalledTimes(1)
  return tlsFake.setDefaultCACertificates.mock.calls[0]![0].map(fingerprint)
}

describe('ensureSystemTrust: the OS store\'s usable roots join the default trust (#564)', () => {
  it('keeps every default certificate as it was and adds each new usable root once', async () => {
    const { ensureSystemTrust } = await loadTrust()
    ensureSystemTrust()
    const trusted = tlsFake.setDefaultCACertificates.mock.calls[0]?.[0] ?? []
    expect(trusted.slice(0, DEFAULT_CERTS.length)).toEqual(DEFAULT_CERTS)
    // The RSA root the default list holds already is not added a second time, though its text differs.
    expect(trustedFingerprints()).toEqual([DEFAULT_ROOT, RSA_ROOT, EC_ROOT, ED25519_ROOT].map(fingerprint))
    // One line, counts only: certificates read from the store, usable, new.
    expect(logged()).toEqual([[expect.any(String), { read: 3, kept: 3, added: 2 }]])
  })

  it('reads the store once: a second download changes nothing', async () => {
    const { ensureSystemTrust } = await loadTrust()
    ensureSystemTrust()
    ensureSystemTrust()
    expect(tlsFake.getCACertificates.mock.calls.filter(([type]) => type === 'system')).toHaveLength(1)
    expect(tlsFake.setDefaultCACertificates).toHaveBeenCalledTimes(1)
  })

  it('importing the module reads no store and changes no trust (never at startup)', async () => {
    await loadTrust()
    expect(tlsFake.getCACertificates).not.toHaveBeenCalled()
    expect(tlsFake.setDefaultCACertificates).not.toHaveBeenCalled()
  })

  // What Windows' store holds besides usable roots (measured: intermediates, self-signed server certificates,
  // expired and 1024-bit roots, an entry whose key does not decode). Each is left out; the usable root beside it
  // is still added, and nothing throws.
  it.each([
    ['an expired root', cert('root-expired')],
    ['a root that is not valid yet', cert('root-not-yet-valid')],
    ['a root with a 1024-bit RSA key', cert('root-rsa1024')],
    ['a root with a DSA key', cert('root-dsa')],
    ['an intermediate', cert('intermediate')],
    ['a certificate that names itself as issuer but another key signed', cert('name-twin')],
    ['a self-signed server certificate (not a CA)', cert('self-signed-leaf')],
    ['text that is not a certificate', 'not a certificate'],
    ['a PEM block whose body does not decode', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n']
  ] as const)('leaves out %s and still adds the usable root beside it', async (_case, entry) => {
    tlsFake.stores.system = [entry, EC_ROOT]
    const { ensureSystemTrust } = await loadTrust()
    expect(() => ensureSystemTrust()).not.toThrow()
    expect(trustedFingerprints()).toEqual([DEFAULT_ROOT, RSA_ROOT, EC_ROOT].map(fingerprint))
    expect(logged()).toEqual([[expect.any(String), { read: 2, kept: 1, added: 1 }]])
  })

  // The error's text quotes what a log must never carry (a certificate, a user's path).
  const leakyError = (): Error =>
    Object.assign(new Error('-----BEGIN CERTIFICATE----- C:\\Users\\XSENTINEL_564\\cert.pem'), { code: 'ERR_TEST_STORE' })

  it.each([
    [
      'a system store that cannot be read',
      () => {
        tlsFake.getCACertificates.mockImplementation((type: string = 'default') => {
          if (type === 'system') throw leakyError()
          return [...(tlsFake.stores[type] ?? [])]
        })
      }
    ],
    [
      'an empty system store',
      () => {
        tlsFake.stores.system = []
      }
    ],
    [
      'a system store with no usable root',
      () => {
        tlsFake.stores.system = [cert('root-expired'), cert('intermediate'), cert('self-signed-leaf')]
      }
    ],
    [
      'a system store whose usable roots Node trusts already',
      () => {
        tlsFake.stores.system = [RSA_ROOT_FROM_OS]
      }
    ],
    [
      'a list Node refuses',
      () => {
        tlsFake.setDefaultCACertificates.mockImplementation(() => {
          throw leakyError()
        })
      }
    ]
  ] as const)('keeps the default trust on %s, logs one content-free line and never retries', async (_case, arrange) => {
    arrange()
    const { ensureSystemTrust } = await loadTrust()
    expect(() => ensureSystemTrust()).not.toThrow()
    // Node replaces the list only on a call that succeeds, so a failed or skipped call leaves the default as it was.
    expect(tlsFake.setDefaultCACertificates.mock.results.filter((r) => r.type === 'return')).toHaveLength(0)
    expect(logged()).toHaveLength(1)
    expect(JSON.stringify(logged())).not.toMatch(/XSENTINEL_564|BEGIN CERTIFICATE/)

    const readsBefore = tlsFake.getCACertificates.mock.calls.length
    expect(() => ensureSystemTrust()).not.toThrow()
    expect(tlsFake.getCACertificates.mock.calls.length).toBe(readsBefore)
    expect(logged()).toHaveLength(1)
  })
})

describe('downloadToFile: every in-app download is trusted the same way (#564)', () => {
  it('the system store is trusted before the first request leaves', async () => {
    const { downloadToFile } = await import('../../src/main/services/assets')
    const trustSetAtRequest: number[] = []
    const fetchImpl: FetchFn = async () => {
      trustSetAtRequest.push(tlsFake.setDefaultCACertificates.mock.calls.length)
      return new Response('weights', { status: 200 })
    }
    const dest = join(mkdtempSync(join(tmpdir(), 'hilbertraum-trust-')), 'x.gguf')
    await downloadToFile('https://example.test/x.gguf', dest, { fetchImpl })
    expect(readFileSync(dest, 'utf8')).toBe('weights')
    expect(trustSetAtRequest).toEqual([1])
  })
})
