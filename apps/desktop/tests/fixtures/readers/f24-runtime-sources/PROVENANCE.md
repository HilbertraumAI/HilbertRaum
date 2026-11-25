# F-24 golden runtime-sources.yaml files (app-update wave, T2.10)

Hand-written on 2026-11-25 at commit `ae70b75f` from the contract text: the plan's Appendix B (F-24: "the yaml
validator is whole-file"; "add families as new top-level keys and build fields as new keys") and
`docs/model-policy.md` ("`runtime-sources.yaml`"). Each file is read whole by `validateRuntimeSources`;
`verdicts.json` says whether it validates and which families it yields; a file the YAML parser refuses is
refused like an invalid one. Round 2 (after the Fable QA) added `a7` (a new backend) and `d9`-`d12` (no YAML,
empty, not a mapping, a new os in an optional family); no earlier verdict changed. Locked by
`../../golden-fixtures.sha256`.
