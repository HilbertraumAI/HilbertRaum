// #975 (owner decision G-4 b, the exit rule): what the diagnostics log hands out carries no absolute path and no
// account name. `app.log` keeps full detail at rest (the drive's paths, a refused engine's `binPath`, a sidecar's stderr
// tail): it stays on the device, and on an encrypted workspace it is sealed under the vault key. Every line that leaves
// it, through `readLogTail` (the Diagnostics panel and Copy) and `readLogFull` (Save log), goes through
// `redactLogText` first, so a log shared with support names folders by placeholder.
//
// Two passes, in this order:
// 1. Known roots, registered once by the main process (`setLogRedactionRoots`): the drive root, the app's data folder
//    (`userData`), the home folder, the temp folder and the app's own folders become `<drive>`, `<app-data>`, `<home>`,
//    `<temp>` and `<app>`. What follows the root stays (`<drive>\runtime\llama.cpp\win\llama-server.exe`), so support
//    still sees which file failed. The longest root goes first: a dev drive root can sit inside the home folder, and
//    the home folder holds the temp folder on Windows. A root matches in every spelling a line can carry: `\` or `/`
//    separators, JSON's doubled backslashes (`write()` JSON-stringifies the meta), the `\\?\` long form and a `file:`
//    URL (percent-encoded too). A Windows root matches in any letter case. A root matches only as whole segments:
//    `C:\Users\x` never takes the start of `C:\Users\xavier`.
// 2. Generic shapes the roots did not cover (a root not registered yet, a path on another drive, a line an earlier
//    session wrote on another computer): the account segment of a profile path becomes `<user>` (`C:\Users\<user>\…`,
//    `/Users/<user>/…`, `/home/<user>/…`, `/media/<user>/…`, an 8.3 short name such as `PETERS~1` included), a mounted
//    volume's name becomes `<volume>` (`/Volumes/<volume>/…`), and a network path's server and share become
//    `\\<server>\<share>\…`. The rest of the path stays. Relative paths, file names, `http(s)` URLs and ordinary text
//    are left alone.
//
// Pure (no electron import), and idempotent: redacting a redacted line changes nothing.

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
 *  or a character outside this class (a quote, a space, a comma, a closing bracket). */
const SEGMENT_CHAR = String.raw`[^\\/\s"'` + BACKTICK + String.raw`<>|*?,;:)\]}]`
/** A character an account, volume, server or share name can hold. Windows refuses `" / \ [ ] : ; | = , + * ? < >` in
 *  an account name; quotes and parentheses are left out too, because a log line wraps paths in them. `~` stays in: an
 *  8.3 short name (`PETERS~1`) is an account segment as well. `%` stays in for a percent-encoded `file:` URL. */
const NAME_CHAR = String.raw`[^\\/\s"'` + BACKTICK + String.raw`<>|:*?,;=+\[\]()]`
/** An account or volume name. A name with spaces (`Peter Müller`) is taken whole only when a separator follows it, so
 *  `C:\Users\peter is missing` takes `peter`, not the rest of the sentence. */
const NAME = String.raw`(?:${NAME_CHAR}+(?: +${NAME_CHAR}+){1,4}(?=[\\/])|${NAME_CHAR}+)`
/** A JSON escape (`\n`, `\r`, `\t`) right before a path: a stderr tail logged as a JSON field. */
const AFTER_JSON_ESCAPE = String.raw`(?<=\\[nrt])`
/** What may come right before a POSIX path or a `file:` URL: the start, a space, a quote, a bracket, `=`, `,`, `;`,
 *  `|`, `:` (a `PATH` list), `>` (right after a placeholder) or a JSON escape; for a POSIX path also `file://`. Never a
 *  letter, a digit, `.`, `/` or `\`: the match would then start inside a longer path or an `https://` URL. */
const PATH_START = String.raw`(?:(?<=^|[\s"'` + BACKTICK + String.raw`(\[{<>=,;:|])|${AFTER_JSON_ESCAPE})`
const POSIX_START = String.raw`(?:${PATH_START}|(?<=file://))`
/** Before a Windows drive letter: the same, plus `/` (`file:///C:/`) and `\` (`\\?\C:\`). */
const DRIVE_START = String.raw`(?:(?<=^|[\s"'` + BACKTICK + String.raw`(\[{<>=,;:|/\\])|${AFTER_JSON_ESCAPE})`
/** Before a network path's leading `\\` or `//`: never `:` or `>`, which put it inside a JSON-escaped drive path
 *  (`C:\\Users`, `<drive>\\runtime`) or an `https://` URL. */
const UNC_START = String.raw`(?:(?<=^|[\s"'` + BACKTICK + String.raw`(\[{=,;|])|${AFTER_JSON_ESCAPE})`

type Replacer = (match: string, ...groups: Array<string | undefined>) => string

/** The generic shapes of pass 2, applied in order. */
const GENERIC: ReadonlyArray<[RegExp, string | Replacer]> = [
  // A Windows profile folder: `C:\Users\<user>`, also behind `\\?\`, in a `file:///C:/` URL, or under a drive root
  // that pass 1 already turned into a placeholder (`<drive>\Users\<user>` under a drive root at `E:\`).
  [
    new RegExp(String.raw`((?:${DRIVE_START}[A-Za-z]:|<(?:drive|app-data|home|temp|app)>)${SEP}Users${SEP})${NAME}`, 'gi'),
    '$1<user>'
  ],
  // A network path (`\\server\share`, `\\?\UNC\server\share`, JSON-escaped too): the server and the share by
  // placeholder; a share that is the profile folder (`\\pc\Users\peter`) also hides the account.
  [
    new RegExp(
      String.raw`${UNC_START}(\\{2,}|//)((?:\?${SEP}UNC${SEP})?)${NAME_CHAR}+(${SEP})(${NAME_CHAR}+)(?:(${SEP})(${NAME}))?`,
      'gi'
    ),
    (_match, lead = '', longForm = '', sep1 = '', share = '', sep2, next) =>
      `${lead}${longForm}<server>${sep1}<share>` +
      (sep2 === undefined || next === undefined ? '' : `${sep2}${/^users$/i.test(share) ? '<user>' : next}`)
  ],
  // A network path as a `file:` URL: `file://server/share/…` (`file:///` has no server).
  [new RegExp(String.raw`${PATH_START}(file://)${NAME_CHAR}+(/)${NAME_CHAR}+`, 'gi'), '$1<server>$2<share>'],
  // WSL's view of a Windows profile: `/mnt/c/Users/<user>`.
  [new RegExp(String.raw`(${POSIX_START}/mnt/[A-Za-z]/Users/)${NAME}`, 'g'), '$1<user>'],
  // A Linux mount point that is no WSL drive letter: `/mnt/<volume>`.
  [new RegExp(String.raw`(${POSIX_START}/mnt/)(?=${NAME_CHAR}{2})${NAME}`, 'g'), '$1<volume>'],
  // macOS and Linux homes: `/Users/<user>`, `/home/<user>`.
  [new RegExp(String.raw`(${POSIX_START}/(?:Users|home)/)${NAME}`, 'g'), '$1<user>'],
  // Removable drives: Linux `/media/<user>/<volume>` and `/run/media/<user>/<volume>`, macOS `/Volumes/<volume>`.
  [
    new RegExp(String.raw`(${POSIX_START}/(?:run/)?media/)${NAME}(?:(/)${NAME})?`, 'g'),
    (_match, lead = '', sep) => `${lead}<user>${sep === undefined ? '' : `${sep}<volume>`}`
  ],
  [new RegExp(String.raw`(${POSIX_START}/Volumes/)${NAME}`, 'g'), '$1<volume>']
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

interface CompiledRoot {
  placeholder: LogRedactionPlaceholder
  segments: number
  length: number
  patterns: RegExp[]
}

/** The patterns of one root, or null for a root that cannot be told apart from ordinary text (a relative path, `/`
 *  alone, a network path without its share). */
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
  // A POSIX root starts with one `/` (JSON leaves `/` alone); a run would take the `//` of `file:///home/…`.
  const start = unc ? String.raw`${UNC_START}[\\/]{2,}(?:\?${SEP}UNC${SEP})?` : windows ? DRIVE_START : `${POSIX_START}/`
  // A bare drive root (`E:\`) must be followed by a separator; any other root by a separator or a non-segment character.
  const end = windows && !unc && segments.length === 1 ? String.raw`(?=[\\/])` : `(?!${SEGMENT_CHAR})`
  const bodies = new Set([
    segments.map(escapeRegExp).join(SEP),
    segments.map((s) => escapeRegExp(urlEncoded(s))).join(SEP)
  ])
  const flags = windows ? 'gi' : 'g'
  const patterns = [...bodies].map((body) => new RegExp(`${start}${body}${end}`, flags))
  return { placeholder, segments: segments.length, length: root.length, patterns }
}

const compiled = new WeakMap<LogRedactionRoots, CompiledRoot[]>()

function compileRoots(roots: LogRedactionRoots): CompiledRoot[] {
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
  compiled.set(roots, list)
  return list
}

/** `text` with every known root by placeholder, and every account, volume and network name the generic shapes find
 *  hidden. Lines stay lines: nothing matches across a line break. */
export function redactLogText(text: string, roots: LogRedactionRoots): string {
  if (text === '') return text
  let out = text
  for (const root of compileRoots(roots)) {
    for (const pattern of root.patterns) out = out.replace(pattern, root.placeholder)
  }
  for (const [pattern, replacement] of GENERIC) {
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement)
  }
  return out
}

let registered: LogRedactionRoots = {}

/** Register the folders pass 1 names by placeholder. The main process calls it once, as soon as the drive root is
 *  resolved and before anything can read the log; until then only the generic shapes apply. Replaces the whole set. */
export function setLogRedactionRoots(roots: LogRedactionRoots): void {
  registered = { ...roots }
}

/** The registered folders (none until `setLogRedactionRoots`). */
export function logRedactionRoots(): LogRedactionRoots {
  return registered
}
