import { basename, dirname, isAbsolute, posix, resolve, win32 } from 'node:path'
import { nativeArchivePath } from './identity'

// How a kiwix-tools child is handed the library file and an archive (#787; rag-design.md §17
// D-Z1 "#787 amendment").
//
// On Windows both pinned kiwix-tools 3.8.1 programs take their paths on a narrow `char** argv`,
// which Windows fills in the ANSI code page, and libkiwix 14.1.1 then decodes those bytes as UTF-8
// (`Utf8ToWide` before every file call). Any non-ASCII character in a path on the command line is
// therefore mis-read (`Jürgen` → `J�rgen`, `山田` → `??`): kiwix-manage cannot write the library
// ("Cannot write the library …") nor open the archive ("Cannot add ZIM …"), and kiwix-serve cannot
// load the library. Measured on the real win-x86_64 binaries on 2026-11-08.
//
// What libkiwix does read correctly: a RELATIVE path, which it resolves against
// `getCurrentDirectory()` — `_wgetcwd` on Windows, wide and therefore exact — and the book paths
// inside a library file, which are UTF-8 text. So each child starts in the library's own folder
// and is handed the shortest ASCII spelling of each path:
//
//   - the library always by its bare file name (`library.<n>.xml`, `library.xml` — names the app
//     chooses, so ASCII), on every platform;
//   - on Windows, an archive whose absolute path holds a non-ASCII character by its path relative
//     to that folder when that is ASCII — the drive's own `zim/` folder under a root such as
//     `C:\Users\Jürgen\AppData\Roaming\HilbertRaum`, or another folder under that same account.
//
// The working directory is always that app-owned folder, never the archive's: Windows searches a
// process's working directory for a DLL it finds neither beside the exe nor in the system folders,
// and the pinned build imports the Visual C++ runtime, which the app does not bundle (#530). On a
// PC without it, a `vcruntime140.dll` planted beside a downloaded archive would run inside the
// integrity-checked tool (owner call 2026-11-08, from review).
//
// So an archive whose path has no ASCII spelling from there — a non-ASCII file name, or a
// non-ASCII folder outside the app's own — still reaches the child as it is: a system whose ANSI
// code page is UTF-8 reads it fine, and `nonAsciiArgv` tells the caller why it most likely failed.
//
// The written library is the same either way: kiwix-manage records every book path relative to the
// library's own folder (absolute across drives), measured byte-identical for an ASCII Kit; and the
// served names, which libkiwix derives from the archive's file name, do not change.
//
// A child's working directory must be under MAX_PATH on Windows, and spawn fails (ENOENT) when it
// is not. That only happens for a library path of 260+ characters, which kiwix cannot open from
// any spelling (its own file calls carry no `\\?\` prefix) — measured: both layouts fail alike
// from 250 characters. `KiwixServer` guards its stderr pipe against the error such a spawn emits.

const NON_ASCII = /[^\x00-\x7F]/

/** Every character is 7-bit ASCII — what libkiwix's UTF-8 decode of the ANSI argv reads exactly. */
export function isAsciiPath(path: string): boolean {
  return !NON_ASCII.test(path)
}

/**
 * The command a kiwix child is spawned as, absolute. The child starts in the library's folder, and
 * a relative command holding a separator is looked up from the CHILD's working directory — a dev
 * run's relative drive root or `HILBERTRAUM_KIWIX_BIN` would no longer resolve.
 */
export function kiwixCommand(binPath: string): string {
  return isAbsolute(binPath) ? binPath : resolve(binPath)
}

/** How to start kiwix-serve over one library file: from its folder, by its bare name. */
export interface KiwixLibraryLaunch {
  cwd: string
  library: string
}

/**
 * kiwix-serve's `--library` argument and working directory (#787). The same on every platform
 * (owner call 2026-11-08): one code path, and on Windows the library's folder may hold any
 * character. Uses the host's path flavour — the service builds the path with `join()`.
 */
export function kiwixLibraryLaunch(libraryXmlPath: string): KiwixLibraryLaunch {
  return { cwd: dirname(libraryXmlPath), library: basename(libraryXmlPath) }
}

/** One `kiwix-manage LIBRARY add ARCHIVE` invocation, as spawned. */
export interface KiwixManageInvocation {
  cwd: string
  args: [library: string, action: 'add', archive: string]
  /** Windows only: the archive's path had no ASCII spelling from the library's folder, so the argv
   *  still carries a non-ASCII character — the pinned build's known refusal (#340, #787). Always
   *  false elsewhere. */
  nonAsciiArgv: boolean
}

/**
 * Plan one `kiwix-manage LIBRARY add ARCHIVE` spawn (#787): the child starts in the library's
 * folder and gets the library by its bare name; on Windows a non-ASCII archive path is spelled
 * relative to that folder when that is ASCII (never across drives: `win32.relative` then returns
 * the absolute target). The archive is otherwise passed absolute, as before, with native separators
 * (kiwix-manage on Windows rejects forward-slash absolute paths — spike 2026-08-22).
 */
export function planKiwixManageAdd(
  libraryXmlPath: string,
  zimPath: string,
  platform: NodeJS.Platform
): KiwixManageInvocation {
  const p = platform === 'win32' ? win32 : posix
  const library = nativeArchivePath(libraryXmlPath, platform)
  const archive = nativeArchivePath(zimPath, platform)
  const cwd = p.dirname(library)
  const name = p.basename(library)
  if (platform !== 'win32' || isAsciiPath(archive)) {
    return { cwd, args: [name, 'add', archive], nonAsciiArgv: false }
  }
  const rel = win32.relative(cwd, archive)
  if (rel !== '' && !win32.isAbsolute(rel) && isAsciiPath(rel)) {
    return { cwd, args: [name, 'add', rel], nonAsciiArgv: false }
  }
  return { cwd, args: [name, 'add', archive], nonAsciiArgv: true }
}
