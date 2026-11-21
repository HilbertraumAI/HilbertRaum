import { describe, it, expect } from 'vitest'
import { redactLogText, type LogRedactionRoots } from '../../src/main/services/log-redact'

// #975 (owner decision G-4 b, the exit rule): every line the diagnostics log hands out (the Diagnostics panel, Copy,
// Save log) goes through `redactLogText`, so it names no absolute path and no account. The log at rest keeps them. These
// rows hold the redaction itself; core-model-ipc.test.ts holds the two exits that apply it.

const NONE: LogRedactionRoots = {}

/** A Windows profile at its deepest nesting: a dev drive root inside the home folder, the temp folder inside the home
 *  folder, a portable exe's folder inside the temp folder. Listed outermost first, so only the length order can win. */
const WIN: LogRedactionRoots = {
  home: 'C:\\Users\\xavi',
  driveRoot: 'C:\\Users\\xavi\\HilbertRaum Kit',
  appData: 'C:\\Users\\xavi\\AppData\\Roaming\\HilbertRaum',
  temp: 'C:\\Users\\xavi\\AppData\\Local\\Temp',
  app: 'C:\\Users\\xavi\\AppData\\Local\\Temp\\2kQx9'
}

/** The same on Linux: a Kit under the account's media folder, the app's data folder inside the home folder, an
 *  AppImage's mount inside the temp folder. */
const LINUX: LogRedactionRoots = {
  home: '/home/xavi',
  driveRoot: '/media/xavi/HILBERTRAUM',
  appData: '/home/xavi/.config/HilbertRaum',
  temp: '/tmp',
  app: '/tmp/.mount_HilberQ1'
}

const json = (text: string): string => JSON.stringify(text).slice(1, -1)
const slashes = (text: string): string => text.replaceAll('\\', '/')

describe('known roots become placeholders (#975 pass 1)', () => {
  const WIN_ROOTS: Array<[keyof LogRedactionRoots, string]> = [
    ['driveRoot', '<drive>'],
    ['appData', '<app-data>'],
    ['home', '<home>'],
    ['temp', '<temp>'],
    ['app', '<app>']
  ]
  /** [spelling, how a line spells the path, how it spells the placeholder and the rest]. */
  const WIN_SPELLINGS: Array<[string, (path: string) => string, (placeholder: string, rest: string) => string]> = [
    ['raw', (p) => `open '${p}'`, (ph, rest) => `open '${ph}${rest}'`],
    ['forward-slash', (p) => `open '${slashes(p)}'`, (ph, rest) => `open '${ph}${slashes(rest)}'`],
    ['JSON-escaped', (p) => `{"path":"${json(p)}"}`, (ph, rest) => `{"path":"${ph}${json(rest)}"}`],
    ['long-form', (p) => `open '\\\\?\\${p}'`, (ph, rest) => `open '\\\\?\\${ph}${rest}'`],
    ['file-URL', (p) => `<${encodeURI(`file:///${slashes(p)}`)}>`, (ph, rest) => `<file:///${ph}${slashes(rest)}>`],
    ['upper-case', (p) => `open '${p.toUpperCase()}'`, (ph, rest) => `open '${ph}${rest.toUpperCase()}'`],
    ['lower-case', (p) => `open '${p.toLowerCase()}'`, (ph, rest) => `open '${ph}${rest.toLowerCase()}'`]
  ]
  const rows = WIN_ROOTS.flatMap(([root, placeholder]) =>
    WIN_SPELLINGS.map(([spelling, line, expected]) => [`${root} ${spelling}`, root, placeholder, line, expected] as const)
  )
  it.each(rows)('Windows %s', (_title, root, placeholder, line, expected) => {
    const rest = '\\logs\\app.log'
    expect(redactLogText(line(`${WIN[root] as string}${rest}`), WIN)).toBe(expected(placeholder, rest))
  })

  it.each<[keyof LogRedactionRoots, string]>([
    ['driveRoot', '<drive>'],
    ['appData', '<app-data>'],
    ['home', '<home>'],
    ['temp', '<temp>'],
    ['app', '<app>']
  ])('POSIX %s, raw and as a file URL', (root, placeholder) => {
    const path = `${LINUX[root] as string}/logs/app.log`
    expect(redactLogText(`spawn ${path} ENOENT {"cwd":"${path}"}`, LINUX)).toBe(
      `spawn ${placeholder}/logs/app.log ENOENT {"cwd":"${placeholder}/logs/app.log"}`
    )
    expect(redactLogText(`file://${path}`, LINUX)).toBe(`file://${placeholder}/logs/app.log`)
  })

  it('a root alone, at the end of a JSON field, and a bare drive root (a Kit at E:\\)', () => {
    expect(redactLogText('Workspace resolved {"root":"C:\\\\Users\\\\xavi\\\\HilbertRaum Kit","preparedDrive":true}', WIN)).toBe(
      'Workspace resolved {"root":"<drive>","preparedDrive":true}'
    )
    const kit: LogRedactionRoots = { driveRoot: 'E:\\' }
    expect(redactLogText('Workspace resolved {"root":"E:\\\\","preparedDrive":true}', kit)).toBe(
      'Workspace resolved {"root":"<drive>\\\\","preparedDrive":true}'
    )
    expect(redactLogText("open 'e:\\runtime\\llama.cpp\\win\\llama-server.exe'", kit)).toBe(
      "open '<drive>\\runtime\\llama.cpp\\win\\llama-server.exe'"
    )
    // A bare drive letter in prose is no path.
    expect(redactLogText('the E: drive is full', kit)).toBe('the E: drive is full')
  })

  it('the longest root wins, whatever order the roots are registered in', () => {
    const outerFirst: LogRedactionRoots = { home: 'C:\\Users\\xavi', driveRoot: 'C:\\Users\\xavi\\HilbertRaum Kit' }
    const innerFirst: LogRedactionRoots = { driveRoot: 'C:\\Users\\xavi\\HilbertRaum Kit', home: 'C:\\Users\\xavi' }
    for (const roots of [outerFirst, innerFirst]) {
      expect(redactLogText('C:\\Users\\xavi\\HilbertRaum Kit\\models\\a.gguf C:\\Users\\xavi\\Desktop\\b.pdf', roots)).toBe(
        '<drive>\\models\\a.gguf <home>\\Desktop\\b.pdf'
      )
    }
  })

  it('a root matches whole segments only: C:\\Users\\x never takes the start of C:\\Users\\xavier', () => {
    const roots: LogRedactionRoots = { home: 'C:\\Users\\x' }
    expect(redactLogText("open 'C:\\Users\\xavier\\notes.txt' and 'C:\\Users\\x\\notes.txt'", roots)).toBe(
      "open 'C:\\Users\\<user>\\notes.txt' and '<home>\\notes.txt'"
    )
    expect(redactLogText('C:\\Users\\x.old\\a.txt', roots)).toBe('C:\\Users\\<user>\\a.txt')
    expect(redactLogText('/home/x2/a.txt', { home: '/home/x' })).toBe('/home/<user>/a.txt')
  })

  it('a root registered with a trailing separator or in its long form matches the same folder', () => {
    expect(redactLogText('C:\\Users\\xavi\\a.txt', { home: 'C:\\Users\\xavi\\' })).toBe('<home>\\a.txt')
    expect(redactLogText('C:\\Users\\xavi\\a.txt', { home: '\\\\?\\C:\\Users\\xavi' })).toBe('<home>\\a.txt')
  })

  it('the app-data folder names a workspace on the userData fallback (no Kit), not <drive>', () => {
    const fallback: LogRedactionRoots = {
      driveRoot: 'C:\\Users\\xavi\\AppData\\Roaming\\HilbertRaum',
      appData: 'C:\\Users\\xavi\\AppData\\Roaming\\HilbertRaum'
    }
    expect(redactLogText('{"root":"C:\\\\Users\\\\xavi\\\\AppData\\\\Roaming\\\\HilbertRaum"}', fallback)).toBe('{"root":"<app-data>"}')
  })

  it('a network root, its long form and its JSON spelling', () => {
    const roots: LogRedactionRoots = { driveRoot: '\\\\nas\\kits\\HilbertRaum' }
    expect(redactLogText('\\\\NAS\\kits\\HilbertRaum\\models\\a.gguf', roots)).toBe('<drive>\\models\\a.gguf')
    expect(redactLogText('\\\\?\\UNC\\nas\\kits\\HilbertRaum\\models', roots)).toBe('<drive>\\models')
    expect(redactLogText('{"p":"\\\\\\\\nas\\\\kits\\\\HilbertRaum\\\\models"}', roots)).toBe('{"p":"<drive>\\\\models"}')
  })

  it('a root that cannot be told from ordinary text is ignored: relative, "/" alone, empty', () => {
    const roots: LogRedactionRoots = { driveRoot: 'runtime', home: '/', temp: '' }
    expect(redactLogText('runtime/llama.cpp/win/llama-server.exe /usr/bin/env', roots)).toBe(
      'runtime/llama.cpp/win/llama-server.exe /usr/bin/env'
    )
  })
})

describe('generic shapes hide the account, volume and server (#975 pass 2)', () => {
  it.each<[string, string, string]>([
    [
      'an EPERM line',
      "EPERM: operation not permitted, open 'C:\\Users\\peter\\AppData\\x'",
      "EPERM: operation not permitted, open 'C:\\Users\\<user>\\AppData\\x'"
    ],
    [
      'the same in a JSON field',
      '{"error":"EPERM: operation not permitted, open \'C:\\\\Users\\\\peter\\\\AppData\\\\x\'"}',
      '{"error":"EPERM: operation not permitted, open \'C:\\\\Users\\\\<user>\\\\AppData\\\\x\'"}'
    ],
    ['forward slashes', 'C:/Users/peter/Documents/a.pdf', 'C:/Users/<user>/Documents/a.pdf'],
    ['an account with a space', 'C:\\Users\\Peter Müller\\Documents\\a.pdf', 'C:\\Users\\<user>\\Documents\\a.pdf'],
    ['an 8.3 short name', 'C:\\Users\\PETERS~1\\AppData\\Local\\Temp\\hr-1', 'C:\\Users\\<user>\\AppData\\Local\\Temp\\hr-1'],
    ['another letter case', 'd:\\USERS\\peter\\x', 'd:\\USERS\\<user>\\x'],
    ['the long form', '\\\\?\\C:\\Users\\peter\\x', '\\\\?\\C:\\Users\\<user>\\x'],
    ['a file URL', 'file:///C:/Users/Peter%20M/x.pdf', 'file:///C:/Users/<user>/x.pdf'],
    ['a profile under a drive-root placeholder', '<drive>\\Users\\peter\\x', '<drive>\\Users\\<user>\\x'],
    ['an account at the end of a sentence', 'C:\\Users\\peter is missing', 'C:\\Users\\<user> is missing'],
    ['a stderr tail after a JSON newline', '{"stderr":"load failed\\nC:\\\\Users\\\\peter\\\\m.gguf"}', '{"stderr":"load failed\\nC:\\\\Users\\\\<user>\\\\m.gguf"}'],
    ['a network path', "open '\\\\PETERS-PC\\share\\docs\\a.pdf'", "open '\\\\<server>\\<share>\\docs\\a.pdf'"],
    ['a network path in JSON', '{"p":"\\\\\\\\PETERS-PC\\\\share\\\\docs"}', '{"p":"\\\\\\\\<server>\\\\<share>\\\\docs"}'],
    ['a long-form network path', '\\\\?\\UNC\\PETERS-PC\\share\\docs', '\\\\?\\UNC\\<server>\\<share>\\docs'],
    ['a shared profile folder', '\\\\PETERS-PC\\Users\\peter\\x', '\\\\<server>\\<share>\\<user>\\x'],
    ['a network file URL', 'file://PETERS-PC/share/docs/a.pdf', 'file://<server>/<share>/docs/a.pdf'],
    ['a macOS home', "open '/Users/peter/Library/x'", "open '/Users/<user>/Library/x'"],
    ['a Linux home', 'cwd=/home/peter/.config/x', 'cwd=/home/<user>/.config/x'],
    ['a POSIX home as a file URL', 'file:///home/peter/x', 'file:///home/<user>/x'],
    ['a POSIX home after a JSON newline', '"load failed\\n/home/peter/m.gguf"', '"load failed\\n/home/<user>/m.gguf"'],
    ['a macOS volume', 'spawn /Volumes/Kit/runtime/llama.cpp/mac/llama-server', 'spawn /Volumes/<volume>/runtime/llama.cpp/mac/llama-server'],
    ['a Linux removable drive', 'spawn /media/peter/Kit/runtime/x', 'spawn /media/<user>/<volume>/runtime/x'],
    ['a Linux removable drive under /run', 'spawn /run/media/peter/Kit/runtime/x', 'spawn /run/media/<user>/<volume>/runtime/x'],
    ['a Windows profile under WSL', 'open /mnt/c/Users/peter/x', 'open /mnt/c/Users/<user>/x'],
    ['a Linux mount point', 'open /mnt/usbstick/x', 'open /mnt/<volume>/x']
  ])('%s', (_what, line, expected) => {
    expect(redactLogText(line, NONE)).toBe(expected)
  })
})

describe('what is no absolute path stays as it is (#975)', () => {
  it.each<[string, string]>([
    ['a model file name', 'Model qwen3-4b-instruct-q4.gguf started {"port":8080}'],
    ['an https URL', 'download https://example.org/a/b failed'],
    ['an https URL with a profile-like path', 'https://example.org/Users/peter/home/x and http://localhost:8080/media/a/b'],
    ['a relative path', 'runtime/llama.cpp/win/llama-server.exe and runtime\\llama.cpp\\win\\llama-server.exe'],
    ['a sentence with a slash', 'Copy and/or save the log; 3/4 done, read/write.'],
    ['a time stamp and a skill id', '2026-11-21T10:00:00.000Z [INFO] skill fence {"skillId":"app:meeting-minutes"}'],
    ['a POSIX path with no account', 'spawn /usr/bin/tesseract in /var/folders/zz/T/hr-1']
  ])('%s', (_what, line) => {
    expect(redactLogText(line, NONE)).toBe(line)
    expect(redactLogText(line, WIN)).toBe(line)
    expect(redactLogText(line, LINUX)).toBe(line)
  })
})

describe('redacting twice changes nothing (#975)', () => {
  const lines = [
    "EPERM: operation not permitted, open 'C:\\Users\\peter\\AppData\\x'",
    '{"root":"C:\\\\Users\\\\xavi\\\\HilbertRaum Kit","p":"\\\\\\\\PETERS-PC\\\\share\\\\docs"}',
    'file:///C:/Users/xavi/HilbertRaum%20Kit/a C:\\Users\\PETERS~1\\x',
    'spawn /media/peter/Kit/runtime/x /Volumes/Kit/a /mnt/usbstick/b /home/xavi/c',
    '\\\\?\\UNC\\PETERS-PC\\Users\\peter\\x file://PETERS-PC/share/d'
  ]
  it.each(lines.flatMap((line) => [WIN, LINUX, NONE].map((roots) => [line, roots] as const)))('%s', (line, roots) => {
    const once = redactLogText(line, roots)
    expect(redactLogText(once, roots)).toBe(once)
  })
})
