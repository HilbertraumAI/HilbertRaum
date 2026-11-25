# F-24 golden install markers (app-update wave, T2.10)

Hand-written on 2026-11-25 at commit `ae70b75f` from W-62's lists (plan §2, PA-314, #1028) and the marker
contract in `docs/data-contracts.md` ("#1028 — how every reader reads the marker"). One file,
`vectors.json`: the engine copy the vectors describe (`copy`: two files and their bytes), the record every
writer writes for it, and the vectors, each with its verdict per reader. The marker's real name
(`.hilbertraum-runtime.json`) is written by the tests into a temp root; no marker file is committed, because
a NUL or a byte-order mark in a text file under `tests/` fails the repo hygiene nets (decision 2 of the phase
sheet): such bytes are base64 here.

As built and frozen (Δ-53, Δ-54): "a map without the program" is damaged at the pre-spawn check and in a Kit
build (`--commercial`), a marker to the shared reading and to the twins outside commercial mode; a marker with
no map, or an empty one, is fetched again only with `--commercial`; both twins read past a byte-order mark.
One vector differs between the twins, given under `sh`: a pretty-printed marker is fetched again by the .sh
twin with `--commercial` (its hash lookup reads one line) and kept by the .ps1 twin.

Round 2 (after the Fable QA) added 15 vectors (no map; pretty-printed; nested os/arch/binaries; structural
characters in a string; a missing or escaping recorded file; a number field; a list; an empty file; a control
byte in an unknown string; a folder; the 64 KiB pair; over 1 MiB; no marker) and `relations`, the version
relation; no earlier verdict changed. Locked by `../../golden-fixtures.sha256`.
