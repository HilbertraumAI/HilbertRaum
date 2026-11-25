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
Where the twins differ, the `.sh` twin's verdict is given under `sh`: a pretty-printed marker is fetched again
by the .sh twin with `--commercial` (its hash lookup reads one line) and kept by the .ps1 twin (and round 3's
two below).

Round 2 (after the Fable QA) added 15 vectors (no map; pretty-printed; nested os/arch/binaries; structural
characters in a string; a missing or escaping recorded file; a number field; a list; an empty file; a control
byte in an unknown string; a folder; the 64 KiB pair; over 1 MiB; no marker) and `relations`, the version
relation; no earlier verdict changed.

Round 3 (after the QA's re-check 1) measured every vector on the `.sh` leg too (Git Bash), and W-4: the `.sh`
twin skips "nested os, arch and binaries" in both modes (its hash lookup reaches the top-level map). It added
four vectors (a comma in a recorded name, its file there and gone; structural characters in a string before
the map; a nested map after the top-level one with a recorded file gone), a vector's optional `files` (files
it adds to the copy), and the relation row "no marker" (no `marker`, no `order`). Two of the new vectors carry
an `sh` entry: the `.sh` twin takes its recorded names for the gone-file check from the last map on the line,
split at commas, so it skips a copy whose comma-named file, or whose file recorded only before a nested map,
is gone (the `.ps1` twin fetches it again, the app refuses it at the start as `missing`). No earlier verdict
changed. Locked by `../../golden-fixtures.sha256`.
