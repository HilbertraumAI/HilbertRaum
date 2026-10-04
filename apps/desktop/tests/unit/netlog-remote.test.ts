import { describe, it, expect } from 'vitest'
import { bareHost, parseNetLog, remoteRequests } from '../../../../scripts/lib/netlog-remote.mjs'

// #567: the net-log reader behind scripts/check-netlog.mjs. The event shapes below are copied
// from real Electron 43 net logs (Windows and Linux) of the spell checker's dictionary download,
// the WPAD lookup, and loopback traffic.

const TYPES = {
  URL_REQUEST_START_JOB: 1,
  HOST_RESOLVER_MANAGER_REQUEST: 2,
  HTTP_SERVER_PROPERTIES_UPDATE_CACHE: 3,
  TRANSPORT_SECURITY_STATE_SHOULD_UPGRADE_TO_SSL: 4
}
const log = (events: Array<{ type: number; params?: Record<string, unknown> }>) => ({
  constants: { logEventTypes: TYPES },
  events
})

describe('remoteRequests (#567)', () => {
  it('reports the dictionary download and the WPAD lookup, with counts', () => {
    const r = remoteRequests(
      log([
        { type: 1, params: { url: 'https://redirector.gvt1.com/edgedl/chrome/dict/pl-pl-3-0.bdic' } },
        { type: 1, params: { url: 'https://redirector.gvt1.com/edgedl/chrome/dict/pl-pl-3-0.bdic' } },
        { type: 1, params: { url: 'http://wpad/wpad.dat' } },
        { type: 2, params: { host: 'wpad:80' } },
        { type: 2, params: { host: 'http://wpad' } },
        { type: 2, params: { host: 'https://redirector.gvt1.com' } }
      ])
    )
    expect(r.urls).toEqual({
      'https://redirector.gvt1.com/edgedl/chrome/dict/pl-pl-3-0.bdic': 2,
      'http://wpad/wpad.dat': 1
    })
    expect(r.hosts).toEqual({ wpad: 2, 'redirector.gvt1.com': 1 })
  })

  it('ignores loopback, the app scheme and data: URLs', () => {
    const r = remoteRequests(
      log([
        { type: 1, params: { url: 'http://127.0.0.1:49190/net-fetch' } },
        { type: 1, params: { url: 'http://localhost:5173/' } },
        { type: 1, params: { url: 'http://[::1]:9333/json/version' } },
        { type: 1, params: { url: 'hilbertraum://app/index.html' } },
        { type: 1, params: { url: 'data:text/html,<p>x</p>' } },
        { type: 2, params: { host: 'http://127.0.0.1:49190' } },
        { type: 2, params: { host: 'localhost:5173' } }
      ])
    )
    expect(r).toEqual({ urls: {}, hosts: {} })
  })

  it('does not count saved state that only names a host (the QUIC hints kept after a download)', () => {
    const r = remoteRequests(
      log([
        {
          type: 3,
          params: { broken_alternative_services: [{ host: 'r12---sn-x.gvt1.com', port: 443 }] }
        },
        { type: 4, params: { host: 'redirector.gvt1.com' } }
      ])
    )
    expect(r).toEqual({ urls: {}, hosts: {} })
  })

  it('a log without the event types reports nothing rather than throwing', () => {
    expect(remoteRequests({})).toEqual({ urls: {}, hosts: {} })
  })
})

describe('bareHost', () => {
  it.each([
    ['wpad:80', 'wpad'],
    ['http://wpad', 'wpad'],
    ['https://Redirector.GVT1.com/edgedl/x.bdic?a=1', 'redirector.gvt1.com'],
    ['https://[::1]:9333/json', '::1'],
    ['::1', '::1'],
    ['127.0.0.1:49190', '127.0.0.1']
  ])('%s → %s', (input, expected) => {
    expect(bareHost(input)).toBe(expected)
  })
})

describe('parseNetLog', () => {
  it('reads a log a killed process left without its closing brackets', () => {
    const open = '{"constants":{"logEventTypes":{"URL_REQUEST_START_JOB":1}},"events":[\n{"type":1,"params":{"url":"http://wpad/wpad.dat"}},\n'
    expect(remoteRequests(parseNetLog(open)).urls).toEqual({ 'http://wpad/wpad.dat': 1 })
  })
})
