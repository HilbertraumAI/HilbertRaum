# Remediation ledger — audit 2026-07-23 wave

Branch: `fix/audit-2026-07-23-remediation` (off `master` `bbf26add`, v0.1.55)
Baseline: `bbf26add` · typecheck ✓ · repo-hygiene 12/12 ✓ · `tests/unit` 1656 pass / 102 files ✓
Machine: i7-1185G7 / 8 logical cores / 17 GB RAM (~3 GB free under load); local node **v22.18.0**,
npm 10.9.3 on the shell PATH (BUILD_STATE §2 records v24.13.0 / npm 11.6.2 — see backlog B-01).

Working paper. Transient with the plan and the report; folded into the durable
`architecture.md` close-out ledger at Phase 11 and deleted. Keep NUL/BOM-free UTF-8
(`repo-hygiene.test.ts` walks `docs/` on the filesystem).

---

## Carry-forward backlog (issues found mid-wave; each assigned to a phase)

- [ ] **B-01** — the shell PATH node is **v22.18.0 / npm 10.9.3**; `package.json` `engines` declares
  `node >=22.5` (satisfied) but `npm >=11` (**not** satisfied locally), the same dead-policy floor
  AUD-26 says CI must exercise. Only affects local gate runs
  (vitest is unaffected); relevant context for Phase 9a's CI Node bump. *Assigned: Phase 9a
  (informational — do not "fix" the local box).*

## Decisions log

- **D-W1 (plan §3, carried in):** the verified-and-dismissed engine-download tar-child-on-quit item is
  a confirmed **live extension of the known residual** BUILD_STATE §5 item 9 ("Downloads on quit" —
  the registered residual names the *model* download `.part` stream; the sighting is the separate
  *engine* downloader's tar child). **Not in this wave**; recorded here so a future
  downloads-teardown wave inherits it.
- **D-W2 (plan §3):** DV-4 (Skills auto-fire card label duplication) is Info/no-action — not
  scheduled.
- **D-W3 (plan §0.7):** reference hygiene — no durable artifact (code/test comments, commit messages,
  `BUILD_STATE.md`, `CHANGELOG.md`, committed docs, the `architecture.md` close-out ledger) may cite
  the audit report, this plan, this ledger, or `invoice-audit-ia1.test.ts` by path or filename.
  `AUD-nn` is a label that must resolve to the self-contained Phase-11 close-out ledger.

## Phase outcomes

### Phase 0 — wave setup — DONE
- Branch `fix/audit-2026-07-23-remediation` created off `master` `bbf26add` (== `origin/master`).
- Ledger created (this file), NUL/BOM-free UTF-8.
- Baseline gate: `apps/desktop` `npm run typecheck` **green**;
  `npx vitest run tests/integration/repo-hygiene.test.ts` **12/12 pass**;
  `npx vitest run --reporter=dot tests/unit` **1656 pass / 102 files** (18.83 s).
  Full suite deliberately NOT run here — Phase 10 owns it (plan §0.2).
- Machine profile recorded above; backlog seeded with B-01.
