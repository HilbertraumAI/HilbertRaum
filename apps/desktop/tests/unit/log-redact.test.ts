import { describe, it, expect, afterEach } from 'vitest'
import { homedir, userInfo } from 'node:os'
import {
  accountNamesFrom,
  addLogRedactionRoots,
  currentAccountNames,
  logRedactionRoots,
  redactLogText,
  setLogRedactionRoots,
  type LogRedactionRoots
} from '../../src/main/services/log-redact'

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
    // The URL keeps its third slash, as the Windows form does (`file:///<drive>/…`).
    expect(redactLogText(`file://${path}`, LINUX)).toBe(`file:///${placeholder}/logs/app.log`)
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

// #975 review round 1: a name with spaces, a profile deeper in a network path, a sentence's period, letter case on
// macOS, and shapes that only look like network paths.
describe('names with spaces, deeper profiles and look-alikes (#975)', () => {
  it('a root never takes the start of a segment that goes on after a space', () => {
    const peter: LogRedactionRoots = { home: 'C:\\Users\\Peter' }
    expect(redactLogText("open 'C:\\Users\\Peter Smith\\x'", peter)).toBe("open 'C:\\Users\\<user>\\x'")
    expect(redactLogText('{"p":"C:\\\\Users\\\\Peter Smith\\\\x"}', peter)).toBe('{"p":"C:\\\\Users\\\\<user>\\\\x"}')
    expect(redactLogText("open 'C:\\Users\\Peter Smith'", peter)).toBe("open 'C:\\Users\\<user>'")
    expect(redactLogText('/Volumes/KIT 1/runtime/x', { driveRoot: '/Volumes/KIT' })).toBe('/Volumes/<volume>/runtime/x')
    // A sentence after an unquoted root is no part of it.
    expect(redactLogText('C:\\Users\\Peter is missing', peter)).toBe('<home> is missing')
  })

  it.each<[string, string, string]>([
    ['before a closing quote', "open 'C:\\Users\\Anna Schmidt'", "open 'C:\\Users\\<user>'"],
    ['before a JSON closing quote', '{"cwd":"C:\\\\Users\\\\Anna Schmidt"}', '{"cwd":"C:\\\\Users\\\\<user>"}'],
    ['a macOS home before a closing quote', "'/Users/Anna Schmidt'", "'/Users/<user>'"],
    ['before a backtick', '`/home/Anna Schmidt`', '`/home/<user>`'],
    ['at the end of a quoted path cut short', "open 'C:\\Users\\Anna Schmidt", "open 'C:\\Users\\<user>"],
    ['before a period in a quoted path', "'C:\\Users\\Anna Schmidt. Next'", "'C:\\Users\\<user>. Next'"]
  ])('a profile name of several words ends the path %s', (_where, line, expected) => {
    expect(redactLogText(line, NONE)).toBe(expected)
  })

  it.each<[string, string, string]>([
    ['under an admin share', '\\\\pc\\c$\\Users\\peter\\x', '\\\\<server>\\<share>\\Users\\<user>\\x'],
    ['in WSL', '\\\\wsl$\\Ubuntu\\home\\peter\\x', '\\\\<server>\\<share>\\home\\<user>\\x'],
    ['in WSL (wsl.localhost)', '\\\\wsl.localhost\\Ubuntu\\home\\peter\\x', '\\\\<server>\\<share>\\home\\<user>\\x'],
    ['JSON-escaped', '{"p":"\\\\\\\\pc\\\\c$\\\\Users\\\\peter\\\\x"}', '{"p":"\\\\\\\\<server>\\\\<share>\\\\Users\\\\<user>\\\\x"}'],
    ['with forward slashes after a quote', "'//pc/c$/Users/peter/x'", "'//<server>/<share>/Users/<user>/x'"],
    ['as a file URL', 'file://pc/c$/Users/peter/x', 'file://<server>/<share>/Users/<user>/x'],
    ['as a file URL a few folders down', 'file://nas/data/team/home/peter/x', 'file://<server>/<share>/team/home/<user>/x'],
    ['as a file URL on a home$ share', 'file://fs01/home$/peter/x', 'file://<server>/<share>/<user>/x'],
    ['a few folders down', '\\\\nas\\data\\Shared Folders\\home\\Anna Schmidt\\x', '\\\\<server>\\<share>\\Shared Folders\\home\\<user>\\x']
  ])('a profile deeper in a network path hides the account: %s', (_what, line, expected) => {
    expect(redactLogText(line, NONE)).toBe(expected)
  })

  it('a sentence’s period stays outside the path', () => {
    expect(redactLogText('Could not find C:\\Users\\peter.', { home: 'C:\\Users\\peter' })).toBe('Could not find <home>.')
    expect(redactLogText('Could not find C:\\Users\\peter. Retrying', { home: 'C:\\Users\\peter' })).toBe(
      'Could not find <home>. Retrying'
    )
    expect(redactLogText('Could not find C:\\Users\\peter.', NONE)).toBe('Could not find C:\\Users\\<user>.')
    expect(redactLogText('Could not find /home/peter.', NONE)).toBe('Could not find /home/<user>.')
  })

  it('macOS homes and volumes match in any letter case; a Linux home does not', () => {
    expect(redactLogText('/users/peter/x', { home: '/Users/peter' })).toBe('<home>/x')
    expect(redactLogText('/volumes/kit/x', { driveRoot: '/Volumes/KIT' })).toBe('<drive>/x')
    expect(redactLogText('/users/peter/x /VOLUMES/Kit/y', NONE)).toBe('/users/<user>/x /VOLUMES/<volume>/y')
    expect(redactLogText('/HOME/peter/x', { home: '/home/peter' })).toBe('/HOME/peter/x')
  })

  it('a Fedora Silverblue home (/var/home) hides the account; /root names none', () => {
    expect(redactLogText('open /var/home/peter/.config/x', NONE)).toBe('open /var/home/<user>/.config/x')
    expect(redactLogText('open /root/.config/x', NONE)).toBe('open /root/.config/x')
  })
})

// #975 review round 2 (F1, F2, F4): this computer's account is a known value. Wherever its name appears as a whole
// token, whatever the shape around it, it becomes `<user>`.
describe('this computer’s account, wherever it appears (#975)', () => {
  it.each<[string, string, string, string]>([
    ['an apostrophe in the name', "O'Brien", "open 'C:\\Users\\O'Brien\\AppData\\x'", "open 'C:\\Users\\<user>\\AppData\\x'"],
    ['a comma in the name, JSON-escaped', 'Smith, Anna', '{"p":"C:\\\\Users\\\\Smith, Anna\\\\AppData"}', '{"p":"C:\\\\Users\\\\<user>\\\\AppData"}'],
    ['a name of two words at the end of an unquoted path', 'Anna Schmidt', 'Error: spawn C:\\Users\\Anna Schmidt ENOENT', 'Error: spawn C:\\Users\\<user> ENOENT'],
    ['a redirected folder on a server', 'peter', "open '\\\\fs01\\data\\peter\\Documents\\x.pdf'", "open '\\\\<server>\\<share>\\<user>\\Documents\\x.pdf'"],
    ['a home under a path prefix', 'peter', 'open /srv/nfs/peter/x', 'open /srv/nfs/<user>/x'],
    ['a temp folder named after the account', 'peter', '{"error":"D:\\\\Temp\\\\peter is full"}', '{"error":"D:\\\\Temp\\\\<user> is full"}'],
    ['in prose, any letter case', 'peter', 'Signed in as PETER.', 'Signed in as <user>.']
  ])('%s', (_what, account, line, expected) => {
    expect(redactLogText(line, { account })).toBe(expected)
  })

  it('only as a whole token: a longer word, a host name or a dotted name keeps it', () => {
    const line = 'host peter-laptop, user petersen, mail peter.smith@example.org, file x.peter, id peter_2'
    expect(redactLogText(line, { account: 'peter' })).toBe(line)
  })

  it('a name shorter than 3 characters or a common word is left to the path rules', () => {
    expect(redactLogText('al opened the admin panel; C:\\Users\\al\\x', { account: ['al', 'admin'] })).toBe(
      'al opened the admin panel; C:\\Users\\<user>\\x'
    )
    for (const word of ['user', 'users', 'administrator', 'owner', 'guest', 'default', 'public', 'root', 'test', 'app', 'home']) {
      expect(redactLogText(`the ${word} folder`, { account: word })).toBe(`the ${word} folder`)
    }
  })

  it('never touches a placeholder, whatever the account is called', () => {
    const roots: LogRedactionRoots = {
      driveRoot: 'E:\\',
      appData: 'C:\\ProgramData\\HilbertRaum',
      account: ['drive', 'server', 'share', 'volume', 'temp', 'data', 'app-data']
    }
    expect(redactLogText('E:\\x \\\\nas\\kits\\y /Volumes/KIT/z C:\\ProgramData\\HilbertRaum\\w', roots)).toBe(
      '<drive>\\x \\\\<server>\\<share>\\y /Volumes/<volume>/z <app-data>\\w'
    )
  })

  it('the longest name goes first, so a shorter name inside it leaves no part behind', () => {
    expect(redactLogText('open /srv/Anna Schmidt/x for Anna', { account: ['Anna', 'Anna Schmidt'] })).toBe(
      'open /srv/<user>/x for <user>'
    )
  })

  it('a known folder keeps its own placeholder; the account elsewhere becomes <user>', () => {
    const roots: LogRedactionRoots = { home: 'C:\\Users\\peter', account: 'peter' }
    expect(redactLogText('C:\\Users\\peter\\x and /mnt/c/Users/peter/y and peter', roots)).toBe(
      '<home>\\x and /mnt/c/Users/<user>/y and <user>'
    )
  })

  it('currentAccountNames names the signed-in account and the home folder’s own name', () => {
    const names = currentAccountNames()
    const home = homedir().split(/[\\/]/).filter(Boolean).pop() as string
    expect(names).toContain(home)
    expect(names).toContain(userInfo().username)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each<[string, string | null, string | null, string[]]>([
    ['a profile folder with a domain suffix', 'peter', 'C:\\Users\\peter.CORP', ['peter', 'peter.CORP']],
    ['a renamed account', 'anna', '/Users/annaschmidt', ['anna', 'annaschmidt']],
    ['the same name twice', 'anna', '/home/anna/', ['anna']],
    ['no account entry', null, '/home/anna', ['anna']],
    ['a home at the file system root', 'svc', '/', ['svc']]
  ])('accountNamesFrom: %s', (_what, username, home, expected) => {
    expect(accountNamesFrom(username, home)).toEqual(expected)
  })
})

// #975 review round 2 (F1, F2, F3, F5, F7): other computers' accounts in more path shapes, and a root that pass 2
// could not hide.
describe('other computers’ accounts in more shapes (#975)', () => {
  it.each<[string, string, string]>([
    ['an apostrophe in a Windows profile', "open 'C:\\Users\\O'Brien\\AppData\\x'", "open 'C:\\Users\\<user>\\AppData\\x'"],
    ['an apostrophe in a macOS home', "open '/Users/o'brien/Library/x'", "open '/Users/<user>/Library/x'"],
    ['an apostrophe in a volume name', "open '/Volumes/Peter's Kit/runtime/x'", "open '/Volumes/<volume>/runtime/x'"],
    ['a home$ share', "open '\\\\fs01\\home$\\peter\\Documents\\x.pdf'", "open '\\\\<server>\\<share>\\<user>\\Documents\\x.pdf'"],
    ['a users$ share', "open '\\\\fs01\\users$\\peter\\Documents\\x.pdf'", "open '\\\\<server>\\<share>\\<user>\\Documents\\x.pdf'"],
    ['a profiles share', "open '\\\\fs01\\profiles\\peter.V6\\AppData\\x'", "open '\\\\<server>\\<share>\\<user>\\AppData\\x'"],
    ['a profile$ share in JSON', '{"error":"open \'\\\\\\\\fs01\\\\Profile$\\\\peter\\\\x\'"}', '{"error":"open \'\\\\\\\\<server>\\\\<share>\\\\<user>\\\\x\'"}'],
    ['a homes folder deeper down', "open '\\\\contoso.com\\dfs\\homes\\peter\\x'", "open '\\\\<server>\\<share>\\homes\\<user>\\x'"],
    ['a home$ share in JSON', '{"error":"open \'\\\\\\\\fs01\\\\home$\\\\peter\\\\Documents\\\\x.pdf\'"}', '{"error":"open \'\\\\\\\\<server>\\\\<share>\\\\<user>\\\\Documents\\\\x.pdf\'"}'],
    ['a Linux home under /nfs', "open '/nfs/home/peter/x'", "open '/nfs/home/<user>/x'"],
    ['a Linux home under /export', 'open /export/home/peter/x', 'open /export/home/<user>/x'],
    ['a macOS home behind the firmlink', "open '/System/Volumes/Data/Users/peter/Library/x'", "open '/System/Volumes/Data/Users/<user>/Library/x'"],
    ['a macOS network home', 'open /Network/Servers/srv/Users/peter/x', 'open /Network/Servers/srv/Users/<user>/x'],
    ['an error code after a profile path', '{"error":"Error: spawn C:\\\\Users\\\\peter ENOENT"}', '{"error":"Error: spawn C:\\\\Users\\\\<user> ENOENT"}'],
    ['a manual mount with no user folder', "open '/media/KIT/runtime/llama.cpp/linux/llama-server'", "open '/media/<volume>/runtime/llama.cpp/linux/llama-server'"]
  ])('%s', (_what, line, expected) => {
    expect(redactLogText(line, NONE)).toBe(expected)
  })

  it('a profile behind a path prefix inside an http(s) URL stays', () => {
    for (const line of ['see https://example.org/nfs/home/peter/x', 'GET http://host:8080/a/Users/peter/b']) {
      expect(redactLogText(line, NONE)).toBe(line)
    }
  })

  it.each<[string, string, string]>([
    ['words and a closing quote', '{"error":"C:\\\\work\\\\kit is not writable"}', '{"error":"<drive> is not writable"}'],
    ['words and a JSON newline', '{"error":"check failed\\nC:\\\\work\\\\kit not found\\nnext"}', '{"error":"check failed\\n<drive> not found\\nnext"}']
  ])('a root no generic shape could hide keeps its placeholder before %s', (_what, line, expected) => {
    expect(redactLogText(line, { driveRoot: 'C:\\work\\kit' })).toBe(expected)
  })
})

// #975 review round 2 (F9): the main process registers the roots that do not depend on the drive first, and adds the
// drive root once it resolves.
describe('the root registry (#975)', () => {
  afterEach(() => setLogRedactionRoots({}))

  it('addLogRedactionRoots adds to what is registered; setLogRedactionRoots replaces it', () => {
    setLogRedactionRoots({ home: 'C:\\Users\\xavi', account: 'xavi' })
    addLogRedactionRoots({ driveRoot: 'E:\\' })
    expect(redactLogText('C:\\Users\\xavi\\x E:\\y xavi', logRedactionRoots())).toBe('<home>\\x <drive>\\y <user>')
    setLogRedactionRoots({ driveRoot: 'E:\\' })
    expect(redactLogText('C:\\Users\\xavi\\x E:\\y', logRedactionRoots())).toBe('C:\\Users\\<user>\\x <drive>\\y')
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
    ['a POSIX path with no account', 'spawn /usr/bin/tesseract in /var/folders/zz/T/hr-1'],
    ['a Windows pipe', 'connect \\\\.\\pipe\\hilbertraum-1 failed'],
    ['a protocol-relative link in prose', 'see the docs and //cdn/x for more'],
    ['a JSON-escaped rooted path (\\runtime\\x)', '{"p":"\\\\runtime\\\\x"}'],
    ['a doubled separator after a drive letter', 'copy C:\\\\temp\\x and <drive>\\\\cache\\y']
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
    '\\\\?\\UNC\\PETERS-PC\\Users\\peter\\x file://PETERS-PC/share/d',
    "open 'C:\\Users\\Anna Schmidt' C:\\Users\\peter is missing. \\\\wsl$\\Ubuntu\\home\\peter\\x",
    '/users/peter/x /Volumes/KIT 1/y /var/home/peter/z file:///home/xavi/a "//pc/c$/Users/peter/x"',
    "open 'C:\\Users\\O'Brien\\x' \\\\fs01\\home$\\peter\\y /nfs/home/peter/z /media/KIT/runtime/w peter ENOENT"
  ]
  const ACCOUNT: LogRedactionRoots = { ...WIN, account: ['xavi', 'peter', 'drive', 'server', "O'Brien"] }
  it.each(lines.flatMap((line) => [WIN, LINUX, NONE, ACCOUNT].map((roots) => [line, roots] as const)))('%s', (line, roots) => {
    const once = redactLogText(line, roots)
    expect(redactLogText(once, roots)).toBe(once)
  })
})
