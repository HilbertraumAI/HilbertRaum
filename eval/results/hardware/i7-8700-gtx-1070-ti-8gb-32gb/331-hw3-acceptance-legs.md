# #331 — the four blocked HW3 acceptance legs: performed 2026-09-09

Closes the legs PR #303's HW3 review could not exercise on the reviewing machine
(`docs/benchmark.md` "Audit remediation record — PR #303" §2 row HW3, §4 "Not verified here").
This is a VERIFICATION record: the deliverable is evidence plus separately-filed defects
(#436, #437, #438), not a fix.

Machine: DESKTOPDIT — i7-8700 (6c/12t), GTX 1070 Ti 8 GB, 31.9 GB RAM, Windows 11 Pro 26200.
Drive:   E: lite test stick (SSK USB 3.2), runtime b9849, chat weights 4B / 9B / 14B.
App:     dev build at master `4f3c1f78` + this branch, launched with
         `HILBERTRAUM_DRIVE_ROOT=E:\`, `HILBERTRAUM_MANIFESTS_DIR=E:\model-manifests`,
         `HILBERTRAUM_PERF_LOG=1`, `REMOTE_DEBUGGING_PORT=9222`, `ELECTRON_RUN_AS_NODE` cleared.
         Renderer driven over CDP; DOM sampled every 25 ms and recorded on change.
UI language: German (the machine's locale) — labels below are quoted as they appeared.
Raw logs stay on the drive (`E:\logs\perf.log`) and are not committed.

Workspace **A** was created on a SECOND computer (Surface, i7-1185G7 / Iris Xe, 15.8 GB) with
`qwen3-14b-instruct-q4` set active, then carried here — so unlocking it on this machine is a
genuine moved-drive `new-machine` decision, confirmed in the log:
`Drive is on a new computer: benchmarking it in the background once the model start settles`.

## Why the reviewing machine could not do these — reproduced first

Control run on this box against a scratch drive root with no runtime binary: the automatic
first-run check took **106 ms** (`First run: …` → `Benchmark complete`) and a manual check
**under 87 ms**; `ul.perf-steps` never appeared in a 25 ms sample at all. That is PR #303's
blocker ("a first run that finishes in ~120 ms") reproduced exactly, and it is why a fresh
workspace on this drive would NOT have unblocked leg 2 either — a fresh workspace has
`activeModelId: null`, so no model start precedes the check and there is no speed leg.
What makes the legs possible is the stick plus a real runtime: an in-run `probeAndPersistGpu`
`--list-devices` subprocess, a USB drive probe, a 14B speed leg, and a 66 s model start.

---

## Leg 1 — assistive technology  ✗ BOTH REGIONS SILENT (#436, #437)

Narrator (Windows built-in), app window in the foreground, owner listening. Every result below
was taken with the app genuinely in front — an earlier pass where focus sat in the terminal was
discarded, because Narrator announces focus changes more broadly than live-region updates and
that difference would have produced a false negative.

**Positive control, in the app's own window.** Three injected textbook live regions — two
`role="alert" aria-live="assertive"`, one `role="status" aria-live="polite"`, each mounted EMPTY
and filled later — were **all three announced**. Live regions therefore work in this Electron
window under Narrator, and the silences below belong to the app.

**1b — progress steps: SILENT.** Two runs, step list on screen for **14.2 s** and **14.4 s**.
Narrator announced the button's own name on focus ("Erneut prüfen") and then said nothing for
the entire check. Two causes, both real, both needed for a fix → **#437**:
  1. `<ul className="perf-steps" aria-live="polite">` is built inside `steps()`, which is only
     called from the `busy` branch — the region is INSERTED already containing its three `<li>`s
     (the M-U1 anti-pattern). `perf-steps` is the only live region in the renderer that does this.
  2. Even always-mounted there would be nothing to announce as it advances: the `<li>` text is
     constant for the whole run and progress rides only on the `perf-step-{state}` class and on
     `StepIcon`, which is `aria-hidden="true"`.

**1a — failure banner: ALSO SILENT.** This was the half predicted to PASS, and it does not.
A genuine refusal was produced with nothing broken: with a chat streaming, "Erneut prüfen" is
refused (`BenchmarkBusyError`, `lane: 'chat'`); the text lands in the region 35 ms after the
click and Narrator says nothing. Cause, isolated by control → **#436**:

`ErrorBanner`'s always-mounted `role="alert" aria-live="assertive"` wrapper is defeated by the
`Banner` nested inside it, which carries `role="status"` — itself a live region (implicit
`aria-live="polite"`) — and is mounted WITH its text. The nearest live-region ancestor governs,
so the announcement is governed by an inserted-with-content polite region: M-U1 reintroduced one
level down. Three variants inside an identical always-mounted alert wrapper:

| variant | inserted child                     | Narrator      |
|---------|------------------------------------|---------------|
| A       | `role="status"` (what ships today) | **silent**    |
| B       | `role="status" aria-live="off"`    | **silent**    |
| C       | no role at all                     | **announced** |

So the fix is variant C — the role has to go on that path; `aria-live="off"` does not rescue it.
Blast radius is the shared component: 11 screens, plus `WorkspaceGate`'s wrong-password banner,
which is the SH-2 / #145 fix.

Note on scope: two `.error-banner-region` elements are mounted on this screen — a global one in
`.app-shell` and the Performance screen's own inside its `.card`. Both were always present and
empty; the screen's is the one that filled. Not a defect, recorded because a naive
`querySelector('.error-banner-region')` reads the wrong one.

## Leg 2 — a moved-drive check observed live  ✓ TRANSITION / ✗ STEPS (#438)

Unlock → Performance immediately → stayed there. Timeline (offsets from process start):

```
+   619 ms  unlock clicked        +   708 ms  app shell up (89 ms later)
             Home: "Arbeitsbereich Wird geprüft…"  (the moved-drive 'measuring' notice)
+  1744 ms  screen still shows the SURFACE's result: "15,8 GB RAM · i7-1185G7"
+  2361 ms  GPU probe lands: placement memoryClass cpu → discrete, 8273 MB, GTX 1070 Ti
+ 77102 ms  model load done — observed row updates IN PLACE (120.3 MB/s, 9.0 GB, 74 844 ms)
+ 79727 ms  step list APPEARS, already [active, todo, todo]
+ 93464 ms  check finishes (13.7 s) — tiles now "31,9 GB RAM · i7-8700 · GTX 1070 Ti"
+ 93514 ms  step list gone
```

**Passed:** the check was fully observable (13.7 s), the screen moved from the outgoing
computer's result to this one's with **no navigation**, and `ipcRunning` was true for the span.

**Failed:** the step list never advanced — one single state for the whole 13.7 s, sampled at
25 ms. Cause: progress events are addressed to the window that invoked `benchmark:run`
(`registerBenchmarkIpc.ts:1266-1272`) and the automatic scheduler passes no callback
(`:819`), while the screen renders the list whenever the backend span is held (correct per
audit M1). A manual check DOES advance — recorded as the contrast case. → **#438**

## Leg 3 — a foreground chat during a benchmark span  ✓ PASSED

Only one direction is legal: `modelBusyLane` returns `'chat'` first, so a benchmark refuses to
start on top of a live stream; a chat is not gated by the benchmark span. So: check first, chat
inside it. Two runs. Both halves of audit **M1** confirmed:

- **A chat does not masquerade as a span.** ~86 s / 1345 samples of a live stream with no check
  running: `running` false throughout.
- **A chat does not hide a real span.** `streaming` and `running` both true, in both runs.

The overlap is short — 273 ms (run 1) and 126 ms (run 2) — and that is **structural, not a
defect**: `modelBusy` is re-checked inside the speed leg, so a chat arriving during it causes the
leg to be abandoned and the span legitimately ends. A long overlap is unreachable by design in
this direction. The chat answered normally in both runs (595 and 1347 characters).

## Leg 4 — a load / verification finishing while mounted  ✓ PASSED (both halves)

**4a — model load.** From leg 2 above: the 14B's start finished while Performance was mounted;
`lastModelLoad` (120.3 MB/s, 9 001 752 960 bytes, 74 844 ms) appeared in the observed rows and in
the drive tile with no navigation.

**4b — full file verification.** Run twice, because the first attempt exposed a trap:

- On workspace A, "Alle Modelldateien prüfen" **read nothing and returned instantly** — no
  progress, no Stop button, no log line, no sample. The workspace's `checksumCache` lives in its
  own settings (`models.ts` HashStore over `AppSettings.checksumCache`) and had travelled inside
  the workspace from the Surface, where every file had just been hashed. Every file was a cache
  hit. Not a defect; recorded because on a drive whose files were already verified this button
  is a silent no-op with no visible confirmation.
- The per-model "Prüfsumme prüfen" invalidates every file the manifest carries before re-hashing
  ("the forced re-hash is a real full-file read", `registerModelIpc.ts`). On the 14B: **85.5 s,
  105.3 MB/s, 9.0 GB**, landing in the observed rows while Performance stayed mounted.
- Then, on a workspace created fresh here (COLD cache), the named `#382`/`#420` action itself:
  the pass really ran (the "Prüfung abbrechen" Stop button was present 1.5 s in), the first
  checksum sample landed **27.2 s** after the start while Performance was mounted with no
  navigation, and the drive tile changed in place from "Ausstehend" to
  "Langsam 71,5 MB/s lesen · Aus einer Dateiprüfung". Full pass: **242 s**.

Displayed values matched what was persisted: all three observed rows equalled the
`performance:get` snapshot exactly. The drive tile kept the model-load sample (120.3 MB/s) over
the checksum one (105.3 MB/s) — correct per the documented source ranking, not a defect.

---

## Acceptance boxes (issue #331)

- [x] 1 — assistive-technology pass. Performed with Narrator against a positive control.
      **Both** regions silent → #437 (steps) and #436 (banner, the more serious).
- [x] 2 — a moved-drive check observed live from window-open through completion (13.7 s).
      Transition passed; the steps do not advance → #438.
- [x] 3 — a foreground chat answer generated while a benchmark span is running; `running`
      unaffected, both directions of M1 confirmed.
- [x] 4 — a model start and a full file verification each observed finishing while Performance
      was the active screen; rows and tiles refreshed in place and matched what was persisted.
- [x] 5 — every defect filed separately with its own reproduction: **#436**, **#437**, **#438**.

## Drive housekeeping

The owner's workspaces were set aside for the session and `F` was restored in place at the end
(`E:\_334\swap.cmd`). Workspace `A` (the moved-drive one, created on the Surface) and `P` (the
cold-cache one created here) are left set aside beside the existing `U` / `W1`, the same way the
#330 and #334 sessions left theirs. Every session was quit normally; `vault_lock_done` is in
`E:\logs\perf.log` for the A session and both encrypted DBs were written at quit with no
`-wal`/`-shm` sidecars left behind.
