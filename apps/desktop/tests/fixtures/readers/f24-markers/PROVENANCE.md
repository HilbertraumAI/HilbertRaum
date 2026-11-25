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

`copy-shapes.json` (T3.12's fix round, 2026-11-25, at `233aaa1a`) is an addition beside `vectors.json`, which
stays byte for byte as round 3 left it. Hand-written from T3.12's two Fable reviews (R1 M-3, R1 m-2, R1 M-4,
R2 m-1), their disposition and the plan's W-84 and F-24, not from the code's output; the true hashes were taken
with `sha256sum` of each text. Its eight vectors hold the copy beside the marker, for the pre-spawn check alone
(the twins read no copy shape): a file the map does not record, changed or added, is never looked at (`ok`); a
recorded file in a subfolder that changed is `mismatch`; a main marker's keys under `cpu/`, `cpu.new/` and
`cpu.old/` are set aside (`ok`, wrong hashes and all), and a main marker that records only such keys is
`marker-damaged`, never `skip-legacy`; a recorded name the OS refuses (a NUL in it, a path longer than every
system's limit, a link to itself) is `marker-damaged`. `binary-verifier.test.ts` runs them. A read error of the
medium (EIO, now counted like a file that is not there, by what the file is) has no portable path that fails with
it: the same file proves it, and the holds that stay `unreadable`, with an injected error code. Locked by
`../../golden-fixtures.sha256`.
