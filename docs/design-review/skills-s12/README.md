# Skills S12 — run-surface eyeball (RESIDUAL: live-model capture deferred)

This directory is the home for the running-model Playwright eyeball of the **Tier-2 run surfaces**
(`SkillRunBar`): the OFFER buttons, the busy row, the write/export **confirm modal** (now
production-firing), and the calm result rows for every tool. It is the last carry-forward of the
Skills wave (forwarded since S6 / S11b / S11c).

## Status — deferred, NOT faked

No PNGs are committed here. The capture was **not produced** at S12, and a fake capture is worse than
an honest gap (CLAUDE.md offline/honesty posture). What *is* done:

- **Every visual state is unit-covered** by [`tests/renderer/SkillRunBar.test.tsx`](../../../apps/desktop/tests/renderer/SkillRunBar.test.tsx):
  - renders nothing with no run / no offered tools;
  - OFFER — a read-only tool runs immediately (no modal); a write/export tool raises the
    `ConfirmDialog` and runs only on confirm;
  - RUNNING — the busy row + Cancel;
  - RESULT — done count, friendly failure, cancelled ("nothing was saved"), the per-tool done copy
    (categorize / summarize / export), and `validate_statement_balances`'s
    `reconciled` / `unreconciled` / `unchecked` verdicts keyed off `resultKind`.
  - EN + DE copy is exercised through the i18n catalogs the bar reads.
- The **composer-picker** surfaces (the other half of the skills UI) were captured live at S6 —
  see [`../skills-s6/`](../skills-s6/).

## Why the live walk wasn't run at S12

The existing harness [`apps/desktop/scripts/walk-skills-composer.mjs`](../../../apps/desktop/scripts/walk-skills-composer.mjs)
brings up the **mock runtime** + the bundled `app-skills/bank-statement/` skill and captures the
composer picker. The run surfaces need three more things the composer walk does not set up, and they
could not be authored-and-verified in the current (headless, no-Playwright, de-AT) dev environment
without risking a broken committed harness:

1. **A seeded, indexed bank statement in the conversation's scope** — `listRunnableTools` returns `[]`
   (so the OFFER never renders) unless `resolveInScopeDocumentIds` finds an `indexed` document. That
   means driving a real ingestion (import → extract → chunk → embed via the mock embedder) for a
   statement whose text the deterministic parser can extract rows from.
2. **A live run through the app-orchestrated seam** (extract → the busy row → the result row), then a
   second run for `export_transactions_csv` to reach the confirm modal.
3. **A stub for the native save dialog** — the `ConfirmDialog` fires *before* `dialog.showSaveDialog`,
   so the modal can be shot without completing a save; the save dialog itself must be stubbed
   (`BrowserWindow`/`dialog` evaluate hook) so the walk never blocks on an OS dialog.

## Recipe for whoever runs it (GUI machine)

Add a sibling `walk-skills-runbar.mjs` modelled on the S6 walk:

1. Same gate-(A) setup (mock runtime) + the bundled skill, now **`kind:'tool'`** so the OFFER renders.
2. Seed one indexed statement: import a small `.txt` whose lines match the parser
   (`<ISO-date> <description> <amount with 2 minor digits> [<balance>]`, with a currency code/symbol
   on the page), and wait for `status === 'indexed'`.
3. Open Chat → pick "Bank Statement Analysis" → the `.skill-run-bar` OFFER appears. Capture
   `runbar-<loc>-offer`.
4. Click **Extract transactions** → capture `runbar-<loc>-running` (the busy row) then
   `runbar-<loc>-result-extract`.
5. Re-run validate / categorize / summarize → capture each result row (incl. validate's three
   `resultKind` verdicts).
6. Click the **export** tool → capture `runbar-<loc>-confirm` (the `ConfirmDialog`); confirm with the
   save dialog stubbed → capture `runbar-<loc>-result-export`.
7. Each in both themes × EN/DE, `fullPage`, into this directory.

Playwright stays an ad-hoc dev tool (installed `--no-save`, never a committed dependency).
