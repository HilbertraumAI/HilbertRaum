import { closeSync, openSync, writeSync } from 'node:fs'
import { ReadStream } from 'node:tty'

// Issue #190 phase 2 — read a password from the OPERATOR'S CONSOLE, not from `process.stdin`.
//
// WHY THIS EXISTS. The first version of the diagnostic harness prompted only when
// `process.stdin.isTTY`. Vitest runs every test file in a FORKED WORKER whose stdin is a pipe, so
// `isTTY` is `undefined` there NO MATTER what the operator's shell is — the hidden prompt could
// never fire, and the failure message told the operator to "re-run from an interactive shell",
// which cannot help. Measured on Windows PowerShell during the 2026-08-20 operator run; only the
// env-var fallback worked, which is the variant with the shell-history hazard.
//
// So the prompt must bypass the worker's streams entirely and talk to the console device:
//   * Windows — `\\.\CONIN$` / `\\.\CONOUT$`. The path MUST be the device form (`//./CONIN$`):
//     libuv makes a bare `CONIN$` absolute against the cwd first, which turns it into ENOENT.
//     It must also be opened READ-WRITE (`r+`): `SetConsoleMode` needs `GENERIC_READ |
//     GENERIC_WRITE` on the handle, and a `'r'` open fails `setRawMode` with EPERM.
//   * POSIX — `/dev/tty`, the controlling terminal, opened `r+` for the same reason.
//
// ECHO SUPPRESSION is the whole point, and it is delegated, not hand-rolled: `tty.ReadStream`'s
// `setRawMode(true)` is libuv's `uv_tty_set_mode(UV_TTY_MODE_RAW)`, which clears
// `ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT` on Windows and drops ECHO/ICANON on POSIX. Node exposes
// no console-mode API of its own, so if raw mode is NOT available we refuse: a cooked read would
// echo the workspace password onto the screen, and a half-hidden prompt is worse than no prompt.
// `openConsolePrompt` therefore probes raw mode as part of opening and returns `null` on failure,
// and the caller fails fast with `consoleUnavailableMessage()` — a copy-pasteable recipe that
// keeps the password out of the shell history, not an instruction that cannot be followed.

/** The env var the harness reads when the console prompt is unavailable. */
export const PASSWORD_ENV_VAR = 'HILBERTRAUM_STORED_COPY_AUDIT_PASSWORD'

/** A console opened for a hidden prompt: raw (no echo) input, plus a write side for the prompt. */
export type ConsolePrompt = {
  /** The console's input, already in raw mode. */
  input: ReadStream
  /** Write to the console DIRECTLY — vitest captures `process.stdout`, so the prompt would vanish. */
  write: (text: string) => void
  /** Restore cooked mode and release both handles. Idempotent. */
  close: () => void
}

const DEVICES =
  process.platform === 'win32'
    ? { input: '//./CONIN$', output: '//./CONOUT$' }
    : { input: '/dev/tty', output: '/dev/tty' }

/**
 * Open the controlling console with echo suppressed, or return `null` when there is none (a CI
 * runner, a detached process, a redirected console) or when raw mode is refused. Never falls back
 * to an echoing read.
 */
export function openConsolePrompt(): ConsolePrompt | null {
  let inFd: number | null = null
  let outFd: number | null = null
  let input: ReadStream | null = null
  try {
    inFd = openSync(DEVICES.input, 'r+')
    outFd = DEVICES.output === DEVICES.input ? inFd : openSync(DEVICES.output, 'w')
    input = new ReadStream(inFd)
    input.setRawMode(true) // throws (EPERM / ENOTTY) when this is not a real console — refuse then
  } catch {
    // Release whatever got as far as opening. The ReadStream owns `inFd` once constructed, so it
    // is closed by `destroy()`, never by a second `closeSync`.
    try {
      input?.destroy()
    } catch {
      /* already gone */
    }
    if (outFd != null && outFd !== inFd) closeSyncQuiet(outFd)
    if (inFd != null && input == null) closeSyncQuiet(inFd)
    return null
  }

  const stream = input
  const writeFd = outFd
  let closed = false
  return {
    input: stream,
    write: (text: string): void => {
      if (closed) return
      try {
        writeSync(writeFd, text)
      } catch {
        /* the console went away mid-prompt — the read below will fail loudly enough */
      }
    },
    close: (): void => {
      if (closed) return
      closed = true
      try {
        stream.setRawMode(false)
      } catch {
        /* best effort — we are on the way out */
      }
      stream.pause()
      try {
        stream.destroy()
      } catch {
        /* already gone */
      }
      if (writeFd !== inFd) closeSyncQuiet(writeFd)
    }
  }
}

function closeSyncQuiet(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    /* already closed */
  }
}

/**
 * The fail-fast text for "there is no console to prompt on". It carries a recipe that WORKS from
 * the operator's shell and keeps the secret out of the history file — typed at a prompt, never on
 * a command line — because the alternative the old message offered ("re-run from an interactive
 * shell") is not a thing the operator can do: vitest's worker has a piped stdin either way.
 */
export function consoleUnavailableMessage(): string {
  const recipe =
    process.platform === 'win32'
      ? // Read-Host -AsSecureString keeps the typed characters off the screen and out of
        // PSReadLine's ConsoleHost_history.txt; the Marshal round-trip is the documented way to
        // get the plaintext back out of a SecureString in Windows PowerShell.
        `  $env:${PASSWORD_ENV_VAR} = [Runtime.InteropServices.Marshal]::PtrToStringAuto(\n` +
        `    [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host -AsSecureString "Workspace password")))`
      : // `read -s` does not echo, and a value typed at a prompt never enters the history file.
        `  read -rs -p "Workspace password: " ${PASSWORD_ENV_VAR}\n` +
        `  export ${PASSWORD_ENV_VAR}`
  return (
    'This workspace is encrypted and no console is available for the hidden password prompt ' +
    `(${DEVICES.input} could not be opened in raw mode). Set the password into the environment ` +
    'with the recipe below — it is typed at a prompt, so it never lands in the shell history — ' +
    'then re-run:\n\n' +
    `${recipe}\n\n` +
    'Clear it afterwards, and note that the value is readable in the process environment by ' +
    'anything running as you while it is set.'
  )
}

/**
 * Prompt for a password on the console with the input hidden. Throws
 * `consoleUnavailableMessage()` when there is no console — never an echoing fallback, and never a
 * partially-typed password (Ctrl-C rejects).
 *
 * `open` is injectable so the no-console path is CI-testable on every platform.
 */
export async function promptHiddenPassword(
  prompt = 'Workspace password (input hidden, Enter to submit): ',
  open: () => ConsolePrompt | null = openConsolePrompt
): Promise<string> {
  const con = open()
  if (!con) throw new Error(consoleUnavailableMessage())
  con.write(prompt)
  try {
    return await new Promise<string>((resolve, reject) => {
      let buf = ''
      const finish = (fn: () => void): void => {
        con.input.removeListener('data', onData)
        con.write('\n')
        fn()
      }
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            const out = buf
            buf = ''
            finish(() => {
              resolve(out)
            })
            return
          }
          if (ch === '\u0003') {
            // Ctrl-C: abort the run rather than proceeding with a partial password.
            buf = ''
            finish(() => {
              reject(new Error('cancelled'))
            })
            return
          }
          if (ch === '\u007f' || ch === '\b') {
            buf = buf.slice(0, -1)
            continue
          }
          buf += ch
        }
      }
      con.input.setEncoding('utf8')
      con.input.on('data', onData)
      con.input.resume()
    })
  } finally {
    con.close()
  }
}
