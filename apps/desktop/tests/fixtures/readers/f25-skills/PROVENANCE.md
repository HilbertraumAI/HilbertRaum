# F-25 golden skill folders (app-update wave, T2.10)

Hand-written on 2026-11-25 at commit `ae70b75f` from the contract text: the plan's Appendix B (F-25: the
closed `kind` set checked before `compatibility.minAppVersion`, the fail-open gate, a pre-release app older
than its release, `disabled_reason` re-enabling only `min_app_version`, a vanished or invalid folder marked
unavailable, never deleted) and W-65 as T2.14 built it (commit `73639b94`: the reconcile's `needsNewerApp`
code, `failedSkillNeedsNewerApp`, `needsNewerAppCount`). `skills/` holds one folder per case; `verdicts.json`
gives each folder's verdicts at `0.1.66` and, under `at`, at `0.1.66-beta.1` and at an app that does not know its
version (`""`), plus four reconcile sequences. The tests copy the folders to a temp root as app skills.
Locked by `../../golden-fixtures.sha256`.
