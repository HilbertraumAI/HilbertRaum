# F-25 golden skill folders (app-update wave, T2.10)

Hand-written on 2026-11-25 at commit `ae70b75f` from the contract text: the plan's Appendix B (F-25: the
closed `kind` set checked before `compatibility.minAppVersion`, the fail-open gate, a pre-release app older
than its release, `disabled_reason` re-enabling only `min_app_version`, a vanished or invalid folder marked
unavailable, never deleted) and W-65 as T2.14 built it (commit `73639b94`: the reconcile's `needsNewerApp`
code, `failedSkillNeedsNewerApp`, `needsNewerAppCount`). `skills/` holds one folder per case; `verdicts.json`
gives each folder's verdicts at `0.1.66` and, under `at`, at `0.1.66-beta.1` and at an app that does not know its
version (`""`), plus reconcile sequences. The tests copy the folders to a temp root as app skills.

As built: a `minAppVersion` that is not plain `MAJOR.MINOR.PATCH` (a suffix, a fourth part, `1.0`) makes the
skill invalid before the gate is asked; the gate's fail-open covers an app version it cannot read only.
Round 2 (after the Fable QA) added six folders (`g25-min-suffix`, `g25-min-four-parts`, `g25-unknown-keys`,
`g25-missing-title-min-above`, `g25-kind-unknown-min-malformed`, `g25-folder-not-id`) and a fifth sequence
(an unknown `disabled_reason`); no earlier verdict changed. Round 3 (after the QA's re-check 1) added three
folders: a `v`-prefixed and a `+build` minimum, both invalid at every version, and a leading-zero minimum
(`0.01.66`), valid and compared as numbers; no earlier verdict changed. `unavailable-reasons.json` is T2.14 round 2's
addition beside `verdicts.json` (the reason a reconcile gives for an unavailable row), over this set's folders.
Round 4 (T2.7's F-23/F-25 fix round, 2026-11-25, on `dc46db15`, from the two Fable reviews of F-25 as built) pins what
release 1 does as built: three folders with a value it does not know of a key it reads leniently and no minimum
(`g25-analysis-unknown`, `g25-permission-unknown`, `g25-tool-unknown`; R1 MJ-3: valid, the value dropped, the skill runs
without it, under the new `reads` key), two with a misplaced minimum (`g25-min-top-level`, `g25-min-top-level-snake`;
R1 MJ-6: ignored, the skill is used), and two sequences (R2 M-3: an app row off with no reason, never written since, is
read as the version gate's and switched back on; on an app version the gate cannot read its reason is recorded as
`min_app_version` first). No earlier verdict changed. Locked by `../../golden-fixtures.sha256`.
