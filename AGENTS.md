# AGENTS.md — instructions for AI agents working in this repo

General working rules, build commands, and the per-phase ritual live in
[`CLAUDE.md`](CLAUDE.md) — read that first. This file adds the **licensing and
governance invariants** every agent must respect, plus the current review brief.

## Licensing & CLA invariants (do not violate in any PR)

1. **License:** the software core is GPL-3.0-or-later and stays under GPL — the
   README makes that a public promise. Never add code under a GPL-incompatible
   license; flag any new dependency or vendored snippet for license review.
2. **CLA:** every external contribution requires a signed CLA
   ([`.github/CLA.md`](.github/CLA.md), enforced by
   [`.github/workflows/cla.yml`](.github/workflows/cla.yml)). Never merge a PR
   with a red CLA check. Never weaken the workflow (allowlist additions need
   maintainer sign-off). The `cla-signatures` branch stores signatures — never
   delete, rebase, or force-push it.
3. **Anti-tivoization design rules (GPLv3 §6, we sell hardware kits):**
   - Drive/build verification may **warn**, but must never **lock out** modified
     or unsigned builds.
   - Workspace decryption is keyed **only to the user's password**, never to a
     binary signature, drive serial, or other attestation.
   Any feature resembling drive pairing, attestation, or anti-copy enforcement
   must be escalated to the maintainers before implementation.
4. **Trademark:** "HilbertRaum" name/logo are trademarks
   ([`TRADEMARKS.md`](TRADEMARKS.md)); the GPL does not license them. Keep code
   and docs consistent with that split.
5. **If the repo moves to the HilbertRaumAI org:** update the two hardcoded
   URLs in `.github/workflows/cla.yml` (`path-to-document`,
   `custom-notsigned-prcomment`) and the badge/links that embed
   `comilionas/AI_Drive`.

## Review brief: PR "CLA, trademark policy & license promise" (2026-07-09)

You are reviewing the launch-governance PR in place of a lawyer's first pass.
The repo goes public imminently; treat findings as blocking (must fix before
launch) or non-blocking (file as issues). Verify at minimum:

1. **Internal consistency.** CLA (`.github/CLA.md`, `.github/CLA-corporate.md`),
   `CONTRIBUTING.md` ("License and CLA"), `README.md` ("License"), and
   `TRADEMARKS.md` must tell one coherent story: GPL-3.0-or-later core +
   forever-GPL promise + dual licensing funded by the CLA + trademark separate
   from the code license. Flag any contradiction, including "GPLv3" vs.
   "GPL-3.0-or-later" wording drift.
2. **CLA substance.** Does the individual CLA actually grant relicensing rights
   broad enough for dual licensing (copyright §2, patent §3)? Is the corporate
   CLA's incorporation-by-reference of the individual CLA coherent? Are the
   Austrian-law / moral-rights clauses internally consistent? Note: this text
   is v1.0 and deliberately short — flag substantive gaps, not style.
3. **Workflow correctness.** Compare `.github/workflows/cla.yml` against the
   tested reference in the private test repo `humaniser/cla-flow-test` (PR #2
   ran green end-to-end). Check: action inputs are valid for
   contributor-assistant/github-action@v2.6.1; the repo's default branch is
   `master` (not `main`) everywhere; the allowlist contains exactly the founder
   accounts (`humaniser`, `comilionas`) plus bots. Confirm the `cla-signatures`
   branch exists before merge.
4. **Promise vs. rights.** The README promise ("every version we publish here,
   forever" stays GPL) must not overpromise: it may bind published versions,
   but must not accidentally forbid dual licensing or future source-available
   editions of *other* distributions. Read it adversarially, as a HN commenter
   would.
5. **Trademark policy.** Nominative-fair-use carve-outs present; unmodified
   redistribution allowed; forks-must-rename and no-unofficial-kits rules
   clear; EUTM application number correct (019392763, filed 2026-07-09).
6. **Nothing leaked.** No internal/private-repo paths, personal data, or
   business figures in any public file of this PR.
7. **Launch checklist residue.** After merge, branch protection on `master`
   must require the `CLAAssistant` check; a follow-up lawyer review of the CLA
   texts remains open (v1.0 is unreviewed).

Remove or archive this review-brief section once the review is signed off; the
invariants section above stays.
