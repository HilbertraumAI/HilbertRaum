import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PASSWORD_ENV_VAR,
  consoleUnavailableMessage,
  openConsolePrompt,
  promptHiddenPassword,
  type ConsolePrompt
} from '../helpers/console-password'

// Issue #190 phase 2 — CI proof for the console password path of the manual diagnostic.
//
// THE DEFECT THIS PINS. The first harness prompted only `if (process.stdin.isTTY)`. Vitest runs
// every test file in a FORKED WORKER whose stdin is a pipe, so that branch is dead in the only
// process that ever executes it — the prompt could not fire from a fully interactive PowerShell,
// and the operator was told to "re-run from an interactive shell", which cannot help. THIS FILE
// RUNS IN THAT SAME WORKER, so the assertion below is the defect's own witness rather than a
// simulation of it.
//
// What is CI-able here is everything except a human typing: the no-console fail-fast, the exact
// recipe it carries, the refusal to fall back to an echoing read, and the harness header telling
// the truth about how to run it. The keystroke path is exercised by the operator run.

const MANUAL = join(__dirname, '..', 'manual', 'stored-copy-diagnostic.test.ts')

describe('console password prompt (#190) — the non-TTY path', () => {
  it("the vitest worker's stdin is NOT a TTY — the branch the old harness gated on is dead here", () => {
    // If this ever becomes true, vitest changed its pooling and the header's explanation needs
    // revisiting — but the console-device prompt keeps working either way.
    expect(process.stdin.isTTY).toBeFalsy()
  })

  it('fails fast with the copy-pasteable recipe when there is no console, and never echoes', async () => {
    await expect(promptHiddenPassword('pw: ', () => null)).rejects.toThrow(PASSWORD_ENV_VAR)
    const msg = consoleUnavailableMessage()

    // It must name the env var and a recipe that WORKS from the operator's shell...
    expect(msg).toContain(PASSWORD_ENV_VAR)
    if (process.platform === 'win32') {
      expect(msg).toContain('Read-Host -AsSecureString')
      expect(msg).toContain('SecureStringToBSTR')
      expect(msg).toContain('PtrToStringAuto')
    } else {
      expect(msg).toContain('read -rs')
    }
    // ...and must NOT repeat the advice that wasted an operator round trip: no shell is
    // "interactive" enough to give a forked vitest worker a TTY on stdin.
    expect(msg.toLowerCase()).not.toContain('interactive shell')
    // The hazard of the fallback is stated where the operator reads it.
    expect(msg).toContain('shell history')
  })

  it('never resolves a password from a console it could not put into raw mode', async () => {
    // A console whose `setRawMode` fails must be treated as absent, not read in cooked mode —
    // a cooked read echoes the workspace password onto the screen.
    let opened = 0
    const refusing = (): ConsolePrompt | null => {
      opened += 1
      return null // exactly what `openConsolePrompt` returns when the raw-mode probe throws
    }
    await expect(promptHiddenPassword('pw: ', refusing)).rejects.toThrow(/no console is available/)
    expect(opened).toBe(1)
  })

  it('opening the console is safe to attempt anywhere: it yields a raw stream or null', () => {
    // CI runners have no controlling terminal, so this is `null` there; on a developer machine
    // with a console it opens. Either way it must not throw, and it must leave nothing behind.
    const con = openConsolePrompt()
    if (con) {
      expect(con.input.isRaw).toBe(true) // raw = echo suppressed, which is the whole contract
      con.close()
      con.close() // idempotent — a double close must not throw on the way out of a failed run
      expect(con.input.isRaw).toBe(false) // cooked mode restored for the operator's shell
    } else {
      expect(con).toBeNull()
    }
  })

  it('the manual harness reads the console, not process.stdin, and its header says how to run it', () => {
    const src = readFileSync(MANUAL, 'utf8')
    // Comments explain the dead `isTTY` branch on purpose; the CODE must not contain it.
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n')
    // The fix is adopted, not re-implemented next to the old one.
    expect(code).toContain("from '../helpers/console-password'")
    expect(code).toContain('promptHiddenPassword(')
    expect(code).not.toContain('process.stdin')
    expect(code).not.toContain('isTTY')
    expect(code).not.toContain('setRawMode') // the hand-rolled prompt is gone, not duplicated
    // The header must not advertise an invocation that is blocked on the maintainer's machine.
    expect(src).not.toContain('npx vitest')
    expect(src).toContain('node_modules\\.bin\\vitest.cmd')
  })
})
