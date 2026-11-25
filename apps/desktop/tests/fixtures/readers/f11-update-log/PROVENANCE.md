# F-11 golden `update.log` lines (app-update wave, T3.2)

Hand-written on 2026-11-25 at commit `6ba8094f`, before the writer existed (tests first), from W-14, W-68 and F-11
(plan section 2 and Appendix B, as edited for the P3 entry), the P3 entry decisions 3, 9, 10 and 21, the record's
5.1 (G0), 5.3 (table B.2: the `update.log` line frame), 5.4, 5.6, 5.7 (the hand-off, start-file and notice events),
5.9 (the support copy), 5.10 (table B.11) and 8.2 (`docs/app-updates.md`), the T3.2 blast-radius sheet (its part (a)
grammar, part (b) size rule and part (c) vector list, with its two cmd lines as the sheet's base64) and the
orchestrator's answers to the sheet's questions (Q1: the error code's key is `err=`, `code=` stays the `UPD-*`
reference code's; Q2 and Q3: the failed-start line carries `syscall=` and `version=`; Q9: a cap of 65,536 bytes,
a trim keeps the newest 32,768). The token rules name their outside sources: semver.org 2.0.0 for V, the drive-release
reader's answer shape (`DriveReleaseRead`, F-13, T3.3a) for the record's states, and `start-failure.ts`'s gate codes
for the `failure` inputs. No expected value was taken from the writer's output; the byte lengths in `why` were counted
with a scratch script over the hand-written lines.

Two files:

- `vectors.json`:
  - `tokens`, `frame` and `cap`: the grammar and the size rule in words;
  - `accept`: lines any reader must accept from any writer (the app, cmd and bash start files, a later version's
    `lb`, an apply script), each with the record's reading (`parse`) and what "Copy details for support" shows of it
    (`copied`). Lines with bytes the repo hygiene nets refuse in a text file under `tests/` (a CR, a NUL) or that are
    not ASCII (cmd's code-page bytes) are held as base64 (`bytes_b64`). `a11`, a line over 1,024 bytes, is left out
    until P6 decides what the support copy does with it (CF-34);
  - `emit`: the exact lines the HEAD writer emits for fixed input (the time and the platform are inputs): the startup
    line's token rules and sentinels, the worst case of each event, the failed-start line for real start errors (a
    non-ASCII drive root among them, which must never appear) and the generic appender that later events use.
- `PROVENANCE.md`: this file.

Who reads which part: `tests/unit/update-log.test.ts` runs `emit` against the writer's pure rules and `accept`
through a reading written from the record's text in that file; `tests/integration/update-log-drive.test.ts` and
`tests/integration/backend-start-failure.test.ts` check lines the real writer appends on a scratch drive against
`emit`, and that a trim keeps `accept`'s cmd bytes byte for byte. Locked by `../../golden-fixtures.sha256`. The unlock
line (T3.10) adds its own `vectors-unlock.json` beside this file; this one is never rewritten.
