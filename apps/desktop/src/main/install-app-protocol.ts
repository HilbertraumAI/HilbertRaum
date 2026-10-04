import { lstatSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { protocol } from 'electron'
import {
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  createAppProtocolHandler,
  listAppAssets,
  printPages
} from './app-protocol'

// Electron glue for the app's own scheme (#560). The policy — privileges, resolver, headers — is
// the pure app-protocol.ts, pinned by tests/unit/app-protocol.test.ts; keep this file thin.

/** Register the scheme's privileges. Electron allows this only BEFORE `ready`, once. */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { ...APP_SCHEME_PRIVILEGES } }])
}

/**
 * Serve `rendererRoot` (out/renderer, inside app.asar when packaged) on the default session — the
 * one all three windows use — and the evidence-pack print pages from memory (#563). The file list
 * is taken once, here: the packaged root is read-only, and under the dev server no window loads it
 * (it serves whatever was last built, or nothing). Returns the number of files.
 */
export function installAppProtocol(rendererRoot: string): number {
  const files = listAppAssets(
    rendererRoot,
    {
      readdir: (dir) => readdirSync(dir),
      kind: (path) => {
        // lstat: a symlink is neither a file nor a directory here, so it is never followed out.
        const st = lstatSync(path)
        return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
      }
    },
    join
  )
  protocol.handle(
    APP_SCHEME,
    createAppProtocolHandler({ files, readFile: (relPath) => readFile(join(rendererRoot, relPath)), printPages })
  )
  return files.size
}
