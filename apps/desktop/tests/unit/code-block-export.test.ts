import { describe, it, expect } from 'vitest'
import { codeBlockExtension } from '../../src/shared/code-block-export'

// #286 (owner decision D6): the fence info string → extension map is a FIXED allowlist. The info
// string is model output, so this is the only step between it and a filename/filter/audit row —
// every alias, the fallback and the token/strip rule are pinned here. The default file name
// (`code.<ext>`) is pinned through the real handler in chat-ipc.test.ts (#286).

describe('codeBlockExtension (#286 D6 allowlist)', () => {
  it.each([
    ['html', 'html'],
    ['js', 'js'],
    ['javascript', 'js'],
    ['ts', 'ts'],
    ['typescript', 'ts'],
    ['py', 'py'],
    ['python', 'py'],
    ['csv', 'csv'],
    ['json', 'json'],
    ['md', 'md'],
    ['markdown', 'md'],
    ['sh', 'sh'],
    ['bash', 'sh'],
    ['zsh', 'sh'],
    ['css', 'css'],
    ['xml', 'xml'],
    ['yaml', 'yml'],
    ['yml', 'yml'],
    ['sql', 'sql'],
    ['ps1', 'ps1'],
    ['powershell', 'ps1'],
    ['bat', 'bat'],
    ['cmd', 'bat'],
    ['svg', 'svg'],
    ['toml', 'toml'],
    ['txt', 'txt'],
    ['text', 'txt']
  ])('maps %s → .%s', (info, ext) => {
    expect(codeBlockExtension(info)).toBe(ext)
  })

  // #839 R3: the table above pins what the allowlist holds, so an entry ADDED to it fails nothing there. These binary,
  // installer, shortcut and script-host types stay outside D6's set (which does map bat/cmd, js, ps1 and sh, by decision):
  // a fence labelled with one of these names saves as .txt. The row sees a new KEY from this list, not a new value.
  it.each(['exe', 'com', 'scr', 'msi', 'lnk', 'vbs', 'vbscript', 'vbe', 'wsf', 'hta', 'cpl', 'jar', 'reg', 'dll', 'pif', 'msc'])(
    '%s is not on the allowlist: a fence labelled so saves as txt',
    (info) => {
      expect(codeBlockExtension(info)).toBe('txt')
    }
  )

  it('falls back to txt for an unknown language, an empty string and whitespace', () => {
    expect(codeBlockExtension('rust')).toBe('txt')
    expect(codeBlockExtension('')).toBe('txt')
    expect(codeBlockExtension('   ')).toBe('txt')
    expect(codeBlockExtension('\n')).toBe('txt')
  })

  it('takes only the first whitespace-separated token — an info string with attributes', () => {
    expect(codeBlockExtension('html title="x"')).toBe('html')
    expect(codeBlockExtension('  python   {.numberLines}')).toBe('py')
    expect(codeBlockExtension('js\tfilename=app.js')).toBe('js')
  })

  it('is case-insensitive', () => {
    expect(codeBlockExtension('HTML')).toBe('html')
    expect(codeBlockExtension('Python')).toBe('py')
    expect(codeBlockExtension('PowerShell')).toBe('ps1')
  })

  it('strips everything outside [a-z0-9+#.-] before the lookup; a kept + # . - blocks the lookup', () => {
    expect(codeBlockExtension('h!t@m$l')).toBe('html')
    // `+ # . -` survive the strip (a language alphabet: c++, c#, d.ts), and no allowlist key carries one,
    // so a token that keeps one falls back instead of mapping (stripping them would turn these into html/py/js).
    expect(codeBlockExtension('html.')).toBe('txt')
    expect(codeBlockExtension('py+')).toBe('txt')
    expect(codeBlockExtension('js-')).toBe('txt')
    expect(codeBlockExtension('c++')).toBe('txt')
    expect(codeBlockExtension('c#')).toBe('txt')
  })

  it('never lets garbage, path characters or prototype names through', () => {
    expect(codeBlockExtension('../../etc/passwd')).toBe('txt')
    expect(codeBlockExtension('..\\..\\x.exe')).toBe('txt')
    expect(codeBlockExtension('html/../x')).toBe('txt')
    expect(codeBlockExtension('<script>')).toBe('txt')
    expect(codeBlockExtension('\u0000html')).toBe('html') // control char stripped, token kept
    // Lower-casing and the strip turn these into `proto` / `tostring` / `hasownproperty` before the lookup, so they
    // prove the normalization, not the guard.
    expect(codeBlockExtension('__proto__')).toBe('txt')
    expect(codeBlockExtension('toString')).toBe('txt')
    expect(codeBlockExtension('hasOwnProperty')).toBe('txt')
    // `constructor` is the one Object.prototype member that survives normalization: it is the assert that reaches the
    // `Object.hasOwn` guard.
    expect(codeBlockExtension('constructor')).toBe('txt')
  })
})
