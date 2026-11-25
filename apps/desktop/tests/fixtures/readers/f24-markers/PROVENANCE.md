# F-24 golden install markers (app-update wave, T2.10)

Hand-written on 2026-11-25 at commit `ae70b75f` from W-62's lists (plan §2, PA-314, #1028) and the marker
contract in `docs/data-contracts.md` ("#1028 — how every reader reads the marker"). One file,
`vectors.json`: the engine copy the vectors describe (`copy`: two files and their bytes), the record every
writer writes for it, and the vectors, each with its verdict per reader. The marker's real name
(`.hilbertraum-runtime.json`) is written by the tests into a temp root; no marker file is committed, because
a NUL or a byte-order mark in a text file under `tests/` fails the repo hygiene nets (decision 2 of the phase
sheet): such bytes are base64 here.

Two verdicts differ from the plan's wording and are frozen as built (T2.10 report): "a map without the
program" is damaged at the pre-spawn check and in a Kit build, a marker to the shared reading and to the twins
outside commercial mode. Locked by `../../golden-fixtures.sha256`.
