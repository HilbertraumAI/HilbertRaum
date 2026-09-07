import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CODE_BLOCK_EXTENSION,
  codeBlockDefaultFileName,
  codeBlockExtension,
  codeBlockLanguageToken
} from '../../src/shared/code-block-export'

// #286 (owner decision D6): the fence info string → extension map is a FIXED allowlist. The info
// string is model output, so this is the only step between it and a filename/filter/audit row —
// every alias, the fallback and the token/strip rule are pinned here.

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

  it('falls back to txt for an unknown language, an empty string and whitespace', () => {
    expect(DEFAULT_CODE_BLOCK_EXTENSION).toBe('txt')
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

  it('strips everything outside [a-z0-9+#.-] before the lookup', () => {
    expect(codeBlockLanguageToken('h!t@m$l')).toBe('html')
    expect(codeBlockExtension('h!t@m$l')).toBe('html')
    // The kept punctuation is a language alphabet (c++, c#, objective-c, d.ts) — still not in
    // the allowlist, so it falls back rather than becoming a filename.
    expect(codeBlockLanguageToken('C++')).toBe('c++')
    expect(codeBlockExtension('c++')).toBe('txt')
    expect(codeBlockExtension('c#')).toBe('txt')
  })

  it('never lets garbage, path characters or prototype names through', () => {
    expect(codeBlockExtension('../../etc/passwd')).toBe('txt')
    expect(codeBlockExtension('..\\..\\x.exe')).toBe('txt')
    expect(codeBlockExtension('html/../x')).toBe('txt')
    expect(codeBlockExtension('<script>')).toBe('txt')
    expect(codeBlockExtension('\u0000html')).toBe('html') // control char stripped, token kept
    expect(codeBlockExtension('__proto__')).toBe('txt')
    expect(codeBlockExtension('constructor')).toBe('txt')
    expect(codeBlockExtension('toString')).toBe('txt')
    expect(codeBlockExtension('hasOwnProperty')).toBe('txt')
  })

  it('the default file name is fixed and never derived from content', () => {
    expect(codeBlockDefaultFileName('html')).toBe('code.html')
    expect(codeBlockDefaultFileName('html title="Secret plan"')).toBe('code.html')
    expect(codeBlockDefaultFileName('')).toBe('code.txt')
    expect(codeBlockDefaultFileName('anything-secret')).toBe('code.txt')
  })
})
