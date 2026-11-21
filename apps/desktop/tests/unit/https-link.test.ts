import { describe, expect, it } from 'vitest'
import { httpsLink } from '../../src/renderer/lib/httpsLink'

// #894: the one https-only parse behind the three licence links (the Models screen, the engine confirm dialog and the
// Knowledge-pack tools dialog). The component rows pin the wiring; this table pins the rule itself, which no component
// row reaches: the normalised href, the host WITH its port, and every scheme that must not become an anchor.

describe('httpsLink (#894)', () => {
  it.each([
    ['a plain https URL', 'https://example.test/license', { href: 'https://example.test/license', host: 'example.test' }],
    [
      'an upper-case scheme and host, a port and a space: normalised, host keeps the port',
      'HTTPS://Example.TEST:8443/a b',
      { href: 'https://example.test:8443/a%20b', host: 'example.test:8443' }
    ],
    ['padding around the URL: anchor and host come from the same parse', '  https://example.test/x  ', { href: 'https://example.test/x', host: 'example.test' }]
  ])('links %s', (_what, input, expected) => {
    expect(httpsLink(input)).toEqual(expected)
  })

  it.each([
    'http://example.test/x',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://example.test/',
    'file:///c:/x',
    '//example.test/x',
    'not a url',
    'https://',
    '   ',
    '',
    null,
    undefined
  ])('gives no link for %j', (input) => {
    expect(httpsLink(input)).toBeNull()
  })
})
