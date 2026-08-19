import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStoredCopyAudit, isUnder } from '../helpers/stored-copy-audit-run'
import { fingerprintTree, treeUnchanged } from '../helpers/read-only-witness'
import { PASSWORD_ENV_VAR, promptHiddenPassword } from '../helpers/console-password'

// MANUAL stored-copy diagnostic (issue #190 checkbox 1) — NOT CI.
//
// This is the operator harness. Everything it does is proven in CI by
// `tests/integration/stored-copy-audit-run.test.ts` (exact counts against a synthetic vault, plus
// the read-only witness) and `tests/unit/stored-copy-audit.test.ts` (the classifier). What CANNOT
// be CI'd is pointing it at the real prepared drive, which needs the drive and the owner's
// password — hence the env gate, in the shape of the other `tests/manual/*-smoke.test.ts` files.
//
// RUN OF RECORD: 2026-08-20 against the prepared drive on `G:\` (encrypted, v2 descriptor,
// pre-#189 schema). 24/24 rows stale, 24/24 healable, 1 orphan (115.2 KiB), tree byte-identical.
// The measured report and what it settles are in `docs/architecture.md` §9.
//
// ---------------------------------------------------------------------------------------------
// RUN IT — from `apps/desktop/`.
//
//   PowerShell (Windows — the reporting drive):
//     $env:HILBERTRAUM_STORED_COPY_AUDIT = "G:\"          # the drive ROOT (holds config\ + workspace\)
//     ..\..\node_modules\.bin\vitest.cmd run tests/manual/stored-copy-diagnostic.test.ts
//
//   bash / zsh (macOS, Linux):
//     HILBERTRAUM_STORED_COPY_AUDIT=/Volumes/HILBERTRAUM \
//       ../../node_modules/.bin/vitest run tests/manual/stored-copy-diagnostic.test.ts
//
//   Use those paths, NOT `npx` — it is blocked by the PowerShell execution policy on the
//   maintainer's machine (its shim is a `.ps1`). The `node_modules/.bin/vitest.cmd` form above is
//   a `.cmd` and runs under any policy. The report is printed to stdout; add
//   HILBERTRAUM_STORED_COPY_AUDIT_OUT=<file> to also write it somewhere you can copy from.
//
// THE PASSWORD. The harness prompts on the CONSOLE with the input hidden — `\\.\CONIN$` on
// Windows, `/dev/tty` on POSIX, in raw mode, opened directly. It deliberately does NOT look at
// `process.stdin`: vitest runs this file in a forked worker whose stdin is a pipe, so
// `process.stdin.isTTY` is always false and a prompt gated on it can never fire, however
// interactive your shell is (measured on Windows PowerShell, 2026-08-20 — it is why the run of
// record had to use the env var). Nothing is recorded anywhere.
//
// If there is no console at all — CI, a detached process, a redirected terminal — the run FAILS
// FAST with the exact recipe for setting `HILBERTRAUM_STORED_COPY_AUDIT_PASSWORD` from a hidden
// prompt (`Read-Host -AsSecureString` / `read -rs`), because a value typed at a prompt does not
// enter the shell history the way one typed on a command line does (bash `~/.bash_history`,
// PowerShell's PSReadLine `ConsoleHost_history.txt` — a plain file in your roaming profile).
// While it is set it is readable in the process environment by anything running as you, so clear
// it afterwards. A `plaintext_dev` workspace needs no password at all.
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
// once before pasting anyway (checklist in the PR body). It is also the evidence collector for
// the second-laptop continuity check (BUILD_STATE §5 item 1): run it before and after the
// relocation and compare the stale / healable / `stored_name populated` triple.

const ROOT = process.env.HILBERTRAUM_STORED_COPY_AUDIT?.trim() ?? ''
const PASSWORD_ENV = process.env[PASSWORD_ENV_VAR] ?? ''
const OUT = process.env.HILBERTRAUM_STORED_COPY_AUDIT_OUT?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

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
      // The console prompt, or a fail-fast carrying the recipe. Never an echoing fallback.
      if (needsPassword && !password) password = await promptHiddenPassword()

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
