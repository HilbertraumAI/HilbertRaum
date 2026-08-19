import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStoredCopyAudit, isUnder } from '../helpers/stored-copy-audit-run'
import { fingerprintTree, treeUnchanged } from '../helpers/read-only-witness'

// MANUAL stored-copy diagnostic (issue #190 checkbox 1) — NOT CI.
//
// This is the operator harness. Everything it does is proven in CI by
// `tests/integration/stored-copy-audit-run.test.ts` (exact counts against a synthetic vault, plus
// the read-only witness) and `tests/unit/stored-copy-audit.test.ts` (the classifier). What CANNOT
// be CI'd is pointing it at the real prepared drive, which needs the drive and the owner's
// password — hence the env gate, in the shape of the other `tests/manual/*-smoke.test.ts` files.
//
// ---------------------------------------------------------------------------------------------
// RUN IT
//
//   PowerShell (Windows — the reporting drive):
//     $env:HILBERTRAUM_STORED_COPY_AUDIT = "H:\"          # the drive ROOT (holds config\ + workspace\)
//     npx vitest run tests/manual/stored-copy-diagnostic.test.ts
//
//   bash / zsh (macOS, Linux):
//     HILBERTRAUM_STORED_COPY_AUDIT=/Volumes/HILBERTRAUM \
//       npx vitest run tests/manual/stored-copy-diagnostic.test.ts
//
//   Run it from `apps/desktop/`. The report is printed to stdout; add
//   HILBERTRAUM_STORED_COPY_AUDIT_OUT=<file> to also write it somewhere you can copy from.
//
// THE PASSWORD. The harness prompts on the terminal (no echo) whenever stdin is a TTY, which is
// the way to supply it: nothing is recorded anywhere. If you must run non-interactively, set
//   HILBERTRAUM_STORED_COPY_AUDIT_PASSWORD=…
// and understand the hazard: an environment variable typed at a shell lands in that shell's
// HISTORY (bash `~/.bash_history`, PowerShell's PSReadLine `ConsoleHost_history.txt`, which is a
// plain file in your roaming profile) and is readable in the process environment by anything
// running as you. Prefer the prompt. A `plaintext_dev` workspace needs no password at all.
//
// WHAT IT WILL NOT DO. It never writes to the drive: it copies `config/workspace.json` +
// `workspace/hilbertraum.sqlite.enc` to a scratch directory in your temp dir, decrypts the COPY,
// opens the copy read-only, and shreds the scratch on the way out. It never calls
// `unlockEncryptedVault`, `recoverPendingRekey`, `preserveNewerPlaintext`, `lockEncryptedVault`
// or `openDatabase` against the drive — each of those MUTATES (see the safety contract in
// `tests/helpers/stored-copy-audit-run.ts`). It fingerprints the whole drive tree before and
// after and FAILS if a single size or mtime moved.
//
// WHAT THE OUTPUT IS FOR. It is designed to be pasted verbatim into public issue #190: counts,
// histograms, and shape tokens only — no titles, no content, no paths, no file names. Read it
// once before pasting anyway (checklist in the PR body).

const ROOT = process.env.HILBERTRAUM_STORED_COPY_AUDIT?.trim() ?? ''
const PASSWORD_ENV = process.env.HILBERTRAUM_STORED_COPY_AUDIT_PASSWORD ?? ''
const OUT = process.env.HILBERTRAUM_STORED_COPY_AUDIT_OUT?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

/** Read a password from the terminal without echoing it. Never logged, never persisted. */
async function promptPassword(): Promise<string> {
  const stdin = process.stdin
  process.stdout.write('Workspace password (input hidden, Enter to submit): ')
  return new Promise<string>((resolve, reject) => {
    let buf = ''
    const finish = (fn: () => void): void => {
      stdin.removeListener('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause()
      process.stdout.write('\n')
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
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
  })
}

describe.skipIf(!enabled)('HILBERTRAUM_STORED_COPY_AUDIT — read-only stored-copy diagnostic (#190)', () => {
  it(
    'audits the drive without writing to it and prints a report safe to paste in public',
    { timeout: 600_000 },
    async () => {
      const scratchRoot = join(tmpdir(), 'hilbertraum-stored-copy-audit')
      mkdirSync(scratchRoot, { recursive: true })
      // The scratch MUST NOT live on the drive — a decrypted copy landing there is exactly the
      // outcome this harness exists to avoid. `runStoredCopyAudit` refuses too; this fails first
      // and with an instruction rather than a stack trace.
      expect(
        isUnder(ROOT, scratchRoot),
        'TMPDIR points inside the drive — set it elsewhere before running'
      ).toBe(false)

      let password = PASSWORD_ENV
      const needsPassword = existsSync(join(ROOT, 'config', 'workspace.json'))
      if (needsPassword && !password) {
        if (!process.stdin.isTTY) {
          throw new Error(
            'This workspace is encrypted and stdin is not a terminal. Re-run from an interactive ' +
              'shell for the hidden prompt, or set HILBERTRAUM_STORED_COPY_AUDIT_PASSWORD (see the ' +
              'shell-history hazard in this file’s header).'
          )
        }
        password = await promptPassword()
      }

      // The read-only witness. Anything that moves between these two fingerprints — a size, an
      // mtime, an added or removed path — fails the run and is a defect in the tool, not in the
      // drive.
      const before = fingerprintTree(ROOT)
      let result
      try {
        result = runStoredCopyAudit({ root: ROOT, password: password || undefined, scratchRoot })
      } finally {
        password = ''
      }
      const after = fingerprintTree(ROOT)

      const text = result.text
      process.stdout.write(`\n${text}\n`)
      for (const note of result.notes) process.stdout.write(`note: ${note}\n`)
      if (OUT) {
        expect(isUnder(ROOT, OUT), 'the output file must not be written to the drive').toBe(false)
        writeFileSync(OUT, text, 'utf8')
        process.stdout.write(`report written to ${OUT}\n`)
      }

      expect(
        treeUnchanged(before, after),
        `THE DRIVE CHANGED during the run (${String(before.entries)} → ${String(after.entries)} entries). ` +
          'Do not trust this report; report it as a bug in the diagnostic.'
      ).toBe(true)

      // A sanity floor: an empty report means the harness was pointed at the wrong root.
      expect(result.report.documents.total).toBeGreaterThan(0)
    }
  )
})
