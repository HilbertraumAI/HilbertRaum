// #975 (owner decision G-4 b, the exit rule): what the diagnostics log hands out names the known folders by
// placeholder and hides account names. `app.log` keeps full detail at rest (the drive's paths, a refused engine's
// `binPath`, a sidecar's stderr tail): it stays on the device, and on an encrypted workspace it is sealed under the
// vault key. Every line that leaves it, through `readLogTail` (the Diagnostics panel and Copy) and `readLogFull`
// (Save log), goes through `redactLogText` first. It is a best effort, not a proof: a path outside the known folders
// keeps its folders (`D:\Private\letter.pdf`), and another computer's account name in an unusual place can stay.
//
// Three passes, in this order (the middle one, this computer's account, is described after pass 2):
// 1. Known roots, registered once by the main process (`setLogRedactionRoots`): the drive root, the app's data folder
//    (`userData`), the home folder, the temp folder and the app's own folders become `<drive>`, `<app-data>`, `<home>`,
//    `<temp>` and `<app>`. What follows the root stays (`<drive>\runtime\llama.cpp\win\llama-server.exe`), so support
//    still sees which file failed. The longest root goes first: a dev drive root can sit inside the home folder, and
//    the home folder holds the temp folder on Windows. A root matches in every spelling a line can carry: `\` or `/`
//    separators, JSON's doubled backslashes (`write()` JSON-stringifies the meta), the `\\?\` long form and a `file:`
//    URL (percent-encoded too). A Windows root, and a macOS one under `/Users` or `/Volumes`, matches in any letter
//    case. A root matches only as whole segments: `C:\Users\x` never takes the start of `C:\Users\xavier`, nor of
//    `C:\Users\x y` (a segment that goes on after a space).
// 2. Generic shapes the roots did not cover (a root not registered yet, a path on another drive, a line an earlier
//    session wrote on another computer): the account segment of a profile path becomes `<user>` (`C:\Users\<user>\…`,
//    `/Users/<user>/…`, `/home/<user>/…`, `/var/home/<user>/…`, `/media/<user>/…`, a profile anywhere in a network path,
//    an 8.3 short name such as `PETERS~1` included), a mounted volume's name becomes `<volume>` (`/Volumes/<volume>/…`),
//    and a network path's server and share become `\\<server>\<share>\…`. The rest of the path stays. Relative paths,
//    file names, `http(s)` URLs, device paths (`\\.\pipe\…`) and ordinary text are left alone.
// Between them, this computer's account (`currentAccountNames()`, registered as `account`): each name becomes `<user>`
// wherever it stands as a whole token, in any shape (`O'Brien`, `Smith, Anna`, a redirected folder on a server, prose).
// A name shorter than 3 characters, or a common word (`admin`, `user`, `home`, …), is left to passes 1 and 2.
//
// A name of several words (`Anna Schmidt`) is one segment when a separator, a closing quote or a backtick follows it,
// or, inside a quoted path, the end of the line or a sentence's `.`. After an unquoted path the words are a sentence:
// `C:\Users\peter is missing` hides `peter` only. A `.` before a space or the end of the text is a sentence's, never
// part of a segment.
//
// No electron import (only `node:os`, for `currentAccountNames`), and idempotent: redacting a redacted line changes
// nothing.

import { homedir, userInfo } from 'node:os'

export type LogRedactionPlaceholder = '<drive>' | '<app-data>' | '<home>' | '<temp>' | '<app>'

/** The folders the main process knows. Each may name more than one path (the app's own folders, for one). */
export interface LogRedactionRoots {
  /** The root the workspace resolved to (`paths.rootPath`): a Kit, a dev folder, or the `userData` fallback. */
  driveRoot?: string | readonly string[]
  /** `app.getPath('userData')`. */
  appData?: string | readonly string[]
  /** `os.homedir()`. */
  home?: string | readonly string[]
  /** `os.tmpdir()`. */
  temp?: string | readonly string[]
  /** The app's own folders: the executable's folder, `process.resourcesPath`, `app.getAppPath()`. */
  app?: string | readonly string[]
  /** This computer's account names (`currentAccountNames()`): each becomes `<user>` wherever it stands as a whole
   *  token, not only in a path. */
  account?: string | readonly string[]
}

/** Placeholders by root, in tie order: when two roots are the same folder, the first one names it. The app-data folder
 *  comes before the drive root, so a workspace on the `userData` fallback (no Kit) reads `<app-data>`. */
const ROOT_PLACEHOLDERS: ReadonlyArray<[keyof LogRedactionRoots, LogRedactionPlaceholder]> = [
  ['appData', '<app-data>'],
  ['driveRoot', '<drive>'],
  ['temp', '<temp>'],
  ['app', '<app>'],
  ['home', '<home>']
]

const BACKTICK = '`'
/** One run of path separators: a raw `\`, JSON's `\\` (or a twice-escaped `\\\\`), or `/`. */
const SEP = String.raw`[\\/]+`
/** A character that continues the segment a root ends in. A root must be followed by a separator, the end of the text,
 *  or a character outside this class (a quote, a space, a comma, a closing bracket). A `.` continues the segment only
 *  when no space and no end of the text follows it (`peter.old`, not the period of `… C:\Users\peter.`). */
const SEGMENT_CONTINUES = String.raw`(?:[^\\/\s"'` + BACKTICK + String.raw`<>|*?,;:)\]}.]|\.(?!\s|$))`
/** A character a server or share name can hold. Windows refuses `" / \ [ ] : ; | = , + * ? < >` in an account name;
 *  quotes and parentheses are left out too, because a log line wraps paths in them. */
const NAME_CHAR = String.raw`[^\\/\s"'` + BACKTICK + String.raw`<>|:*?,;=+\[\]()]`
/** A letter for the apostrophe rule below (Latin, with accents). */
const LETTER = String.raw`[A-Za-z\u00C0-\u024F]`
/** One word of an account or volume name: name characters, with a `.` only inside it (as in a segment), and an
 *  apostrophe between two letters (`O'Brien`, `Peter's Kit`). `~` stays in: an 8.3 short name (`PETERS~1`) is an
 *  account segment as well. `%` stays in for a percent-encoded `file:` URL. */
const WORD =
  String.raw`(?:[^\\/\s"'` +
  BACKTICK +
  String.raw`<>|:*?,;=+\[\]().]|\.(?!\s|$)|(?<=${LETTER})'(?=${LETTER}))+`
/** Where a name of several words may end: a separator (a JSON escape such as `\"` or `\n` starts with `\` too), a
 *  closing quote or backtick, the end of a line, or a `.` or `,` before a space or the end. Which of these really end
 *  the path is the replacers' call (`wordsBelongToPath`). */
const WORDS_END = String.raw`(?=[\\/"'` + BACKTICK + String.raw`]|$|[\r\n]|[.,](?:\s|$))`
/** Node's error codes, which follow a path in `spawn C:\Users\peter ENOENT`: never a further word of a name. */
const ERROR_CODE = String.raw`(?:E(?:NOENT|PERM|ACCES|BUSY|EXIST|ISDIR|NOTDIR|NOTEMPTY|NOSPC|MFILE|IO|AGAIN|INVAL|PIPE|ROFS|LOOP|NAMETOOLONG|XDEV|CONNREFUSED|CONNRESET|TIMEDOUT|ADDRINUSE)|UNKNOWN)(?![A-Za-z0-9_])`
/** The further words of a name, captured (one group): ` Schmidt` in `Anna Schmidt`. */
const MORE_WORDS = `((?: +(?!${ERROR_CODE})${WORD}){1,4}${WORDS_END})?`
/** An account or volume name: its first word, then the further words (one capture group). */
const NAME = `${WORD}${MORE_WORDS}`
/** A JSON escape (`\n`, `\r`, `\t`) right before a path: a stderr tail logged as a JSON field. */
const AFTER_JSON_ESCAPE = String.raw`(?<=\\[nrt])`
/** What may come right before a POSIX path or a `file:` URL: the start, a space, a quote, a bracket, `=`, `,`, `;`,
 *  `|`, `:` (a `PATH` list), `>` (right after a placeholder) or a JSON escape. Never a letter, a digit, `.`, `/` or
 *  `\`: the match would then start inside a longer path or an `https://` URL. */
const PATH_START = String.raw`(?:(?<=^|[\s"'` + BACKTICK + String.raw`(\[{<>=,;:|])|${AFTER_JSON_ESCAPE})`
/** Before a generic POSIX shape: the same, or `file://` (`file:///home/…`). */
const POSIX_START = String.raw`(?:${PATH_START}|(?<=file://))`
/** Before a Windows drive letter: the same, plus `/` (`file:///C:/`) and `\` (`\\?\C:\`, `\\.\C:\`). */
const DRIVE_START = String.raw`(?:(?<=^|[\s"'` + BACKTICK + String.raw`(\[{<>=,;:|/\\])|${AFTER_JSON_ESCAPE})`
/** Before a network path's leading `\\`: never `:` or `>`, which put it inside a drive path with a doubled separator
 *  (`C:\\temp\x`, `<drive>\\x\y`). */
const UNC_START = String.raw`(?:(?<=^|[\s"'` + BACKTICK + String.raw`(\[{=,;|])|${AFTER_JSON_ESCAPE})`

/** The three spellings of a network path. Its leading `\\` is twice its separator: a raw `\\server\share` has one `\`
 *  between segments, a JSON-escaped `\\\\server\\share` two, so a JSON-escaped rooted path (`\\runtime\\x`, which is
 *  `\runtime\x`) is never one. The `//` spelling counts only right after a quote: in prose, `//cdn/x` is a link. */
const NETWORK_FORMS: ReadonlyArray<{ start: string; lead: string; longForm: string; sep: string }> = [
  { start: UNC_START, lead: String.raw`\\\\(?!\\)`, longForm: String.raw`(?:\?\\UNC\\(?!\\))?`, sep: String.raw`\\(?!\\)` },
  {
    start: UNC_START,
    lead: String.raw`\\\\\\\\(?!\\)`,
    longForm: String.raw`(?:\?\\\\UNC\\\\(?!\\))?`,
    sep: String.raw`\\\\(?!\\)`
  },
  { start: `(?<=["'${BACKTICK}])`, lead: '//(?!/)', longForm: '', sep: '/(?!/)' }
]
/** A server: not `.`, which opens a device path (`\\.\pipe\…`, `\\.\C:\…`); a `\\?\` path has no server either (`?` is
 *  no name character), unless it is `\\?\UNC\`. */
const SERVER = String.raw`(?!\.(?:[\\/]|$))${NAME_CHAR}+`
/** A folder between a share and a profile folder; it may hold spaces (`Shared Folders`). */
const NETWORK_FOLDER = String.raw`[^\\/"'` + BACKTICK + String.raw`<>|*?:\r\n]+`
/** The folders a file server keeps profiles and redirected folders in: `Users`, `home`, `homes`, `profile`, `profiles`,
 *  each also as a hidden share (`home$`, `users$`, `profiles$`). Matched in any letter case. */
const PROFILE_FOLDER = String.raw`(?:users|homes?|profiles?)\$?`
/** Path segments before a POSIX home (`/nfs`, `/export`, `/System/Volumes/Data`, `/Network/Servers/srv`); a segment
 *  may hold single spaces. The path still starts where `POSIX_START` allows, so nothing inside an `http(s)://` URL
 *  matches: there the first `/` after the start is a second `/`. */
const POSIX_PREFIX =
  String.raw`(?:/[^\s/\\"'` + BACKTICK + String.raw`<>|:*?]+(?: [^\s/\\"'` + BACKTICK + String.raw`<>|:*?]+)*)*?`
/** The drive layout's own top folders: on `/media/<label>/runtime/…` (a mount with no user folder) the first segment is
 *  the volume, not an account. */
const KIT_FOLDER = String.raw`(?=/(?:runtime|models|workspace|logs|config|zim|model-manifests)(?:/|$))`

type Replacer = (match: string, ...rest: unknown[]) => string

/** The match's offset and the whole text, the last two arguments a replacer gets (no named groups here). */
function position(rest: unknown[]): { offset: number; text: string } {
  return { offset: rest[rest.length - 2] as number, text: rest[rest.length - 1] as string }
}

/** Whether the words after a name or a root belong to its last segment: a separator, a quote or a backtick follows
 *  them, or a quote opened the path (`'C:\Users\Anna Schmidt`, cut short). After an unquoted path that ends at the
 *  end of the line or at a sentence's `.`, they are a sentence (`C:\Users\peter is missing`). */
function wordsBelongToPath(text: string, offset: number, match: string): boolean {
  return /[\\/"'`]/.test(text.charAt(offset + match.length)) || /["'`]/.test(text.charAt(offset - 1))
}

/** A shape whose last part is a name: `prefix` (no capture group in it) stays, the name becomes `placeholder`, and
 *  words that are a sentence stay after it. `after` (a lookahead) is what must follow the name. */
function named(prefix: string, flags: string, placeholder: string, after = ''): [RegExp, Replacer] {
  return [
    new RegExp(`(${prefix})${NAME}${after}`, flags),
    (match, ...rest) => {
      const kept = rest[0] as string
      const more = rest[1] as string | undefined
      const { offset, text } = position(rest)
      const sentence = more !== undefined && !wordsBelongToPath(text, offset, match) ? more : ''
      return `${kept}${placeholder}${sentence}`
    }
  ]
}

/** The generic shapes of pass 2, applied in order. */
const GENERIC: ReadonlyArray<[RegExp, string | Replacer]> = [
  // A Windows profile folder: `C:\Users\<user>`, also behind `\\?\` or `\\.\`, in a `file:///C:/` URL, or under a
  // drive root that pass 1 already turned into a placeholder (`<drive>\Users\<user>` under a drive root at `E:\`).
  named(String.raw`(?:${DRIVE_START}[A-Za-z]:|<(?:drive|app-data|home|temp|app)>)${SEP}Users${SEP}`, 'gi', '<user>'),
  // A profile folder anywhere in a network path: `\\pc\Users\<user>`, `\\pc\c$\Users\<user>`,
  // `\\wsl$\Ubuntu\home\<user>`, a redirected folder on `\\fs01\home$\<user>`, `file://pc/c$/Users/<user>`. Before the
  // server and share are named by placeholder, which would hide a share that is the profile folder itself.
  ...NETWORK_FORMS.map((f) =>
    named(
      `${f.start}${f.lead}${f.longForm}${SERVER}(?:${f.sep}${NETWORK_FOLDER})*?${f.sep}${PROFILE_FOLDER}${f.sep}`,
      'gi',
      '<user>'
    )
  ),
  named(`${PATH_START}file://${SERVER}(?:/${NETWORK_FOLDER})*?/${PROFILE_FOLDER}/`, 'gi', '<user>'),
  // A network path: the server and the share by placeholder (`\\<server>\<share>\…`, also `\\?\UNC\…`).
  ...NETWORK_FORMS.map((f): [RegExp, string] => [
    new RegExp(`(${f.start}${f.lead})(${f.longForm})${SERVER}(${f.sep})${NAME_CHAR}+`, 'gi'),
    '$1$2<server>$3<share>'
  ]),
  // A network path as a `file:` URL: `file://server/share/…` (`file:///` has no server).
  [new RegExp(String.raw`${PATH_START}(file://)${NAME_CHAR}+(/)${NAME_CHAR}+`, 'gi'), '$1<server>$2<share>'],
  // WSL's view of a Windows profile: `/mnt/c/Users/<user>`.
  named(`${POSIX_START}/mnt/[A-Za-z]/Users/`, 'gi', '<user>'),
  // A Linux mount point that is no WSL drive letter: `/mnt/<volume>`.
  named(`${POSIX_START}/mnt/(?=${NAME_CHAR}{2})`, 'g', '<volume>'),
  // A macOS home, in any letter case (APFS ignores it by default), also behind a prefix: `/Users/<user>`,
  // `/System/Volumes/Data/Users/<user>`, `/Network/Servers/srv/Users/<user>`.
  named(`${POSIX_START}${POSIX_PREFIX}/Users/`, 'gi', '<user>'),
  // A Linux home, also behind a prefix: `/home/<user>`, `/var/home/<user>` (Fedora Silverblue), `/nfs/home/<user>`,
  // `/export/home/<user>`. `/root` names no account.
  named(`${POSIX_START}${POSIX_PREFIX}/home/`, 'g', '<user>'),
  // Removable drives: Linux `/media/<user>/<volume>` and `/run/media/<user>/<volume>`, macOS `/Volumes/<volume>`. A
  // mount with no user folder (`/media/<volume>/runtime/…`) is told by the drive layout's folder after the label.
  named(`${POSIX_START}/(?:run/)?media/`, 'g', '<volume>', KIT_FOLDER),
  named(`${POSIX_START}/(?:run/)?media/`, 'g', '<user>'),
  named(`${POSIX_START}/(?:run/)?media/<user>/`, 'g', '<volume>'),
  named(`${POSIX_START}/Volumes/`, 'gi', '<volume>')
]

/** A Windows-shaped root (a drive letter, or a UNC path) matches in any letter case. */
function isWindowsShaped(root: string): boolean {
  return /^[A-Za-z]:/.test(root) || /^[\\/]{2}/.test(root)
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

/** A segment as a `file:` URL spells it (percent-encoded); `:` stays, as in `C:`. */
function urlEncoded(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** Pass 2 alone. */
function applyGeneric(text: string): string {
  let out = text
  for (const [pattern, replacement] of GENERIC) {
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement)
  }
  return out
}

/** The root's placeholder, unless the words after it continue its last segment (`C:\Users\Peter Smith` is not the
 *  home folder `C:\Users\Peter`) and a generic shape hides that whole segment (`yields`): then the match stays as it
 *  is, for pass 2. A root no generic shape could hide (`C:\work\kit`, `D:\Temp\peter`) keeps its placeholder, and the
 *  words after it stay as text. */
function rootReplacer(placeholder: LogRedactionPlaceholder, yields: boolean): Replacer {
  return (match, ...rest) => {
    const more = rest[0] as string | undefined
    const { offset, text } = position(rest)
    if (more && yields && wordsBelongToPath(text, offset, match)) return match
    return `${placeholder}${more ?? ''}`
  }
}

interface CompiledRoot {
  segments: number
  length: number
  patterns: RegExp[]
  replace: Replacer
}

/** The patterns of one root, or null for a root that cannot be told apart from ordinary text (a relative path, `/`
 *  alone, a network path without its share). Each pattern holds one capture group: the words after the root. */
function compileRoot(raw: string, placeholder: LogRedactionPlaceholder): CompiledRoot | null {
  let root = raw.trim()
  // A long form names the same folder as the short one. The pattern matches the folder; a `\\?\` in the text stays.
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(root)) root = `\\\\${root.slice(8)}`
  else if (/^[\\/]{2}\?[\\/][A-Za-z]:/.test(root)) root = root.slice(4)
  const windows = isWindowsShaped(root)
  const unc = windows && /^[\\/]{2}/.test(root)
  if (!windows && !root.startsWith('/')) return null
  const segments = root.split(/[\\/]+/).filter((s) => s.length > 0)
  if ((!windows && segments.length === 0) || (unc && segments.length < 2)) return null
  if (windows && !unc && !/^[A-Za-z]:$/.test(segments[0])) return null
  // A POSIX root starts with one `/` (JSON leaves `/` alone); in a `file:///` URL that `/` stays outside the match, so
  // the URL keeps its third slash, as the Windows form does.
  const starts = unc
    ? [String.raw`${UNC_START}[\\/]{2,}(?:\?${SEP}UNC${SEP})?`]
    : windows
      ? [DRIVE_START]
      : [`${PATH_START}/`, '(?<=file:///)']
  // A bare drive root (`E:\`) must be followed by a separator; any other root by something that does not continue its
  // last segment (the words after it are the replacer's call). The empty group keeps one capture group in each.
  const end = windows && !unc && segments.length === 1 ? String.raw`(?=[\\/])()` : `(?!${SEGMENT_CONTINUES})${MORE_WORDS}`
  const bodies = new Set([
    segments.map(escapeRegExp).join(SEP),
    segments.map((s) => escapeRegExp(urlEncoded(s))).join(SEP)
  ])
  // APFS, macOS's default, ignores letter case: a home under `/Users` or a volume under `/Volumes` matches in any case.
  const caseless = windows || /^\/(?:users|volumes)\//i.test(root)
  const patterns = starts.flatMap((start) =>
    [...bodies].map((body) => new RegExp(`${start}${body}${end}`, caseless ? 'gi' : 'g'))
  )
  // Does pass 2 hide the root's whole last segment (a profile, a volume, a share)? Then it can take a longer one too.
  const yields = /<(?:user|volume|share)>$/.test(applyGeneric(root.replace(/[\\/]+$/, '')))
  return { segments: segments.length, length: root.length, patterns, replace: rootReplacer(placeholder, yields) }
}

/** Account names never replaced as a whole token: words that also occur in ordinary log text, and the words of the
 *  placeholders. For these the path rules (passes 1 and 2) still apply. */
const ACCOUNT_STOPLIST = new Set([
  'user',
  'users',
  'admin',
  'administrator',
  'owner',
  'guest',
  'default',
  'public',
  'root',
  'test',
  'app',
  'home',
  'drive',
  'data',
  'temp',
  'volume',
  'server',
  'share'
])

/** One account name as a whole token, in any letter case: no letter, digit, `_` or `-` right before or after it, no
 *  `.` joining it to more letters (`peter.smith`, `x.peter`), and never inside a placeholder (`<…>`). Null for a name
 *  shorter than 3 characters or on the stoplist. */
function compileAccount(name: string): RegExp | null {
  const trimmed = name.trim()
  if (trimmed.length < 3 || ACCOUNT_STOPLIST.has(trimmed.toLowerCase())) return null
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}_<-]|[\p{L}\p{N}]\.)${escapeRegExp(trimmed)}(?![\p{L}\p{N}_>-]|\.[\p{L}\p{N}])`,
    'giu'
  )
}

interface Compiled {
  roots: CompiledRoot[]
  accounts: RegExp[]
}

const compiled = new WeakMap<LogRedactionRoots, Compiled>()

function compileRoots(roots: LogRedactionRoots): Compiled {
  const cached = compiled.get(roots)
  if (cached) return cached
  const seen = new Set<string>()
  const list: CompiledRoot[] = []
  for (const [name, placeholder] of ROOT_PLACEHOLDERS) {
    const value = roots[name]
    const paths: readonly string[] = value === undefined ? [] : typeof value === 'string' ? [value] : value
    for (const path of paths) {
      if (typeof path !== 'string' || path.trim() === '') continue
      // The same folder registered twice keeps the first placeholder (the tie order above).
      const spelled = path.trim().replace(/[\\/]+/g, '/').replace(/\/$/, '')
      const identity = isWindowsShaped(path.trim()) ? spelled.toLowerCase() : spelled
      if (seen.has(identity)) continue
      seen.add(identity)
      const root = compileRoot(path, placeholder)
      if (root) list.push(root)
    }
  }
  // Longest first: a root inside another root is replaced before the outer one can take its start.
  list.sort((a, b) => b.segments - a.segments || b.length - a.length)
  const names = roots.account === undefined ? [] : typeof roots.account === 'string' ? [roots.account] : roots.account
  // The longest name first, so `Anna Schmidt` goes before a shorter name inside it.
  const accounts = [...new Set(names.filter((n): n is string => typeof n === 'string'))]
    .sort((a, b) => b.length - a.length)
    .map(compileAccount)
    .filter((re): re is RegExp => re !== null)
  const result = { roots: list, accounts }
  compiled.set(roots, result)
  return result
}

/** `text` with every known root by placeholder, this computer's account name wherever it stands as a whole token, and
 *  every account, volume and network name the generic shapes find hidden. Lines stay lines: nothing matches across a
 *  line break. */
export function redactLogText(text: string, roots: LogRedactionRoots): string {
  if (text === '') return text
  const { roots: known, accounts } = compileRoots(roots)
  let out = text
  for (const root of known) {
    for (const pattern of root.patterns) out = out.replace(pattern, root.replace)
  }
  for (const account of accounts) out = out.replace(account, '<user>')
  return applyGeneric(out)
}

/** The account names of a signed-in `username` and a `home` folder: the name, and the home folder's own name, which
 *  differs when the profile folder was named before a rename or carries a domain suffix (`peter.CORP`). Both when they
 *  differ; an empty or unknown one is left out. */
export function accountNamesFrom(username: string | null, home: string | null): string[] {
  const homeName = home?.split(/[\\/]/).filter((s) => s !== '').pop() ?? ''
  return [...new Set([username ?? '', homeName].filter((n) => n.trim() !== ''))]
}

/** This computer's account names: `os.userInfo().username` and the name of `os.homedir()` (`accountNamesFrom`). */
export function currentAccountNames(): string[] {
  let username: string | null = null
  let home: string | null = null
  try {
    username = userInfo().username
  } catch {
    /* a system with no account entry (some containers): the home folder's name still counts */
  }
  try {
    home = homedir()
  } catch {
    /* no home folder */
  }
  return accountNamesFrom(username, home)
}

let registered: LogRedactionRoots = {}

/** Register the folders and account names the redaction knows, replacing what was registered. The main process calls
 *  it at the top of its entry module with everything that does not depend on the drive, before anything can log; until
 *  then only the generic shapes apply. */
export function setLogRedactionRoots(roots: LogRedactionRoots): void {
  registered = { ...roots }
}

/** Add to what is registered (a given key replaces that key only): the main process adds the drive root once
 *  `resolvePaths` has found it. */
export function addLogRedactionRoots(roots: LogRedactionRoots): void {
  const defined = Object.fromEntries(Object.entries(roots).filter(([, value]) => value !== undefined))
  registered = { ...registered, ...defined }
}

/** The registered folders (none until `setLogRedactionRoots`). */
export function logRedactionRoots(): LogRedactionRoots {
  return registered
}
