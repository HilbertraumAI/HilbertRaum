# F-23 golden manifests (app-update wave, T2.10)

Hand-written on 2026-11-25 at commit `ae70b75f` (branch `feat/updates-workspace-guards`) from the contract
text, not from the code: the plan's Appendix B (F-23), `docs/model-policy.md` ("Manifest fields",
"A manifest for a newer HilbertRaum", `min_app_version`, `default_for_role`) and W-62 (b) for the scripts.

- `single/`: one file per case, every id unique, read as one folder. `verdicts.json` gives each file's verdict
  at the set's app version (`0.1.66`) and, under `at`, at `0.1.66-beta.1` and at an app that does not know its
  version (`""`), where it differs. `scripts` is what both twins of `fetch-models` and `verify-models` do with
  the file at each version (the version a checkout's scripts read is its `apps/desktop/package.json`).
- `scenarios/`: one `model-manifests/` tree each (id space, walk order, `default_for_role`).
- `flat-read/`: the manifest that proves the scripts' flat-read parity row can fail.

Release 1 reads every file a later release puts on a drive, for ever: a verdict here never changes. A later
release adds files and lines only. Locked by `../../golden-fixtures.sha256`.
