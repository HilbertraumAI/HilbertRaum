# App updates — design record

_The planned design of HilbertRaum's in-app update: a signed update file that the user imports
offline, staged on the drive, applied after a clean quit, confirmed at the new version's first start,
with an automatic fallback. **This is an open design record on the integration branch
`feat/app-updates`: each phase of the update wave fills in its sections, and the wave's closing phase
removes this sentence before the record reaches `master`.** The section numbers §1–§12 are stable:
code comments cite them as `app-updates.md §N` (or `§N.M` for a numbered subsection), and §12 says how
to read every plan id the code and the other docs cite._

**Status words.** _Planned (Pn)_ = the decided contract; phase Pn builds it and rewrites the section
as built. _As built on master_ = merged code that release 1 freezes as it is. _Values approved_ = the
exact values of the protocol tables (§4, §5), approved by the owner on 2026-11-24 before the first pull
request; a row there marked pending waits for its named measurement. A section whose phase has not run
states the decided contract only; details the plan leaves to a later phase are not written here.

**Words used here.**
- _Release 1_: the first release that carries the updater, and so the oldest version ever sold on a
  Kit. Whatever it runs during an update can never be fixed in the field.
- _The new version_: the version an update installs. _The old version_: the one on the drive before.
- _Kit_: the HilbertRaum AI Kit, the sold product. _Drive_: the storage medium, a Kit or a drive
  someone prepared themselves (a DIY drive).
- _Update file_: the signed file a user downloads and imports (extension `.hrupdate`).
- _Start files_: `Start HilbertRaum.cmd`, `Start HilbertRaum.command` and `start-hilbertraum.sh` at
  the drive root (the other docs and the code call them launchers). The user is told to
  "start HilbertRaum on the drive".
- _System_: Windows, macOS (Apple Silicon) or Linux.
- _Frozen_: it runs in release 1 and can never change on a sold Kit. _Replaceable_: every later
  update can replace it.
- _R1_ and _vB_ (in the protocol tables, §4 and §5): release 1 and the new version.

---

## 1. Scope, decisions, what release 1 freezes

### 1.1 The design in one paragraph

An update reaches a drive as one signed update file. The user picks it with "Install update from a
file…" in Settings → Updates, on the unlock screen, or in a failure message an update can fix. The
app checks the signature (Ed25519 over a DSSE envelope, §2) before it reads anything else, checks
the version and the drive's policy, and copies the listed files into `updates/` on the drive, each
one hashed while it is written (§4). "Restart and update" locks the workspace, quits cleanly and
hands over to an apply script that ships inside the update file and runs after the app has exited
(§5). The script replaces every app already on the drive in one step. The new version confirms its
own start; if it never starts properly, the start files bring the old version back by themselves,
and the old version says what happened. The new version then brings its drive content (model
definitions, skills, docs) with it and gets its AI engine afterwards, by download or from a file
(§6). Nothing is checked online in release 1: every update of a release-1 Kit is installed from a
file (§3).

### 1.2 Release 1 is the oldest sold version

There is a deploy stop: no app release and no sale until the updater is ready (one exception: a
files-only release whose tag does not start with `v`, §9.1, §9.7). So the next
release is release 1, tagged on `master` after the integration branch merged (§9), and it carries
everything this wave builds: what the oldest Kit needs to take an update (the plan's tier M1), the
drive content and engine handling (M2) and the migration framework (M3). The online check is not part
of it (§3.1). Every Kit carries all three systems.

### 1.3 Owner decisions

Answered by the owner on 2026-11-17 (K2) and 2026-11-23 (the rest); U7's reading of "Go back" was
corrected on 2026-11-24 (§6.10). The owner's calls on the protocol tables are in §5.12, the other calls
of P1 in §11.2. §12 defines the ids.

| Call | Decision, in plain words | § |
|---|---|---|
| U1 | A later version may offer an update check the user clicks (the internet switch on, a click, a consent), never one at start. Release 1 has no check. The Kit builders write `updates.allow_online_check: true` | §3.1, §8.1 |
| U2 | No background or startup check | §11.4 |
| U3 | One update replaces every app already on the drive in one step; the AI engines are not part of that step | §5, §6.5 |
| U4 | Windows stays one portable `.exe` | §11.4 |
| U5 | The address a future online check uses is decided with that check, after release 1 | §11.2 |
| U6 | One release covers the app and the drive content under one signature and names the AI engine version; the engine follows separately on each system, unless a release deliberately carries it | §6.5 |
| U7 | An update that never starts properly falls back by itself. "Go back to version {n}" is offered within stated limits (§6.10) and never moves an engine | §5, §6.10 |
| U8 | Kits receive only releases published as stable ("Latest"), plus security fixes on their own line | §2.6, §9.6 |
| U9, U10, U11 | How buyers learn of updates, the support period, the risk assessment under the EU Cyber Resilience Act (CRA): answered after counsel | §11.1 |
| K1 | Each key is held by the owner, offline. The succession key's sealed file is held by a second custodian, its password elsewhere. Any one of the three keys signs alone, and no key can be withdrawn from a sold Kit | §2.1, §2.2 |
| K2 | Three keys: active, standby and succession | §2.1 |
| K3 | The rotation and compromise runbook is written before the key ceremony | §2.2 |
| K4 | Free builds carry the project's keys; a fork replaces them | §2.9 |
| K5 | A DSSE envelope with an Ed25519 signature, verified with the app's built-in crypto | §2.3 |
| M-D1 | v0.1.50, the first public release, is the oldest workspace a new version must upgrade | §7.5 |
| M-D2 | The workspace database's version number means "the oldest app that may open this" | §7.5 |
| M-D3, M-D4 | Snapshot retention and long migrations: asked in P10 | §7.8 |

### 1.4 Plan gates, decided

| Gate | Decision, in plain words | § |
|---|---|---|
| G-1, G-8 | This document is the design record, with legends for every plan id (§12) | §12 |
| G-2 | The whole wave lives on one integration branch, `feat/app-updates`, merged into `master` once | §9.1 |
| G-3 | App-owned model definitions and skills come from the app itself; the drive's copy is a mirror plus the user's own entries | §6.2 |
| G-4 | Tests trust a test-signed update only through throw-away builds with a one-time key; the product has no test entrance | §2.7, §10.4 |
| G-5 | The update file is a strict tar (ustar) subset that the app reads and writes itself, never the OS `tar` | §4.3 |
| G-6 | Linux is a full system: in-app update with the same protocol, the static AppImage runtime (`toolsets.appimage: "1.0.3"`, no libfuse2; it needs fuse3) | §3.6, §10.6 |
| G-7 | Superseded by G-2: `master` never holds a half-merged updater | §9.1 |
| G-9 | Release 1 writes a last-writer stamp into the workspace database | §7.4 |
| G-12 | How the wave assigns its agents and models (process only) | — |
| G-13 | The support end date is written per Kit, once, into `config/kit-support.txt` | §8.4 |
| G-14 | The update policy keys, built the simple way: the Kit builders write the online-check key; a damaged `policy.json` never blocks the signed import | §8.1 |
| G-15 | Every Kit is sold for Windows, Apple Silicon macOS and Linux; the first sale waits for all three systems' hardware tests | §9.2 |
| G-16 | Security fixes for sold Kits come from a fix line per Kit release, `kit/<version>` | §9.6 |
| G-17 | The update address in frozen copy: a short project page first, the GitHub releases page second; the exact path is open | §3.3 |
| G-18 | Every frozen string is checked by machine back-translation in the eight languages the owner does not read; native readers are an open call | §11.1 |
| G-19 | The version rule: newer than the running version, and not below the drive's version | §2.5 |
| G-20 | Never asked (moot without an online check in release 1) | — |
| G-21 | No online check in release 1 and not in this wave; it is built for the first update after release 1 | §3.1 |
| G-22 | Release 1 accepts the channel `stable` only; only Kit releases are signed for now | §2.6 |
| G-23 | Release 1 carries everything the plan lists; nothing is cut | §1.2 |
| G-24 | An update can carry a minimum OS version per system, Linux included as a glibc floor; release 1 refuses below it before staging, and also when a `linux` floor or this computer's glibc can't be read (fail closed, 2026-11-24); a release that raises a floor is not offered to the Kit channel while a supported Kit stated a lower one at sale | §2.4, §9.3 |
| G-26 | The system requirements printed with a Kit: Windows 11, or a Mac with Apple Silicon on a macOS version Apple still supports, at least 8 GB of memory, and Linux with the distribution floors of `READ ME FIRST.txt`; no Windows 10 | §11.5 |
| G-27 | Update files stay under GitHub's 2 GiB asset limit; a larger one is hosted on the mirror | §9.4 |
| G-28 | Code signing of the AI engines for Windows Kits: deferred by the owner | §6.8, §11.1 |
| G-29 | The age reminder shows 6 months after the build date; a dismissal hides it for 6 months; on Home and in Settings → Updates | §8.4 |
| G-30 | New models reach a Kit with each content-changing app release; release 1 gives any other signed HilbertRaum file a typed "for a newer HilbertRaum" answer | §2.4, §6.4 |
| G-31 | AI engines are not in the update file: the new version downloads its engine, or installs it from a file, after the update; one release may still carry engines (the escape hatch) | §6.5 |
| G-32 | The new engine goes into a folder of its own beside release 1's, which is never moved while "Go back" is offered | §6.6 |
| G-33 | The Kit carries both small chat models, so an offline first screen recommends a model on the drive (a manifest change outside this wave) | §11.5 |
| G-34 | Release 1 never redoes a newer extractor's rows; it serves them as they are with a one-line note | §7.6 |
| G-35 | A release offered to release-1 Kits never requires an engine newer than the oldest pin such a Kit may run | §6.6 |
| G-36 | Kit buyers are offered one update file, for all systems; the apply installs only the systems already on the drive | §9.4 |
| G-37 | Each update notice is one in-context banner at a time, with its help text in the app and a muted reference code | §5.7, §5.8 |
| G-38 | Five buyers try the update path in moderated sessions before the copy freezes | §10.5 |
| G-39 | The restart dialog states a duration measured on the Kit's media before the copy freezes; without the measurement it says "This can take a few minutes" | §5.8, §10.5 |
| G-40 | Release 1 is tagged on `master` after the final merge of the integration branch | §9.2 |
| G-41 | Green CI is required on the integration branch and, later, on `kit/*`, by the existing ruleset | §9.1 |
| G-42 | `master`'s `BUILD_STATE.md` points at the integration branch until the final merge | §9.1 |
| G-43 | Two vault start-path fixes before release 1 (a start whose swap fails still serves the update path; the rekey journal acts only inside the workspace) and one documented residual | §7.3 |
| G-44 | The pre-spawn engine check covers every recorded file before release 1; starting an engine in place on a write-protected drive is a documented residual | §6.7 |
| G-45 | The upgrade acceptance runs in two stages on the project's used exFAT test drive | §10.5 |

G-10, G-11 and G-25 are decided in their phases (§11.2).

### 1.5 The frozen-forever rule

Whatever release 1 executes during an update, or when it later meets files a newer version wrote,
can never be fixed on a Kit that is not updated. So every frozen contract below gets:
- a golden contract test whose expected values live in data fixtures with an origin other than the
  code under test, locked by a committed sha256 manifest that `repo-hygiene.test.ts` checks (§10.2);
- two independent reviews, each with its own lens;
- after release 1 ships, an owner call for any change to its test's assertions or vectors.

The table lists the contract ids (F-n) that the code and the docs cite.

### 1.6 Frozen contracts

| F | Contract, in one line | § | Owning phase | Status |
|---|---|---|---|---|
| F-1 | Envelope verification: DSSE PAE, Ed25519, standard and URL-safe base64; a 4 MiB size cap checked before the envelope is parsed and a 64-signature cap counted after the parse, whose excess is "too new", never "not genuine"; the typed unknown-signer answer | §2.3, §4.3 | P4 | planned; values approved |
| F-2 | Payload forward compatibility: unknown fields ignored, a new `format` major refused, `files[]` lists every member, the optional `group`, `install_as`, `requires`, `summary` and `min_upgrade_from`, `channel: "stable"` only, other HilbertRaum payload types answered "for a newer HilbertRaum" | §2.4, §2.6, §4.3 | P4 | planned; table A's values approved; the `linux` floor settled by spike 4a, fail closed (§2.4) |
| F-3 | The embedded public keys (`keys.json`) | §2.7 | P4; the owner's key ceremony | planned |
| F-4 | The version rule | §2.5 | P4 | planned |
| F-5 | The `updates/` layout and staging: one commit marker, at most one staged update, the start-up sweep, no import while an update is in progress | §4.2, §4.5, §4.6 | P6 | planned; values approved |
| F-6 | The hand-off from the app to the apply script after a clean lock: `handoff.txt`, the scripts' copies, the `finish-<n>` cap, the spawn and its acknowledgement, the removal of a finished or dead `updates/applying/` | §5.3, §5.4 | P7 | planned; values approved (the Linux spawn measured by spike 4a; the macOS spawn pending spike 3, §5.4) |
| F-7 | The rules of release 1's start files: resume an interrupted apply (rule 1), the launch counter and its fallback, restore from `updates/previous/` (rule 2), refuse two apps (rule 3), every path ending in one parsed block, and the lines they print | §5.6 | P7 | planned; values approved (`start-hilbertraum.sh`'s rule 1 measured by spike 4a; the `.command`'s rule 1 provisional until spike 3; the Windows in-flight probe can reopen on P11a's Defender row, §5.6) |
| F-8 | Policy key names, and what an absent key, a junk value and a missing or damaged `policy.json` mean (the install half) | §8.1 | P3 | as built in P3 (T3.1 and its fix round), golden `f8-policy/`; first Fable review sound with limits, the second (T3.7) pending |
| F-9 | The vault-format guard: a descriptor, journal, frame or working copy from a newer version reads as "newer", never as damage, and nothing is written | §7.2 | P2 | as built on master, with P2's fix rounds (T2.9, T2.16, T2.7's security round) as built |
| F-10 | The `schema_meta` table's shape, the `last_writer` stamp, and the keys the migration framework writes | §7.4 | P2, P10 | the table and the stamp as built in P2 (T2.2); the framework's keys planned (P10) |
| F-11 | The `update.log` line grammar, content-free | §8.2, §5.3 | P3 | the line frame's values approved (§5.3); the app's writer and its three events as built in P3 (T3.2 and its fix round, T3.10), golden `f11-update-log/`; first Fable reviews sound with limits, the second (T3.7) pending; P6's and P7's events planned |
| F-12 | The support-end and age-reminder computation and its inputs | §8.4, §5.10 | P6 | planned; the build-date file approved (§5.10) |
| F-13 | The `drive-release.json` read contract and the write-once `config/kit-support.txt` | §8.5, §8.4, §5.10 | P3 | the reader's types approved (§5.10); both readers and the builders' writers as built in P3 (T3.3a and its fix round, T3.3b), golden `f13-drive-release/`; the record reader's first Fable review sound with limits; T3.7's review of both halves pending; P8's in-app writer planned |
| F-14 | The update channels callable while the workspace is locked, also after a failed start, and the content-free text that "Copy details for support" copies | §3.5 (the hand-off channel: §5.4; the copied text: §5.9) | P6, P7 | planned; the copied text approved (§5.9) |
| F-15 | Released migration step ids and their source hashes | §7.8 | P10 | planned |
| F-16 | The update file container: the ustar subset read in process, the reserved `HRUPDATE` prefix | §4.3 | P1 (table), P6 (reader), P5 (writer) | planned; table A approved |
| F-17 | The online check's request contract | §3.1 | P9, after release 1 | not in release 1 |
| F-18 | The member-name rule, and the root-artifact globs release 1 reads | §4.4 | P6 | planned; values approved |
| F-19 | What release 1 offers at a start when an update is staged or in progress, and the older-than-drive notice | §5.7 | P7 | planned; values approved |
| F-20 | `updates/last-result.txt`, the outcome codes, the `UPD-*` reference codes and the old version's notices | §5.3, §5.8 | P7 | planned; values approved |
| F-21 | The refusal on a root that is not a prepared drive, and the two drive-awareness fixes | §3.6 | P6 (the refusal, the macOS notice), P7 (the static AppImage runtime, T7.12) | planned (the Linux `APPIMAGE` lookup is on master and found the root in every start mode, spike 4a) |
| F-22 | `updates/unconfirmed.txt`, the `updates/confirmed/<v>_<os>` files and the start confirmation | §5.3, §5.7 | P7 | planned; values approved |
| F-23 | The model-manifest old-reader contract | §6.11 | P2 (goldens, reviews) | as built on master, frozen in P2's goldens (T2.10), with the scripts' skip rule (W-62 (b)) and T2.7's fix round as built |
| F-24 | The AI engine contract: pins, install marker, version relation, release 1's own staged swap | §6.7, §6.11 | P2 (goldens, reviews) | as built on master, frozen in P2's goldens (T2.10), with T8.5c's fix rounds as built; the pre-spawn check with T3.12's two Fable reviews and two fix rounds as built in P3 (golden `f24-markers/copy-shapes.json`) |
| F-25 | The skills contract | §6.11 | P2 (goldens, reviews) | as built on master, frozen in P2's goldens (T2.10), with W-65 (T2.14) and T2.7's fix round as built; P8 restates the reader (G-40 (b)) |
| F-26 | Persisted message values | §7.6 | P2 | as built in P2 (T2.12) |
| F-27 | Duties of every later writer of workspace data | §7.7 | P2 | written in P2 (T2.11, T2.D) from the code as built, with W-70's settings duty from P3 (T3.11); frozen at M1 |

---

## 2. Trust

_Status: planned (P4). The production keys come from the owner's key ceremony (§2.2)._

### 2.1 Three keys, any one signs alone

Release 1 embeds three Ed25519 public keys (K2):
- **active**: signs every routine release, alone;
- **standby**: takes over when the active key is lost or compromised;
- **succession**: a cold key generated at the same ceremony, kept by a different custodian, never used
  for a routine release.

A release-1 Kit accepts a signature from **any one** of its three keys and has **no way to withdraw a
key** (K1). Each key alone is therefore trusted for the Kit's whole support period. Dropping a stolen
key in a later release protects only the Kits that install that release; offline custody is the whole
defense.

### 2.2 Custody and the runbook

- Each private key is a password-protected key file on separate offline media with sealed backups,
  held by the owner; never on GitHub, never in CI (K1).
- The succession key's sealed file is held by a second custodian (a notary, a bank box or counsel); its
  password is kept elsewhere and named in the succession file, so nobody but the owner signs alone.
- The rotation and compromise runbook is written before the ceremony (K3). It says when the
  succession key may sign and who may ask its custodian for it. No private key is destroyed while a
  supported release embeds its public half. A key an attacker already used can sign a release that
  embeds any keys, so speed and offline custody are the defense, not a second signature for key
  changes.
- Agents never generate, hold or use a signing key (§9.8).

### 2.3 The envelope: DSSE with Ed25519

The update file carries one signed envelope (K5), verified with `node:crypto` (Electron 43.8.10 has
Ed25519 and no BLAKE2b, so minisign's default format is out):
- the DSSE pre-authentication encoding (PAE), with standard **and** URL-safe base64, as the DSSE
  specification requires;
- caps: the envelope at most 4 MiB (4,194,304 bytes), checked before it is parsed; at most 64
  signatures, counted after its JSON parse and before any signature is verified. A file over a cap
  gets the typed answer "too new for this version" (`UpdateTooNew`) with the update address, never
  "not genuine". The caps are generous on purpose: a ten-year-old reader meets envelopes with more
  languages and keys. The envelope is the update file's member 0,
  `hilbertraum-release.dsse.json`; the file's other caps (at most 4,096 members, each under 8 GiB, the
  member names) are table A's (§4.3, §4.4);
- the signature is verified before the payload is parsed; a signature's `keyid` is only a hint, the
  embedded key bytes decide;
- signed only by keys release 1 does not know → the typed answer `UnknownSigner`: "signed with a newer
  key: install the in-between update first", with the update address and the manual replacement, for
  the case where none of release 1's keys signs any more. It is never "not genuine";
- **when no signature verifies under an embedded key**: `UnknownSigner` if no signature's `keyid`
  equals the id of an embedded key, else `UPD-NOT-GENUINE`. P4 confirms this rule and its `keyid` form
  in F-1's golden vectors before the freeze. Accepted: a forged file whose signatures carry made-up
  `keyid`s reads "signed with a newer key: install the in-between update first"; it is refused either
  way, and the copy may send the user looking for an in-between update that does not exist;
- no trust on first use and no key a user adds.

The verdicts carry these reference codes (§5.8): `UpdateTooNew` is shown as `UPD-TOO-NEW` and
`UnknownSigner` as `UPD-UNKNOWN-SIGNER`.

The release `payloadType` string and the envelope's place in the update file are part of the
container (§4.3).

### 2.4 The payload

The signed payload is forward compatible (F-2):
- unknown fields are ignored; a new `format` major version is refused with `UpdateTooNew` and the hint
  to install the in-between update first;
- `files[]` (name, size, sha256, role) lists **every** member of the update file except the envelope,
  the apply scripts and the start files included. Every listed member the file carries is staged as it
  is, whatever its role (§4.5); nothing is refused for a system the drive carries but the payload lacks
  (the apply script decides: `UPD-INCOMPLETE`, §5.5), except that this computer's own apply script must
  be present (`UPD-NO-HELPER`, §4.4);
- `group` (optional): a label for members staged all or nothing; a member without one is required.
  Release 1 never interprets the label, so one payload serves the full update file and per-system
  files;
- `install_as` (optional): the name a member gets at the drive root. Member names must be fetchable as
  GitHub asset names (§4), so `Start HilbertRaum.cmd`, whose name has a space, travels under a plain
  member name and carries its root name here. Release 1 ignores the field at the import; it reads it
  only for the support details (§5.9); the apply script (through its name table, §5.5) and the sell
  gate use it;
- `product`: its value and its refusal code are set by P4 before F-2 freezes and recorded here;
  `channel` is checked as §2.6 says; `min_upgrade_from` above the running version is a typed refusal
  (`UPD-NEEDS-IN-BETWEEN`), never "not genuine";
- the engine fields (the engine version a release names, U6, and `engine_min`, §6.6): release 1
  ignores them; their names and shape are set by P5 (the writer) with P8 (the reader) and recorded
  here;
- `issued`: advisory clock checks only. A date in the future gives a warning; a file whose `issued` is
  more than 12 months before this computer's date needs one explicit confirmation that a newer one may
  exist;
- `requires` (optional): a minimum OS version per system (G-24). `win32` and `darwin` hold a dotted
  version compared component by component with `process.getSystemVersion()`. `linux` holds a minimum
  glibc version as a string of dot-separated decimal integers (`"2.34"`), compared component by
  component as integers (a missing component counts 0) with
  `process.report.getReport().header.glibcVersionRuntime`, a string (`"2.39"` on Ubuntu 24.04; one call
  costs 2–49 ms, so it is read once per import; spike 4a). `glibcVersionCompiler` (`"2.26"`, the glibc
  Electron's Node was built against) and the text of `ldd --version` or `getconf GNU_LIBC_VERSION` are
  never used. **Fail closed** (owner 2026-11-24, Δ-39): a `linux` value that is not such a string
  refuses the import before staging on every system, and so does, on Linux, a runtime glibc version
  that is absent or is not such a string; the answer is `UPD-CANT-CHECK-LINUX-FLOOR` ("this update's
  Linux requirement can't be checked", §5.8), and the release tools never sign such a value (§9.3).
  Unknown keys and systems are ignored. Release 1 refuses **before staging** when this computer is
  below its own system's floor, and shows the drive's other systems' floors as a one-line warning it
  cannot test;
- `summary` (optional): a map from a UI language code to one or two plain sentences of at most 400
  characters, shown at the import in the UI language, else in `en`, else not at all. A wrong type, an
  unknown language or a longer value is ignored, never an error;
- a well-formed envelope from a known key whose `payloadType` is any other
  `application/vnd.hilbertraum.*` type, or whose payload `kind` is not the release kind, gets the typed
  answer "This file is for a newer HilbertRaum. Install the update first" (G-30), never "not a
  HilbertRaum update". A later definitions-only or model-pack file then needs no in-between update.

The exact types and units of `format`, `version`, `issued`, `min_upgrade_from` and `summary` (whether
"400 characters" counts code points, whether "12 months" are calendar months, whether `issued` is a
date or a date-time) are fixed by P4's payload table before F-2 freezes. The order in which the
payload's checks run is §4.5's.

Every answer that refuses a well-formed update file (`UpdateTooNew`, `min_upgrade_from`,
`UnknownSigner`, the OS floor, a `linux` floor that can't be checked) shows the running version and the
address
`<G17-ADDRESS>/from/<running version>`, also as plain text (§3.3).

### 2.5 The version rule

An update installs when (G-19 (b), F-4):
- its version is **newer than the running version**, and
- its version is **not below the drive's `app_version`** (`config/drive-release.json`, §8.5).

`app_version` counts only when some root artifact carries that version (its name is exactly
`HilbertRaum-<app_version>-portable.exe`, `HilbertRaum-<app_version>-mac-arm64.app.zip` or
`HilbertRaum-<app_version>.AppImage`, §4.4) or a root `*.app` exists (whose version is unknown). Otherwise it is stale, logged and treated as absent. The "not below" lets a
lagging system install the version the drive already has and makes a re-install after "Go back"
work; a downgrade below the drive is still refused. Release 1 does not act on `highest_version_seen`
(a reserved field, §8.5): a hard floor there would refuse every security fix of the fix line to a
user who went back. A looser rule can be tightened by any later version; a tighter one could never
be loosened. The accepted risk: an old but genuine update file can move a Kit up to an outdated
version, never down.

### 2.6 The channel

- **Frozen:** release 1 accepts `channel: "stable"` only. Any other value gets the typed refusal "not
  a release for this drive" (G-22).
- **Reversible:** which releases the owner signs. Only Kit releases get an envelope now; signing more
  later stays possible. DIY users get in-app updates from stable releases like Kits; DIY pre-releases
  stay manual.
- Kits receive only releases published as stable ("Latest"), plus security fixes on their own line
  (U8, §9.6).

### 2.7 The keys inside a build

- The public keys live in a JSON file in the source, `keys.json`, which the app embeds and the release
  tools read (F-3).
- The production keys enter the repository only from the owner's ceremony, through a pull request on
  `master` after the integration branch merged (one of release 1's release pull requests, §9.2). Until
  then the production key set is empty. A build with an empty set says that updates are not available
  in this build; of the project's own builds only walk and dispatch builds before the ceremony can
  have one (a fork may ship one to turn updates off, §2.9), and no Kit is ever
  built with it (the sell gate and the pre-publish check refuse an empty set).
- **The release guard**, on every build leg of `release.yml` (Windows, macOS, Linux) and on its
  dispatch pre-flight: the public keys embedded in the packed `app.asar` (their SPKI bytes, not only
  their ids) equal the committed key set, and the embedded build date equals the release commit's
  committer date (the build-date file, §5.10, §8.4).
- **No test entrance in the product** (G-4 (d)): tests that need a test-signed update build throw-away
  copies with a one-time test key written into their `keys.json` (§10.4). Test key pairs are generated
  at test time; committed test vectors hold public keys, envelopes and verdicts only, never a private
  key.

### 2.8 The key proof before release 1 is published

After release 1's build and before it is published, the owner signs one throw-away update file per
embedded key, each for a version below every build that embeds the production keys
(`0.0.0-keyproof.<n>`). The exact release-1 candidate binary must refuse each with the "same or older"
answer, which it reaches only after the signature verified. The proof runs on each sold system's draft
asset whose sha256 equals the signed payload's entry (the signed `.exe` for a Windows Kit). The
throw-away files are never uploaded, and immutable releases are on before the publish click, so the
published asset is the one tested.

### 2.9 The fork rule

- Builds from this repository, free DIY builds included, carry the project's public keys (K4). They
  accept the project's signed update files and offer the same "Install update from a file…" as a Kit.
  There is one program and one support story.
- **A fork that publishes its own builds** replaces `keys.json` with its own public keys (its builds
  then accept only the fork's signed releases), or ships an empty key set, which turns the in-app
  update off. A fork must already use its own name and logo ([`TRADEMARKS.md`](../TRADEMARKS.md)).
- **A fork that keeps the project's keys** accepts every update file the project signs. Installing one
  replaces the fork's app on the drive with the project's own HilbertRaum build.
- A fork that replaced the keys and imports one of the project's update files sees the
  "signed with a newer key" answer, which is misleading for it; the fork's own documentation should
  say so.

---

## 3. Finding and importing an update

_Status: planned (P6; the hand-off channel P7). The entry points and the locked channels are frozen._

### 3.1 No online check in release 1

Release 1 makes no network request for updates (G-21 (b')). Every update of a release-1 Kit is
installed from a file. A check the user clicks (U1 (b)) is built after release 1, for the first update,
on its own branch; its request contract (F-17) is not frozen in release 1. Release 1 keeps the policy
key that a later version's check will obey (`updates.allow_online_check`, §8.1). `PRIVACY.md`'s
statement that the app makes no update checks stays true for release 1.

### 3.2 How people learn of an update

- **A Kit buyer**: the owner's buyer notice by email, for each release that matters to Kits; a GitHub
  Security Advisory for a security release; a registration route for buyers who did not buy direct;
  in the app, the offline age reminder and, at the end, the end-of-support notice (§8.4).
- **A DIY user**: the GitHub releases page and the age reminder (no support date: a DIY drive has no
  `config/kit-support.txt`).
- **An administrator**: the advisory and the admin section of the user guide (how to block updates,
  how to update a blocked fleet, `updates.max_version`, allow-listing the update helper).
- **The download**: one update file for all systems, from the release page or the project page
  (§9.4). The buyer notice links the per-version page `<G17-ADDRESS>/update/<version>`, never a raw
  asset, so an old email can never serve a withdrawn file.

### 3.3 The update addresses

Release 1's frozen copy prints two addresses, so that one survives the other (G-17 (d)):
1. a short page on `hilbertraum.ai` without a language prefix (the site's own pages use `/en/` and
   `/de/`). **Its exact path is open**; this record and the copy write it `<G17-ADDRESS>` until the
   owner sets it, at the latest by the release-1 tag;
2. the project's GitHub releases page, `github.com/HilbertraumAI/HilbertRaum/releases`.

The project page answers two sub-paths: `/from/<version>` (every refusal of a well-formed update file,
§2.4) and `/update/<version>` (the buyer notice, §3.2). It says "you have the newest version" where a
Kit's line has nothing newer. The copy reads correctly with and without a later online check. The plan
is to keep the domain and both sub-paths for ten years.

As built in P2 (T2.6): the copy's `<G17-ADDRESS>` is the catalogs' `{address}`, filled from one
constant, `UPDATE_ADDRESS` in `shared/update-address.ts`, which main and the gate both import
(`workspaceFailureParams`). Until P11c types the real address it is the placeholder
`https://update-address.invalid` (RFC 2606), so a dev or test build shows
`https://update-address.invalid/from/<version>` in X01's and C01's text on the lock screen (the legend of
these ids is in §7.6); a `repo-hygiene.test.ts` row fails
once the app's version moves off 0.1.66 while the placeholder is still there.

### 3.4 Where the import starts

"Install update from a file…" is offered in these places (W-4):
- **Settings → Updates**, a new tab, with an unlocked workspace;
- **on the unlock screen, without unlocking**: (i) a button inside the failure banner, for the
  failures an update can fix: a workspace from a newer version (`workspace_newer`), a workspace that
  could not be opened (`vault_open_failed`), the copy for a database schema this version cannot read,
  and the vault-format refusal; the create form shows it too; (ii) one secondary link in the card's
  footer that opens a small sheet with the import, the "Last update attempt" line and "Copy details for
  support" (§8.3, §5.9). The calm unlock card gains one line, not three;
- **on the start-failure card** (a start that could not finish, `start_failed`): in the card's banner
  slot, for the cause `other` only (W-82, §3.5).

An import from the unlock screen is finished from there: after it, the screen offers "Restart and
update", without unlocking (§5).

### 3.5 The channels callable while locked

The update channels answer while the workspace is locked (F-14):
- `updates:importFile`, `updates:status` and `updates:cancel`;
- the decline channel `updates:discardStaged`, behind "Don't install this update", for a merely staged
  update (refused while an update is in progress, §4.5);
- the read-only "Copy details for support" channel (§8.3, §5.9);
- the hand-off channel behind "Restart and update" and "Continue the update" (§5.4).

They are registered even in a run whose start failed (W-82): inside `registerStartFailureIpc`, on the
narrow start-failure context (the senders, the drive root, `isDev`, the app version), never on the full
app context, which does not exist in that state ([`data-contracts.md`](data-contracts.md), the
start-failure section). "Every other channel refuses while locked" holds for the `updates:*` channels;
other modules answer before unlock by design.

### 3.6 What the import refuses before it reads the file

1. **A root that is not a prepared drive** (F-21, W-58). When the app runs on the user-data fallback
   root (`isPreparedDrive` is false: a standalone download in a downloads folder, a Dock-pinned Mac app
   started from its cache, an AppImage started off a drive), release 1 offers neither the import nor
   staging. The Updates tab and the unlock screen say that this copy of HilbertRaum isn't running from
   a prepared drive and name the address where the new version can be downloaded. Otherwise the apply
   script, which finds its root from its own location, would plant apps in the app-data folder. The
   test is `isPreparedDrive`, never `HILBERTRAUM_DRIVE_ROOT` (that variable wins without a marker
   check).
2. **The policy**, read again from disk (§8.1): `updates.allow_user_install: false` refuses before
   anything is read ("Updates are managed by your organization"), and so does a junk value of either
   key ("the update policy on this drive has an invalid value"); `updates.max_version` is applied once
   the file's version is known. The reader is built (P3, `readUpdatePolicy`); P6 calls it here.
3. **An update already in progress** (`updates/applying/` exists, after release 1 has removed a
   finished or dead one, §5.4): the import is refused (`UPD-IN-PROGRESS`) and the screen offers
   "Continue the update" instead (§4.5, §5.7).
4. **A drive that is read-only or full**: a writability probe and a fixed 64 MiB free-space margin at
   the start of every import (§5.4); the full free-space formula follows once the members are known
   (§4.5).

The two drive-awareness fixes of F-21:
- **macOS**: an app started from the start file's cache (`~/Library/Caches/HilbertRaum/`) without a
  drive root shows "Start HilbertRaum on the drive" with Quit as the main action; a workspace on the
  Mac stays reachable as the secondary one, instead of being offered silently.
- **Linux**: the drive is also found through `APPIMAGE`, so an AppImage started directly from the drive
  lands on the drive. **As built on master** (PR #866: only when `APPDIR` contains the running
  program). The AppImage switches to electron-builder's static runtime (type2-runtime `dd6cebe`, no
  libfuse2) before F-21 freezes (G-6). The switch is task T7.12 of P7: `toolsets.appimage: "1.0.3"` in
  `electron-builder.yml`, the `.desktop` entry without `--no-sandbox`, `AppRun`'s `unshare -Ur true`
  probe kept; the libfuse2 workaround in [`troubleshooting.md`](troubleshooting.md) then becomes a
  fallback note.
  **What the lookup relies on** (spike 4a, Δ-39): with the static runtime (and the legacy one under
  `APPIMAGE_EXTRACT_AND_RUN=1`) `APPIMAGE` is the image's absolute path and `APPDIR` contains the
  running exe in every start that starts: a normal start, extract-and-run, a relative `./` start, a
  start through the start file and the start the apply `exec`s (the new runtime overwrites both with
  the new image's values); `locateDriveRoot` as built found the root in every one, so no code changes.
  `OWD` (unset under extract-and-run and after a start from a deleted folder) and `ARGV0` (the path as
  typed) are never used. The static runtime still needs a `fusermount3` or `fusermount` program
  (package `fuse3`) and `/dev/fuse`, without which only extract-and-run starts; it keeps its
  extract-and-run folder in `$TMPDIR` and reuses it at the next start; and no AppImage starts from a
  drive mounted `noexec` (§11.3).

Then the file itself is checked: the envelope and the payload as §2 says, the container and its
members as §4 says, in the order of §4.5.

### 3.7 What the import shows

Before "Restart and update" the import shows what the update is: its version, its date (`issued`) and,
if present, its signed `summary` in the UI language (§2.4). The confirmation for an update file older
than 12 months and the warning about the other systems' OS floors come at the import, before staging.

---

## 4. Staging and the update file container

_Scope: what release 1 does between the file pick and "Restart and update": the update file's
container (the ustar subset, F-16), the member-name rule (F-18), the `updates/` layout and staging
(F-5). The frozen values come from the protocol table A._

_Status: planned (P6 builds the reader and staging, P5 the writer, P6 commits the golden update file).
Table A below is the decided contract. Its evidence is spike 9 (§10.6: the prototype reader in
Electron 43.8.10's main process, a 450.6 MB file on NTFS, exFAT USB 3 and exFAT USB 2, Norton
on, 80 runs and 51 hand-built refusal files), its method review (T1.11, finding ids `S9-n`, `C-n`) and
G-5 (c)._

### 4.1 How to read table A

Table A uses §5.1's columns ("frozen since": _R1_ or _Scripts_), its spellings of systems, versions and
tokens, and its common text rules G0 for `staged.txt`. A cap is frozen for ever: an update file over
one of release 1's caps is "too new" for release 1 (`UPD-TOO-NEW`), so every update that release 1
must install directly has to fit inside them. The caps are therefore set for what a 2035 file may need,
not for today's file (each one's reason is in its row).

### 4.2 Names (table A.1)

| Name | What it is | Written by | Read by | Frozen since |
|---|---|---|---|---|
| `updates/staging/` | the staging folder | R1 app (the import) | R1 app, the apply | R1 |
| `updates/staging/.incoming-<v>/` | the members of version `<v>` while they are written and hashed, each under its member name; a dot name, so no version folder and no member can collide with it | R1 app | R1 app (the start-up sweep) | R1 |
| `updates/staging/<v>/` | the staged update of version `<v>`: the folder `files/`, then `hilbertraum-release.dsse.json`, `staged.txt` and `staged.json`. Only these four names are ever in it | R1 app | R1 app (the offer, the re-hash, the copy of the scripts), the apply | R1 |
| `updates/staging/<v>/files/` | the staged members, each under its member name, one level below the markers, so no member name can ever meet a marker (T1.11 S9-2) | R1 app | R1 app, the apply (the members) | R1 |
| `updates/staging/<v>/hilbertraum-release.dsse.json` | the verified envelope, byte for byte as member 0 carried it; the apply keeps it as `updates/applied/<v>.dsse.json` (§6.9) | R1 app | the apply | R1 |
| `updates/staging/<v>/staged.txt` | the member list for the scripts (§4.6) | R1 app | the apply (sizes and names) | R1 |
| `updates/staging/<v>/staged.json` | the one commit marker, written last (§4.6) | R1 app | R1 app; a later app | R1 |
| `updates/.write-probe` | the writability probe (§5.4): opened with flag `w` (a leftover is overwritten), one byte written, closed, deleted | R1 app | — | R1 |
| the update file's own name | not frozen: the user may rename it. The release tooling names it outside the `HilbertRaum-*` prefix that the start files and the sell gate glob (§9.3); its extension is `.hrupdate` | P5's writer | nobody reads the name | — |

### 4.3 The update file container (table A.2; F-16, G-5 (c))

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| Format | a strict subset of POSIX ustar, read and written in process over `node:fs` and `node:crypto` (no OS `tar`, no dependency): a sequence of members, each a 512-byte header then the member's bytes zero-padded to a multiple of 512, then the end | G-5 (c), C9 | R1 |
| The reserved prefix | a file whose first 8 bytes are the ASCII `HRUPDATE` is a future container: `UPD-TOO-NEW` with the in-between hint (§2.4), tested on those 8 bytes before any header | F-16 | R1 |
| Header check order | magic, checksum, type, name, size (spike 9 DD2). For member 0's header with the right magic only a checksum failure is `UPD-FILE-DAMAGED`; a type, name or size field that fails is `UPD-NOT-AN-UPDATE` (an ordinary archive that bsdtar wrote has the same magic and starts with a pax header or a folder; T1.12 review V-1, orchestrator 2026-11-24, Δ-41; §4.7) | spike 9 DD2; V-1 | R1 |
| Magic and version | bytes 257–262 `ustar` + NUL, bytes 263–264 `00`; anything else (GNU's `ustar  ` included) fails | spike 9 DD2 | R1 |
| Checksum | bytes 148–155: `[0-7]{1,7}`, then only NUL or space bytes to the end of the 8-byte field; equal to the unsigned sum of the header's 512 bytes with these 8 bytes counted as spaces. The writer writes 6 zero-padded octal digits, NUL, space | spike 9 DD2; L1-10 | R1 |
| Type | byte 156 must be `0`; `x`, `g`, `L`, `K` (pax and GNU extension headers) and every other value, NUL included, fail | spike 9 DD2, G-5 (c) | R1 |
| Name | bytes 0–99: the member name (§4.4), then at least one NUL, only NULs after it | spike 9 DD2 | R1 |
| Link name, prefix | bytes 157–256 and 345–499 all zero | spike 9 DD2 | R1 |
| Size | bytes 124–135: `[0-7]{1,11}`, then only NUL or space bytes to the end of the 12-byte field; no leading space, no base-256 form; so every member is 0 to 8,589,934,591 bytes (a member of 0 bytes is legal). The writer writes 11 zero-padded octal digits and NUL | spike 9 DD2, G-5 (c); L1-10 | R1 |
| Ignored fields | mode, uid, gid, mtime, uname, gname, devmajor, devminor and bytes 500–511; the writer writes `0000644` NUL, `0000000` NUL, `0000000` NUL, `00000000000` NUL, zeros, zeros, `0000000` NUL, `0000000` NUL and zeros | spike 9 DD2 | R1 (the reader ignores them) |
| Member 0 | the signed envelope, member name **`hilbertraum-release.dsse.json`** (the release asset's name, §9.3), at most **4 MiB** (4,194,304 bytes; a larger header size is `UPD-TOO-NEW` before a byte of it is read); read whole into memory and verified as §2.3 says before anything else is read. Any other first member is `UPD-NOT-AN-UPDATE`. The cap is F-1's and §2.3's (T1.11 S9-1), the one thing it protects being the bytes parsed before the signature is checked: it holds a 4,096-entry payload as base64 (1.1 MB, light run below) plus 64 signatures of up to ~45 KB each (room for a later hash-based signature scheme) | F-1, F-16, §2.3; T1.11 S9-1 | R1 |
| Where the payload lives | **inside the envelope**, as DSSE's base64 `payload` field; the update file has no separate payload member (spike 9's prototype used one only as a stand-in for P4). `files[]` lists every member after member 0 (§2.4) | F-2, F-16; T1.11 S9-1 | R1 |
| DSSE `payloadType` | `application/vnd.hilbertraum.release+json`; any other `application/vnd.hilbertraum.*` type from a known key → `UPD-FOR-NEWER-HILBERTRAUM` (G-30); any other type → `UPD-NOT-AN-UPDATE` | F-2, G-30 | R1 |
| The payload's `kind` | `"release"`; any other value from a known key → `UPD-FOR-NEWER-HILBERTRAUM` (§2.4) | F-2 | R1 |
| Signatures | at most 64 per envelope, counted after the envelope's JSON parse and before any signature is verified (§2.3; the 4 MiB size cap comes before the parse) | F-1; L1-30 | R1 |
| `files[]` entries | `files` is an array; each entry has a string `name` (§4.4), an integer `size` from 0 to 8,589,934,591, and a `sha256` of 64 hex characters (either case; compared lower-cased); no two names equal after folding; the payload's `version` is SemVer and at most 64 bytes (it becomes a folder name). Anything else from a known key → `UPD-TOO-NEW` (a later writer's file) | F-2; L1-6 | R1 |
| Members after member 0 | every one listed in the payload's `files[]`, in any order, each at most once (case-folded, §4.4), its header size equal to the listed `size`; every listed member without a `group` present; each `group` present whole or absent whole (§2.4) | F-2, W-5 | R1 |
| Member count | `files[]` holds at most **4,096** entries, checked before staging; more → `UPD-TOO-NEW`. The reason is what a later file may carry (T1.11 S9-1, C-12): the apps of more systems and architectures, the scripts and start files, the engine archives of §6.5's escape hatch (families × systems), and, if M2's content ever travels one file at a time, the drive content: 35 model manifests today, the skills, the drive docs and notices in ten languages; a few hundred members in all, so 4,096 leaves more than ten times that. The cost is time only: a light run of spike 9's prototype (plain Node 24.13, NTFS, 4,096 members of 1 KiB and an 830 KB payload with ten 400-character `summary` texts; 3 runs) staged them in 8.3–9.3 s, 1.6 ms per member (median; max 32 ms), memory +11.3 MB; on a stick spike 9 measured 9–10 ms per member (median, ≤ 81 ms), so ~41 s at the median. P8's sheet confirms the M2 file stays under the cap (C-12). Spike 9 proposed 256 (judgement value) | spike 9 DD3; T1.11 S9-1, C-12 | R1 |
| Total size | no cap of its own beyond the member bound (< 8 GiB each) and the free-space check (§4.5). Spike 9: 450 MB stage in 15–16 s on USB 2, linear (not measured beyond) | spike 9 DD3 | R1 |
| The end | exactly two 512-byte zero blocks, then the end of the file; any byte after them, a tar record's zero padding included, fails (so P5 never writes an update file with the OS `tar`, whose 10,240-byte records this rule refuses) | spike 9 DD2 | R1 |
| The header walk | right after member 0 verified and the payload passed §2.4–§2.6 and the version rule, the reader reads every following header by seeking (512 bytes per member, no member data) up to the two zero blocks: each header is checked as above, the set of members against `files[]`, and the end against the file's length. An end of file before a header, inside a member or before the zero blocks → `UPD-DOWNLOAD-INCOMPLETE`, before any member is written; bytes after the end → `UPD-FILE-DAMAGED`. With every member present this equals spike 9's early length check (payload end + Σ (512 + size + pad₅₁₂(size)) + 1024; measured 31–75 ms instead of 6.3–10.7 s), and it also holds when whole groups are absent (one payload serves the full and the per-system files, §2.4). The first failing check in file order decides the verdict (§4.7) | spike 9 DD2 (judgement: the walk generalises the measured check to absent groups); L1-9 | R1 |
| Then the data pass | one sequential pass over the members (§4.5); each header is read again and must equal the walk's, else `UPD-FILE-DAMAGED` (the file changed meanwhile) | spike 9 DD1; L1-9 | R1 |

### 4.4 The member-name rule (table A.3; F-18)

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| Characters | ASCII `[A-Za-z0-9._-]` only (no space, no `+`: GitHub renames asset names with other characters, and every member must be fetchable under its own name; the root name of a member whose root name differs travels in `install_as`, §2.4) | F-18 | R1 |
| Length | 1 to 99 bytes (the ustar name field with its NUL) | F-18 | R1 |
| First and last character | the first is `[A-Za-z0-9]` (a leading `-` reads as an option to the scripts' commands, a leading `.` is a hidden file on macOS and Linux and the staging folder's own dot names start so; spike 9 DD8, decided here); the last is not `.` | F-18; spike 9 DD8 | R1 |
| Reserved names | refused, compared case-folded: the Windows device names `con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`, alone or before a `.` (`nul.txt`); `hilbertraum-release.dsse.json` anywhere but member 0. The staging folder's own files can never meet a member, because members live one level down in `files/` (§4.2; T1.11 S9-2, decided here instead of reserving `staged.*`): a member named `staged.json` is legal and is staged as `files/staged.json`. A later version that adds a marker puts it beside `files/`, never inside it | F-18; T1.11 S9-2 | R1 |
| Uniqueness | no two names equal after folding `A`–`Z` to `a`–`z` (ASCII only, never a locale), so NTFS, exFAT and APFS hold them all | F-18 | R1 |
| Names release 1 looks for | `apply.cmd` and `apply.sh`, byte-exact (§5.2): the one for this computer's system must be listed **and present in the file** (found by the header walk; a script in an absent group does not count), checked right after the walk, before the free-space formula; else `UPD-NO-HELPER` (W-5) | W-5; L1-7 | R1 |
| A name that breaks the rule | in the signed payload → `UPD-TOO-NEW` (a later writer's file release 1 cannot take); in a header but not in the payload → `UPD-FILE-DAMAGED` | F-18 | R1 |
| One rule, no list | no enumeration of systems or artifact patterns: a later file that adds a system or renames an artifact stages whole (W-2) | F-18 | R1 |
| The root globs release 1 reads | its own system's start-file globs (`HilbertRaum-*-portable.exe`; `*.app` and `HilbertRaum-*-mac-arm64.app.zip`; `HilbertRaum-*.AppImage`), for the older-than-drive notice and the confirmation (§5.7). An artifact **carries version `V`** when its name is exactly `HilbertRaum-V-portable.exe`, `HilbertRaum-V-mac-arm64.app.zip` or `HilbertRaum-V.AppImage` (never by prefix or substring: `HilbertRaum-1.4.0-rc.1-portable.exe` does not carry `1.4.0`); a root `*.app` carries no known version | F-18; L1-17, L2-12 | R1 |
| Later writers: a second architecture | a later Kit that carries a second architecture of one system gives it a root name outside release 1's three globs (release 1 would count it as a second app, rule 3) or makes it share that system's confirmation | L1-29 | R1 (the duty) |

### 4.5 Staging (table A.4; F-5, W-5)

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| Order of an import | the refusals before the file is read (§3.6: not a prepared drive, the policy, `updates/applying/` present → `UPD-IN-PROGRESS`, the writability probe and the 64 MiB margin of §5.4) → the `HRUPDATE` prefix → member 0 and its verification (§2.3) → the payload, the first failing check deciding, in this order: `format` major → `kind` → `product` → `channel` → `version` well-formed → `min_upgrade_from` → the version rule (§2.5) → `updates.max_version` → `requires` (the `linux` value's form on every system, then this system's floor) → `issued` → `files[]` (the order written by the T1.12 review, R-5; P4 confirms or corrects it before F-2 freezes) → the header walk (§4.3) → this system's apply script present (§4.4) → on Windows the path check (below) → the free-space formula (below) → the data pass → the commit. **A refusal before the data pass removes nothing** (a good update of the same version staged earlier stays) | W-5, §3.6; L1-7, L1-8 | R1 |
| Path length (Windows) | before the data pass: the length of `<root>updates\staging\<v>\files\` (the root with its trailing `\`) plus the longest listed member name is at most 259 characters (`MAX_PATH` 260 with its NUL; the cmd twin moves from there, and cmd is bound by `MAX_PATH`); else `UPD-PATH-TOO-LONG`. Argued from the path forms, not measured; a P7 row measures the real limit | L2-18 | R1 |
| Free space | before the data pass, with `c` = the drive's cluster size from `fs.statfs` `bsize` (1 MiB when it reports 0) and `w` = the write size, and free bytes = `bavail × bsize`, counting the bytes that `updates/staging/<v>/` and `updates/staging/.incoming-<v>/` hold now as free (the data pass removes them first): free bytes ≥ Σ over the members present of ⌈size ÷ `c`⌉ × `c` + `c` (the staging folders' own entries) + max(64 MiB, 64 × `w`); else `UPD-DRIVE-FULL`. The last term covers exFAT's allocation ahead of the data in an open file, about 32 × the write size (≤ 33.7 MB measured at 1 MiB writes), with 2× room; at P6's 1 MiB writes it is 64 MiB (67,108,864 bytes). Spike 9's flat 1 MiB per file is replaced by the real cluster size (T1.11 S9-3); P11a's legs add a peak-free-bytes row on macOS and Linux exFAT and on the Kit SSD. The update file itself is already on its volume when the check runs. When `statfs` fails, the check passes and `ENOSPC` is the typed answer. Another version's `updates/staging/<w>/` stays until the commit, so the drive needs room for both | spike 9 DD5; T1.11 S9-3; L1-8, L1-23, L2-23 | R1 |
| Reads (P6's constant) | an implementation constant, not a format value: any read size reads any update file (T1.11 S9-4). Release 1 reads 1 MiB (1,048,576 bytes) at a time into one reused buffer (`FileHandle.read` into a single `Buffer.allocUnsafe(1048576)`), hashing (SHA-256) and writing each slice before the next read; the re-hash before the hand-off (W-6) reads the same way. Spike 9, in the packaged app's main process: a read stream stalls the event loop by 66–155 ms and adds 73–89 MB; one reused buffer stays ≤ 43 ms and +6.4–9.8 MB at the same speed; 64 KiB reads are 1.5–2.4× slower on sticks; 4 MiB gain nothing and quadruple exFAT's run-ahead. Plain Node shows no stall, so P6's performance row runs in the packaged app | spike 9 DD1; T1.11 S9-4 | P6 (constant) |
| Where a member is written | `updates/staging/.incoming-<v>/<member name>` (opened `wx`), every byte hashed as it is written, fsynced and closed; on a hash match it is moved (same name) into `updates/staging/<v>/files/`; on a mismatch it is deleted and the import refused (`UPD-FILE-DAMAGED`). Nothing is ever renamed to an `.exe` name (S-P1-14: such a rename costs 240–391 ms on a stick with Norton on; the move costs 4.4–39.4 ms), and no temporary name can collide with a member name (a `.part` suffix did: `apply.cmd.part` is a legal name) | spike 9 DD4 (decided here) | R1 |
| Staged names | every member keeps its member name in staging; the release tooling gives each root artifact a member name equal to its root name (`HilbertRaum-<v>-portable.exe`), so the apply's move from staging to the root renames no `.exe` (spike 1 DD6); a member whose root name differs (a start file) carries it in `install_as`, which the apply applies (§5.5) | spike 1 DD6, spike 9 DD4 | R1 (the staged name); Scripts (the move) |
| Moves | every move in staging uses the rename retry of `services/fs-retry.ts` (`renameWithRetry`: `EBUSY`, `EPERM`, `EACCES`, its 12 s budget); spike 9: 0 retries in 802 renames, Norton's inspection runs inside `close()` | W-5, spike 9 DD7 | R1 |
| Errors while staging | never a raw error: `ENOSPC` → `UPD-DRIVE-FULL`; `EFBIG` (a FAT32 drive and a member of 4 GiB or more) → `UPD-FILE-TOO-BIG-FOR-DRIVE`; any read error on the update file but a short file (its stick or share went away, `EIO`, `EACCES`) → `UPD-CANT-READ-FILE`; any other write, move or remove error (an unplug, an antivirus denial, a path the system refuses, a move that failed after its retry budget) → `UPD-CANT-WRITE-DRIVE`. Each removes `.incoming-<v>/` and `updates/staging/<v>/` as far as it can | spike 9 DD3; L1-5 | R1 |
| The data pass starts | by removing `updates/staging/<v>/` and `updates/staging/.incoming-<v>/` (a re-import of a staged or failed version replaces it; the free-space formula before it counted their bytes as free) | W-5; L1-8, L2-22 | R1 |
| A refusal or a cancel from the data pass on | a refusal, or the user's cancel (`updates:cancel`), removes `updates/staging/.incoming-<v>/` and `updates/staging/<v>/`, moved members included (spike 9: 4–49 ms, 0 files left in 414 refusals) | W-5, F-14; L1-8 | R1 |
| The commit | in this order, so that a kill at any point leaves no staged update or exactly one that nothing marks (L2-7): every present member in `updates/staging/<v>/files/` → remove every other `updates/staging/<w>/` and `.incoming-<w>/` (at most one staged update, F-5 GAP-8; they are re-importable) → append the `cleared` line of §5.7 when `last-result.txt` marks `<v>` → write `hilbertraum-release.dsse.json`, then `staged.txt`, then, last, `staged.json` into `updates/staging/<v>/` (each to a `.tmp` name, fsynced, renamed; on macOS and Linux the folder fsynced after) → remove `updates/staging/.incoming-<v>/` | F-5; L2-7 | R1 |
| Folder names | compared after folding `A`–`Z` to `a`–`z`: a version that equals a staged one after folding replaces it (`1.0.0-RC1` and `1.0.0-rc1` are one folder on NTFS, exFAT and APFS) | L1-11 | R1 |
| The start-up sweep | at every drive-aware start, before the offers, and **never while `updates/applying/` exists** (the apply moves members out of staging): remove every `updates/staging/.incoming-*` folder, every `updates/staging/<w>/` without a valid `staged.json` (§4.6; an import cut by a kill or an unplug), and every `<w>/` in which a file its `staged.json` lists is missing or has another size (an antivirus removal; logged `staging-swept reason=member-missing`, and the Updates screen shows `UPD-FILE-DAMAGED-ON-DRIVE` once) | F-5; L2-8, L1-11 | R1 |
| Later writers | nothing under `updates/staging/` but a `<w>/` with a valid `staged.json` (§4.6) survives a release-1 start; a later version keeps nothing else there | L1-11 | R1 (the duty) |
| "Don't install this update" | removes that version's `updates/staging/<v>/`; never offered, and the channel `updates:discardStaged` refused, while `updates/applying/` exists | F-5, F-14 | R1 |
| The re-hash refusal | the hand-off's re-hash (W-6) removes that version's `updates/staging/<v>/` on a mismatch (`UPD-FILE-DAMAGED-ON-DRIVE`) | F-5, F-6 | R1 |
| Progress | bytes staged / Σ sizes of the members present, shown at most every 250 ms; the re-hash has its own label (UX-10). Spike 9: the longest flat stretch is 0.11–0.66 s (the exe's close, a content scan of ~245 ms on a stick) | spike 9 DD6 | R1 |
| A staged member's use | the apply moves only the members of the systems the drive carries; it removes `updates/staging/<to>/` whole in J6 (§5.5), the unused members of other systems included (L1-12: one rule, J6's) | W-21; L1-12 | Scripts |
| `update.log` events of the import | `r1-app <os> <event> [<field>…] t=<…>` (§5.3) with `<event>` one of `import-refused` (`code=`), `import-staged` (`version=`), `import-cancelled`, `staging-swept` (`n=`, `reason=`), `staging-discarded` (`version=`) | L1-20 | R1 |

### 4.6 `staged.txt` and `staged.json` (table A.5; F-5)

**`staged.txt`** (R1 writes, the apply reads). G0 (§5.1), except its 65,536-byte limit: a reader reads
the whole file (at most 4,096 lines of at most 111 bytes, 454,656 bytes; L1-3). One line per staged
member, in `files[]` order: `<size> <name>`. `<size>` is the member's byte count in decimal, no sign, no
leading zero (`0` for an empty member), 1 to 10 digits; `<name>` is the rest of the line after one space
(a member name, §4.4, so it holds no space; the file is `updates/staging/<v>/files/<name>`). The app
writes LF; cmd reads it with `for /f "usebackq tokens=1,*"` and bash with `read -r size name`, both
accepting CR LF. A line whose first field is not decimal is ignored. The apply checks each member's
size against it before it moves the member, **as text** (cmd `if "%%~zF"=="<size>"`, never `EQU`, which
is 32-bit and reads a leading zero as octal; bash a string comparison; L2-16); it never hashes (C12).
`staged.txt` gives presence and size only: the member names, systems, roles and `install_as` names are
constants the release tooling writes into the two scripts of that version (§5.5).

**`staged.json`** (R1 writes and reads; a later app may read it). UTF-8 JSON without a byte-order mark,
one object: `{"format":1,"version":"<v>","files":[{"name":"<member name>","size":<bytes>,"sha256":"<64
lower-case hex>"},…]}`, the `files` entries in `files[]` order and only for the members present; a
`group` key per entry that had one in the payload. Readers ignore unknown keys. **Valid** means: it
parses, `format` is the integer 1, `version` equals its folder's name, and every `files` name keeps
§4.4. A `staged.json` that is not valid means "not staged": the folder is swept (L1-11). R1 ignores
every other name in `updates/staging/<v>/`.

### 4.7 Verdicts of the container and of staging (table A.6)

The first failing check in file order decides (L1-9).

| Case | Code (§5.8) |
|---|---|
| a file of 0 bytes, or shorter than 512 bytes whose bytes are a prefix of a valid member-0 header (the name `hilbertraum-release.dsse.json`, then NULs); the end of the file inside member 0 or its padding (L2-17, L1-9) | `UPD-DOWNLOAD-INCOMPLETE` |
| any other file shorter than 512 bytes; a first block that has no ustar magic and is not `HRUPDATE`; member 0 not named `hilbertraum-release.dsse.json`; a first header whose magic and checksum are right and whose type, name or size field fails (an ordinary archive: a pax header, a folder; V-1, Δ-41) | `UPD-NOT-AN-UPDATE` |
| a first header whose magic is right and whose checksum fails (L2-17; V-1) | `UPD-FILE-DAMAGED` |
| the first 8 bytes are `HRUPDATE`; member 0 over 4 MiB; over 64 signatures; `files[]` over 4,096 entries, or an entry or a `version` that breaks §4.3's `files[]` row (a name against §4.4, a size of 8 GiB or more, a `sha256` that is not 64 hex characters, two names equal after folding) | `UPD-TOO-NEW` |
| a header that fails §4.3's checks after member 0; one zero block not followed by a second zero block, with every required member seen; an unlisted, repeated or case-colliding member; a header size ≠ the listed size; a missing member without a group, or a partial group, after a complete end; bytes after the end (`TrailingData`); non-zero padding; a member's hash ≠ its listed `sha256` | `UPD-FILE-DAMAGED` (its copy says the file is damaged or not completely downloaded, and to download it again: the action is the same) |
| the end of the file before a header, inside a member or before the two zero blocks | `UPD-DOWNLOAD-INCOMPLETE` |
| a zero block where a header should be while a listed member without a group, or part of a group, is still missing: a preallocated, zero-filled partial download (a browser's) of the full length (T1.11 S9-6) | `UPD-DOWNLOAD-INCOMPLETE`, found by the header walk (a tail that starts inside any member but the last puts zeros where the next header belongs); a zero-filled tail inside the last member's data passes the walk and ends as a hash mismatch, `UPD-FILE-DAMAGED` |
| no `apply.cmd` (Windows) or `apply.sh` (macOS, Linux) listed and present in the file | `UPD-NO-HELPER` |
| on Windows, a staging path over 259 characters (§4.5) | `UPD-PATH-TOO-LONG` |
| free space under the formula; `ENOSPC` while staging | `UPD-DRIVE-FULL` |
| `EFBIG` while staging | `UPD-FILE-TOO-BIG-FOR-DRIVE` |
| a read error on the update file (not a short file) | `UPD-CANT-READ-FILE` |
| any other write, move or remove error while staging | `UPD-CANT-WRITE-DRIVE` |
| the probe fails | `UPD-DRIVE-READ-ONLY` |

### 4.8 Cases table A was checked against

- **The staged name** (S-P1-14): every member is written under its own name in `.incoming-<v>/` and moved
  under the same name, and artifact members carry their root names, so no step of the import or of the
  apply renames anything to an `.exe` name.
- **A version from 2035** writing an update file for release 1: it fits as long as it keeps ustar's
  subset, one envelope of at most 4 MiB with at most 64 signatures as member 0, at most 4,096 members,
  §4.4's names and members under 8 GiB; any other container starts with `HRUPDATE` and is told "too new",
  never "not an update". Unknown payload fields are ignored (§2.4), unknown `staged.json` keys too.
- **Absent groups**: the header walk accepts a file that carries whole groups only, which spike 9's
  length equation alone would not.
- **Spike 9's limits** (its Not covered): cold reads of a file already on a stick and a cold re-hash
  (spike 6, P11b; the restart time, O22), Defender active (P11a; Δ-30 adds a Defender PC to O22), FAT32 and
  files near 2 GiB (not measured; `EFBIG` is typed), macOS and Linux (P11a).

---

## 5. Hand-off, apply script, start files, outcome

_Scope: what happens from "Restart and update" to the new version's confirmed start or the old
version's notice: the hand-off (F-6), the apply script and its journal, the start-file rules (F-7),
"Continue the update" (F-19), the outcome codes and notices (F-20, G-37, G-39) and
`updates/unconfirmed.txt` (F-22). The frozen values come from the protocol table B._

_Status: planned (P7; the confirmation also ships in release 1, T7.5a), except the app's own
`update.log` lines in §5.3, as built in P3 (and `update.log.tmp`, §5.2). Table B below is the decided
contract. Its evidence: spike 1 (`budget 30`), spike 8 (the profile and lock facts), spike 10 (the
spawn, rule 1, the lock, the cmd rules) and the method review of those spikes (T1.11, its finding ids
`S1-n`, `S8-n`, `S10-n`, `C-n`), the addenda spike 1b and spike 10b, and spike 4a for the Linux half (the
bash spawn, wait, final step and rule 1; Δ-39). A row marked **pending** states
its value and waits for the named measurement. Every finding that once marked a row OPEN is closed._

### 5.1 How to read table B

- **Frozen since.** _R1_: release 1 writes or reads the value, so it holds for ever (§1.5). _Scripts_:
  a convention of the two apply scripts of one version (`apply.cmd`, `apply.sh`) and of the start
  files a version ships. Release 1's scripts follow it; a later version may change it for its own
  scripts, but must still converge on every state an R1 writer can leave (§5.5).
- **Systems** are written as `win32`, `darwin` and `linux` (Node's `process.platform`, the same spelling
  as the payload's `requires`, §2.4) wherever a file holds one.
- **A version** is the SemVer 2.0.0 string of the app's `package.json` `version`, as the artifact names
  carry it (`HilbertRaum-<version>-portable.exe`): ASCII, no space, at most 64 bytes. Two versions are
  the same when their bytes are equal; order is F-4's (§2.5). A version field that is not SemVer names
  an unknown version, never an error.
- **A token** is 1 to 32 characters of `[0-9A-Za-z]`. Release 1's app writes 16 lower-case hex
  characters from `crypto.randomBytes(8)`; release 1's start files write `%RANDOM%%RANDOM%%RANDOM%`
  (cmd) and `$RANDOM$RANDOM$RANDOM` (bash: both bash start files start bash by their first line); the
  apply scripts build theirs the same way. A writer never appends a `last-result.txt` line whose token equals the token of the
  file's last valid line or of `last-result.seen`; it draws again. Readers accept 1 to 64 non-space
  ASCII bytes.
- **Common text rules (G0)**, for every text file of this section:
  - bytes 0x20–0x7E and TAB only; a line holding any other byte is damaged and is ignored;
  - lines end in LF or CR LF; a reader removes one CR before the LF, trims spaces and TABs at both ends,
    skips empty lines and splits fields at runs of spaces and TABs; a last line without a line end
    counts;
  - **writers:** cmd writes CR LF (its `echo`); bash and the app write LF;
  - keys and codes are lower-case ASCII compared byte for byte, never case-folded (so a `tr-TR` locale
    cannot change them);
  - a writer's line is at most 256 bytes; a reader ignores a line over 1,024 bytes and reads at most
    65,536 bytes of a file (append-only files: the last 65,536 bytes, the first partial line
    dropped);
  - an unknown key, an unknown extra field or an unknown extra line is ignored, never an error; a
    missing, unreadable or damaged file means "absent" unless its row says otherwise; a read error (a
    sharing violation while a scanner holds the file) is "absent" for that read only: nothing is
    deleted or rewritten because of it (L2-11);
  - **every writer that appends** to a file first appends an empty line, then its line (cmd
    `>>"…" echo(` then `>>"…" echo …`; bash and the app `\n<line>\n`), so a torn earlier append (a
    partial line, a zero-filled tail) can never join a later line (L2-9).

### 5.2 Names (table B.1)

All paths are relative to the drive root; names are exact, case included. `<os>` is a system token,
`<v>` a version, `<n>` the digit 1, 2 or 3.

| Name | What it is | Written by | Read by | Frozen since |
|---|---|---|---|---|
| `updates/` | the update folder (table A, §4, owns staging) | R1 app | everyone below | R1 |
| `updates/applying/` | the pending-apply folder: while it exists an update is in progress (F-6, F-7) | R1 hand-off; "Go back" and every later fallback write it before moving an app (F-7's later-writer duty) | R1 start files (rule 1, the counter), R1 app (F-19), every apply | R1 |
| `updates/applying/handoff.txt` | the hand-off record (§5.3) | R1 hand-off and "Continue the update"; later writers | the apply | R1 |
| `updates/applying/apply.cmd`, `updates/applying/apply.sh` | byte copies of the staged members `apply.cmd` and `apply.sh` (member names exact, lower case; R1 finds them by name, whatever their `role`); R1 copies each one the staging holds, for every system, so the other system's twin can resume; each through `<name>.tmp`, fsync, rename (rule 1 tests the final name only, so it never meets a cut copy; L1-15, L2-2) | R1 hand-off; R1 "Continue the update" re-copies one that is missing, or whose size or SHA-256 differs from its `staged.json` entry, from `updates/staging/<v>/files/` (`<v>` = `handoff.txt`'s `version`) | R1 start files (rule 1), the apply | R1 |
| `updates/applying/started` | empty file: the apply's first action creates it (the start acknowledgement); R1 deletes it before the spawn of a "Continue the update", so it always acknowledges this spawn (L1-2, L2-6). `journal.txt`, not `started`, marks J2 and later | the apply; R1 deletes it | R1 app (≤ 10 s after the spawn, §5.4) | R1 |
| `updates/applying/done` | empty file: the apply creates it before its terminal start and removal (§5.5); an `applying/` that holds it is finished, and R1 removes it (§5.4) | the apply | R1 app | R1 |
| `updates/applying/launch-1`, `launch-2`, `launch-3` | empty files: one per resume a start file began (N = 3) | R1 start files (rule 1); later start files keep rule 1 | R1 start files; the apply deletes them | R1 |
| `updates/applying/finish-1`, `finish-2`, `finish-3` | empty files: one per hand-off of one version by an app ("Restart and update" and "Continue the update"; N = 3); a fourth hand-off finds no free marker and is refused (§5.4; Δ-41, the owner's "three tries") | R1 app | R1 app; the apply deletes them | R1 |
| `updates/applying/apply.lock` | the cmd twin's lock: a file held open by redirection handle 9 for the whole run; its presence means nothing | `apply.cmd` | `apply.cmd` | Scripts |
| `updates/applying/apply.lock.d/` and its `owner` | the bash twin's lock: a directory made with `mkdir`; `owner` holds `pid`, `os`, `boot` and `lstart` lines (§5.3's `key value` form) | `apply.sh` | `apply.sh` | Scripts |
| `updates/applying/journal.txt` (and `journal.tmp` while it is written) | the apply journal's header (§5.3, §5.5) | the apply | both twins of the version whose scripts lie there | Scripts |
| `updates/applying/step-launchers`, `step-result` | empty files: journal steps done (§5.5) | the apply | both twins | Scripts |
| `updates/previous/` | the previous set: at most one artifact per system, the replaced start files, and the previous content set (P8 names its folder, §6.10) | every apply | R1 start files (rule 2, the counter), "Go back" | R1 (rule 2 reads it) |
| `updates/applied/<v>.json`, `updates/applied/<v>.dsse.json` | the apply's record and the kept signed envelope (§6.9) | the apply | the new version | Scripts |
| `updates/unconfirmed.txt` | F-22's trigger (§5.3, §5.7) | a forward apply, before its first move | R1 app, R1 start files' counter, later start files | R1 |
| `updates/confirmed/<v>_<os>` | empty file: version `<v>` had a confirmed start on system `<os>`; `<os>` matches `[a-z0-9]{1,16}`; the separator `_` is in no SemVer string, so the glob `confirmed/<v>_*` never matches a pre-release of `<v>` (L1-4, L2-12; owner 2026-11-24, §5.12 question 4) | every confirming app, R1 included | every app; R1's counter tests `updates/confirmed/<v>_*` | R1 |
| `updates/launch-count.txt` | R1's launch counter, one per drive (§5.3) | R1 start files (the counter); removed by a confirming app (F-22) and by a counter fallback | R1 start files | R1 |
| `updates/launch-count-<anything>.txt` | reserved for later start files' per-computer counts (W-21); R1 never reads them and its confirmation removes them | later start files | later start files | R1 (the name is reserved) |
| `updates/starting-<os>` | later start files' in-flight record (W-7 (d)) | later start files | later start files | Scripts |
| `updates/last-result.txt` | the outcome lines (F-20, §5.3, §5.8) | the apply, start files, R1 app | R1 app, every later app | R1 |
| `updates/last-result.seen` | the line R1 showed last (§5.3) | R1 app on dismissal; later apps in the same form | R1 app | R1 |
| `updates/update.log` | the support log (§8.2); table B's writers' lines in §5.3 | R1 app, R1 start files, later start files, the apply; only an app trims it (§5.3) | support, `/check`, "Copy details for support" | R1 |
| `updates/update.log.tmp` | the trim's temporary copy: the newest part of `update.log`, flushed, then renamed over it (§5.3); a file or link at the name when a trim starts is removed by its name, never followed (a folder there fails the trim), and a failed trim removes the copy it made | R1 app (T3.2) | nobody (renamed over `update.log`) | R1 (the name is R1's) |

### 5.3 Grammars (table B.2)

Every file below follows G0 (§5.1).

**`handoff.txt`** (R1; F-6). `key value` lines: the key is the first field, the value the rest of the
line after one run of spaces or TABs. The first line with a key wins; a key R1 does not know is kept
and ignored.

| Key | Value | Written by |
|---|---|---|
| `pid` | decimal, 1 to 10 digits: `process.pid` of the app that hands off (on Windows the main process inside `%TEMP%`, whose parent is the stub) | R1, every later writer |
| `version` | the version whose scripts were copied into `applying/` (the staged version) | R1, every later writer |
| `budget` | decimal seconds, 1 to 86400: the wait floor; R1 writes `30` (spike 1). The apply waits at least this long, and may wait longer, never shorter | R1, every later writer |
| `os` | the system token of the computer that handed off | R1, every later writer |
| `boot` | decimal: that computer's boot time in epoch seconds, `max(0, Math.round(Date.now() / 1000 - os.uptime()))` (a dead clock battery can make the difference negative; L2-24) | R1, every later writer |
| `mode` | `forward`, `back` or `fallback`; absent means `forward` | later writers only ("Go back", a fallback) |
| `to` | the version the apply moves to the root (for `back` and `fallback`) | later writers only |

- R1 writes the five lines in the order above, LF line ends, to `handoff.txt.tmp`, fsyncs it, renames it
  to `handoff.txt`. No host name, user name or path is written.
- **"Continue the update"** (R1, §5.4) rewrites the file: new `pid`, `os`, `boot` and `budget 30`,
  and **every other line kept in its order** (`version`, `mode`, `to`, unknown keys), so a fallback or
  a "Go back" that release 1 continues keeps its direction. R1's four lines come first, then every
  kept line byte for byte; a damaged line is dropped. A `handoff.txt` that is missing or has no valid
  `version` is rewritten with all five keys, `version` being the one staged version (`staged.json`,
  table A); with nothing staged the `version` line is left out, R1 writes no `last-result.txt` line for
  this continue and logs `version=unknown` (L1-14, L2-3). An apply that finds no `version` uses its own
  version, written into the script.
- The apply reads `pid`, `os`, `boot` and `budget` only to wait (§5.5); it never takes its direction
  or its versions from `handoff.txt` once `journal.txt` exists.

**`journal.txt`** (Scripts; W-21). `key value` lines as `handoff.txt`, written once per apply run by
the first instance that holds the lock, to `journal.tmp`, then renamed (bash: `sync` after), and never
rewritten; a resume reads it.

| Key | Value |
|---|---|
| `journal` | `1` (the journal format) |
| `mode` | `forward`, `back` or `fallback` (from `handoff.txt`; absent there means `forward`) |
| `to` | the target version: the staged version for `forward`, `handoff.txt`'s `to` otherwise |
| `from-win32`, `from-darwin`, `from-linux` | one line per system: the version of that system's root artifact when the journal opened, `none` when the root had none, `unknown` for a root `*.app` |

For `unconfirmed.txt` and `launch-count.txt`: **only the first non-empty line counts** (after G0's
trimming); valid means two or more fields of the forms below; if the first non-empty line is not
valid, the file is damaged, and later lines are never read. R1 deletes a damaged file only after a
read that succeeded (L1-27, L2-11).

**`unconfirmed.txt`** (R1; F-22). `<version> <token> [<field>…]`, the rest of the line ignored. Written
by a forward apply before its first move (temp + rename, CR LF from cmd, LF from bash). A damaged file
is removed by R1's app as stale (§5.7), only while `updates/applying/` is absent.

**`launch-count.txt`** (R1; F-7). `<count> <version> [<field>…]`. `<count>` is
decimal; a count above 3 reads as 3, a count that is not decimal reads as 0, and a `<version>` other than
`unconfirmed.txt`'s reads as 0. R1's start files rewrite the whole file (`>"…" echo <count> <version>`;
bash `printf '%s %s\n'`). A confirming app removes it (F-22).

**`last-result.txt`** (R1; F-20, W-51). Append-only; nothing ever deletes or shortens it.
- A valid line: `<code> <version> <token> [<field>…]` with `<code>` matching `[a-z][a-z0-9-]{0,31}`.
  A line with fewer than three fields, a malformed code or a non-SemVer version is ignored (a torn or
  hand-edited line never counts).
- **The last valid line wins.** Its code decides (§5.8): every code outside the success set `applied`,
  `cleared` means "don't offer this version again"; an unknown code gets the generic copy.
- Writers append one line per event, after an empty line (G0; `>>"…" echo(` then `>>"…" echo …`, with
  the redirection first in cmd).
- **`helper-blocked` lines** carry two extra fields, `os=<os> boot=<boot>` (this computer's, as in
  `handoff.txt`), so another computer or a restarted one is not bound by the mark (§5.7; L2-14; owner
  2026-11-24, §5.12 question 5).

**`last-result.seen`** (R1). One line: the last valid `last-result.txt` line that R1 showed, as R1
read it after G0's trimming, then LF. A `last-result.txt` line is new when its trimmed text differs
from this line. R1 writes it when the notice is dismissed (W-51), never on render; an absent or
unreadable file means nothing was shown. On a drive that cannot be written the notice therefore shows
at every start (accepted, W-51).

**`update.log` lines of table B's writers** (R1; F-11, §8.2). One line per event:
`<writer> <os> <event> [<field>…] <time>`.
- `<writer>`: `r1-launcher` (release 1's start files), `r1-app` (release 1's app), `lb` (a later
  version's start files), `apply-<version>` (an apply script).
- `<field>`: `key=value`, value ASCII without spaces (versions, codes, counts, the class names below).
  No path, no host or user name, no free text.
- `<time>` is the last field: `t=<YYYY-MM-DDTHH:MM:SSZ>` (the app and bash, UTC), or
  `d="<%date% %time%>"` from cmd, whose content between the quotes is opaque bytes in the console's code
  page and is never parsed.
- **`update.log` is exempt from G0's damaged-line rule**: no reader drops a line. G0's byte rule and
  field split stop at ` d="`; from there to the end of the line any bytes but CR and LF are allowed and
  never parsed (`%date%` carries non-ASCII bytes, `%time%` a space or a comma in some locales; L1-19,
  L2-10). "Copy details for support" replaces every byte outside 0x20–0x7E in a copied line by `?`.
- Every writer appends an empty line first (G0). A write failure is ignored (`2>nul`; bash
  `2>/dev/null || true`); it never stops a start file or an apply.

**The app's lines (`r1-app`), as built in P3** (F-11; T3.2 and its fix round, T3.10;
`main/services/updates/update-log.ts`; golden `tests/fixtures/readers/f11-update-log/`). Release 1's
app writes the file through one appender, `appendUpdateLogLine`, which takes only a registered event.
- **The frame.** Every app line is `r1-app <os> <event> <key>=<value> … t=<YYYY-MM-DDTHH:MM:SSZ>`,
  written as one append of LF, the line, LF; tokens of bytes 0x21–0x7E, one space between tokens, at
  most 256 bytes without the two LFs; never a CR, never `d="…"`. `<os>` is `process.platform` when it
  matches `[a-z0-9]{1,8}`, else `unknown`. An event matches `[a-z][a-z0-9-]{0,31}`, a key
  `[a-z][a-z0-9_]{0,31}`; a value is 1 to 64 bytes of `[0-9A-Za-z._+-]`; `t` is the writer's own key. A
  field that fails, or a second field with the same key, is dropped; an invalid event, or a line still
  over 256 bytes, is not written (skipped and counted). The time is UTC to the second, the milliseconds
  dropped, never rounded; it is left out when it fails
  `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$`.
- **Registered events only** (Δ-66). The frame alone does not make a line content-free: a one-word file,
  host or account name passes the value rule. So the appender writes only the events of the frozen
  table `UPDATE_LOG_EVENTS`, each with its keys in a fixed order and each key with one token rule (with
  only the sentinels that key admits) or a closed list of words. An unregistered event is no line
  (skipped and counted, on any root); a key the event does not name, or a value its key's rule refuses,
  never reaches the file. A later event (P6's, P7's) is registered in that module as data: every key
  with a token rule or a closed list (the `UPD-*` code as a closed list of table B.9's codes), a key
  whose value comes from a file another program or build wrote named in the module's header as
  data-fed, and a new token rule numeric-shaped or a closed list, which is a golden change (CF-41).
- **The token rules.** V: a SemVer 2.0.0 version (T3.1's parse) of at most 24 bytes. P: an engine pin
  `[0-9A-Za-z][0-9A-Za-z._+-]{0,15}` that holds a digit. I: `[0-9]{1,6}`, from JSON only as an integer.
  S: the SQLite version `[0-9]{1,3}(\.[0-9]{1,3}){2,3}`. E: an error code `E[A-Z0-9]{1,30}`,
  `ERR_[A-Z0-9_]{1,36}`, `SQLITE_[0-9]{1,5}` or the literal `UNKNOWN` (libuv's code for a Windows error it
  does not map, seen on failing USB media), at most 40 bytes. C: a bare system call of at most 16 bytes.
  N (T3.10): a signed integer `-?[0-9]{1,10}`. A (T3.10): the `last_writer` stamp's applied-through
  token `[0-9A-Za-z._-]{1,16}`, used only for `applied`. The sentinels `unknown`, `absent`,
  `unreadable` and `none` hold no digit; every real version, pin, integer and SQLite version holds one,
  so a sentinel never passes for a value.
- **Word-shaped rules and data-fed keys.** P and C admit a word (`Steuer_2026.xlsx` is a pin by shape,
  `peter` a system call), V and E admit one in their own shapes (`1.0.0-peter`, `EMMA`), and A is
  word-shaped outright; they cannot be tightened without changing frozen golden lines. So such a key is
  filled only from its own source (the pins from the app's own bundled `runtime-sources.yaml`, a system
  call from a thrown error's `syscall`), or it is named as data-fed: `startup`'s `release` (V) and
  `release_format` (I) from `config/drive-release.json` and `drive_format` (I) from `config/drive.json`;
  `unlock`'s `writer` (V) and `applied` (A) from the workspace's `last_writer` stamp, and `user_version`
  (N) and `found` (I) from its header or a newer-format refusal. Each is bounded by its rule. `applied`
  is release 1's one word-shaped data-fed key, the exception to CF-41's rule; only a build holding the
  workspace key, or a person with the password, writes the stamp. P10's T10.3 chooses a token that
  passes A, or `applied` is left out of release 1's lines for ever. Every later registration is
  reviewed against this paragraph.
- **256 bytes per an event's actual fields.** `startup` and `start-failed` fit by their whole schema
  (their longest golden lines: 252 bytes, `s46`, the worst case, and 179 bytes, `f14`). `unlock` fits per
  result: its nine keys at their caps would come to about 290 bytes, but no result carries them all,
  and its longest real line is 210 bytes (golden `u61`).
- **The 24-byte version cap.** V's cap keeps the startup line under 256 bytes, so a valid version of 25
  to 64 bytes is logged as `version=unknown` (the app's own), `release=unreadable` (the record's) or
  `writer=unreadable` (the stamp's): `release=unreadable` reads "unreadable, or longer than 24 bytes"
  (T3.2's review, m-4).
- **`startup`** (T3.2; W-14, W-68), in order: `version` (V: `app.getVersion()`, else `unknown`);
  `llama`, `whisper`, `kiwix` (P: the pins of the app's own bundled `runtime-sources.yaml`; `absent` for
  no file or no block, `unreadable` for a read error, text that does not parse or validate, or a pin
  that fails P); `release` (V: the drive-release reader's `app_version`, §8.5; `absent` for no file or no
  valid `app_version`, `unreadable` for a read that failed, a damaged file or a version over 24 bytes);
  `release_format` (I: only when the record was read and its `format` is valid and passes I);
  `drive_format` (I: `config/drive.json`'s `drive_format_version`; `absent` when the key is missing or
  not an integer, `unreadable` for no file, a read error, text that is no JSON object, a file over
  65,536 bytes or an integer that fails I); `sqlite` (S: `process.versions.sqlite`, else `unknown`); `t`.
  Written once per start, in `initBackend` after logging exists and before the policy and the
  workspace's start.
- **`start-failed`** (T3.2; W-82), in order: `version` (V, else `unknown`); `cause`
  (`drive_not_writable`, `drive_full` or `other`; anything else is `other`); `err` (E: the start gate's
  code when it passes E; when the gate shows none and the thrown value's code is libuv's `UNKNOWN`,
  `UNKNOWN`; else left out); `syscall` (C: bare, else left out); `t`. Written in the start runner's catch
  (`backend-start.ts`); never a message, a path or SQLite's text.
- **`unlock`** (T3.10; CF-23): after every unlock attempt, a success and every refusal, one line
  `r1-app <os> unlock result=<token> [<field>…] t=<UTC>`. `result` is `ok` or the answer's reason
  (`wrong_password`, `vault_damaged`, `workspace_schema_unreadable`, `vault_open_failed`,
  `vault_missing`, `vault_descriptor_missing`, `vault_descriptor_unreadable`, `vault_recovery_blocked`,
  `workspace_newer`); any other value is `error`. The fields follow in the order
  `result user_version writer applied damage what found err syscall`, only the result's own: `ok`
  `user_version`, `writer`, `applied`; `vault_damaged` `user_version`, `damage` (`failed-authentication` or `not-a-database`);
  `workspace_schema_unreadable` `user_version`; `vault_open_failed` `user_version`, `writer`,
  `applied`, `err`; `vault_recovery_blocked` `err`; `workspace_newer` `user_version`, `what`
  (`database`, or the vault format's `descriptor`, `kdf`, `frame` or `journal`, refused before the
  password, with no `user_version`), `found`; `error` `user_version`, `writer`, `applied`, `err`,
  `syscall`; every other refusal the result alone. `user_version` (N) is the workspace file's own, read
  from its SQLite header after the decrypt and before the migrations (only when the header starts with
  SQLite's magic), or a newer database's version. `writer` is the `last_writer` stamp found before the
  overwrite, through `parseLastWriter`: `none` when there is no stamp, `unreadable` when it does not
  parse or its version is no SemVer of at most 24 bytes, otherwise the version, with its second field as
  `applied` when that passes A; `writer` is left out when the open never got as far as the stamp. `err`
  is SQLite's result code as `SQLITE_<n>` when the error carries one (node:sqlite reports the extended
  code, such as `SQLITE_1811`), else the error's code. What the line means, and when none is written:
  §8.2.
- **Where.** Lines only on a prepared drive (`config/drive.json` exists), never through a link:
  `updates/` must be a real folder at its name (`folderContainment`; made with one plain `mkdir` when it
  is missing), and `update.log` absent or a regular file with one name, opened once and checked on its
  descriptor (on macOS and Linux also opened with `O_NOFOLLOW` and `O_NONBLOCK`). A skip or a failure is
  swallowed, counted and reported in `app.log` as "Update log: line skipped" with the event, a fixed
  reason, the error's code and system call and the count, never a path; nothing throws. The reasons and
  the `app.log` text are not part of F-11.
- **The cap and the trim.** The cap is 65,536 bytes. After an app append that takes the file over it,
  and only while `updates/applying/` is proven absent, the app keeps the newest 32,768 bytes from the
  byte after the first LF in them, copied as bytes and never decoded, through `update.log.tmp`, a flush
  and a rename (§5.2); a failed trim is counted and tried again at the next app append. The kept part
  fits the 65,536-byte window every reader takes from an append-only file (G0). Start files and apply
  scripts only append; readers accept any size.
- **Not written.** No quit line and no line for C09 (§7.6). Release 1 parses no writer token or event; a
  later app writes its own writer token, not `r1-app` (an open item for the first release after release
  1).
- **Residuals** (T3.2's review, N-4 and m-3; also in [`known-limitations.md`](known-limitations.md)): on
  Windows, which has no `O_NOFOLLOW`, a symbolic link planted between the `lstat` and the open is
  followed, so only a content-free line can land at its target; the log's own `O_NONBLOCK` is a belt no
  row can prove (an `O_RDWR` open of a pipe never blocks on Linux); a line another writer appends while
  the app trims can be lost (a trim comes once per 32 KiB of appends: about every 200 starts where
  startup lines are all a drive writes, sooner with unlock lines); a case-variant `Updates/` folder on
  macOS gets no line; two app instances writing one drive's log are not coordinated. Whether a reader
  keeps an `update.log` line over 1,024 bytes (as above) or ignores it (G0) is P6's support copy's to
  settle (CF-34); the app's own lines are at most 256 bytes.

### 5.4 The hand-off (table B.3; F-6, F-14's hand-off channel)

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| Who hands off | the app, on the `will-quit` leg only: P7 gives `performShutdown` a typed result (`clean`, `working_copy_lost`, `failed`; today it returns nothing), and the hand-off runs only after `clean` (`working_copy_lost` and `failed` end with nothing written, the update still staged); an app that survived a session-end lock and shows its unlock screen runs the hand-off directly from there, with no second lock (W-6 (i)–(v)) | W-6 | R1 |
| Order | "Restart and update" → pre-check (below) → policy re-read (§8.1) → re-hash every staged file against `staged.json` (table A; a mismatch removes that version's staging folder, code `UPD-FILE-DAMAGED-ON-DRIVE`) → the question about running text recognition or translation (`UPD-RESTART-TASK-RUNNING`, #935) and the save of unsaved changes (`UPD-RESTART-UNSAVED`, #888), each only when it applies → the restart dialog last → lock → teardown → write `applying/` (below) → spawn → wait for `started` → `app.exit(0)`. Every abort choice before the lock writes nothing | W-6, F-6 | R1 |
| Precondition: the running app is the drive's app | the apply finds the root from its own place and swaps the root's artifacts (`%~dp0..\..\`), so the hand-off assumes the running app is a root artifact of the root R1 resolved (`locateDriveRoot`, `services/workspace.ts:42-53`): Windows, `dirname(PORTABLE_EXECUTABLE_FILE)` is that root; macOS, `HILBERTRAUM_DRIVE_ROOT` names that root (a start through the root's start file) or the running bundle is a root `*.app`; Linux, `dirname(APPIMAGE)` is that root or `HILBERTRAUM_DRIVE_ROOT` names it. Two paths are the same after `path.resolve` (no `realpath`), compared without case on `win32` and byte for byte elsewhere (the start file's `%~dp0` has a trailing `\`, `dirname` none; L1-18). On macOS and Linux a root given by `HILBERTRAUM_DRIVE_ROOT` always passes: release 1 cannot tell an override from a start through the start file, so only Windows can refuse an override root. When it fails (a bare exe one folder below the root, or on Windows an override that names a folder other than the exe's; every start through the start file sets the override to the exe's own folder and passes), "Restart and update" and "Continue the update" are refused before the lock with `UPD-NOT-DRIVE-APP` (copy key prefix `updates.restart.notDriveApp`), nothing is written and the update stays staged; the import and the staging stay allowed (owner 2026-11-24, Δ-31, §5.12) | T1.11 S10-1; owner | R1 |
| Pre-check | before the lock, and at the start of every import (table A, §4.5): `updates/` is created when it is missing; the probe opens `updates/.write-probe` with flag `w` (a file left over by a kill is overwritten), writes one byte, closes it and deletes it; only a failing open or write means "read-only" (a failing delete is retried as §4.5's moves are, then ignored; L1-23, L2-15); free space = `bavail × bsize` ≥ 64 MiB (67,108,864 bytes, the third term of table A's formula; when `statfs` fails this part passes); failing either → no shutdown, code `UPD-DRIVE-READ-ONLY` or `UPD-DRIVE-FULL` | W-6 (GAP-23, A-6); spike 9 DD5 | R1 |
| `applying/` write order | `mkdir updates/applying` → `handoff.txt` (temp, fsync, rename; §5.3) → `apply.cmd` then `apply.sh` from `updates/staging/<v>/files/`, each copied to `<name>.tmp`, fsynced and renamed with §4.5's retry (rule 1 only ever sees a whole script; L1-15, L2-2) → `finish-<n>` (below) → on macOS and Linux fsync `updates/applying/` and `updates/` (W-6, lens A-9). Any write failure after the teardown is handled as a failed spawn (below) | W-6; L1-15, L2-2 | R1 |
| `finish-<n>` cap (per computer and boot) | **before the lock**, with the pre-check (L1-1, L2-1): (a) when `updates/applying/handoff.txt` is missing or damaged, or its `os` is not this system, or its `boot` is more than 300 s from this computer's (another computer, or a restart since), R1 deletes every `finish-<n>` and `launch-<n>`: a new computer, or a restarted one, gets three new tries, and rule 1 resumes there again; (b) then, if `finish-1`, `finish-2` and `finish-3` all exist (no free marker), the hand-off is refused like a failed spawn of class `finish-cap`, with no spawn: R1 shows `UPD-HELPER-BLOCKED` without the "Try again on this computer" button, logs `handoff-failed class=finish-cap`, appends no new line when the last valid one already is this version's `helper-blocked`, and does **not** shut down; (c) otherwise the hand-off goes on and, after the scripts, creates the lowest free of `finish-1`, `finish-2`, `finish-3`. So one computer spawns at most three times per boot without the apply making progress (the apply deletes the markers when it takes its lock; Δ-41, aligned to the owner's "three tries per computer": _Was:_ `finish-3` was created by the refusal of a third hand-off, so only two spawned); (d) a failed spawn that removed `applying/` took its markers with it, so R1 also keeps **the failed-hand-off count**: going back from the last valid line of `last-result.txt` (within the 65,536 bytes G0 reads), the number of consecutive valid lines that are `helper-blocked`, name this version and carry this computer's `os` and a `boot` within 300 s of this computer's; the count stops at the first valid line that is anything else (another code, another version, another computer or boot, a `cleared`). Every failed spawn and every missing acknowledgement appends one such line; refusals by (b) or (d) append none. At a drive-aware start a count of 1 or 2 offers "Try again on this computer" (§5.7); a count of 3 (the third failed hand-off: the first "Restart and update" plus two "Try again on this computer") ends the retries on this computer and boot: nothing is offered, the notice shows without the button, and a hand-off reached anyway is refused as at (b), except that no file is created (there may be no `applying/`), no line is appended and nothing shuts down. A restart, another computer or a re-import (its `cleared` line) starts a new count. **One limit**: at most three hand-offs per computer and boot, whichever record counts them, the `finish-<n>` markers while `applying/` stays or the failed-hand-off count after a removal; the first of the two to reach three ends the tries (T1.12 review V-2, owner 2026-11-24, Δ-41) | W-6 (GAP-24); L1-1, L2-1; V-2 | R1 |
| Windows spawn | `spawn(<SystemRoot>\System32\cmd.exe, ['/d', '/c', '.\\apply.cmd', String(process.pid)], { cwd, detached: true, stdio: 'ignore', windowsHide: true, env })`; no `shell`, no `windowsVerbatimArguments`. `<SystemRoot>` = `process.env.SystemRoot`; unset, empty or not an absolute path → a failed spawn of class `no-shell`, no spawn tried (L1-26, L2-25). Node builds the command line `C:\WINDOWS\System32\cmd.exe /d /c .\apply.cmd <pid>` (spike 10: `spawnargs`). No path on the command line: the script finds the root from its own place (`%~dp0..\..\`). Measured on 12 roots × NTFS and exFAT, 72 of 72 runs (spike 10, Norton on, Windows 11 x64 build 26300). Its open legs, placed by the owner 2026-11-24 (Δ-30): a Defender-only PC in O22's pre-release timing leg (T1.11 S1-1) and GitHub's `windows-11-arm` runner in the walk (T1.11 C-3) | spike 10 DD1; W-6 | R1 |
| `cwd` (both systems) | `path.join(<the drive root R1 resolved with locateDriveRoot and wrote applying/ under>, 'updates', 'applying')`; **never** `dirname(PORTABLE_EXECUTABLE_FILE)` (spike 10's probe shortcut; T1.11 S10-1). Two T7.1 rows: the exe one folder below the root; an override root | T1.11 S10-1 | R1 |
| Environment | `env` = `process.env` minus every name below, then `NoDefaultCurrentDirectoryInExePath=1` and `ComSpec=<SystemRoot>\System32\cmd.exe` added (Windows only). Iterate `Object.entries(process.env)` (it keeps the stored spelling). **Dropped** on Windows matched case-insensitively, on macOS and Linux case-sensitively: names starting `HILBERTRAUM_`, `PORTABLE_EXECUTABLE_`, `ELECTRON_`, `NODE_`, `BASH_FUNC_`, `LD_`, `DYLD_`; the names `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `IFS`, `CDPATH`, `GLOBIGNORE`, `TAR_OPTIONS`, `POSIXLY_CORRECT`, `PS4`, `COPYCMD`, `DIRCMD`; on Windows also every spelling of `NoDefaultCurrentDirectoryInExePath` and `ComSpec` before they are set. Measured: the stub adds `PORTABLE_EXECUTABLE_APP_FILENAME`, `_DIR`, `_FILE`, Electron adds `ELECTRON_NO_ATTACH_CONSOLE`; all four are dropped (spike 10: 116 names → 92). A later apply may drop more; it can never restore a name | spike 10 DD1; W-6 | R1 |
| macOS and Linux spawn | `spawn(<sh>, ['./apply.sh', String(process.pid)], { cwd, detached: true, stdio: 'ignore', env })`; `<sh>` = the first of `/bin/bash`, `/usr/bin/bash`, `/bin/sh` that is a regular file with execute permission; none → a failed spawn of class `no-shell`. `detached` makes the child a session leader (`setsid`). `apply.sh` re-execs itself under bash when bash exists (W-21). **Measured on Linux** (spike 4a, Δ-39: WSL2 Ubuntu 24.04, the packaged static-runtime AppImage, 52 spawns on 10 roots × ext4, FUSE exFAT and drvfs, plus a namespace with no bash): the lookup works with `/bin` a link to `usr/bin`; the child is its own session, outlives the app and the old mount, and renames 67–224 ms after the app's exit (39 runs of the three base groups); with no bash the child runs under `/bin/sh` (dash) and still writes `started`; no denied name reaches it (Linux matching is case-sensitive, as written). The spawn inherits 37–39 descriptors (the AppImage runtime's pipe, descriptor 1023 on the old mount, files inside the mount, Chromium's sockets): closing them in `apply.sh` (§5.5, the bash rules) is what releases the old mount (without it the old image stays mounted for the new app's session). **macOS pending** P11a's spike 3 | W-6, B-13; spike 4a DD7 | R1 |
| Failed spawn, classes | R1 classifies before and at the spawn (spike 10 DD4): `cwd.length > 258` → `cwd-too-long` (no spawn tried); `child.pid === undefined` right after `spawn()`, or an `error` event, with code `ENOENT` while the shell exists → `cwd-missing-or-too-long`; `EPERM` or `EACCES` → `blocked`; the shell missing → `no-shell`; any other code → `spawn-failed`; plus `finish-cap` and `write-failed` (a write after the teardown failed). Measured: a cwd of 259 characters or more gives `ENOENT` naming `cmd.exe` 2 ms after `spawn()` (`LongPathsEnabled` doesn't help); with the real exe name a too-deep root never reaches the hand-off (the stub fails first at a 256-character exe path) | spike 10 DD4, item 5 | R1 |
| After a failed spawn | append `helper-blocked <v> <token> os=<os> boot=<boot>` to `last-result.txt` (§5.3); log `r1-app <os> handoff-failed version=<v> class=<class> code=UPD-HELPER-BLOCKED`; remove `updates/applying/` when this hand-off created it and `started` is absent (a "Continue the update" never removes it here); show the `helper-blocked` notice until it is dismissed, at most 60 s (owner 2026-11-24, §5.12 question 6), then quit (the teardown already ran). The update stays staged. When this hand-off removed `applying/`, the next drive-aware start on this computer and boot offers "Restart and update" labelled "Try again on this computer" at once, within the cap ((d) above; §5.7; V-2, owner 2026-11-24, Δ-41), so a buyer who allow-lists the helper can retry without a restart. R1's other removals are only the two of the next row | W-6 (CC-21, CE-D7); V-2 | R1 |
| A finished or dead `applying/` | at a drive-aware start, before the offers and the import gate, and in "Continue the update": when the folder holds `done` (finished: the apply's removal was cut short), or holds no apply script for this system and none can be re-copied from `updates/staging/<v>/files/` (dead), R1 removes the folder (recursively, with §4.5's retry; logged `applying-removed reason=done` or `reason=no-script`) and treats it as absent everywhere: the offers, the import gate, the confirmation (§5.7). A torn swap left that way is rule 2's and rule 3's, as for the accepted "apply script missing" class (L2-4). T1.11 S10-2 is closed by spike 10b: with the final line's order (removal before `start`, §5.5) and rule 1's `(goto)` prefix (§5.6), the cmd apply removes its folder with `LockBatchFilesWhenInUse` = 1 (34 of 34) and = 0 (the final text, 12 of 12); the measured residues of the old texts, an `applying\` that holds **only `apply.cmd`** at 1 (the old order) and an **empty** `applying\` at 0 (the `cd /d` before the `(goto)`), no longer arise from the order itself. This row stays the backstop for a removal cut short (an unplug, an Explorer window or a scanner on the folder). A folder left holding only `apply.cmd` can still arise at either value when something holds the script at the final line's `rmdir`, which then deletes `done` with the rest (T1.11 P3-5): it holds a script, so this row keeps it, and the apply removes it itself (§5.5 "Nothing to resume", a Scripts rule). R1 gets no further rule (orchestrator 2026-11-24) | W-6; L2-4; spike 10b DD4 (c); T1.11 S10-2 (closed), P3-5 | R1 |
| Start acknowledgement | before the spawn of a "Continue the update" R1 deletes `updates/applying/started` (if it cannot, it skips the wait and logs `handoff-started ack=stale`; L1-2, L2-6). After a successful spawn R1 polls `updates/applying/started` every 100 ms for at most **10 s**. Present → log `handoff-started`, `app.exit(0)`. Absent after 10 s → append `helper-blocked <v> <token> os=<os> boot=<boot>`, log `handoff-no-ack … code=UPD-HELPER-BLOCKED`, show the notice (as above), remove nothing (a slow first scan may still let the apply run; its later lines win), `app.exit(0)`. Measured spawn → `started`: **16–41 ms over 82 runs** (spike 1 item 4: 16 runs, 25–41 ms; spike 10: 66 runs, 16–39 ms; Norton on, the script's hash known; T1.11 C-6), so 10 s is more than 200× the worst case seen. The wait stays also because a helper can fail before its first line: a script held open for writing at the spawn makes cmd exit 1 and run no line at value 1 (5 of 5), and a Restart Manager query about the running script breaks it at value 0 (5 of 5; spike 10b DD4 (b)). The one spawn of spike 10b that ran no line at value 1 (1 of 41) was **likely the harness's Restart Manager query: reproduced at value 0, not at value 1** (a query loop during the start at value 1 left the script running 5 of 5; T1.11 P3-2). The 10 s acknowledgement covers it either way, and T7.2's value-1 row runs at least 40 spawns with no Restart Manager query and counts those that ran no line. R1 writes `apply.cmd` by temp + rename and closes it before the spawn (§5.4's write order), and the missing `started` stays the signal for a helper that never got going. A Defender-only PC joins O22's pre-release timing leg (owner 2026-11-24, Δ-30; T1.11 S1-1) | W-6; T1.11 C-6, S1-1, P3-2; spike 10b DD4 | R1 |
| `budget` | `30` seconds, a floor, in `handoff.txt`. Its clock starts at the spawn, after the lock, so the lock's own time is outside it. After the old app's process is gone the stub releases the exe in 0.22–0.27 s and exits in 0.42–0.62 s (spike 1: 45 runs, both stub builds, NTFS, exFAT USB 3, exFAT USB 2); the 10 s acknowledgement wait ends as soon as `started` appears. Times are spike 1's; spike 8 gives the mechanism only (the stub exits last; T1.11 S8-6) | spike 1 DD1 | R1 |
| End of the app | `app.exit(0)`, never a graceful quit (a hung quit would keep the single-instance lock and swallow the apply's start, CE-D6) | W-6 | R1 |
| "Continue the update" | offered only while `updates/applying/` exists at a drive-aware start (F-19, §5.7); when the last valid `last-result.txt` line is `helper-blocked` for that version it is labelled "Try again on this computer" (not after the cap). After a failed spawn that removed `applying/` the same label sits on "Restart and update" instead, on this computer and boot, within the cap (§5.7; V-2). "Continue the update" runs the whole path above with these differences: no re-hash of a staged update and no policy gate (W-13: once `applying/` exists the policy no longer stops it), the pre-check still runs, the `finish-<n>` cap runs first, `handoff.txt` is rewritten (§5.3), an `apply.cmd` or `apply.sh` that is missing, or whose size or SHA-256 differs from its `staged.json` entry, is re-copied from `updates/staging/<version>/files/` (through `.tmp`, as above) when that folder holds it, `started` is deleted before the spawn, and it removes `applying/` only by the previous row. A script for the other system that is missing and cannot be re-copied does not stop it | W-6, F-19; L2-2, L2-4 | R1 |
| Kill-on-close job (accepted residual) | a detached spawn from Node never requests breakaway: inside a `KILL_ON_JOB_CLOSE` job the apply dies within ~25 ms of the job's close, even with `BREAKAWAY_OK` (spike 10 item 6, 4/4). Kit starts are in no such job (the start-file path is in no job; a double-click on the exe runs in a job with `BREAKAWAY_OK` only, without kill-on-close). It is the class "apply killed after `started`": `applying/` stays and rule 1 or "Continue the update" resumes (owner 2026-11-24, S-P1-11) | spike 10 DD5 | R1 |
| `update.log` events of the hand-off | `r1-app <os> <event> version=<v> [<field>…] t=<…>` with `<event>` one of `handoff-refused` (`reason=` `read-only`, `full`, `policy-managed`, `policy-invalid`, `damaged`, `lock-failed`, `working-copy-lost`, `not-drive-app`), `handoff-aborted` (the user's abort choice), `handoff-spawned`, `handoff-started` (`ms=<n>`, or `ack=stale`), `handoff-no-ack`, `handoff-failed` (`class=`), `applying-removed` (`reason=done` or `no-script`), each with `code=` when a message is shown (L1-20) | F-11, W-6 | R1 |

### 5.5 The apply script and its journal (table B.4; W-21)

The apply scripts ship in every update file and are replaceable, but frozen code starts them (F-6,
F-7) and they must converge on every state an R1 writer leaves. One on-disk state machine serves both
twins: an apply interrupted on Windows may be resumed by `apply.sh` on a Mac after the drive moved,
and the reverse (T7.10's shared fixtures).

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| Arguments | `apply.cmd <pid>` / `apply.sh <pid>` from the app; `apply.cmd resume` / `apply.sh resume` from a start file. The script never takes a path argument: root = its own folder's grandparent (`%~dp0..\..\`; bash `$(cd "$(dirname "$0")/../.." && pwd)`). With any other argument list, or from a folder that is not `<root>\updates\applying` with `<root>\config\drive.json` present (a double-click on a staged copy), it exits 0 having written nothing (L2-26 (a)) | F-6, F-7; L2-26 | R1 (R1 starts it so) |
| First action | create `updates/applying/started` (before the lock) | W-6 | R1 (R1 waits for it) |
| Lock, cmd | the whole run inside `9>"%~dp0apply.lock" (call :main %*)` (or a multi-line block with `)` on its own line; on one line `( … do rem )` swallows the `)` and cmd exits 255 without the lock, spike 10 item 4). A second instance tests `2>nul (9>>"%~dp0apply.lock" (call ))`: failure = a live holder. The handle dies with the process (kill, `taskkill /T /F`, unplug: no stale state). A console child of the holder would inherit handle 9 and keep the lock, so the apply starts no console program and starts the new app with `start` (a `start`ed child does not inherit it) | W-21; spike 10 DD6 (a) | Scripts |
| Lock, bash | `mkdir updates/applying/apply.lock.d` succeeds = taken; then `owner` is written (`pid <$$>`, `os <os>`, `boot <boot>`, `lstart <ps -p $$ -o lstart=>`). A failing `mkdir` with a readable `owner`: live when the PID is alive and `ps -p <pid> -o lstart=` equals `lstart`, whatever `boot` says (a clock step must not make a live lock stale; L2-24), provided `os` is this system; otherwise stale: remove the directory and take it. A lock folder with no readable `owner` is checked again after 1 s before it is called stale (the holder may be between `mkdir` and its write; L2-26 (d)). `LC_ALL=C` and `TZ=UTC` are exported before any `ps` (one live PID reads 01:11, 09:11 or 00:11 under three `TZ` values). cmd ignores `apply.lock.d`; bash ignores the `apply.lock` file | W-21 (GAP-5) | Scripts |
| Markers on the lock | a resume that finds a live holder deletes the highest-numbered `launch-<n>` (the one its start caused) and exits; the instance that takes the lock deletes every `launch-<n>` and `finish-<n>` (progress, W-7) | W-7, W-6 | Scripts (R1 counts on it) |
| Wait, Windows | **in J1, by a probe that moves nothing** (L2-13, L1-24; spike 1b): §5.6's write-open probe (`if exist "<x>" ( 2>nul (>>"<x>" (call )) \|\| set "HELD=1" )`) on every root artifact of this system, whatever its version, retried until all read "free", `budget × 250` attempts of a `for /l` delay (T7.2 records the measured rate of the loop it ships); the journal opens only after it succeeds, so a `timeout` always rests in J1 with nothing written but its line. It reads "held" from the stub's process creation to the stub's exit, never-seen first starts sandboxed for 71.7 s and 77.9 s included (spike 1b: 2,457 of 2,457 samples), so it also waits for a start of the old version that the buyer double-clicked during the apply; the rename retry it replaces would have moved the exe from under such a stub while the stub had not yet opened its file (0.57–10 s; spike 1b surprise b). A free probe implies the old app's process is gone and the stub's unpack folder deleted, for both stub builds (the folder was gone at the re-check right after the first successful rename in 18 of 18 starts, spike 1b; the order rests on electron-builder's `portable.nsi`). Exhausted → `timeout`. **The first move keeps a bounded retry** (T1.11 P3-4; script text, T7.2): a holder that shares read and write but not delete (a state in spike 1b's own table) lets the probe read "free" and fails the rename, so the apply's first move of a root artifact (the out-move (b) of `win32`, §5.5's move order) is retried with the same `for /l` delay for at most `budget × 250` attempts, judged by `if exist` on source and target; still failing → T-io-error with nothing moved (J3's rule). No spike ran an apply that waits with the probe and then moves (spike 10b's applies still waited by `ren`): T7.2 runs this wait in a detached apply against a real stub. Residual (known limitation, T7.D): a start that begins after the probe read "free" and before the apply's first move, while its stub process is created but has no handle yet, is not seen by the move that follows | spike 1 DD3; spike 1b; W-21; L2-13, L1-24; T1.11 P3-4 | Scripts |
| Wait, macOS and Linux | only when `handoff.txt`'s `os` is this system, its `boot` is within ±300 s of this computer's (`sysctl -n kern.boottime` / `/proc/stat` `btime`), the last `/`-separated part of `ps -p <pid> -o comm=` is `HilbertRaum` (`executableName`, pinned by W-15 (v)) and `ps -p <pid> -o stat=` does not start with `Z`; then while all of them hold, at most `budget` seconds (or longer, never shorter). Exhausted → `timeout`. The `stat` test (spike 4a DD2, Δ-39): a zombie, an exited app that its launcher has not reaped, keeps its `comm`, and without the test the wait ran 24 s and would have ended in `timeout`; with it the wait ended 63 ms after the exit. Measured on Linux (procps-ng 4.0.4; the probe's `comm` matched its executable's name in 150 of 150 records, and the runtime's and `AppRun`'s never did; the real app's `HilbertRaum` is P11a's spike 4b); macOS (`comm`, `stat`) pending spike 3 (P11a) | W-21; spike 4a DD2 | Scripts |
| Nothing to resume | in J1, after the wait and in place of writing `journal.txt`: a run that finds no `journal.txt` and no `done`, and either **no `handoff.txt`** (rule 1's `resume`; the wait then uses `budget` 30 and, on macOS and Linux, has no process to wait for) or a `handoff.txt` with **no `version` line** while `updates/staging/<its own version>/` does not exist (R1's rewrite in "Continue the update" when nothing is staged, §5.3), has nothing to resume: it creates `done` and runs the final line (below), `<artifact>` being the one root artifact of this system that the start file's root glob finds; with none or two, the line removes the folder and starts nothing, and the next start goes through rules 2–3. No `last-result.txt` line; `update.log` `result code=nothing-to-resume`. No state of table B.5 meets the condition: R1 writes `handoff.txt` before the scripts and "Continue the update" rewrites it, and J2 on holds `journal.txt`. The case (T1.11 P3-5): something holds `apply.cmd` at the final line's `rmdir`, which deletes `done`, `handoff.txt` and the journal and leaves the held script; R1's removal rule (§5.4) keeps a folder that holds a script, and without this rule rule 1 would resume it at every start until three markers exist while R1 offers "Continue the update" and refuses imports. T7.2's row: a folder holding only `apply.cmd`, resumed by rule 1 and by R1's continue, ends with the folder gone, the root's app started and no result line; the protocol model gains the state "`applying/` with only the scripts" (W-59; P7's re-run adds it). Plan-rule change 21 | W-21; T1.11 P3-5 | Scripts |
| Systems an apply moves | forward: each system whose `from-<os>` is not `none` (the apply installs only systems already on the drive, G-36); `back` and `fallback`: each system whose `from-<os>` is not `none` | W-21 | Scripts |
| Move order, per system | systems in the order `win32`, `darwin`, `linux`; for each: (a) forward only: delete from `previous/` every artifact of that system, a stale copy of `to` left there by an earlier fallback included (`to` comes from staging), so that after (b) `previous/` holds exactly the one artifact moved there (F-7/W-21: at most one artifact per platform; the protocol model found a later fallback picking the stale copy as its target, T1.8 stage 3); (b) **out**: move every root artifact of the system whose version is not `to` into `previous/` (a root `*.app` has no version and always moves); (c) **in**: if the root lacks `to` for the system, move it from its source: forward `updates/staging/<to>/files/` (the member the script's name table gives for that system, when `staged.txt` lists it, to the table's `install_as` name where there is one), `back` and `fallback` `updates/previous/`. Out first: a stop between (b) and (c) leaves an empty root, which rule 2 repairs, never two artifacts (CE-D9). `previous/` never receives an artifact of version `to`. Every move is `move /y` (cmd) / `mv -f` (bash), judged by the existence of source and target, never by an exit code | W-21 duty 3 | Scripts |
| Start files | a drive with no start file at the root (every `prepare-drive` drive) gets the new ones before any artifact moves; otherwise after the swap: each replaced start file moves to `previous/`, each new one is copied to `<name>.new` and renamed over the root name (never written in place). Each move is retried with the `for /l` delay for at least 2 s and judged by `if exist` (never by errorlevel; spike 10b DD2): with `LockBatchFilesWhenInUse` = 1 a start file is locked while it runs and while any process its `start` created runs, so on the Kit path the old version's stub holds it until a few ms after it releases the exe (the replacement failed 5–7 times after the exe's move, then succeeded; 0–42 ms after the holder's exit). At value 0 the rename succeeds at once even under a running start file, and that start file then reads on in the new file at its old offset (12 of 12; spike 10b part 2): the rename is not what keeps a start file safe. What does is that every start file hands over and ends inside one parsed block (rule 1 with its `(goto)` prefix; rules 2–3's `start` of the exe followed by the end of the file), and the apply runs only after that. Residual (not measured): a user who starts a start file by hand in the very milliseconds of its replacement could read mixed lines at value 0. When the bound runs out the apply keeps the start files it has, deletes `<name>.new`, logs `launcher-replace-deferred` and goes on to its terminal state (a failed replacement is never `io-error`). Then `step-launchers`. **What a deferral loses**: until the new version's reconcile installs its own start files from its bundle at its next start (§6.3), the drive starts with the old ones: release 1's frozen rules (rule 1, its counter, rules 2–3) keep working with any version, but the newer start files' rules (per-computer counts after a confirmation, the in-flight record on macOS and Linux, the fallback through the apply, the `blocked` and `restored` lines, a progress line per try) are absent | W-21; spike 10b DD2 | Scripts |
| Artifact versions from names | Windows `HilbertRaum-<v>-portable.exe`; macOS `HilbertRaum-<v>-mac-arm64.app.zip` (a root `*.app` is `unknown`); Linux `HilbertRaum-<v>.AppImage`. Root globs as R1's start files use them (F-18) | F-18 | R1 (the globs) |
| The new app's start | first the apply creates `updates/applying/done` inside its lock block (R1 removes a folder that holds it, §5.4, L2-4; an instance that finds `done` goes straight to the final line). **cmd, the final line**: after the lock block returns, at the script's top level, outside the `call :main` lock block (inside a `call`ed label `(goto)` only returns from the call), on one line:<br>`(goto) 2>nul & cd /d "<root>" & rmdir /s /q "<root>\updates\applying" & set "HILBERTRAUM_DRIVE_ROOT=<root>\" & set "HILBERTRAUM_MANIFESTS_DIR=<root>\model-manifests" & start "" "<root>\<artifact>"`<br>with `<root>` and `<artifact>` expanded from the apply's own variables when the line is parsed. The `cd /d` and both `set`s stand **after** the `(goto)`: its implicit `endlocal` restores the variables **and the current directory** the script's `setlocal` saved (the spawn's cwd `updates\applying`); with the `cd /d` before the line an empty `applying\` stayed (3 of 3) and the new exe started inside it (spike 10b part 2, v6). **The self-delete first, the start last** (spike 10b DD1): with `LockBatchFilesWhenInUse` = 1 cmd holds the running script through an inheritable handle and `start` hands it to the started process, so in the old order (start first) the new exe's stub held `apply.cmd` for its whole session and `rmdir /s /q` removed everything but `apply.cmd` (0 of the 18 runs that reached the line); `(goto)` closes cmd's own handle, and removing first, then starting, removed the folder in 34 of 34 runs (NTFS and exFAT, two roots, F-6, Kit-path and resumed applies, no console window). At `LockBatchFilesWhenInUse` = 0 this exact text (v7) removed the folder in 12 of 12 runs and delivered both variables 12 of 12 (NTFS and exFAT, two roots; spike 10b part 2). A non-terminal end (`timeout`) leaves the script before this line. **v7 at value 1: T7.2's test row** (its lock-relevant order was measured there as v5, 34 of 34; the line belongs to the replaceable scripts). **bash, the final step** (spike 4a DD3, Δ-39): after `done`, `cd "<root>"`, then the apply replaces itself with a fresh shell that holds no descriptor on `apply.sh` (bash's script descriptor is close-on-exec):<br>`exec "$BASH" -c 'rm -rf "$1"; exec "$2"' apply-final "<root>/updates/applying" "<root>/<artifact>"`<br>on Linux, and on macOS the same with `open "$2"` in place of `exec "$2"` and `"<root>/Start HilbertRaum.command"` as `$2`; with `HILBERTRAUM_DRIVE_ROOT` and `HILBERTRAUM_MANIFESTS_DIR` set as above and `APPIMAGE`, `APPDIR`, `OWD`, `ARGV0` and the old image's `$APPDIR` entries in `PATH`, `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR` removed (`rm -rf`: Finder's `._*` and `.DS_Store` may lie in the folder). Measured: the earlier text, an `rm -rf` from inside `applying/` and then the start, left an empty `updates/applying/` on FUSE exFAT (14 of 14) and drvfs (10 of 10), because bash holds `apply.sh` open and these file systems keep an open file's entry, and started the new app in a deleted folder (ext4, 22 of 22: `process.cwd()` throws, `OWD` unset) or in the left-over one (20 of 20); this form removed the folder 5 of 5 on ext4, FUSE exFAT and drvfs, with the new app's cwd and `OWD` the root. R1's removal rule (§5.4) stays the backstop: an empty folder holds no script, so it is "dead". The kernel exFAT driver is expected to behave like ext4 (P11a's spike 4b); macOS pending spike 3. T1.11 S10-2 is closed by spike 10b (§10.6) | W-21 (CE-1, GAP-1); spike 10b DD1; spike 4a DD3; T1.11 S10-2 (closed) | Scripts; the rule below is R1's |
| **CE-1 rule** | no journal state starts a start file, an app or a resume while `updates/applying/` exists; every terminal state (T-done, T-refused, T-io-error, T-aborted, and the scripts' T-nothing) creates `done`, then removes `applying/` and only then starts an app, on both systems (bash: the final shell's `rm -rf`, then `open` or `exec`; cmd: the final line above, removal before `start`); `timeout` is not terminal and starts nothing | W-21 (CE-1, duty 1); spike 10b; spike 4a | R1 (R1's rule 1 and R1's removal rule depend on it) |
| Name tables | the member names, their systems, their roles and their `install_as` names are constants the release tooling writes into the two scripts of that version (the scripts travel in the same signed file); `staged.txt` gives presence and size only; the draft check (§9.3) refuses a release whose scripts' table differs from the payload's `install_as` values (L1-13, L2-27) | L1-13, L2-27 | Scripts |
| A cut script does nothing | `apply.cmd`'s first line is `@goto :whole`; its last two lines are the label `:whole` and the jump to the real start, so a copy cut short ends at "label not found" before it runs a line (measured by lens 2: a missing label ends the script); `apply.sh`'s whole body is one function called on the last line (L1-15, L2-2) | L1-15, L2-2 | Scripts |
| cmd rules | ASCII only, CR LF (P7 adds `launchers/apply/*.cmd text eol=crlf` to `.gitattributes`); the head is `setlocal enableextensions disabledelayedexpansion` (L2-26 (b)), then `set "COPYCMD="`; only built-ins (`ren`, `move /y`, `if exist`, `set`, `>`/`>>`, `rmdir`, `for`, `call`, `start` of the GUI artifact): no console program at all (no `ping`, `timeout`, `tasklist`, `find`, `chcp`, `wmic`, PowerShell), since each opens a visible window from the detached cmd (spike 10 item 7: 4 windows for 3 `ping`s and a `chcp`); the delay is a `for /l` loop; every output line puts its redirection first (`>>"file" echo …`); a write whose result matters is read with `\|\|` on its line or `if exist` afterwards, never `if errorlevel` (a failed redirection leaves ERRORLEVEL unchanged, spike 1b); no pipeline; every wait and every retry is a `for /l` loop inside one parsed block wherever its body allows, not a `goto` loop: cmd re-reads the script file at every `goto`, and a script that something holds or replaces at that moment runs other lines or ends (spike 10b P2-5; T1.11 P3-5); never `start` a `.cmd` (it runs `%ComSpec% /K`: a window that never closes, and with a missing `ComSpec` the script ends there); with `LockBatchFilesWhenInUse` = 1, `>`/`>>` onto a locked script and `del` of it fail with errorlevel 0, and `ren`/`move /y` with errorlevel 1: only `if exist` judges them (spike 10b DD5 (e)); `(goto)` ends the script's `setlocal`, which restores its variables and its current directory, so whatever the commands after it need (variables, `cd /d`) is done on the same line after it (spike 10b DD5 (f)); nothing may query the Restart Manager about a running apply script (`RmGetList` makes it exit 1 within 46–132 ms at value 0: a test-harness rule for P7's kill-point matrix and T11.8; spike 10b DD5 (g)); a resume started by a start file inherits the start file's starting environment unfiltered (rule 1's `(goto)` drops what the start file set inside its `setlocal`, spike 10b DD3), so the `COPYCMD` rule is required; files cmd writes are in the ANSI code page (start files: OEM), so no line another script or the app parses carries a path; `for /f` only over a file of this section, never over a program's output; never `pause`, never parse JSON, never hash (C12) | W-21; spike 10 DD6 | Scripts |
| bash rules | a POSIX-sh preamble re-execs the script under bash when bash exists (the lookup may start it with `/bin/sh`); bash 3.2 syntax; closes every descriptor above 2 first (required: it releases the old AppImage's mount, §5.4; spike 4a); `LC_ALL=C` and `TZ=UTC` before any `ps`; `sync` after each journal step; gives the installed AppImage and start files their execute bit (`chmod +x`: the reader ignores ustar's mode and Node creates files without it; L2-26 (c)) | W-21; L2-26 | Scripts |
| `update.log` events | `apply-<version> <os> <event> [<field>…] <time>` with `<event>` one of `started`, `lock-busy`, `waited` (`attempts=` or `s=`), `journal`, `moved` (`os=`, `dir=out` or `in`), `launchers`, `result` (`code=`, `nothing-to-resume` included), `timeout`, `io-error`, `aborted`, `start` (`os=`) | F-11 | Scripts |

**The journal states (table B.5).** `<v>` is `handoff.txt`'s `version` (the apply's own), `to` and
`from-<os>` come from `journal.txt`.

| State | What is on disk | Who may resume it | Next |
|---|---|---|---|
| **J0 handed off** | `applying/` with `handoff.txt` and the copied scripts; no `started` | R1 rule 1; "Continue the update" (R1 or later); the version's own start (W-21 duty 6) | J1 |
| **J1 acknowledged** | J0 + `started`; no `journal.txt` | any instance that takes the lock | the wait (both systems), then: `fallback` with any `confirmed/<v>_*` present → **T-aborted**; forward with a carried system that staging lacks → **T-refused**; else write `journal.txt` → J2. Wait exhausted → `timeout` (stays J1) |
| **J2 journal open** | J1 + `journal.txt` | the lock holder | forward: write `unconfirmed.txt` (`<to> <token>`) unless any `confirmed/<to>_*` exists (CE-D5), read it back; failure → **T-io-error** with nothing moved. A drive without start files: install them, `step-launchers`. Then J3 |
| **J3 swapping** | J2 + some systems moved (root and `previous/` mixed, per the move order) | the lock holder, after a resume, on either system | a forward resume first writes `unconfirmed.txt` again when it is missing and no `confirmed/<to>_*` exists (L1-16, L2-5); each move done or skipped by version; a move that fails for good → **T-io-error**; all systems at `to` → J4 |
| **J4 swapped** | every moved system's root holds exactly `to`; no `step-launchers` | the lock holder | start files replaced, `step-launchers` → J5 |
| **J5 start files done** | J4 + `step-launchers` | the lock holder | forward: `applied/<to>.json`, `applied/<to>.dsse.json` (a copy of `updates/staging/<to>/hilbertraum-release.dsse.json`); append the result line (`applied` forward, `went-back` back, `fallback` fallback; version `<v>`); `back` and `fallback`: remove `confirmed/<v>_*`, `unconfirmed.txt` when it names `<v>`, and `launch-count.txt`; then `step-result` → J6 |
| **J6 recorded** | J5 + `step-result` | the lock holder | create `done`; forward: remove `updates/staging/<to>/` whole (the unused members of other systems included, L1-12); the start → **T-done** |
| **timeout** (not terminal) | J1 + a `timeout <v> <token>` line (both systems wait in J1) | the next start (rule 1, "Continue the update") | J1 |
| **T-done** | `applying/` gone; root at `to`; the line written | — | the new version starts (forward) or the target starts (`back`, `fallback`) |
| **T-refused** | `applying/` gone; nothing moved; `incomplete <v> <token>` | — | the root's version starts and shows the notice |
| **T-io-error** | `applying/` gone; moves made so far reversed by version (`to` out, each `from-<os>` back in), `unconfirmed.txt` removed when it names `to`; `io-error <v> <token>` | — | the root's version starts and shows the notice |
| **T-aborted** | `applying/` gone; nothing moved, no line | — | the root's version starts (W-21 duty 5, CE-D1) |
| **T-nothing** | `applying/` gone; nothing moved, no line (§5.5 "Nothing to resume"; T1.11 P3-5) | — | the root's one artifact of this system starts; none or two: nothing starts |

Every terminal state (T-done, T-refused, T-io-error, T-aborted, T-nothing) creates `done` before its
start and removal, so a removal cut short leaves a folder R1 recognises and removes (§5.4, L2-4).
A version that starts with its own `applying/` present (killed after the swap, then a bare start)
continues it through its own resume (the F-6 path), and removes `applying/` itself only in J6, when
every system the journal names is at `to` (W-21 duty 6, CE-D10). A reverse apply that finds its swap
already done (J4 or later) never moves anything back in (CE-D4).

### 5.6 The start files (table B.6; F-7)

**The order** in release 1's three start files, after the root and the two variables are set:
(0) `/check` (`--check` in bash): today's flow, unchanged (the refusals for no app and two apps print
and exit 1 without a pause; else the report and exit 0), with rule 1, the counter and rule 2 skipped and
nothing started, moved or written; the `Update log :` lines follow the `App        :` line (L1-22);
(1) rule 1; (2) the counter; (3) rule 2; (4) rule 3, the #235 refusal; (5) start the root's
app as today. The `.cmd`'s head is `setlocal enableextensions disabledelayedexpansion`, then
`set "COPYCMD="` (W-7 (c)).

**Rule 1, `Start HilbertRaum.cmd`** (frozen text: spike 10 DD2, 11 roots × NTFS and exFAT, ShellExecute
and `explorer.exe`, the read-on probe showing no line read after the `start`; plus spike 10b DD3's
`(goto) 2>nul & ` prefix on the `start`, confirmed at `LockBatchFilesWhenInUse` = 0 on spike 10's whole
matrix, 12 roots × NTFS and exFAT × ShellExecute and `explorer.exe` with the read-on proof: 0 of 136
starts differ from spike 10's results, `%PATH%` failing as before; and at 1, 4 of 4). The
Japanese-locale VM leg (P11a, owner 2026-11-24, Δ-30; T1.11 S10-3) re-runs it.

```
set "N="
if exist "%~dp0updates\applying\apply.cmd" (
  if not exist "%~dp0updates\applying\launch-1" (set "N=1") else if not exist "%~dp0updates\applying\launch-2" (set "N=2") else if not exist "%~dp0updates\applying\launch-3" set "N=3"
)
if defined N (
  >"%~dp0updates\applying\launch-%N%" type nul
  if exist "%~dp0updates\applying\launch-%N%" (
    (goto) 2>nul & start "" /min /d "%~dp0updates\applying" "%SystemRoot%\System32\cmd.exe" /d /c .\apply.cmd resume
    exit /b 0
  )
)
```

Why the prefix (spike 10b DD3): with `LockBatchFilesWhenInUse` = 1 the resume inherited the start file's
handle on itself from rule 1's `start`, held it for its whole run, and so could never replace the start
file it was started from (0 of 17) and passed the handle on to the new version's stub; `(goto)` closes
that handle before the `start` (the count unchanged 16 of 16, the start file replaced at the first try 4
of 4, `applying\` gone 4 of 4). Measured side effect: the resume gets the start file's starting
environment, not the variables it set inside its `setlocal` (the apply needs none of them: it finds the
root from its own place and clears `COPYCMD` itself).

**The fall-through**, right after that block, when `"%~dp0updates\applying\"` exists: one `update.log`
line `r1-launcher win32 launcher-fallthrough reason=<r> code=UPD-LAUNCH-FALLTHROUGH d="%date% %time%"`
with `<r>` = `no-script` (no `apply.cmd`), `marker-not-created` (`N` defined: a read-only or full
drive) or `markers-used` (three markers), then the message `UPD-LAUNCH-FALLTHROUGH` (below), no pause,
and on to the counter. Known limit (W-7 (e), spike 10): under a drive path holding `%<a defined
variable>%`, or `!` with `^` on a host with `DelayedExpansion=1`, no line of any `.cmd` start file runs;
the app, started as the bare exe, finishes the update through "Continue the update".

**Rule 1, `start-hilbertraum.sh` and `Start HilbertRaum.command`** (from W-7; `$DIR` is the root as both
files set it today). `start-hilbertraum.sh`'s text is measured (spike 4a DD4, Δ-39: WSL2 Ubuntu 24.04,
the packaged static-runtime AppImage, two roots, the start file run as a terminal's session leader, by
a shell inside a terminal and with no terminal: 6 of 6); the `.command`'s is **provisional until P11a's
spike 3** (macOS). What spike 4a showed on Linux, against the acceptance lists of lens 1 and L2-20: the
detached child outlives the app's exit and the AppImage's mount going away (52 of 52); the `/bin/sh`
path with no bash (dash) still reaches `started`; a `noexec` exFAT mount still runs `<sh> ./apply.sh`
(though no AppImage starts from it, §11.3); the old mount is released after the app exits once
`apply.sh` closes its inherited descriptors, and a still-mounted image moves; the probe's
`ps -o comm=` was exactly its executable's name (a helper process or `AppRun` never matched), and a
zombie is caught by the `stat` test (§5.5); Node's `boot` was within 1 s of `btime` at rest. Rule 1 as
first tabled failed when the start file leads a terminal's session (a terminal or file manager that
runs the file itself): its `exit 0` hung up its process group before `nohup` had run (0 of 4 resumes),
and the app a resume started died at the terminal's next hangup even with `nohup` (0 of 2). The
`trap '' HUP` line fixes the first, `setsid` the second (6 of 6); without `setsid` (the `else` branch,
and macOS, which has no `setsid(1)`) the resume survives, but the app it starts stays in the terminal's
session. Still open: on Linux kernel exFAT (`showexec`), a real terminal emulator's window close, the
real app's `comm`, and `boot` after a sleep and a clock step (P11a's spike 4b); on macOS the closing of
the Terminal window (`nohup` in the start file's process group is the whole protection there), `comm`,
`stat` and `kern.boottime` (spike 3).

`start-hilbertraum.sh`:

```
N=""
if [ -f "$DIR/updates/applying/apply.sh" ]; then
  for n in 1 2 3; do
    if [ ! -e "$DIR/updates/applying/launch-$n" ]; then N="$n"; break; fi
  done
fi
if [ -n "$N" ] && : > "$DIR/updates/applying/launch-$N" 2>/dev/null && [ -e "$DIR/updates/applying/launch-$N" ]; then
  SH=/bin/sh
  for c in /bin/bash /usr/bin/bash; do if [ -f "$c" ] && [ -x "$c" ]; then SH="$c"; break; fi; done
  trap '' HUP
  if command -v setsid >/dev/null 2>&1; then
    (cd "$DIR/updates/applying" && setsid nohup "$SH" ./apply.sh resume </dev/null >/dev/null 2>&1 &)
  else
    (cd "$DIR/updates/applying" && nohup "$SH" ./apply.sh resume </dev/null >/dev/null 2>&1 &)
  fi
  exit 0
fi
```

`Start HilbertRaum.command` (**provisional until P11a's spike 3**): the same block, with these two
lines in place of the six from `trap '' HUP` to `fi`:

```
  trap '' HUP
  (cd "$DIR/updates/applying" && nohup "$SH" ./apply.sh resume </dev/null >/dev/null 2>&1 &)
```

Each is followed by the same fall-through
(`r1-launcher <os> launcher-fallthrough reason=<r> code=… t=<UTC>`, the message, on to the counter).
bash reads the whole `if … fi` compound before it runs it, so, as in the `.cmd`, no line after the block
is read once the resume is started.

**The counter** (frozen in release 1; F-7, W-7 (d), (d0), T7.11):

| Value | Exact value |
|---|---|
| When it acts | all of: `updates/applying/` absent; `updates/unconfirmed.txt` has a valid first line whose version (`UV`) consists only of `[0-9A-Za-z.+-]` (any other version: the counter does nothing; the app removes the file, §5.7); the root holds exactly one artifact of this system, and it **carries `UV`** (§4.4). Otherwise this system is not on the unconfirmed version: no count, no message, no pause (L2-28) |
| In flight, Windows | the root artifact (`%APP%`, the full path today's start file finds with its root glob) is held: an instance of this drive's app is running or starting → no count (`counter-skip reason=in-flight`), go on. Frozen text, the probe spike 1b measured inside an `if exist` guard:<br>`set "INFLIGHT="`<br>`if exist "%APP%" (`<br>`  2>nul (>>"%APP%" (call )) \|\| set "INFLIGHT=1"`<br>`)`<br>The failure is read **only** with `\|\|` on the same line: a failed redirection leaves ERRORLEVEL unchanged, so `if errorlevel 1` after it reads 0 while the exe is held (spike 1b). The `if exist` guard means the probe can never create a 0-byte `HilbertRaum-…-portable.exe` (which `>>` does when the file is absent; two root artifacts would then end in rule 3 for ever; spike 1b surprise d, L2-19); with no file it reads "not in flight", and the counter only acts on a root that holds this one artifact anyway. A read-only drive and an exe held by a scanner read "in flight", so no count: the intended, safe side. **Measured** (spike 1b, T1.1b; Electron 43.8.10, electron-builder 26.18.0, stub builds A and B, NTFS and exFAT USB 3, Norton on): the line fails from the stub's process creation to the stub's exit in 2,457 of 2,457 samples over 18 starts, two never-seen first starts that Norton sandboxed for 71.7 s and 77.9 s included; the stub's mapped image refuses a write-open even while Norton holds the process with no handle (0.6–35 s), and the stub's own handle shares read only; it succeeds only before the stub's process exists (21–143 ms after the start request) and after the stub's exit; it changed neither the exe's hash nor its `LastWriteTime`, and all 18 starts reached their window. A rename or DELETE-open test is **not** equivalent: it passes while a new stub has not opened its exe (0.57–1.08 s on known builds, up to 9.8 s on a never-seen one). Residual (known limitation, T7.D): two start files whose probes both run before the first one's stub process exists (≤ 0.15 s under Norton) both count, one extra count at most; no launcher lock is added for it (frozen surface for a sub-second race in a state release 1's start files rarely meet). **What the evidence covers** (T1.11 P3-1): from the stub's process creation on, the probe reads "held" because Windows refuses a write-open of a file mapped as a running image (and then because of the stub's own share-read handle), whatever the antivirus; the 16 known-build starts show the same. The time **before** the process exists is the antivirus's and was measured for Norton only (≤ 0.15 s: Norton lets the process be created, then holds it). Defender, SmartScreen and Smart App Control judge a new exe before or during its process creation, and while no process and no handle exist the probe reads "free", so impatient starts in that time count. **PC D row pending** (P11a, T11.3a): `run-inflight.ps1` from the click, a never-seen build, started through the start file; pass = no "free" sample after the stub's creation, and the time before it reported; the freeze holds on the condition that this run can still reopen this text before the M1 commit. Not measured either: a USB 2 root. T1.11 S1-2 is closed by spike 1b DD1, with that condition |
| In flight, macOS and Linux | no probe in release 1 (CC-20); later start files keep `updates/starting-<os>` |
| The apply's own start | Windows and Linux: never counted, the apply starts the artifact. macOS: the apply opens `Start HilbertRaum.command` (which unpacks the zip, §5.5), so when release 1's `.command` is still at the root (a deferred replacement) that start is counted once; pending spike 3, which decides the macOS final step with this in view (T1.12 review R-2, V-3) |
| Count | `n` = `launch-count.txt`'s count for `UV` (§5.3) + 1, at most 3, rewritten as `<n> <UV>`; a failed write means no count, read with `\|\|` on the writing line (`>"%~dp0updates\launch-count.txt" echo %N% %UV% \|\| set "NOCOUNT=1"`; bash `printf … > "$f" \|\| NOCOUNT=1`), never with `if errorlevel`; log `counter n=<n> version=<UV>` |
| Write results in the start files | every frozen start-file line that must know whether a write succeeded reads it with `\|\|` on that same line or with `if exist` afterwards, never with `if errorlevel` or `%errorlevel%` (a failed redirection leaves ERRORLEVEL unchanged; spike 1b). Rule 1 (`if exist` on the marker), rule 2 and the counter fallback's moves (`if exist` on source and target) and the fallback line (`\|\|`) follow it; `update.log` writes ignore failure |
| At `n` = 3 (i) | any `updates/confirmed/<UV>_*` exists → message `UPD-LAUNCH-CANT-START`, log `counter-stop reason=confirmed version=<UV> code=UPD-LAUNCH-CANT-START`, on to rule 2 (T7.11, CE-F5) |
| At `n` = 3 (ii) | else, when `updates/previous/` holds exactly one artifact of this system and it does not carry `UV` → **the counter fallback**: (1) append `fallback <UV> <token>` to `last-result.txt` (after an empty line, G0; the token `%RANDOM%%RANDOM%%RANDOM%` / `$RANDOM$RANDOM$RANDOM`; a failure, read with `\|\|` on the appending line, ends here, nothing moved); (2) move the root artifact into `previous/`; (3) move the other one from `previous/` to the root (rule 2 finishes a torn (3) at the next start); (4) delete `unconfirmed.txt` and `launch-count.txt`; log `counter-fallback version=<UV>`; prints nothing; on to rule 2. This is how "never a version newer than the root's" is kept without comparing versions in cmd: the counter restores only away from the version `unconfirmed.txt` names, and only a forward apply writes that file, naming a version it installed over the one it moved into `previous/` |
| At `n` = 3 (iii) | else → message `UPD-LAUNCH-NOTHING-TO-RESTORE`, log `counter-stop reason=nothing-to-restore version=<UV> code=UPD-LAUNCH-NOTHING-TO-RESTORE`, on to rule 2 |
| Pause | cmd: `pause` after `UPD-LAUNCH-NOTHING-TO-RESTORE` and after `UPD-LAUNCH-CANT-START`, then the start; the message and its `pause` stand inside step (5)'s block, right before its `start` ("Every path ends in one parsed block", below; the log line is written at the counter); none after the fall-through (the app that starts next offers "Continue the update"); the bash files never wait (Terminal keeps its window) (owner 2026-11-24, Δ-31) |

**Rule 2** (frozen): the root has no artifact of this system and `updates/previous/` holds one or more
(by the system's root glob applied to `updates/previous/`): the one to restore is the only one; with two
or more, the only one whose name does not carry `unconfirmed.txt`'s version (§4.4); and when there is no
`unconfirmed.txt`, or no single one outside its version, **the first one the start file's glob lists**:
cmd's `for %%f in ("%~dp0updates\previous\HilbertRaum-*-portable.exe")` (NTFS lists in name order, exFAT
in directory order), bash's `for f in "$DIR"/updates/previous/<glob>` (sorted by the shell). Never "no
restore" (owner 2026-11-24, after the protocol model found that an empty root then has no way back, T1.8
stage 3). Either pick yields an app that starts: `previous/` holds only versions that ran on this drive,
and a version marked failed is never there as the unique alternative, because the counter and the
fallback pick away from `unconfirmed.txt`'s version first. The same rule holds in later start files. It
is moved to the root (`move /y`, judged by
`if exist` on source and target); if the move fails (a read-only drive mid-swap), the start file starts
it where it lies in `updates/previous/`, with `HILBERTRAUM_DRIVE_ROOT` and `HILBERTRAUM_MANIFESTS_DIR`
set as for a root start (W-7 (d0)). Log `launcher-restore` or `launcher-restore-in-place`. It prints
nothing and writes no `last-result.txt` line (later start files write `restored`, W-7).

**Rule 3** (frozen): two or more root artifacts of this system → today's #235 refusal, unchanged, then
two added lines (UX-20, below), `pause` (as today), exit 1; log `launcher-two-apps`.

**Every path ends in one parsed block** (frozen in release 1's `Start HilbertRaum.cmd`; T1.11 P3-7,
plan-rule change 22). At `LockBatchFilesWhenInUse` = 0 a running start file that is replaced by
rename reads on in the new file at its old byte offset (spike 10b part 2, 12 of 12), so release 1's
`.cmd` never reads a line of itself after a moment in which an apply may replace it. The rule for
T7.4a: **every `pause` and every `start` in the file stands inside one parenthesised block that cmd
parses whole before it runs it, and that block's last command is `exit /b <code>`; every path ends
with `exit /b`, and no path reads a line after the block it ends in.** Exactly:
- rule 1: the block above (`start`, then `exit /b 0`), unchanged;
- the start of the root's app, step (5): today's two lines `start "" "%APP%"` and `endlocal` (the
  last two of the file) become

  ```
  (
    start "" "%APP%"
    exit /b 0
  )
  ```

  (`exit /b` ends the `setlocal` as `endlocal` did);
- rule 2's start in place (its move failed): the same block, with the artifact's path in
  `updates\previous\` and the two variables set inside it before the `start`;
- the counter's messages (i) and (iii) and their `pause`: printed inside the block of step (5), before
  its `start`. The counter sets which one (a variable it sets before
  that block is parsed), and the block prints it with `if "%<variable>%"=="<value>" ( … )`; table B.7's
  character rule keeps the lines safe inside a block. The output and its order do not change: after
  counter (i) or (iii) neither rule 2 nor rule 3 acts, since the counter acts only on a root that holds
  exactly one artifact of this system, rule 2 only on none and rule 3 only on two or more;
- the refusals (no app; rule 3's two apps): today's `if … ( … )` blocks already end with `pause` (when
  not `/check`) and `exit /b 1`; rule 3's two added lines go inside that block, before its `pause`;
- `/check` and the fall-through message: no `pause` and no `start`, so they read on line by line as
  today; `/check` ends with `exit /b 0`.

The bash files need no such rule: the apply replaces them by rename (§5.5), and a running `bash` keeps
reading the old file through its open descriptor.

**The lines release 1's start files print** (table B.7). ASCII English, two spaces of indent, at most
76 characters per line, no `(`, `)`, `&`, `|`, `<`, `>`, `^`, `%`, `!` or `"` (so a line is safe inside a
cmd block), an empty line before and after each message, each message ending with
`See READ ME FIRST.txt on the drive.`; the same text in all three files; English only, with the
German steps in `READ ME FIRST.txt`'s UPDATES block (T7.D) (owner 2026-11-24, Δ-31; C10).

| Code (logged) | When | Exact lines |
|---|---|---|
| `UPD-LAUNCH-FALLTHROUGH` | rule 1 fell through | `  The update in progress could not continue from here.`<br>`  Your workspace is unchanged. See READ ME FIRST.txt on the drive.` |
| `UPD-LAUNCH-NOTHING-TO-RESTORE` | counter (iii) | `  HilbertRaum did not open properly after three tries, and no earlier`<br>`  version on this drive can be started instead.`<br>`  Your workspace is unchanged. See READ ME FIRST.txt on the drive.` |
| `UPD-LAUNCH-CANT-START` | counter (i) | `  This version of HilbertRaum did not open properly after three tries,`<br>`  but it has opened before. Use the computer where it opened.`<br>`  Your workspace is unchanged. See READ ME FIRST.txt on the drive.` |
| (no code) | rule 3, after today's refusal text | `  If this appeared after an update, do not delete anything yet.`<br>`  See READ ME FIRST.txt on the drive.` |
| (no code) | `/check`, after today's `  App        : …` line | `  Update log :` followed by `updates/update.log` verbatim (cmd `type`, bash `cat`), or `  Update log : none on this drive` |

Every other line the three files print is today's text at `95e05214`, unchanged (`Start HilbertRaum.cmd`
`:35-39`, `:47-54`, `:62-68`; the `.command` `:53-57`, `:66-76`, `:81-91`, `:100-103`, `:129`,
`:140-150`, `:156-160`, `:179-188`, `:207-211`, `:222-226`, `:240-244`; `start-hilbertraum.sh` `:36-39`,
`:46-55`, `:60-66`).

### 5.7 Confirmation and the offers at a start (table B.8; F-22, F-19)

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| When an app confirms | when its first window shows ("window up", not the process start), per system, before anything else changes (W-26) | F-22 | R1 (T7.5a) |
| `applying/` exists | after §5.4's rule for a finished or dead `applying/` (a folder it removes counts as absent): nothing recorded and nothing removed: no `confirmed/` file, no count reset, no `drive-release.json` write, and neither `unconfirmed.txt` nor `launch-count.txt` deleted, stale or not (a forward apply writes `unconfirmed.txt` in J2 before the new version is at the root; L1-16, L2-5); "Continue the update" is offered | F-22 (PA-241); L1-16, L2-5 | R1 |
| `unconfirmed.txt` names this app's version `V` | create `updates/confirmed/V_<os>` (empty); delete `updates/launch-count.txt` and every `updates/launch-count-*.txt`; when every system with a root artifact has its `confirmed/V_<that os>`, delete `unconfirmed.txt`; when this start created `confirmed/V_<os>` newly, show `UPD-UPDATED` once; log `confirmed version=V` | F-22, W-26 (C-6); L1-20 | R1 |
| `unconfirmed.txt` is stale | only while `updates/applying/` is absent: when no root artifact of any system carries its version (§4.4) and no root `*.app` exists, delete it and `launch-count.txt`; a damaged `unconfirmed.txt` (§5.3) is deleted the same way, after a read that succeeded; log `unconfirmed-stale` | F-22; L1-16, L2-5, L2-11 | R1 |
| Which systems "have a root artifact" | by R1's root globs: `win32` `HilbertRaum-*-portable.exe`; `darwin` a `*.app` folder or `HilbertRaum-*-mac-arm64.app.zip`; `linux` `HilbertRaum-*.AppImage` | F-18 | R1 |
| A write that fails | nothing changes; the next start tries again | F-22 | R1 |
| R1 and `drive-release.json` | R1 never writes it, so R1's confirmation writes no `app_version` (F-13); a later version writes it after its own confirmation (§6.9) | F-13 | R1 |
| "Restart and update" offered | a staged update (table A: a valid `staged.json` and every listed file present) whose version passes F-4 for the running version, is not named by the last valid `last-result.txt` line with a code outside `applied`, `cleared`, while `updates/applying/` is absent. A `helper-blocked` line with another `os`, or a `boot` more than 300 s from this computer's, does not count as naming it (another computer, or a restart since, gets the offer again; L2-14; owner 2026-11-24, §5.12 question 5). Nor does a `helper-blocked` line of this computer and boot while the failed-hand-off count is 1 or 2 (§5.4 (d)): the offer is then labelled "Try again on this computer" and is the button of the `helper-blocked` notice (V-2, owner 2026-11-24, §5.12 question 9); at 3, nothing is offered on this computer until a restart, another computer or a re-import. This is the one limit of §5.4: at most three hand-offs per computer and boot, whichever record counts them | F-19, W-51; L2-14; V-2 | R1 |
| A re-import clears the mark | when a commit stages version `v` (table A) and the last valid `last-result.txt` line names `v` with a code outside `applied`, `cleared`, R1 appends `cleared <v> <token>` (the plan's "clears that version's mark" in a file nothing deletes; the model writes the same line) | W-5, F-20 | R1 |
| An import while `applying/` exists | refused before the file is read: `UPD-IN-PROGRESS`, with "Continue the update" offered | F-5, F-19 | R1 |
| Older than the drive | a root artifact of this system whose name carries a version newer than the running one (F-4 order; a root `*.app` never counts) → `UPD-OLDER-THAN-DRIVE` with Quit as the action, writing nothing; checked at a drive-aware start before `ensureWorkspaceDirs` and `workspace.init()`, on `second-instance`, on `activate` and before unlock | F-19, W-51 | R1 |
| One notice at a time | priority: a hand-off or apply failure (`helper-blocked`, `io-error`, `timeout`) > an outcome (`fallback`, `blocked`, `restored`, `incomplete`, `went-back`, an unknown code) > an offer ("Continue the update", "Restart and update", older than the drive) > a reminder (G-37 (a)); each shown notice is logged `r1-app <os> notice code=<UPD-…> t=<…>` (L1-20) | W-51 (a); L1-20 | R1 |

### 5.8 Outcome codes and reference codes (table B.9; F-20, G-37)

**`last-result.txt` codes.** The version field is always the apply's own version (`handoff.txt`'s
`version`), also for `fallback` and `went-back`, so "don't offer again" names the version that failed or
was left.

| Code | Writer | Release 1 shows | Offer again? |
|---|---|---|---|
| `applied` | a forward apply, in J5 | nothing (the new version shows `UPD-UPDATED` at its confirmation) | yes (success) |
| `cleared` | R1's app, at a re-import of a marked version (§5.7) | nothing | yes (success) |
| `fallback` | a later version's fallback apply (J5); R1's counter fallback (§5.6) | `UPD-FALLBACK`; `UPD-FALLBACK-AGAIN` when the `fallback` and `blocked` lines naming that version number two or more in the 65,536 bytes R1 reads (F-20) | no |
| `went-back` | a reverse ("Go back") apply, in J5 | `UPD-WENT-BACK` | no |
| `incomplete` | a forward apply (T-refused) | `UPD-INCOMPLETE` | no |
| `timeout` | an apply whose wait ran out (not terminal) | `UPD-TIMEOUT` | no |
| `io-error` | an apply after its rollback (T-io-error) | `UPD-IO-ERROR` | no |
| `helper-blocked` | R1's app (a failed spawn, no acknowledgement, the `finish-<n>` cap), with `os=<os> boot=<boot>` | `UPD-HELPER-BLOCKED`, with the button "Try again on this computer": "Continue the update" while `applying/` exists, "Restart and update" when the failed spawn removed it; neither after the cap (§5.4) | on this computer and boot only through "Try again on this computer", within the cap (V-2, owner 2026-11-24, Δ-41); on another computer or after a restart, yes (§5.7; owner 2026-11-24) |
| `blocked` | a later start file, when starting the app returns access-denied or a code-integrity error | `UPD-BLOCKED` | no |
| `restored` | a later start file's rule 2 after a confirmed update | `UPD-RESTORED` | no |
| any other code | a later writer | `UPD-UNKNOWN-RESULT` (the generic copy with `{code}`) | no |

**Reference codes** (G-37 (a), W-51 (b)). Each frozen update message has one code, never reused for
another message: `UPD-` followed by upper-case words of `[A-Z0-9]` joined by `-`, at most 32 characters.
The app shows it as the muted last line "Reference: UPD-…" inside "Details for support"; `update.log`
records it as `code=UPD-…` (P6 and P7 register `code` as a closed list of this table's codes, §5.3,
CF-41); the project page has one anchor per code. Each message has two copy keys,
`<prefix>.text` (the message) and `<prefix>.help` (its in-app "What you can do" paragraph, G-37 (c));
their texts are copy deck part 2's (T1.10; the English sources of the outcome codes are in the plan's
working papers). The start files' three codes have no copy key: their text is §5.6's.

| Code | Message | Copy key prefix |
|---|---|---|
| `UPD-UPDATED` | "Updated to version {n}", once, at the confirmation | `updates.outcome.updated` |
| `UPD-FALLBACK` | the new version didn't start; the previous one is back; "Try again" | `updates.outcome.fallback` |
| `UPD-FALLBACK-AGAIN` | the second `fallback` of one version: security settings may be the cause | `updates.outcome.fallbackAgain` |
| `UPD-WENT-BACK` | back on the version the user chose | `updates.outcome.wentBack` |
| `UPD-INCOMPLETE` | the update file lacks a system this drive carries | `updates.outcome.incomplete` |
| `UPD-TIMEOUT` | the previous version didn't close in time | `updates.outcome.timeout` |
| `UPD-IO-ERROR` | the drive couldn't be written during the update | `updates.outcome.ioError` |
| `UPD-HELPER-BLOCKED` | the update couldn't start on this computer | `updates.outcome.helperBlocked` |
| `UPD-BLOCKED` | this computer's security settings stopped the new version | `updates.outcome.blocked` |
| `UPD-RESTORED` | the newer version's files were missing; the previous version started | `updates.outcome.restored` |
| `UPD-UNKNOWN-RESULT` | the last update attempt didn't finish (code `{code}`) | `updates.outcome.unknownResult` |
| `UPD-RESTART` | the restart dialog (what happens, how long, don't unplug) | `updates.restart.dialog` |
| `UPD-RESTART-TASK-RUNNING` | text recognition or a translation is running or waiting | `updates.restart.taskRunning` |
| `UPD-RESTART-UNSAVED` | changes that couldn't be saved | `updates.restart.unsaved` |
| `UPD-FILE-DAMAGED-ON-DRIVE` | the staged update was damaged on the drive (found by the re-hash before the restart or by the start-up sweep, §4.5) | `updates.restart.damagedOnDrive` |
| `UPD-NOT-DRIVE-APP` | this copy isn't the drive's app: start HilbertRaum on the drive to install this update (§5.4) | `updates.restart.notDriveApp` |
| `UPD-DRIVE-READ-ONLY` | the drive can't be written (pre-check at the import and the restart) | `updates.drive.readOnly` |
| `UPD-DRIVE-FULL` | the drive is full (pre-check at the import and the restart) | `updates.drive.full` |
| `UPD-READY` | a staged update: "Restart and update" and "Don't install this update" | `updates.offer.ready` |
| `UPD-CONTINUE` | an update in progress: "Continue the update" | `updates.offer.continue` |
| `UPD-IN-PROGRESS` | an import while an update is in progress | `updates.import.inProgress` |
| `UPD-OLDER-THAN-DRIVE` | this drive was updated to version {n}; start it on the drive | `updates.offer.olderThanDrive` |
| `UPD-POLICY-MANAGED` | updates are managed by your organization (`readUpdatePolicy`'s `install: managed`, §8.1) | `updates.policy.managed` |
| `UPD-POLICY-INVALID` | the update policy on this drive has an invalid value (`install: invalid`) | `updates.policy.invalid` |
| `UPD-POLICY-UNREADABLE` | the policy file is unreadable (the import stays allowed; `file: unreadable`: missing on a prepared drive, or damaged; a root with neither `policy.json` nor `drive.json` reads `none` and shows nothing) | `updates.policy.unreadable` |
| `UPD-NOT-AN-UPDATE` | not an update file | `updates.import.notAnUpdate` |
| `UPD-NOT-GENUINE` | the signature doesn't verify | `updates.import.notGenuine` |
| `UPD-TOO-NEW` | `UpdateTooNew`: a newer format or container, over a cap, the `HRUPDATE` prefix (§2.3, §4) | `updates.import.tooNew` |
| `UPD-UNKNOWN-SIGNER` | signed with a newer key: install the in-between update first | `updates.import.unknownSigner` |
| `UPD-NEEDS-IN-BETWEEN` | `min_upgrade_from` above the running version | `updates.import.needsInBetween` |
| `UPD-SAME-OR-OLDER` | the same or an older version than this one, or below the drive's version (F-4) | `updates.import.sameOrOlder` |
| `UPD-ABOVE-MAX-VERSION` | above `updates.max_version` (`updateInstallVerdict`'s `above-max`) | `updates.import.aboveMaxVersion` |
| `UPD-OS-TOO-OLD` | this computer is below the update's OS floor (G-24) | `updates.import.osTooOld` |
| `UPD-CANT-CHECK-LINUX-FLOOR` | this update's Linux requirement can't be checked: its `linux` floor doesn't parse, or, on Linux, this computer's glibc version can't be read (G-24, fail closed, §2.4) | `updates.import.cantCheckLinuxFloor` |
| `UPD-WRONG-CHANNEL` | not a release for this drive (G-22) | `updates.import.wrongChannel` |
| `UPD-FOR-NEWER-HILBERTRAUM` | a signed HilbertRaum file of another kind (G-30) | `updates.import.forNewerHilbertRaum` |
| `UPD-DOWNLOAD-INCOMPLETE` | the file ends before a listed member (F-16) | `updates.import.downloadIncomplete` |
| `UPD-FILE-DAMAGED` | the file's container or a member's hash doesn't match its signed list (§4.7) | `updates.import.damaged` |
| `UPD-FILE-TOO-BIG-FOR-DRIVE` | the drive can't hold a file this large (`EFBIG`: FAT32 and a member of 4 GiB or more) | `updates.import.fileTooBigForDrive` |
| `UPD-CANT-READ-FILE` | the update file couldn't be read (its stick or share went away, a read error; L1-5) | `updates.import.cantReadFile` |
| `UPD-CANT-WRITE-DRIVE` | the drive couldn't be written while the update was copied (any write, move or remove error but a full drive and a too-large file; L1-5) | `updates.import.cantWriteDrive` |
| `UPD-PATH-TOO-LONG` | on Windows the drive's folder is too deep for the update: move the HilbertRaum folder closer to the top of the drive (L2-18) | `updates.import.pathTooLong` |
| `UPD-NO-HELPER` | no apply script for this system in the file | `updates.import.noHelper` |
| `UPD-NOT-AVAILABLE` | updates are not available in this build (an empty key set) | `updates.import.notAvailable` |
| `UPD-NOT-A-DRIVE` | this copy isn't running from a prepared drive (F-21) | `updates.import.notADrive` |
| `UPD-MAC-CACHE-COPY` | the macOS copy started from its cache: start HilbertRaum on the drive (F-21) | `updates.import.macCacheCopy` |
| `UPD-OLD-FILE` | the 12-month confirmation (`issued`) | `updates.import.oldFile` |
| `UPD-ISSUED-IN-FUTURE` | the warning for an `issued` date in the future | `updates.import.issuedInFuture` |
| `UPD-OTHER-SYSTEM-FLOOR` | the warning about the drive's other systems' OS floors | `updates.import.otherSystemFloor` |
| `UPD-AGE-REMINDER` | the age reminder (G-29) | `updates.reminder.age` |
| `UPD-SUPPORT-ENDED` | the end-of-support notice | `updates.reminder.supportEnded` |
| `UPD-SUPPORT-ENDED-LONG-AGO` | the reworded notice past `max(build date, support end)` + 3 years | `updates.reminder.supportEndedLongAgo` |
| `UPD-LAUNCH-FALLTHROUGH` | start file: rule 1 fell through (§5.6) | — |
| `UPD-LAUNCH-NOTHING-TO-RESTORE` | start file: the counter may not restore (§5.6) | — |
| `UPD-LAUNCH-CANT-START` | start file: the counter found a confirmation (§5.6) | — |

The import verdicts come from table A (§4.7). A later revision of the record may add codes, never
rename or reuse one.

### 5.9 "Copy details for support" (table B.10; F-14, W-16)

The copied text, frozen in release 1: ASCII English, LF, the first line `HilbertRaum support details`,
then one `<label>: <value>` line per field in this order; no path, no host or user name. It is run
through the log redaction, and a row asserts it comes back unchanged (W-16).

| Label | Value |
|---|---|
| `Reference` | the `UPD-*` code of the notice the button sits on, else `none` |
| `App version` | the running version |
| `System` | `<os> <process.getSystemVersion()> <process.arch>` |
| `Apps on the drive` | `<os>=<version>` for each root artifact (R1's globs, §5.7), joined by `, `; a root `*.app` is `darwin=unknown`; none: `none` |
| `Start files` | `Start HilbertRaum.cmd=<s>, Start HilbertRaum.command=<s>, start-hilbertraum.sh=<s>, READ ME FIRST.txt=<s>`, `<s>` = `same`, `different` or `missing` against the payload of `updates/applied/<running version>.dsse.json`, or `not checked` when that file is absent or does not verify (§2.3). Release 1 reads `install_as` here only (§2.4); on release 1 itself, before any update, the value is always `not checked` (L1-28) |
| `Drive release record` | `drive-release.json`'s `app_version`, `absent` or `unreadable` (from `readDriveRelease`'s four kinds, §8.5; P6 builds the copy) |
| `Support end` | `config/kit-support.txt`'s `YYYY-MM`, `absent` or `unreadable` (from `readKitSupport`: `unreadable` for a failed read and for a damaged stamp, §8.4) |
| `Update policy` | `allowed`, `managed`, `max <version>`, `invalid value` or `unreadable` (from `readUpdatePolicy`'s `install`, `maxVersion` and `file`, §8.1; P6 builds the copy) |
| `Staged update` | the staged version or `none` |
| `Update in progress` | `no`, or `yes version=<v> launches=<0-3> hand-offs=<0-3> started=<yes or no>` (from `handoff.txt`, `launch-<n>`, `finish-<n>`, `started`) |
| `Unconfirmed` | `unconfirmed.txt`'s version, `damaged` or `none` |
| `Last update results` | `none`, or the last 3 valid `last-result.txt` lines, each on its own line indented by two spaces |
| `Update log (last 40 lines)` | `none`, or the last 40 non-empty lines of `update.log`, each indented by two spaces, every byte outside 0x20–0x7E replaced by `?` (§5.3) |
| `Free space` | decimal bytes, then ` bytes` |
| `Drive writable` | `yes` or `no` (§5.4's probe) |

### 5.10 Other values the protocol tables name (table B.11)

| Value | Exact value | Source | Frozen since |
|---|---|---|---|
| The build-date file | `apps/desktop/src/main/services/updates/build-date.json`, beside `keys.json`; generated by the build, never committed (git-ignored); one JSON object `{"commit_date":"<YYYY-MM-DDTHH:MM:SSZ>"}`, the release commit's committer date in UTC; embedded into the main bundle at build time, and the release guard checks the packed value against the tag (§2.7). Read only by the build that carries it; a later version may change its own. Missing or malformed: the age reminder and the support notices stay silent | W-17, W-3 | R1 (its own reading) |
| `drive-release.json`, the reader's types | UTF-8 JSON, one leading byte-order mark removed, one object, at most 1,048,576 bytes (larger is damaged, `too-large`, and never opened; exactly 1,048,576 bytes is read; §8.5's writer records a `files[]` list of the drive's apps, start files and engines, ~150 bytes per file, so 64 KiB would be reached near 430 files; L1-21); `app_version` a SemVer 2.0.0 string, ASCII, at most 64 bytes, compared byte for byte and never trimmed, else `invalid` (counts as absent); `format` a safe integer ≥ 1 (`1.0` reads as 1), logged only, else `invalid`; `highest_version_seen` a SemVer string of at most 64 bytes, reserved (§8.5); own fields only, the last of a duplicate key; every other field, `systems` and `files[]` included, never read by R1. The reader's four kinds and its other rules: §8.5 (as built in P3) | F-13 | R1 |
| `drive-release.json`, every writer | UTF-8 without a byte-order mark, LF, two-space indent; the writer's own fields first, then every kept field in `JSON.parse`'s order; never over 1,048,576 bytes; a later writer's own fields survive a round trip through an IEEE double parser (big integers and wide values in strings, no duplicate keys, no meaning in key order, number spelling or whitespace); an older helper may rewrite `format`, `app_version`, `systems` and `files` in release 1's shape, so a later shape takes new field names; a damaged record is replaced and its unknown fields lost; `app_version` as §8.5 says | F-13 | R1 (later writers keep it) |
| `config/kit-support.txt` | one month `YYYY-MM`; the builder writes the month and one LF (8 bytes); a reader accepts a regular file of at most 64 bytes with one leading byte-order mark or none, the month, then nothing, LF or CR LF (§8.4) | F-13 | R1 |

### 5.11 Cases the tables were checked against

- **A slow first start** (S-P1-13; 39 to 70 s in spikes 1 and 8, T1.11 C-7; spike 1b: a never-seen build
  under Norton took 71.7 s and 77.9 s to the real window, with a HilbertRaum window inside Norton's
  sandbox border for ~22 s that closes by itself; that is the restart copy's and O22's, not a table
  value) during which the buyer double-clicks one to three times. During vB's first start R1's start
  files are in `previous/` (the apply replaced them before it started vB, CE-1), and on Windows and
  Linux the apply's own start is not a start-file start, so R1's counter never sees it; on macOS the
  apply opens the `.command`, so when a deferred replacement left release 1's `.command` at the root
  that start counts once (§5.6, pending spike 3). Later start files skip a start while one is in
  flight (W-7 (d)); a fallback armed anyway re-reads the confirmation after its wait and aborts
  (T-aborted, W-21 duty 5, CE-D1); the confirmation comes at window up. R1's own counter meets such a
  start only when R1's start files sit at the root while `unconfirmed.txt` names the version at the root,
  that is after a forward apply that could not replace them; there its Windows in-flight probe decides,
  and it reads "in flight" for the whole start, sandboxing included (spike 1b, §5.6); on macOS and Linux
  release 1 has no probe (CC-20), a recorded residual of that rare state.
- **Both stub builds** (today's per-build `%TEMP%` folder and #1043's per-start one): no table value
  depends on which one ships. The probe and the Windows wait hold on both (spike 1b: builds A and B);
  `budget 30` covers both (spike 1).
- **The other twin and the other system:** `journal.txt` holds no system-specific value; every move is
  by version; `os` and `boot` (±300 s) only gate the wait; `LC_ALL=C` and `TZ=UTC` before `ps`; cmd
  ignores the bash lock and bash the cmd one; both read CR LF and LF.
- **A version from 2035** meeting release 1's files: every file R1 writes (`handoff.txt`, `finish-<n>`,
  `launch-<n>`, `launch-count.txt`, its `last-result.txt` lines, `last-result.seen`,
  `confirmed/<v>_<os>`) has a grammar here; every R1 reader ignores unknown keys, fields and lines and
  maps an unknown code to the generic notice (G0, §5.8); R1's rewrite of `handoff.txt` keeps the keys it
  does not know.
- **The staged name** (S-P1-14): table A (§4).

### 5.12 Owner decisions and open values of table B

Decided by the owner on 2026-11-24 (ledger Δ-31), each as recommended:
1. **The running app is not a root artifact** (T1.11 S10-1): "Restart and update" and "Continue the
   update" are refused before the lock with `UPD-NOT-DRIVE-APP`; the import and the staging stay allowed
   (§5.4). The alternative, handing off anyway, would end in a state nobody tested, on a frozen path.
2. **The counter messages wait for a key** on Windows (`pause`); the fall-through does not; bash never
   waits (§5.6). On Windows these lines are the whole UI of that state (UX-18).
3. **English only** in the start files; `READ ME FIRST.txt`'s UPDATES block (T7.D) carries the steps in
   English and German (§5.6, C10).

Decided by the owner on 2026-11-24 after the two reviews, each as recommended:
4. **The confirmation file is `confirmed/<v>_<os>`**, glob `<v>_*` (L1-4, L2-12): `_` is in no SemVer
   string, so a pre-release can never read as its release; the plan's `<v>-<os>` would have needed the
   three exact names in every test and could never see a later system's confirmation.
5. **`helper-blocked` records the computer and its boot** (`os=`, `boot=`; L2-14): another computer or a
   restart is offered the update again ("Restart and update" when the failed hand-off removed
   `applying/`, "Continue the update" when `applying/` stays after a missing acknowledgement, §5.4,
   §5.7), so the notice's own advice ("plug the drive into another computer") works.
6. **The `helper-blocked` notice stays until it is dismissed, at most 60 s**, then the app exits (L1-26).

Decided by the owner and the orchestrator on 2026-11-24 after spike 4a (ledger Δ-39):
7. **G-24's `linux` floor fails closed** (§2.4): a floor that doesn't parse, or a glibc version that
   can't be read, refuses the import before staging with `UPD-CANT-CHECK-LINUX-FLOOR` (§5.8).
8. **Spike 4a's three fixes are adopted as measured**: the wait's zombie test and the bash final step
   (§5.5), and `start-hilbertraum.sh`'s rule 1 with `trap '' HUP` and `setsid` (§5.6); the `.command`'s
   rule 1 gets the `trap '' HUP` line, provisional until P11a's spike 3.

Decided by the owner on 2026-11-24 after the record's independent review (ledger Δ-41):
9. **After a failed spawn that removed `applying/`, the same computer may try again at once** (review
   V-2): its next start offers "Restart and update" labelled "Try again on this computer", so a buyer
   who allow-lists the helper in the antivirus retries without a restart. One limit holds on both
   paths: at most three hand-offs per computer and boot (the owner's "three tries per computer and
   start-up"; the first "Restart and update" plus two "Try again on this computer"), counted by the
   `finish-<n>` markers while `applying/` stays, which now spawn on all three, or, when a failed spawn
   removed them with the folder, by the `helper-blocked` lines at the end of `last-result.txt` (§5.4
   (b)–(d), §5.7; Δ-41). The protocol model's P7 re-run adds the state.

Closed: F-7 (d)'s Windows probe and the Windows wait (T1.11 S1-2), by spike 1b (§5.5, §5.6), with
T1.11 P3-1's condition (the PC D row, §5.6 "In flight, Windows"); the method review's pass 3 (T1.11
P3-1 to P3-8) is applied in §5.4–§5.6 and §11.3; the cmd
self-delete (T1.11 S10-2), by spike 10b: the apply's final line removes first and starts last (§5.5),
rule 1's `start` has the `(goto) 2>nul & ` prefix (§5.6), and the start-file replacement retries for at
least 2 s and defers (§5.5); both texts confirmed at `LockBatchFilesWhenInUse` = 0 (spike 10b part 2),
the final line at value 1 being T7.2's test row; the bash hand-off, wait, final step and
`start-hilbertraum.sh`'s rule 1 on Linux, by spike 4a (§5.4–§5.6). Pending: the macOS half (the spawn,
the wait's `comm` and `stat`, the final step's `open`, the `.command`'s rule 1) on P11a's spike 3, and
the Linux legs of P11a's spike 4b (§10.6).

---

## 6. Drive content, engines, first start

_Status: planned (P8), except the parts marked as built on master, and the pre-spawn check's record
in §6.7 and §6.11, as built in P3 (T3.12's two reviews and fix rounds, T3.12a's measurement). Release 1
carries P8, so the precedence of §6.2, the ownership rule of §6.3, the engine-folder rules of §6.6 and
the notice of §6.4 ship in the oldest sold version and freeze there._

### 6.1 What freezes here

- G-3's precedence: app-owned model definitions and skills from the app's own bundle (§6.2);
- the reconcile's ownership rule and the format of its owned-hash table (§6.3);
- the engine pin-folder lookup, and how release 1 treats a `runtime/<family>/<os>@<pin>/` folder a
  later version left behind after "Go back" (§6.6);
- the "new models are available" notice (§6.4);
- the AI engine installer's call of the OS `tar`: its child inherits the full environment today, and
  GNU tar honors `TAR_OPTIONS`; P8 scrubs the environment or records the residual.

### 6.2 Model definitions and skills come from the app (G-3)

- The app reads its **app-owned** model manifests from its own bundle (`extraResources`). The drive's
  `model-manifests/` becomes a mirror plus a user overlay: the start files set
  `HILBERTRAUM_MANIFESTS_DIR` to `<root>/model-manifests`, and the new version reads that folder as the
  overlay, never as the authority for an app-owned id. The model list is then never stale after an
  update, a failed refresh or a copied app.
- **The cost for DIY users:** a user who edited a built-in model entry on the drive loses that edit; to
  keep one, copy it under a new id. The model docs say so.
- **App skills** are bundled too. The new version **leaves the drive's `app-skills/` as the Kit shipped
  it**: release 1 reads it after any "Go back", and nothing but the sell gate reads it otherwise. A
  skill of a new `kind` therefore never reaches release 1 (F-25).
- The start files, the drive docs, `READ ME FIRST.txt` and the notices are bundled as well, as the
  reconcile's source: after a hand-copied app there is no other source.

### 6.3 The reconcile and the ownership rule (W-25)

The new version refreshes the drive's mirror, start files, docs and notices under one rule:
- **Ownership evidence** is a table, built when the update file is built, of the sha256 of every
  released version of each owned file, from every release tag back to v0.1.0. A file whose hash is in
  the table for its path is "ours, unmodified" and may be replaced or removed. Anything else is left
  alone and logged. A file a user put back to an older shipped version on purpose reads as ours and is
  replaced (documented). A drive whose `docs/` mixes versions is reconciled file by file.
- It works for every drive in the field, including drives with no `drive-release.json` and copied apps.
- **A retired app-owned manifest is never removed while its model files are on the drive.** A model is
  retired with `download.withdrawn`, never by deleting its manifest.
- Everything the reconcile writes into the mirror is read by release 1 after any "Go back" and on a
  system still running release 1, so it obeys F-23 (§6.11): a manifest release 1 cannot validate only
  behind `min_app_version`.
- **App-owned chat manifests are refreshed all or nothing**: one file with a graphics-card rank flips
  the whole role to card ranking.
- The drive's `model-manifests/runtime-sources.yaml`, `DRIVE-NOTICES.md` and the kiwix source bundle are
  refreshed **together with the engine install** (§6.5): the sell gate, `fetch-runtime` and the notices
  read the drive's copy, and the license record must match the binaries on the drive.
- **Start files the apply could not replace** (a deferred replacement, `launcher-replace-deferred`,
  §5.5) are release 1's shipped files, so they read as ours, unmodified, and the new version's next
  start replaces them; until then the drive runs release 1's start-file rules.
- `app-skills/` is not mirrored (§6.2). The previous content set is kept for "Go back" (§6.10).
- Packaged builds only.

### 6.4 New models (G-30, W-74)

New models and changed model definitions reach a Kit with every content-changing app release: the new
version reads them from its bundle and refreshes the mirror. After the update it says once which
models the release added (name, size, and "needs internet to download" while offline); downloads go
through the existing per-model consent. A signed definitions-only or model-pack file is a later
follow-on; release 1 answers such a file with "for a newer HilbertRaum" (§2.4).

### 6.5 The AI engine after an update (G-31 (b), W-30, W-77)

- **The update file carries no AI engine by default.** Nothing engine-related is staged or moved: a
  forward apply has no engine step (U3), and a reverse apply only deletes half-extracted `.new` engine
  folders (§6.10).
- After the update, on the trigger below, the new version offers its engine:
  - **a download**: the existing consent (each archive's size, license and address), the internet
    switch, the audit events of the engine install;
  - **"Install AI engine from a file…"**, on the AI Model screen and in the "After the update" card:
    the user picks the archives they downloaded on another computer from the addresses the consent
    shows. The app copies each picked file onto the drive next to the pin folder, checks its size and
    sha256 against its **bundled** pins, refuses any other file, and installs it exactly as the
    download does. The user's original is never moved or deleted. No network is needed.
- Until its engine is installed, the new version keeps running on release 1's engine (G-35 (a)), so an
  offline Kit loses nothing it had. The card and the buyer notice say that the update also brings a new
  AI engine, which HilbertRaum downloads once when online or installs from a file, and that until then
  it keeps working with the current engine.
- **The trigger**, per system: a start on a computer of that system when this system has confirmed the
  new version (`updates/confirmed/<version>_<system>` exists, §5.2) **or** no `updates/unconfirmed.txt` names
  the new version, and **never while `updates/applying/` exists**.
- **The escape hatch**: one release may still carry its engine archives in the update file, when an
  engine fix must reach offline Kits. Release 1 stages whatever the payload lists, so this needs no
  frozen change. Because the apply removes the staged update whole at its end (J6, §5.5), that
  release's own apply scripts (replaceable, §5.1) move the staged archives to
  `updates/engines/<version>/` as their first journal move; a reverse or fallback apply never touches
  that folder, and the new version installs offline from it.
- A copy placed by hand into the engine folder stays possible for DIY drives and IT departments
  (documented in [`troubleshooting.md`](troubleshooting.md)); the app cannot verify or version it.

### 6.6 Side by side, and the oldest pin (G-32 (a), G-35 (a))

In §6.6 and §6.7, `<os>` in a folder name is the engine's runtime folder name (`win`, `mac`, `linux`;
`drive-layout.md`, `sidecar.ts`), not §5's system token (`win32`, `darwin`, `linux`).

- The new version installs its engine into a folder of its own, `runtime/<family>/<os>@<pin>/`, with
  its `cpu/` safety net inside (P8 fixes the spelling). It extracts into `<os>@<pin>.new/`, checks it,
  writes the install marker **inside** it, flushes every file, then renames it in one move. The next
  start deletes a `.new` it finds and offers the install again.
- **Release 1's `runtime/<family>/<os>/` is never moved or written while "Go back" is offered.**
  Release 1 reads only that folder (its path is fixed in code; nothing walks `runtime/<family>/`), so
  the sibling folder is invisible to it, and "Go back" and every restore by the start files find
  release 1 on its own engine.
- The new version runs its own folder when it is complete with a marker at its pin, else release 1's.
  "Complete" means the marker parses and every file its own `binaries` map records is a file inside the
  folder (a marker without the map: every required file of that build). Every delete removes the
  marker first.
- **`engine_min` is the oldest pin a supported Kit may run** (G-35 (a)). A release that updates
  release-1 Kits starts every sidecar on the engine it finds until its own is installed, choosing the
  arguments by the marker's version. The release ritual's per-pin-bump gate runs the new version's
  arguments on release 1's pin (§9.3). The lasting cost: the day upstream removes a flag release 1's
  pin needs, the release that drops it is a breaking release behind this gate, and the owner decides
  then.
- **The prune**: first `updates/previous/`, then release 1's `runtime/<family>/<os>/` per system, and
  only when `updates/unconfirmed.txt` is gone, every app at the root is the new version, and that
  system's new engine folder is complete with a marker at its pin. A later update's prune, under the
  same conditions, removes every pin folder but its own.
- **Space**: a second engine set per system until the prune, an estimated 150–200 MB per system.
  Release 1's hand-off pre-check does not count it (its margin is the fixed 64 MiB of §5.4, and the new
  version installs its engine only after the update); the space check belongs to the new version's
  engine install (P8). Archives that the escape hatch carries are staged members, so the import's
  free-space formula counts them (§4.5).

### 6.7 Release 1's own engine install, as built (F-24, G-44)

Release 1's own online install, update and reinstall of its engine (into `runtime/<family>/<os>/`) are
**as built on master** (#986, PRs #991 and #1009; [`architecture.md`](architecture.md) "In-app engine
updates — design record" §6):
- every copy is staged before the pause: unpacked, checked against the verified archive's own member
  list, every file hashed into the marker's `binaries` map, flushed, marked last, then swapped per
  family by rename; the old copy is deleted only after the swap;
- the leftover names are `<os>.new` and `<os>.old` and, for the `cpu/` net, `<os>/cpu.new` and
  `<os>/cpu.old` inside the live folder; the start recovery touches only those exact names, so the
  pin folders of §6.6 are a different name it never touches;
- **the pre-spawn check covers every recorded file** (G-44 (a), #1012, PRs #1029 and #1035): before the
  first spawn of a session it checks every file the copy's own marker records, the program first; a
  changed file, or a missing one, refuses an engine's start with the reinstall offer (the knowledge-pack
  tools start on a missing file that is neither their program nor a library); a damaged marker is its
  own verdict, never a fallback to the folder above; what the check is and is not, its tolerance of a
  hash-less marker, its read-error classes, its cache and its measured cost: "The pre-spawn check, as
  built" below (P3);
- **not built, a documented residual** (G-44 (b)): starting a complete copy in place on a drive that
  cannot be written after an interrupted swap. Such a drive starts no engine until it is writable
  again; an encrypted workspace cannot be opened on it either. The same holds for a start whose one
  rename another program refuses at that moment (a scanner's or Explorer's handle): that session has
  no engine, and the next start or engine job heals it (T8.5c R1 F-6; `recoverEngineFolder`,
  `runtime-download.ts`).

P2's review of this install (T8.5c) changed four things, as built in `runtime-download.ts`:
- a start whose recovery cannot read a marker just now (`unreadable`, as opposed to absent or damaged)
  leaves that family's whole layout as it is and logs one content-free line (`heldEngineMarker`); a job
  the user starts reads it again, five times 250 ms apart, and then judges a marker it still cannot read
  as damaged, since that copy cannot be vouched for (`heldAfterRetries`);
- a plain `families` request never replaces a copy whose program is there and whose relation is
  `newer`: it gets the update's answer (`planEngineSteps`), so "a newer engine is never replaced"
  holds for every request except a reinstall;
- on macOS and Linux a tar.gz whose version links fail tar on a drive that holds no links (exFAT) is
  mended as `fetch-runtime.sh` mends it: each listed link becomes a copy of its target, a link that
  leaves the folder is refused, and the member check then judges the result (`mendTarFailure`,
  `judgeMendedTar`, #1045); a stage that holds any symbolic link is never mended (`holdsLink`);
- an engine job leaves a sibling `<os>@<pin>/`, its `.new` and `updates/engines/` byte for byte.

Consumers of the engine folder that the as-built record above did not list (T8.5c review 2's list):
the request gate (`registerEngineIpc.ts`, which admits `reinstall` only for a damaged family and a
plain `families` list as it is); the job's own recovery (`run()`), which moves copies with no spawn
gate and no pause (on NTFS a running program makes the rename fail, which is safe); the graphics probe
(`runtime/gpu.ts`) and the engine health check (`engine-health.ts`), which wait at the spawn gate like
every spawn; and the program resolvers (`runtime/sidecar.ts`, `transcriber/cli.ts`, `zim/tools.ts`),
which run before the spawn gate's wait, so a model start between the swap's two renames reads "no
engine" (up to about 12 s with a held rename; recorded in `runtime/spawn-gate.ts`).

Recorded limits of the install as built (T8.5c dispositions; also in
[`known-limitations.md`](known-limitations.md)):
- "complete" is presence: a copy is trusted for a swap by its own marker's file list, and its bytes are
  checked at the first spawn; files the marker does not record are ignored; no `version`, `backend`,
  `os` or `arch` is compared at the recovery; the flush before the marker is best effort and silent
  (R1 F-7, R2 m-1);
- after a mend, tar's exit code no longer vouches for the bytes: a file of the right size with the wrong
  bytes is recorded as good (the archive's own sha256 was checked before the unpack) (R2 N-3);
- the held check and the recovery read each marker separately, and a failed `stat` of a recorded file
  reads as "missing" (R2 N-1); the leftover guard after the download reads each marker once, so an
  unreadable one there reads as none and that leftover is removed (R2 P-2);
- a named list replaces a copy whose relation is `unknown`, an unreadable marker's included (R1 N-3);
- a marker held through the job's retries refuses only after the full download (R1 N-4); in one layout
  (no install folder, the only whole copy a leftover whose marker stays held) that copy is deleted
  before the download, so a failed download leaves no engine until a later install: kept as built, it
  costs a download, never data (R1 N-5);
- un-marking first can turn a refused copy into an unchecked one when a delete is cut short; with two
  whole leftovers the start deletes an incomplete live folder on the main thread; a killed download
  leaves its partial archive inside `<os>/`; a hand-placed `cpu/` net without a marker is not guarded;
  a file held for a moment while the stage is hashed fails the install after the download (R2 m-2 to
  m-6).

**The pre-spawn check, as built** (W-84, G-44 (a), #1012; `main/services/binary-verifier.ts`; T3.12's
two Fable reviews, both "sound with limits", and its two fix rounds, P3; the owner's ruling on #234,
2026-11-25; the golden `f24-markers/copy-shapes.json`, added beside the locked `vectors.json`):
- **What it is.** It detects a copy that no longer matches its own record: a copy cut short, bit rot, a
  file replaced while the marker is left alone. It is **no defence against whoever can write the engine
  folder**: the record lies beside the files and is not signed, so the same writer can rewrite the
  hashes or the marker ([`security-model.md`](security-model.md), "Re-hash sidecar binaries before
  spawn", "What the check does not cover"). A packaged build enforces it; a developer build skips it
  (`skip-dev`).
- **What it checks.** Before the first spawn of a session it walks up from the program's folder to the
  first marker file (the program's own folder, then the one above, for a `cpu/` net without a marker
  of its own) and covers every key of that marker but a nested net's (`cpu/`, `cpu.new/`, `cpu.old/`),
  the program first. A key that leaves the copy's folder is `mismatch` before anything is read. Each
  recorded file is first looked at with one `stat`: a missing program or library (a name ending `.dll`,
  `.so`, `.so.<n>` or `.dylib`) refuses with **nothing hashed** (`missing`). Then the present files are
  hashed one at a time, stopping at the first difference (`mismatch`).
- **The hash-less tolerance, frozen** (owner: #234 tolerated and documented;
  `REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES` stays `false` for ever, §11.4): a copy with no marker,
  a marker without `binaries` or with an empty map starts with nothing checked (`skip-legacy`), and a
  map that records only the program has the program alone checked, on a Kit too. A marker in the
  program's own folder whose map holds files but not the program, also one whose every key lies under
  a nested net's folder, is `marker-damaged` (T3.12's fix round). The sell gate refuses a Kit without
  full maps at build time (§9.5).
- **Gone files by kind.** Any other recorded file gone is `missing-other`. The engines refuse it as
  damaged files too, at once and with nothing (more) hashed: at the `stat` pass, or at the first read
  that finds a file gone (fix round 2). The knowledge-pack tools, which have no repair in the app,
  **start on `missing-other`** (owner, Q2 (b)), after hashing every present file, so that a changed one
  still wins (`startsOnMissingOther`).
- **Read errors by class** (the fix rounds). `ENOENT` and `ENOTDIR` mean a gone file. **`EIO`** (a worn
  stick, a bad sector; logged by its code) counts as a gone file, by the file's kind, so the engines
  show their damaged-files verdict with "Install again", never "try again in a minute". A name the OS
  refuses (`ERR_INVALID_ARG_VALUE`, `ENAMETOOLONG`, `ELOOP`, `EINVAL`) is `marker-damaged` (fault
  `name-refused`); so is the marker's own `EIO` (fault `drive-read-failed`) and a refused marker name.
  A hold (`EBUSY`, `EPERM`, `EACCES`, `EAGAIN`, `EMFILE`, `ENFILE`) and any code nothing here knows stay
  `unreadable`: no verdict, this attempt refused, the next one reads again. A throw nobody foresaw ends
  the check as `unreadable`, never as a rejected answer kept for the session, and the graphics probe
  then gives no answer, never "no graphics card". On Windows a single name of 256 to 300 characters
  gives `ENOENT` (`ENAMETOOLONG` only beyond 32,767), so there it reads as a gone file, where macOS and
  Linux read it as `marker-damaged` (T3.12's Q2, kept).
- **What is cached** for the session, per resolved program path: `ok`, `skip-*` and `mismatch` stick, and
  so does the knowledge-pack tools' `missing-other` (under its own key); `unreadable`, `missing`, an
  engine's `missing-other` and `marker-damaged` are evicted, so the next spawn or "Check again" reads the
  copy as it is then. The in-app engine installer evicts both entries of every program it puts in place
  (`invalidateBinaryVerification`), and P8's pin folders must do the same (CF-35). A copy whose marker
  changed while the check ran is `unreadable`, not a tamper.
- **The cost, measured** (T3.12a, Δ-60: the real `verifyBinaryBeforeSpawn` on a 52-file, 92.5 MB
  stand-in copy, a fresh process per run, its pages purged first): the first engine spawn of a session
  waits about 2.5 s on a USB 2 stick when the antivirus already knows the files, and 3.0–3.2 s at
  Norton's first look at them on that computer; on a USB 3 stick of about 190 MB/s, about 0.55–0.6 s
  and 1.1–1.2 s the same two ways; about 0.31 s with every page cached (Node's SHA-256 alone); then nothing for the rest
  of the session. The plan's "0.28 s on USB 3" was too low. Not measured: Electron's main process,
  Defender active, Norton offline, b12110 itself (52 files, 94.5 MB, about 2 % more bytes), the
  kiwix-tools and whisper.cpp copies (T11.3a).
- **Its recorded limits** (T3.12's reviews; [`known-limitations.md`](known-limitations.md)): a cached
  `mismatch` outlives a repair made outside the app (a `fetch-runtime` run while the app is open), and
  the session cache outlives a re-plugged stick, so only a restart reads again (R1 m-1, R2 m-3); a hold,
  a lasting deny-read and an unknown code stay "try again", and Windows may report a bad sector as
  `UNKNOWN`, so the `EIO` way out may not reach it there; files the marker does not record (a library
  it lacks, #1025, or one the loader finds in the working directory) are not checked at a start; the
  library test is a closed list of endings, so a later tools copy whose loadable code has another ending
  starts with that file missing (R1 m-5); the cost grows with the copy and shows no progress: a 1 GB
  copy would wait about 26 s on USB 2 in silence (R1 m-6, a follow-up candidate); the "copy changed"
  guard cannot see a reinstall of the same pin across the swap's narrow window (R2 m-2); the
  knowledge-pack tools' refusals have no repair in the app and are latched until the pack set changes or
  the app restarts, and since the fix rounds a passing medium error on their marker or a library is
  latched the same way (R1 m-7, N-3; beside #1013); if a file-system driver ever gave `ELOOP`,
  `ENAMETOOLONG` or `EINVAL` for a healthy file, that copy would be refused with "Install again". The
  rows that need real media or a real antivirus (holds, quarantines, cut-short markers, name case across
  systems, medium read errors and their codes, a write-protected stick, the cost under Defender and on
  macOS and Linux) are T11.3a's.

The five duties a later version keeps for this install (leftover names, links and marker files under
`runtime/`), and the three the pre-spawn check relies on, are in §6.11, "Release rules for the AI
engine".

The frozen marker rules for every later writer are in [`data-contracts.md`](data-contracts.md) (the
engine install marker): `binaries` stays a map of relative path to lower-case SHA-256 hex of every
file, the program first, anything new goes into a new top-level field, the marker stays one line under
64 KiB.

### 6.8 Engine signing and the voice engine

- **Code signing of the AI engines for Windows Kits** (G-28) is deferred by the owner, with one
  deadline: before the release side writes release 1's engine list (P5). Whatever is chosen, a
  signature is added inside the archive the pin names, before any marker is written, never in place on
  a drive; the signing record is a new top-level marker field; the marker's `version` keeps the
  upstream tag (release 1 orders only `bNNNNN` and dotted tags).
- **Mac and Linux voice-engine builds hosted by the project** (W-78): whisper.cpp publishes ready-made
  programs for Windows only, so the project builds `whisper-cli` from the pinned tag in CI (macOS arm64,
  Linux x64, CPU only), publishes the archives on a dedicated release whose tag does not start with
  `v` (§9.7), and adds them to the bundled `runtime-sources.yaml` **before the release-1 cut**, so
  release 1's own install and reinstall reach Mac and Linux Kits. The marker keeps the upstream tag
  `v1.8.6`; the builds are named "built by HilbertRaum from whisper.cpp v1.8.6".

### 6.9 The first start after an update

The new version's post-update steps, in this order (W-26), none of them while `updates/applying/`
exists (the update is continued first: its own through its resume, §5.5, any other through "Continue
the update", §5.7):
1. **the confirmation**, per system, at the first window, before anything else changes (F-22, §5.7). No
   automatic fallback once any system has confirmed;
2. the reconcile (§6.3);
3. the engine offer for this system (§6.5);
4. "Updated to version {n}", shown once by the confirmation itself, so a fix-line release shows it too;
5. the prune (§6.6) and the macOS cache prune (the apply already removed the staged update whole, §5.5 J6);
6. `highest_version_seen` written (§8.5).

Also:
- **Re-verification**: a resume by the start files swaps by size only, so the new version re-hashes
  every root app and start file against the signed payload, which the apply keeps as
  `updates/applied/<version>.dsse.json`. It names the damaged app ("the macOS app on this drive is
  damaged") and offers a re-import. The running system's own exe is readable while its portable stub
  holds it. A start file whose replacement the apply deferred (§5.5) is the reconcile's to replace
  (§6.3), not damage.
- **Notices** (W-32): a withdrawn or repointed installed model; a missing active model; a user manifest
  whose id the bundle now ships (the bundle shadows it); a model the new engine cannot load or that
  needs a new file, which "must be downloaded again after the update", with its size.
- **The macOS cache prune** (W-31), after a confirmed Mac start, keeping the cache's contract: the cache
  is shared by every start and version, a folder `*.partial.<pid>` is never touched while its process
  runs, and the start file removes only dead partials of its own zip
  ([`drive-layout.md`](drive-layout.md)).
- **`drive-release.json`**: the new version rewrites `app_version` after its confirmation, keeps every
  unknown field and never touches `config/kit-support.txt` (§8.5).

### 6.10 "Go back to version {n}" (W-22)

Offered on the migration-error screen and in Settings by a version that an update installed; it returns
to the version kept in `updates/previous/`.
- It runs the apply in reverse (`handoff.txt` `mode back`, `to` the target, §5.3, §5.5): the apps and
  the previous content set. It **moves no engine**: release 1's engine folder was never moved (§6.6),
  and the reverse apply only deletes half-extracted `.new` folders.
- Before the reverse hand-off the new version rewrites `drive-release.json` `app_version` to the target
  version (no script can: `cmd` parses and writes no JSON), so release 1's version rule accepts the fix
  line again. The restored content set never brings back an old `drive-release.json`.
- The restored content set keeps the manifests of models installed under the new version, so release 1
  can still list them. Release 1 has no action that deletes a weight file (its model channels list,
  select, use, verify and download): after a "Go back" the files of a model only the newer version runs
  are freed by hand (T2.7's F-23 review 2, M-4; `registerModelIpc.ts`, `registerDownloadIpc.ts`).
- **Not offered** while `updates/applying/` exists, when `updates/previous/` holds apps of mixed versions
  (it holds at most one app per system, §5.5, and its target is the version every system there
  carries), once the prune has removed `updates/previous/` (§6.6), or once the workspace's version
  number has moved past what the target reads (§7.8). It **is** offered after the new version
  confirmed a good start on this system (this system's confirmation is enough, F-22); what a confirmed
  start stops is the **automatic** fallback (U7, owner 2026-11-24). It uses the same writability check and the same
  questions about unsaved changes and running text recognition as "Restart and update".
- After a "Go back" that stays, the new version's engine folders remain until a later update's prune;
  release 1 ignores them. The version left is not offered again (its `went-back` line, §5.8) until its
  update file is imported again, which appends `cleared` (§5.7).

### 6.11 What release 1 reads that later versions change (F-23, F-24, F-25)

Three old-reader contracts are **as built on master** and freeze as they are. Release 1 is the oldest
reader of every manifest, engine marker, `runtime-sources.yaml` and skill folder a later release puts
on a drive, for ever. P2 (T2.10) froze what release 1 does with each in golden fixture sets, written
from the contract text and locked by `tests/fixtures/golden-fixtures.sha256`; the rules below say
what a later release may change freely and what only behind `min_app_version` or a new key.
- **Model manifests (F-23)**, #847/#848: unknown keys ignored (the goldens hold them at the top level
  and inside `download` and `license_review`); a bad value of a known key
  or a missing required key drops the file with a log line; an unknown `role` or a `min_app_version`
  above the app (exactly `MAJOR.MINOR.PATCH`; anything else, or an app that does not know its version,
  counts as newer; a pre-release app is older than its release) lists the file under "Needs a newer
  HilbertRaum", read for its display fields only, never selectable; a newer manifest still passes the
  safety checks: one without `id` or `display_name`, or whose declared path leaves the drive, is
  dropped, not listed; a `role` that is no string (a number, a block) is a bad value, not a new role;
  one id space: a usable manifest
  always keeps its id over a same-id newer one, and among newer ones the first in walk order wins;
  of two or more usable manifests of one id the first in walk order is the model and every later one
  is dropped with a "duplicate id" log line, whatever either holds; the walk goes depth first and sorts
  each folder's entries, files and folders together, by code unit of the name (`a/z.yaml` before
  `b.yaml`, `B.yaml` before `a.yaml`); `default_for_role` picks among usable manifests, else the
  first usable one of the role; `speculative_decoding` and `disable_prompt_cache` outside chat stay
  rejected; CRLF line ends and a leading byte-order mark are read past
  ([`data-contracts.md`](data-contracts.md), "A manifest for a newer HilbertRaum"); every `.yaml` or
  `.yml` file under `model-manifests/` (any case of the extension, any depth) but `runtime-sources.yaml`
  (or `.yml`) is read as a manifest (`collectManifestFiles`, `models.ts`), so a file that is no manifest is dropped, or listed under "Needs a newer
  HilbertRaum" when it carries `id`, `display_name` and a minimum (goldens `l18-catalog-index`,
  `d14-owned-hashes`); a minimum under any other spelling or place (`minAppVersion`, or
  `min_app_version` inside a block) is an unknown key, and the file is used (goldens
  `a14-min-camel-case`, `a15-min-nested`) (T2.7's F-23 review 1, MJ-4, MJ-6).
- **The AI engine (F-24)**, #516/#842/#843/#873: pins only from the app's bundled
  `runtime-sources.yaml`; the version relation orders two tag shapes of the marker's and the pin's
  `version`, each read with blanks around it trimmed and case-sensitive: a build counter, `b` and one or
  more digits (`b9585`), and a dotted release, an optional `v` and one or more digit runs joined by single
  dots, any number of parts (`v1.8.6`, `3.8.1`, `v1.8`); both tags must have the same shape; parts compare
  as whole numbers (`b10000` above `b9585`, `3.10.0` above `3.8.1`), and a missing trailing part counts as
  zero (`v1.8` is older than `v1.8.6`, `v1.8.6.1` newer); `older` → the update is offered; `newer` →
  never replaced, started anyway; anything else (another shape, `B99999`, a suffix such as `b9585-rc1`, a
  build tag against a dotted pin, no marker that reads) → `unknown`, reported, never updated; a reinstall
  replaces with the pin whatever the relation; the yaml validator is whole-file;
  the install marker is read as one of absent, unreadable, damaged or a marker (#1028); and §6.7.
- **Skills (F-25)**, #846, with W-65: app skills read from the drive's `app-skills/` only; `kind` is the
  closed set `instruction` / `tool`, checked before `compatibility.minAppVersion`, so a new kind is
  invalid whatever version it declares, except W-65's typed case: a skill that fails validation but
  declares a well-formed `minAppVersion` above the app is counted as made for a newer version; a
  `minAppVersion` that is not plain `MAJOR.MINOR.PATCH` (a suffix, a `+build`, a fourth part, a leading
  `v`, `1.0`) makes the skill invalid before the gate is asked, while a leading zero in a part is plain
  and compares as a number (`0.01.66` is `0.1.66`; unlike a manifest's minimum, where it counts as
  newer); the gate's fail-open covers an app version it cannot read only, and
  a pre-release app is older than its own release; frontmatter keys release 1 does not know are
  ignored; `skills.disabled_reason` records why a row is off, and the reconcile re-enables only
  `min_app_version` on a known app version; a vanished or invalid folder marks its row unavailable,
  never deletes it. W-65's typed case as built (T2.14): the verdict needs frontmatter that parses as
  YAML and a well-formed minimum above the app (`failedSkillNeedsNewerApp`, `shared/skill-manifest.ts`);
  a SKILL.md that does not parse, or declares no such minimum, is counted under "could not be read".
  Such a folder gets the discovery code `needsNewerApp`, counted apart in the status
  (`needsNewerAppCount`), and an installed row whose folder now holds one keeps `enabled` and
  `disabled_reason`, is marked unavailable, and shows "Needs newer app", not "Files missing"
  (`SkillRegistry.unavailableReason`, matched by folder). An import of such a package answers
  `needsNewerApp` in the preview and the install, also when the package fails only the file-type or
  depth check; every other structural limit keeps its own reason (`stagePackage`, `installer.ts`).
  P2's fix round (T2.7, `7c427744`) made two reads of a stored row safe: a cached `manifest_json` that
  is no JSON, or lacks or mistypes a member, falls back member by member to release 1's defaults (the
  v1 permission ceiling, no minimum), so no row can fail the list (`storedManifest`, `registry.ts`); and
  a delete removes files only for a `user` row whose `path` is a bare folder name inside `user-skills/`
  (`ownFolderToDelete`, `installer.ts`), else only the row. **G-40 (b):** this reader is the drive's
  `app-skills/` as on master; release 1 carries P8, whose W-24 bundles the app skills (§6.2), so P8
  rewrites this sentence as built (T2.7's F-25 review 2, M-5).

**The golden sets** (`apps/desktop/tests/fixtures/readers/`, each with its `PROVENANCE.md`):

| Set | What it holds | Verdicts | Run by |
|---|---|---|---|
| `f23-manifests/` | 52 single files and two held as base64 (CRLF, a byte-order mark), seven scenario trees (id space both ways round, walk order, two usable files of one id, `default_for_role`), two flat-read probes | accepts / lists / drops / ignores at `0.1.66`, at `0.1.66-beta.1` and at an unknown version; what the scripts do at each | `manifest.test.ts`, `committed-catalog.test.ts`, `script-execution.test.ts` |
| `f24-runtime-sources/` | 19 whole yaml files | accepts (with the families it yields) / drops (the whole file) | `runtime-sources.test.ts` |
| `f24-markers/` | 37 marker vectors of one engine copy (a vector may add a file to the copy), base64 where the repo's byte nets refuse the bytes; ten version-relation rows | per reader: the shared reading, the pre-spawn check, both `fetch-runtime` twins in both modes (the `.sh` twin's own where it differs); the record every writer writes; the relation, the install skip and the twins' choice | `assets.test.ts`, `script-execution.test.ts` |
| `f25-skills/` | 27 skill folders, seven reconcile sequences (and T2.14's `unavailable-reasons.json`) | the parse and the gate, the discovery code, the row a reconcile leaves, at three app versions | `skills-registry.test.ts` |

(Counts at `d1c0f153`. The later-version `skills` rows of the fix round, a row whose cached manifest is
no JSON or lacks members and a row whose `path` or `source` is not release 1's, rest on ordinary rows of
`skills-ipc.test.ts` and `skills-installer.test.ts`, not on a golden; so do the W-65 user-skill
sequences, since the set runs its folders as app skills (T2.7's F-23/F-25 reviews, re-check 1, N-3; R2
m-5).)

A verdict in these sets never changes: a later release adds files and lines only. As built and frozen
(Δ-53, Δ-54, and T2.10's round 3):
- "a map without the program" is damaged at the pre-spawn check and in a Kit build (`fetch-runtime
  --commercial`), but a marker to the shared reading and to the twins outside commercial mode;
- a marker with an empty `binaries` map, or none, is tolerated at the start and fetched again by the
  twins only with `--commercial`; both twins read past a byte-order mark and a marker spread over
  lines, except that the `.sh` twin with `--commercial` finds no recorded hash in a pretty-printed
  marker and fetches the copy again (the `.ps1` twin keeps it);
- the `.sh` twin finds a required file's hash past a `binaries` map nested after the top-level one, so it
  skips that copy in both modes as the `.ps1` twin does; but it takes the recorded names for its
  gone-file check (#998) from the last map on the line, split at commas, so a gone file whose name holds
  a comma, or that only the top-level map records when a nested map follows it, goes unnoticed by it (it
  skips the copy; the `.ps1` twin fetches it again; the app refuses it at the start as `missing`);
- in the yaml, a new `arch` or `backend` value inside a family block is accepted (a build no Kit
  selects, or, listed first for its `os`, that `os`'s default); a new `os` value is refused;
- the scripts skip a `role` that is no string as "needs a newer HilbertRaum", where the app drops the
  file as a bad value: neither uses it, and `--kit` fails on it either way;
- no vector has a nested `binaries` map that records a 64-hex value for a required file: in round 3 the
  `.sh` hash lookup fell back to the top-level map, and the duty below forbids the nested key, so this
  is a gap in the frozen blind spots, not in the contract (T2.10's QA re-check 2);
- in skills (T2.7's fix round, `7c427744`): a new `analysis` mode, tool or permission value with no
  minimum is accepted and its value dropped (`g25-analysis-unknown`, `g25-tool-unknown`,
  `g25-permission-unknown`: an unknown permission value reads as the v1 ceiling); a minimum at the top
  level of the frontmatter is an unknown key and the skill is used (`g25-min-top-level`,
  `g25-min-top-level-snake`); an app row that is off with a `NULL` reason and `installed_at =
  updated_at` is switched on at a known app version, and at one the gate cannot read stays off and
  gets `min_app_version`, to be switched on at the next known one (two sequences).

**Release rules for model manifests (F-23)**, also in [`model-policy.md`](model-policy.md) ("Release
rules for changing a manifest"):
- new keys freely, but no key nested in a block before a top-level key of the same name
  (`id`, `local_path`, `sha256`, `url`, `size_bytes`, `license_url`, `runtime`, `format`, `license`,
  `status`, `withdrawn`, `bundled_on_preconfigured_drive`): release 1's scripts read those flat, first
  match wins (the golden `nested-all-first` shows a nested `id` taken too, T2.10's QA N-2); `id`, `role`
  and `min_app_version` stay top-level keys at column 0, written plain: unquoted, the value on the same
  line, no tag (the scripts' column-0 read does not see a quoted key, a mapping indented whole or a
  flow-style file, and skips a block-scalar `role` or a tagged minimum; T2.7's F-23 review 1, MN-1);
- no byte-order mark: release 1's `.sh` flat read cannot see a key on a first line that starts with one
  (an `id` there prints empty), while the gate reader reads past it (T2.10 round 2);
- nothing but model manifests and `runtime-sources.yaml` under `model-manifests/` with a `.yaml` or
  `.yml` name, at any depth: release 1 reads every other such file as a manifest (MJ-4);
- the minimum only as the top-level `min_app_version`: release 1 ignores any other spelling or place
  and uses the file (MJ-6);
- a new value rule, enum value, role or engine requirement, and `speculative_decoding` or
  `disable_prompt_cache` on a role other than chat, only behind `min_app_version`;
- `min_app_version` is exactly `MAJOR.MINOR.PATCH`: release 1 reads any other value (a pre-release
  minimum, a fourth part, blanks inside quotes) as newer, for ever; a null or empty value is none;
- a newer manifest is still checked for safety: give it `id` and `display_name`, and only paths that
  stay on the drive, or release 1 drops it instead of listing it;
- a changed rule for an existing id only as a second same-id file with `min_app_version`, beside the one
  release 1 uses; never `min_app_version` on the only manifest of an id release 1 runs;
- never make the `default_for_role` manifest unusable for release 1 without flagging a usable
  replacement in the same release, and a new default for a role release 1 runs only behind
  `min_app_version`: of two usable flagged manifests release 1 picks the first in its walk (MN-4);
- never repoint a hash in place; retire a model with `download.withdrawn`, a non-empty string inside
  `download` (release 1 drops a manifest whose `withdrawn` is `true` or a block, so an installed model
  vanishes from its list, and ignores a top-level `withdrawn:`; MN-3), never by deleting a manifest
  whose weights may be on the drive; app-owned chat manifests are refreshed all or nothing (§6.3);
- an app-owned manifest or skill is never renamed or given a new id in place (W-62 (a)):
  `prepare-drive` copies without deleting, so the old and the new file would both stay on a refreshed
  drive as a duplicate id; a retired file leaves a Kit only through §6.3's owned-hash removal. The duty
  rests on the duplicate rule above (the golden scenario `s7-two-usable-one-id`): of two usable files of
  one id, release 1 runs the one whose path comes first in its walk and logs the other on every discovery,
  so a renamed manifest whose new path sorts after the old one is never read by release 1, and one that
  sorts before it silently takes the old one's place; neither is chosen by which file is newer.

**Release rules for the AI engine (F-24).** The marker rules are in [`data-contracts.md`](data-contracts.md)
(the engine install marker, #1028): `binaries` stays a map of relative path (`/`) to lower-case SHA-256
hex of every file of the copy, the program first (a map without the program makes release 1 refuse the
copy at its start); anything new goes into a new top-level field; no key named `version`, `backend`,
`os`, `arch` or `binaries` below the top level; those four stay strings and `version` keeps the
upstream tag shapes; the marker stays one line of UTF-8 JSON, without a byte-order mark or blanks,
with no `{`, `}`, `"`, `,` or `\` inside a key or value, under 64 KiB (the app refuses none of these at a
start, up to its 1 MiB cap; release 1's twins fetch the engine again for a marker over 64 KiB, and the
`.sh` twin with `--commercial` for one spread over lines, the safe direction, frozen per twin, and no
writer writes one; they read past a byte-order mark and past structural characters inside a string; a
comma in a recorded name or a nested `binaries` map hides a gone file from the `.sh` twin's check, as
listed above and in `data-contracts.md`, so a recorded name holds no comma and no `binaries` map is
nested anywhere in the marker). The marker always records the program in `binaries` (Δ-53). In `runtime-sources.yaml`:
families are added as new top-level keys and build fields as new keys; never a new `os` or `arch`
value inside an existing family block (a new `os` value makes release 1 refuse the whole file, and so
run no engine); one block release 1 refuses disables every engine it reads from that file. The
engine folders (§6.6, §6.7): never move, write or delete release 1's `runtime/<family>/<os>/` while
"Go back" to release 1 is offered; a later engine lives beside it; `engine_min` is never above the
oldest pin a supported Kit may run; never move, rewrite or re-sign a recorded file in release 1's
folder (a signing record is a new top-level marker field). **Five more duties release 1's own engine
install relies on** (T8.5c's reviews, F-24's amendment): a later version
1. leaves nothing at the four leftover names (`<os>.new`, `<os>.old`, `<os>/cpu.new`, `<os>/cpu.old`):
   release 1's start recovery acts on exactly those names;
2. puts no link at `<os>`;
3. puts no marker file directly in `runtime/<family>/`;
4. puts no `cpu/…` keys in a main marker;
5. leaves no marker that release 1 would read as damaged in `<os>/` beside a leftover.

**Three more duties the pre-spawn check relies on** (T3.12's two reviews, Δ-61; §6.7 "The pre-spawn
check, as built"; also in [`data-contracts.md`](data-contracts.md)). A later version
1. puts no key into `binaries` that names anything but a file: release 1 counts a recorded folder or
   other non-file as a missing file, so the engines refuse that copy at every start;
2. puts no file under `cpu/`, `cpu.new/` or `cpu.old/` into a main marker, for every family (duty 4
   above, widened): release 1 sets those keys aside as a nested net's, so a main copy's own file there
   would never be checked;
3. records the program under exactly the name release 1 resolves for it (lower case, as
   `llama-server.exe`), and spells every key as the archive spells it: release 1 compares names case
   for case, while a Kit's file system may not (a map that spells the program otherwise is
   `marker-damaged`).

**Release rules for skills (F-25).** The new version bundles its app skills and never rewrites the drive's
`app-skills/` (W-24, §6.2), so release 1 always meets the skills its Kit shipped. A skill of a new
`kind` reaches release 1 only as a user skill; one that declares a well-formed
`compatibility.minAppVersion` (exactly `MAJOR.MINOR.PATCH`) above release 1 is counted as made for a
newer version, any other is invalid there. A `minAppVersion` is always plain `MAJOR.MINOR.PATCH`:
release 1 calls a skill with a suffixed, `+build`, `v`-prefixed or four-part minimum invalid, for ever,
and reads a part with a leading zero as its number. New frontmatter keys
freely. A new `disabled_reason` value is left alone by release 1 (the row stays off); only
`min_app_version` is ever switched back on. Further duties, from the code as built (T2.7's F-23/F-25
reviews, `f23f25-disposition.md`; T2.14's review 2, R2-1 (d)):
- the minimum lives at exactly `compatibility.minAppVersion`, in `---` YAML frontmatter, in one
  spelling: a top-level `minAppVersion` or `min_app_version` is an unknown key and the skill is used,
  and with both spellings inside `compatibility` the camel-case one wins (MJ-6; the both-spellings case
  rests on an ordinary probe, not a golden);
- a new value of a closed set release 1 reads (an `analysis` mode, a tool, a permission value) only
  behind `minAppVersion`: release 1 otherwise accepts the skill and drops the value, so it runs as
  plain instruction text without the mode, tool or permission it was written for (MJ-3);
- a skill a later version wants release 1 to call "made for a newer version" has frontmatter release 1
  can parse and a well-formed minimum; as an import package it stays inside release 1's other limits
  (1 MiB per file, 200 files, 8 MiB in all, an archive stored or deflated, no ZIP64), since only the
  file-type and depth checks give way to `needsNewerApp` (R1 re-check N-1); a known-kind package with a
  minimum above and a `.js` beside it reads "needs a newer version" too (N-2);
- a later version writes a `disabled_reason` whenever it switches a skill off: release 1 reads an app
  row that is off with a `NULL` reason, never written since, as its own version gate's, and switches
  it on at a known app version (R2 M-3);
- the columns release 1 rebuilds from a folder it can read (`title`, `version`, `kind`, `source`,
  `path`, `trusted_level`, `manifest_json`, and `unavailable_at` cleared) are a cache, never the place
  of a decision; among enabled, available rows of one declared id release 1 keeps one on and switches
  the others off as `duplicate`, which it never undoes; it deletes any `user-skills/.skill-import-*` and
  `.skill-backup-*` folder older than an hour at every reconcile; a column a later version adds needs a
  default, and a side table keyed by `install_id` tolerates an orphan, since release 1 deletes a user
  row outright (R2 m-3);
- `manifest_json` keeps `compatibility.minAppVersion` for a skill only the later version bundles, so
  release 1 can show "Needs newer app" instead of "Files missing" for its row (R1 MN-7);
- a later version's reconcile clears `unavailable_at` on a row release 1 marked for a newer-version
  folder, and never reads that mark as "the user's files are gone" (R2-1 (d));
- `skills.path` stays a bare folder name and `skills.source` `app` or `user`: release 1 removes files
  only for such a `user` row, and leaves them for any other (R2 M-2 as fixed);
- a skill is never renamed or given a new id in place (W-62 (a)): of two folders of one id, release 1
  gives the row to the first in sort order whatever their versions (an ordinary row,
  `skills-registry.test.ts`, not a golden; R1 MN-5), and a user skill with a new id comes back off as
  `unconfirmed` (MN-6).

**The scripts (W-62 (b), built in P2).** `fetch-models` and `verify-models` (both twins) skip a manifest
whose `role` their checkout's app does not know or whose `min_app_version` is above the checkout's
`apps/desktop/package.json` version, by the app's exact rule (never a `[version]` cast), each with
one line ("SKIP <id>: needs a newer HilbertRaum (…)"); `fetch-models` adds the count to its summary
line and exits 2 on `--only` of a model only such a manifest carries; `verify-models` prints the count,
judges no file of a skipped manifest (so `--strict` ignores its weight), leaves it out of
`config/checksums.json` (`--generate`), and fails `--kit` on any skip, so a sold Kit is never silently
smaller (the canonical gate refuses the same drive). They read the two keys at column 0, past a CRLF
and a leading byte-order mark; a `role` that is no string they skip as newer (the app drops such a
file; neither uses it). Both twins find a manifest whose extension is in any case (`.YAML`), as the app
does: the `.sh` twins match it case-blind since T2.7's fix round (MJ-5). They never validate a
manifest: one the app drops (a duplicate key, two documents, a merge key, a new enum value with no
minimum, `withdrawn: true`) they verify and plan to fetch, and the gate tool refuses it on a Kit (MN-2).
`committed-catalog.test.ts` holds the scripts'
flat read of every key they read to the YAML parser on every committed manifest; `script-drift.test.ts`
holds their role list to the app's and names the version source.

**Still owed:** the per-pull-request run of release 1's reader snapshot (§10.1) over every committed
manifest, skill and yaml block (T11.7, P11b); a change that makes release 1 drop a file fails it unless
the file carries `min_app_version` (manifests) or is a new kind bundled only (skills).

---

## 7. Workspace guards, the last-writer stamp, migrations

_Status: P2 as built (the vault guard and the start-path fixes from master, reviewed and fixed in P2;
the stamp of §7.4, the old-reader behaviors of §7.6 and the duty list of §7.7 built in P2), and P10
(planned). The goal: release 1 refuses what it cannot read, never damages what a
newer version wrote, says honestly when an upgrade failed, and records what a newer version needs to
know._

### 7.1 Done on master and frozen as built

- **The vault-format guard** (F-9, W-8, #845, PR #880) and **a newer working copy is kept** (W-66, #985,
  PRs #989 and #1007, with #973, #974 and #1001): §7.2.
- **An honest open failure** (#844, PR #871): a workspace that could not be opened answers
  `vault_open_failed` ("… The encrypted workspace on the drive was left as it was …"); "damaged" only for SQLite codes 11 and 26; a failed open
  never rewrites the `.enc`.
- **Why a skill is off** (#846) and **a model for a newer version** (#847): §6.11.

### 7.2 The vault-format guard, as built (F-9)

Recorded in full in [`security-model.md`](security-model.md) (the vault descriptor, the password
change, the working files) and [`data-contracts.md`](data-contracts.md) (the schema stamp). In short:
- a descriptor `version` above 2 (a number or a numeric string) is "newer" before any shape check; a
  known version with an unknown `kdf.algo` is "newer", and so is a key-derivation parameter above
  release 1's upper bounds (T2.9 R1-6; the bounds, lowered in P2's security round, are in §7.7); a
  rekey journal `version` above 1 is "newer" (`readVaultDescriptorChecked`, `vaultFormatVerdict`);
- the frame of `.enc` and of each stage a recovery would swap in: `HRAUMEN` followed by ASCII `2`–`9` is
  "newer", any other eighth byte is damage (`classifyFrameMagic`). **D-1, as built (PR #1030):** the
  stages read are the staged database, the `documents/` and `images/` stages found by scan (not behind
  a store folder that is a link, T2.9 R2-3), and the journal entries the start may act on, inside the
  workspace folder with no link on the way (`stagedRekeyFiles`). An entry outside the folder, or
  reached through a link, is not read for the verdict: a stage there in a newer frame is left with its
  journal at the unlock, and the unlock goes on (`finishOutOfStoreStages`);
- a plaintext working copy or `.recovery` whose header `user_version` exceeds the app's schema version
  is "newer", after three header checks that answer "no database" or "damaged" first (the magic, the
  page size, the schema format number: `probeDatabaseFile`, pinned by `unit/db-probe.test.ts`, "a file
  stamped above this build with %s: the header is judged before the stamp (F-27)");
- at the unlock, an open that SQLite calls damaged on a decrypted file whose stamp reads above this
  build's is "newer", never "damaged" (T2.9 R1-1; `openFailure`); without a higher stamp, a schema this
  SQLite cannot parse is W-68's own answer (§7.6);
- with anything newer, nothing is written, shredded or renamed; the answer is the existing
  `workspace_newer` with its copy (X01, §7.6). "Nothing written" holds after the judgements before it:
  at the unlock the rekey recovery and the #973, #1001 and #1027 checks of stages in doubt run first,
  and may delete or swap stages (T2.9 R2-9).
- **D-2, as built (#1027, PR #1031):** a staged database no journal entry vouches for rolls forward at
  the unlock only while it opens under the data key **and `.enc` does not**. When `.enc` opens under that
  key too, the stage is deleted (`superseded`) and the unlock opens `.enc`; a delete that fails leaves it
  (`left`), and the lock of that session deletes it (`resolveStageInDoubt`, `encOpensUnder`). A stage
  that opens can therefore be deleted: the duty this puts on later writers is in §7.7 ("Never `.enc`
  and a waiting database stage under the same data key").

### 7.3 The vault start path (G-43)

- **(a) A start whose journaled swap fails still serves the update path** (W-82, #1015 and #1024, as
  built on master: PRs #1030 and #1034). The start runs through a guarded runner; on a throw it logs a file
  error as its code and system call only, never its message (#956), and any other error with its message,
  removes the channels the partial start registered, and answers
  `start_failed` with a cause (`drive_not_writable`, `drive_full`, `other`). The update channels join
  that state (§3.5), and `update.log` records the failure's class (§8.2).
- **(b) The rekey journal is acted on only inside the workspace** (W-83, #1014, as built on master: PR
  #1030). A staged entry is acted on at the start only if it ends `.enc.new`, is a full path (on
  Windows with a drive letter or `\\`; T2.7's security round, `fullPathEntry`) and lies inside the
  workspace folder with no link on the way; every other entry is left and counted, and one that is not
  a full path is judged as outside (left for the unlock). An entry outside by its text is never touched
  on the disk, no `stat` and no `realpath` (T2.16 R1 B-4). The journal `version` stays 1. A staged
  database no admitted entry vouches for is left by the start for the unlock, which judges it under the
  data key (D-2, §7.2: `stageInDoubt`, `resolveStageInDoubt`).
- **P2's fix rounds of the start (T2.16; T2.7's security round)**, as built in `workspace-vault.ts`:
  - the workspace folder, the `logs/` folder and the `config/` folder are each tested for a link to a
    folder elsewhere (`folderAtItsName`, `configFolderLinked`). Behind a linked workspace folder the start
    runs no sweep, no stage scan and no rekey recovery; behind a linked `logs/` it removes no rotated log;
    behind a linked `config/` it neither writes nor removes the #875 marker. Each is noted in one
    content-free log line naming the folder kind (`linkedStartFolders`). Two steps still run behind a
    linked workspace folder: the salvage, which can rename a working file to `.recovery` (and shred an
    older `.recovery`) before any password (T2.15 R2 N-1), and the ZIM transient sweep, which removes
    only the app's own `library.<n>.xml` and `meta-<n>/` names (T2.7 security note). The passes after
    the right password run as before: they replay the journal's admitted entries with no key check
    after a database stage in doubt is settled (`recoverPendingRekey`, `applyPendingRekey`; T2.15
    re-check R1 N-3 = R2 N-2);
  - `folderContainment` compares `realpathSync.native` of a folder with the path expected under the base,
    so any reparse point that leads elsewhere reads `outside` (T2.16 R1 B-1);
  - the #911 salvage replays a `-wal` only into a regular file with one name that resolves inside the
    workspace (`replayMayWrite`, T2.16 R1 B-2); a staged entry whose name is a link or has a second name
    is left with its journal (R2 B4); a folder or link at `rekey-journal.json.corrupt` is never
    removed, and the journal goes to the first free `.corrupt-<n>` (R2 A1);
  - every write temp of the vault, and the log's, is created anew after whatever was at its name is
    removed by `lstat`, never through a link (`openWriteTemp`, used by `encryptFile`, `decryptFile`,
    `writeVaultDescriptor`, their async twins and `logging.ts`); the create refuses to open a database
    name that is a link or has a second name (`createMayOpenDatabase`), and on a build that allows no
    plaintext workspace it opens no database it finds: it sets the leftover files aside first
    (`setLeftoversAside`, §7.7 "Nothing of a later version's own under a name release 1 deletes or
    replaces").
- **(c) A documented residual** (G-43 (c)): a spent newer `.recovery` that is older than `.enc` stays on
  the drive unencrypted after a release-1 unlock. It needs a newer version that crashed while locking
  and then a "Go back"; it holds the user's own data on the user's own drive, and the newer version's
  next unlock removes it as spent (`unlockEncryptedVault`'s #985 branch keeps it only until then, or until
  a later failed lock's salvage replaces it). "Older" is judged by file time alone, so a copy or restore tool that
  gives `.enc` a later time makes a fresh newer copy read as spent (T2.9 R2-8).
  [`known-limitations.md`](known-limitations.md) records it, with the other limits of P2's reviews.

### 7.4 The last-writer stamp (G-9 (a), F-10)

As built in P2 (T2.2, in `main/services/db.ts`; CF-3 answered at P2's entry, Δ-P2-3):
- Release 1 creates a key–value table `schema_meta` (`key TEXT PRIMARY KEY, value TEXT NOT NULL`,
  `SCHEMA_META_DDL`) if it is absent and never deletes a key or a table it does not know.
- It writes **exactly one** key of its own, `last_writer`, and overwrites the whole value at every open
  (never "only when it differs"): `<app version>;<applied_through>` (`stampLastWriter`). `<app version>`
  is the app's `package.json` version (`app.getVersion()`, set once by `main/index.ts` before any
  database opens: `setStampAppVersion`); `<applied_through>` is a token without `;` whose meaning the
  migration framework defines (T10.3). Until P10 lands it is the constant `LAST_WRITER_APPLIED_THROUGH`
  (`interim`), which never ships: there is no release before release 1. `applied_through` is never a
  key of its own, and release 1 never sets `application_id`. Every other key name belongs to later
  writers (W-49); where the framework keeps its ledger of applied steps is T10.3's decision.
- The stamp is one transaction of its own after the refusal checks and the migrations, best effort: a
  failure is rolled back and reported as a content-free code (SQLite's code, a Node code,
  `no-app-version`, `stamp-ignored` for a write a trigger skipped, `stamp-in-transaction`), logged by
  the caller, and never fails the open. A stamp that failed at the open is tried once more at the lock,
  before the re-encryption, and at the exit lock (T2.2's fix round); a session that crashed keeps the
  stale value.
- A reader splits the value at the first `;` and reads anything outside the grammar (over 256
  characters, not printable ASCII, a space, an empty field) as "unreadable", never as an error
  (`parseLastWriter`). The value is a hint, never proof of who wrote last (§7.7).
- Every open writes now, so a second open of the same version leaves the file byte for byte only when
  the stamp already holds this build's value (a same-value upsert in WAL mode writes no frame; T2.2 S1).
- **Frozen for every later version:** `schema_meta`'s columns, primary key and constraints never change,
  and no later version puts a trigger on it; later versions add tables of their own. The golden fixture
  `tests/fixtures/schema-meta/` holds the table text, the row shape and the value grammar.
- The unlock line of `update.log` (as built in P3, T3.10; §5.3, §8.2) passes the value found before the
  overwrite (`previous`) through `parseLastWriter` and logs only the parsed, bounded fields (`writer`,
  `applied`): the unlock now opens through `openDatabaseWithStamp` (CF-23's P3 half).

### 7.5 The database version number and the oldest workspace (M-D1, M-D2)

- The workspace database's `user_version` means **"the oldest app that may open this"** (M-D2): today's
  rule, under which 0.1.60 and later refuse a workspace whose number is above their own
  ([`drive-layout.md`](drive-layout.md), "Updating a drive"). It is bumped only for a change an older
  build must not open.
- **v0.1.50**, the first public release, is the oldest workspace a new version must upgrade (M-D1); the
  history fixtures run from it to the latest release, v0.1.66 included.

### 7.6 Old-reader behaviors that only release 1 can provide

Each one ships in the oldest sold version because only that version meets the case. As built in P2,
except W-70 and W-68's startup-line half, as built in P3, and the part of W-68 marked P11b.

The ids C01–C09 and X01–X03 name texts of the app-update copy deck (a working paper outside the repo)
by their catalog keys: C01 `main.workspace.schemaUnreadable`; C02 `common.newerVersionText`; C03 and
C04 `packs.state.newerFormat` and `packs.state.newerFormatTitle`; C05 `packs.addFailed.newerFormat`; C06
and C07 `skills.reconcile.needsNewerApp.one` and `.other`; C08 `analysis.newerExtractorNote`; C09
`main.models.activeUnavailable` (P3); X01 `main.workspace.newer`; X02 `models.newerApp.hint`; X03
`skills.incompatible.title` (the same text as `main.skills.incompatible`).

- **A user skill for a newer version says so** (W-65, T2.14): a skill that fails validation while its
  frontmatter parses and carries a well-formed `compatibility.minAppVersion` above the running version
  is filed as `needsNewerApp` instead of the validator's messages (`failedSkillNeedsNewerApp`,
  `shared/skill-manifest.ts`; `discoverSkillsInDir`, `skills/registry.ts`). Settings → Skills counts such
  folders apart (`SkillReconcileStatus.needsNewerAppCount`) and says so in C06/C07 ("{count} skill on
  this drive was made for a newer version of HilbertRaum and is skipped. To use it, install the update
  in Settings → Updates."); the import preview and the install answer X03's text; an installed row whose
  folder now holds one shows "Needs newer app", not "Files missing" (§6.11). The start's log counts
  them apart from the folders it could not read (`main/index.ts`).
- **A schema this version can't parse says so** (W-68, T2.14): an unlock whose password verified and
  whose decrypted database fails with SQLite's "malformed database schema" (a CORRUPT code), on a file
  whose stamp is not above this build's, answers `workspace_schema_unreadable` with C01 ("Your password
  is correct, but this version of HilbertRaum can’t read the workspace. It was probably last used with
  a newer version. Your workspace is unchanged. …") instead of the damage copy (`sqliteSchemaUnreadable`,
  `db.ts`; `VaultSchemaUnreadableError`, `workspace-vault.ts` `openFailure`; `registerWorkspaceIpc.ts`).
  The decrypted copy is shredded, `.enc` and the descriptor stay byte for byte, the log and audit lines
  carry fixed words only. Unlock only, never the create form. Limits: the plaintext open
  (`openPlaintext`, a developer workspace) opens its database outside `openFailure`, so a malformed
  schema there never reaches C01 (T2.14 decision 6); damage inside a schema row's own text reads the
  same way (the deck's accepted point 1); the classifier's proving row runs on vitest's SQLite, so the
  phase exit's real-app unlock is its proof on Electron's (R1-7). **As built in P3**: release 1's SQLite
  version is in the startup line (`sqlite=`, from `process.versions.sqlite`, T3.2, §5.3), and the unlock
  line records a `workspace_schema_unreadable` refusal (T3.10, §8.2). **Still planned:** that version in
  the frozen register at the Kit tag, and from the first update on a per-pull-request check that runs
  every `CREATE` and `ALTER` text of the database code on exactly that SQLite (P11b).
- **Persisted message values** (W-69, F-26, T2.12): `shared/persisted-messages.ts` holds the keys whose
  English the workspace stores, an append-only alias table (`PERSISTED_ALIASES`, empty today) and the
  parser. The committed fixture `tests/fixtures/display-map/values.json` holds every English value each
  key ever had, oldest first, the seven keys release 1 acts on marked `actedOn`; it is in the golden
  manifest. Release 1's lookup also reads the coded form `hr:<key>?<name>=<value>&…` (whole string,
  percent-encoded values), maps a key it knows, and shows C02 ("This text comes from a newer version of
  HilbertRaum, and this version can’t show it.") for one it does not (`renderer/lib/displayMap.ts`).
  Release 1 originates no code. The grammar and the duties are in §7.7 ("Stored messages").
- **"Go back" leaves release 1 a state it can read** (W-70, as built in P3: T3.11 and its fix round,
  with the owner's rulings of 2026-11-25; T2.7's F-23 review 2, m-1, found the Home half):
  - **The stamp.** With `gpuAutoDisabled` release 1 stores the engine build it was set under:
    `gpuAutoDisabledEngine` = `{ version, backend }` from the install marker of `runtime/llama.cpp/<os>/`,
    or `null` when that is unknown; written before the flag in the same write, and rewritten on every
    set (`createGpuFailureRecorder`, `ownEngineBuild`, `runtime/gpu-failure.ts`). The own build is what
    that folder holds, not what the app pins.
  - **The re-arm.** At every session start (unlock, create, the plaintext start, after a healed "Check
    again"), after the #530 clear, release 1 clears a set flag, with its stamp and `gpuLastError`, when
    its own build differs from the stamp in `version` or `backend`, as exact text, not F-24's order
    (`healEngineLoadState`, `rearmGpuForOtherEngine`, `engine-health.ts`). A wrong re-arm costs one
    failed GPU start, which sets the flag again with this build's stamp.
  - **When the flag stays:** a missing or unreadable stamp, which is every workspace flagged before
    release 1 (owner: kept, so no GPU failure surprises the first start after the update; "Try GPU
    again" still clears it); an unknown own build (no marker the app can read, an `unreadable` one
    included, or a developer binary outside the folder); no engine.
  - **The clears.** "Try GPU again" and the #530 clear also clear the stamp, with no audit event. Every
    clear writes the flag first and the stamp last (the settings store writes key by key, with no
    transaction), so a write cut short leaves at worst a stamp beside a false flag, never a set flag
    without its stamp, which would never re-arm (T3.11's review R1-2).
  - **One Kit on two systems** (owner, 2026-11-25: "the Mac gets its GPU back"): the same engine version
    built for another system is another build (Metal against Vulkan), so a flag set on a Windows or Linux
    computer is re-armed on a Mac and the other way round; back on the first computer the card is tried
    once more, fails, and the workspace falls back to the processor by itself, after every visit to the
    other system. A known limit, pinned by a row; the stamp keeps its two fields and names no system; a
    per-computer flag would be the real fix (a follow-up candidate).
  - **C09.** After unlock, create or the plaintext start, the auto-start names an active model this
    version cannot list with C09 in the notice bar (`main.models.activeUnavailable`: "{model} isn’t
    available in this version of HilbertRaum, so it wasn’t started. Choose another model on the AI Model
    screen.", with "Go to AI Model"), once per unlocked session. "Cannot list" means that no entry of
    `discoverManifests().manifests` has the id (an id listed only under "Needs a newer HilbertRaum"
    included) and that the walk can say so: the id is in the walk's `unsupported` list, or the walk
    reported no error at all (`activeModelUnlisted`, `registerModelIpc.ts`). The auto-start then starts
    nothing, keeps `activeModelId` byte for byte and writes nothing: no settings row, no audit event, no
    `update.log` line.
  - **Not C09:** a listed model whose file is missing or whose role is another, a missing or unreadable
    definitions folder, a stored id that is not a string, and every manual start (today's behaviour:
    `main.models.unknown` for a manual start). The "no errors" rule is the conservative one (T3.11's S-1,
    accepted): the walk does not tell a read error from a parse, validation or duplicate error, so an id
    that no definition names gets no C09 while any other definition on the drive is invalid or a
    duplicate; the `unsupported` clause keeps the "Go back" case. With the auto-start switch off there
    is no notice at all, while Home still shows its no-model state (T3.11's fix round, S-3).
  - **Home.** For such a model Home shows its existing no-model state ("No model selected yet", the badge
    "Needs a model" and "Choose a model") instead of "Getting ready…" and the badge "Starting", from
    `AppStatus.activeModelUnavailable`, worked out once per unlocked session and model id (owner,
    2026-11-25: no new copy).
  - **Recorded limits** (also in [`known-limitations.md`](known-limitations.md)): on the plaintext start
    (developer builds only) C09 may reach no window, since the notice channel is not replayed, while
    Home's state still shows (T3.11's S-3); a C09 banner is dropped, like every `'models'` notice, when the
    chat engine's verdict heals in the same session; the flag carries an engine stamp, still no machine
    stamp. The data contracts are `AppSettings.gpuAutoDisabledEngine: EngineBuildStamp | null`
    (main-owned) and `AppStatus.activeModelUnavailable?: boolean`
    ([`data-contracts.md`](data-contracts.md)); the later-writer duty is in §7.7 ("Settings").
- **A knowledge pack in a newer ZIM format says so** (W-71, T2.14): release 1 reads the ZIM major version
  (a `uint16` at offset 4; `readZimHeader`, `zimFormatTooNew`, `ZIM_MAX_READABLE_MAJOR = 6`,
  `zim/identity.ts`). Above 6 a file is never handed to `kiwix-manage` or `kiwix-serve`: Add refuses it
  with C05 ("This archive uses a newer ZIM format than this version of HilbertRaum can read, so it
  wasn’t added. …"; add reason `newer-format`); a known row whose file is now such an archive is stored
  `unavailable_reason = 'newer_format'` and shows the chip "Newer format" (C03) with C04; a file on the
  drive no row knows gets no row; a chat turn records the outcome `newer-format` ("not searched: newer
  ZIM format"). A restarted `kiwix-serve` resolves the packs again first (T2.14 R1-1); the library file
  is not read again at the hand-off, so a file swapped between the resolve and the serve is not caught
  (R1-2).
- **Extractor versions** (G-34 (a), W-72, T2.13): release 1 re-extracts a bank statement or invoice only
  when its `extractor_version` is `NULL` or **lower** than its own (11 and 13). Equal is current; any
  other value (higher, a real, text) is a newer version's: its rows are served as they are, with C08 as
  the last line of every answer that shows them, never replaced or deleted by an extraction, and nothing
  that hangs off them is deleted by one (`EXTRACTOR_VERDICT_SQL`, `extractorVerdict`, `holdsNewerExtraction`,
  `skills/run.ts`; the document's delete and re-index still remove them, §7.7 "Extractions"). A
  deliberate rollback of a bad extractor ships a higher-numbered one.

### 7.7 Duties of every later writer of workspace data (F-27, W-64)

Release 1 is the oldest version that will ever open a workspace, and after a "Go back" it opens one a
newer version wrote. Its code can never be changed in the field. Each line below is a rule that code
relies on for ever: what release 1 does, and what every later version must therefore do or never do.
The list is frozen at M1 (F-27).
[`data-contracts.md`](data-contracts.md) ("Workspace data: duties of every later writer") holds the
same list in short form.

How to read a line: **Code** names the file and function release 1's behavior lives in, below
`apps/desktop/src/`. **Proof** names the test that pins it, below `apps/desktop/tests/`, by file and
row title. The bracket at the end names the source of the duty: "F-27 review" is the first review of
the list as T2.11 wrote it, "F-27 R1" and "F-27 R2" its two later reviews (each duty against the code;
what the list missed), all P2 working papers outside the repo. "The stamp" is the database's
`PRAGMA user_version`; "the data key" is the key a version-2 descriptor wraps. File names are those of
the workspace database, `hilbertraum.sqlite`.

Not here: the five duties release 1's own engine install relies on (F-24: leftover names, links and
marker files under `runtime/`) are in §6.11 ("Release rules for the AI engine"). The frozen rules of the
`skills` table (F-25: `disabled_reason`, the reconcile, the columns release 1 rebuilds), which are
workspace rows too, are in §6.11, except W-65's line in the group "Knowledge packs and skills" below.

**The database schema and SQLite**

- **Foreign keys onto release 1's tables never refuse a delete.** Release 1 opens the database with
  foreign keys on and deletes its own rows directly: a document with everything derived from it, a
  conversation with its messages, a project, a review, a statement, an invoice. A key that refuses such
  a delete makes it fail for the user, every time. A later version gives every foreign key onto one of
  release 1's tables `ON DELETE CASCADE` (or `SET NULL`), and keeps what must outlive release 1's
  delete in a table with no foreign key onto release 1's rows (see "Extractions").
  Code: `main/services/db.ts` `applyPragmasAndMigrations`; `main/services/ingestion/index.ts`
  `deleteDocument`, `purgeDocumentDerivatives`; `main/services/chat.ts` `deleteConversation`.
  Proof: `integration/document-delete-derivatives.test.ts`, "TEETH: without the ordered cleanup, the
  un-cascaded FK blocks the delete"; `integration/collections.test.ts` (the version-skew cascade rows).
  [W-64]
- **Release 1's own statements keep succeeding.** Release 1 writes its tables with explicit column
  lists, and at every open it creates again any of its tables, columns and indexes that is missing
  (`CREATE TABLE IF NOT EXISTS`, `ensureColumn`). A change to one of its tables can therefore break its
  writes every time: a `NOT NULL` column with no default, a `UNIQUE` index its rows can violate, a
  `CHECK` or `STRICT` typing its values can fail, a trigger that raises. A table of its own that is
  dropped or renamed comes back empty, and so does a column it adds by `ensureColumn`: release 1 reads
  `NULL` there and writes there. A column of a table's first definition does not come back (the table
  is there, so nothing is created): release 1's statements that name it fail with "no such column", and
  when one of its indexes names it, the open's `CREATE INDEX IF NOT EXISTS` fails and every unlock
  answers "Could not open". So does an object of a later version under one of release 1's names in
  another kind: a view left at the name of one of its tables (`CREATE TABLE IF NOT EXISTS` passes over
  it, then `CREATE INDEX` and `ALTER TABLE` fail), or a table, index or trigger at the name of one of
  release 1's of another kind. Below a higher stamp a later version changes release 1's tables only by
  adding columns that are nullable or have a default, adds only tables, indexes and triggers release
  1's writes cannot trip, and names none of them as release 1 names its own. Anything else ships with
  a higher stamp (the line on schema text, below).
  Code: `main/services/db.ts` `SCHEMA`, `ensureColumn`, `applyPragmasAndMigrations`; the `INSERT`
  statements of `main/services/ingestion/index.ts` and `main/services/chat.ts`.
  Proof: `unit/db-user-version.test.ts`, "an existing pre-stamp database (version 0) upgrades in place;
  every later open writes the stamp again, never user_version" (the re-creation); no row yet feeds a
  later version's constraint to release 1's writes, drops a column of a first definition or leaves a
  view at a table's name (the view case was probed on Node 24.13.0's SQLite in the review). [F-27
  review M-4; F-27 R1 m-2, R2 m-6]
- **Times in release 1's columns are `toISOString()` text.** Release 1 writes the times it stores (its
  `created_at`, `updated_at` and other `…_at` columns, all `TEXT`) as `new Date().toISOString()`
  (`2026-11-25T10:00:00.000Z`) and orders and compares stored times as
  text: the turns of a chat ("`messages` rows keep their rowids"), a document's newest statement or
  invoice ("A document's newest row is the newer version's"), the activity log it prunes
  ("`runtime_events` is a short log"), the reset of work left in progress (`updated_at < ?`). A later
  version writes every time in a column release 1 reads in that form: another form sorts out of turn
  in release 1, so a row is reset, served or pruned when it should not be.
  Code: `main/services/chat.ts` (the turn queries, `ORDER BY created_at, rowid`);
  `main/services/skills/run.ts` `latestBankStatementId`; `main/services/audit.ts` `pruneAuditEvents`;
  `main/services/ingestion/index.ts` `reconcileStuckDocuments`. Proof: none for a time in another form.
  [F-27 R1 m-8]
- **Nothing in a schema object release 1 meets that its SQLite lacks.** Release 1 runs every statement
  on the SQLite built into its own runtime (the version is recorded at the Kit tag, §7.6). A trigger,
  generated column, `CHECK` or index expression on a table release 1 reads or writes runs inside
  release 1's own statements, so a function its SQLite lacks fails them. The same holds for a
  collation, a virtual-table module and an FTS5 tokenizer. In an index expression, a partial index's
  `WHERE` or a generated column, SQLite may resolve the name when it loads the schema, and the whole
  database then reads as damaged (the next line). A later version uses none of these.
  Code: `main/services/db.ts` `openReadWriteConnection`. Proof: none yet; the per-pull-request check of
  §7.6 (W-68, P11b) runs the schema texts on that SQLite, and confirms which case fails where. [W-64]
- **Schema text release 1's SQLite cannot parse ships only with a higher stamp.** Release 1 tells a
  newer database from a damaged one by one thing: the stamp is above its own (1). It reads the stamp
  from the file header before SQLite parses anything. Without a higher stamp, a schema its SQLite
  cannot parse fails every read of the schema: release 1's unlock refuses the workspace with
  `workspace_schema_unreadable` and C01 (W-68, §7.6), and its start discards a failed lock's working
  copy as damaged, so that unlock then says "Your workspace is unchanged" under the "changes were lost"
  notice (T2.14 R2-7: the known result of breaking this rule). A later version ships such text (a newer clause in
  a table, an index, a trigger or a generated column) only together with a higher stamp. It raises the
  stamp only for a change release 1 must not open (§7.5): this one, a file-format change (the next
  line), and a change release 1's own statements cannot survive (the line on its own statements,
  above). Above its own stamp release 1 opens nothing.
  Code: `main/services/db.ts` `SCHEMA_VERSION`, `probeDatabaseFile`, `applyPragmasAndMigrations`;
  `main/services/workspace-vault.ts` `openFailure`, `preserveNewerPlaintext`.
  Proof: `integration/workspace-newer.test.ts`, "encrypted: a newer database whose schema this SQLite
  cannot parse is refused as newer, never damaged; every file byte for byte";
  `integration/workspace-vault-format-guard.test.ts`, "a working copy or .recovery a newer build stamped
  is kept, never discarded (#985)"; `integration/workspace-ipc.test.ts`, "an unlock whose schema this
  SQLite cannot parse answers workspace_schema_unreadable with fixed log and audit words (W-68)".
  [W-64, #985; T2.14 R2-1 (e)]
- **A database file release 1's SQLite refuses to open also carries a higher stamp.** The same rule for
  the file format: header byte 19 (the read version) above 2, or any other SQLite-level format change,
  is "newer" to release 1 only through the stamp, and "damaged" without it.
  Code: `main/services/workspace-vault.ts` `openFailure`; `main/services/db.ts` `probeDatabaseFile`.
  Proof: `integration/workspace-newer.test.ts`, "encrypted: a newer database in a file format this
  SQLite refuses (header byte 19 above 2) is refused as newer, never damaged". [F-27 (f)]
- **Three header fields no stamp excuses.** Release 1 judges them before it reads the stamp: the file
  starts with the 16 bytes `SQLite format 3` and a NUL and is at least 100 bytes long (else a working
  copy or a `.recovery` is "no database", and release 1 shreds it as a leftover; a decrypted `.enc`
  without them reads as damaged); its page size is a power of two from 512 to 65,536; its schema format
  number (header byte 47) is at most 4 (else "damaged"). A later version never writes a workspace
  database outside these three.
  Code: `main/services/db.ts` `probeDatabaseFile`. Proof: `unit/db-probe.test.ts` pins "no database"
  (an empty file, noise, the magic alone) and a schema format above 4 as damaged, and "a file stamped
  above this build with %s: the header is judged before the stamp (F-27)" pins all three checks, the
  page size included, on a file stamped above release 1's.
  [W-64: "never a schema format above 4"; T2.11 S-2]
- **`ocr_meta_json` keeps `pageCount` and `textPageCount`.** At every open release 1 looks at each
  document that has `ocr_json`. When the sidecar `ocr_meta_json` does not parse with `pageCount` (a
  whole number above 0) and `textPageCount` (a whole number from 0 to `pageCount`), release 1 writes
  the sidecar again from `ocr_json`, with its own six fields only. It also writes the sidecar whole
  when it runs OCR on the document or re-indexes a photo. A later version keeps both fields valid in
  every such sidecar, and expects a field of its own there to last only until one of those writes.
  Code: `main/services/db.ts` `backfillOcrMeta`; `main/services/ingestion/ocr-meta.ts` `parseOcrMeta`,
  `ocrMetaFromJson`; `main/services/ingestion/index.ts` `setDocumentOcr`, `setPhotoOcrMeta`.
  Proof: `integration/ocr-meta-list.test.ts`, "a sidecar written before #576 (blank pages counted as
  recognized) is re-derived at open". [W-64; F-27 review m-11]
- **`last_writer` is a hint in a fixed shape; `schema_meta` never changes shape.** Release 1 overwrites
  the whole `last_writer` value at every open, best effort, and reads a value as "unreadable" (never an
  error) unless it is at most 256 characters of printable ASCII with no space, with a non-empty field
  on each side of its first `;`. A later version writes it in that shape, keeps data of its own under
  other keys (release 1 never deletes a key it does not know), never changes the table's columns or
  puts a trigger on it (§7.4), and never takes the value as proof that no older version wrote since:
  release 1 writes data also when its stamp could not be written.
  Code: `main/services/db.ts` `stampLastWriter`, `parseLastWriter`, `SCHEMA_META_DDL`.
  Proof: `integration/db-schema-meta.test.ts`, "N3: a later build's richer last_writer is overwritten
  whole by one open, and the open hands back the value it found", "N5: a key and a table this build does
  not know survive two opens, value for value", and the "reading a last_writer value" rows.
  [F-27 (g), F-10]

**The vault, the journal and stages**

- **A new vault format is one release 1 refuses.** Before it writes anything, at every start and
  unlock, release 1 refuses as "newer": a descriptor `version` above 2 (a number or a numeric string),
  a `kdf.algo` it does not know, a rekey journal `version` above 1, and a frame that starts `HRAUMEN`
  plus a digit 2 to 9 at `.enc` or at a staged file (`*.enc.new`). It reads the frame of those files
  only. So: a new key derivation is a new `kdf.algo` value; a new frame for the database is `HRAUMEN2`
  to `HRAUMEN9` (any other eighth byte reads as damage), and after those a higher descriptor version.
  A stage in a new frame locks release 1 out of the whole workspace until it is gone. Below a higher
  descriptor version, release 1 checks the descriptor's shape before its `kdf.algo`: `mode`
  `encrypted`, a `kdf` object, a non-empty `saltB64` and `verifier`, and under version 2 a `dataKey`.
  A new derivation that drops one of them (a key wrapped by a device, no salt) reads as an unreadable
  key file, and the unlock asks for it to be restored: such a change raises the descriptor version.
  Code: `main/services/workspace-vault.ts` `vaultFormatVerdict`, `readVaultDescriptorChecked`,
  `stagedRekeyFiles`; `main/services/security/crypto.ts` `classifyFrameMagic`.
  Proof: `integration/workspace-vault-format-guard.test.ts`, "a vault a newer build wrote is refused at
  startup and at unlock, and left byte for byte (#845)"; no row feeds a new `kdf.algo` without one of
  the shape's fields. [W-64, F-9; F-27 R1 m-1]
- **A workspace keeps `config/workspace.json`, whatever its format.** Release 1 knows that a workspace
  exists by two files only, `config/workspace.json` (in any form: one it can read, one it cannot, one
  in a newer format) and `workspace/hilbertraum.sqlite.enc`, or by a stage or journal it refuses as
  newer (the line above). With none of them it reports no workspace and offers to create one,
  in the same folders: its start deletes `hilbertraum.sqlite.enc.new` (the line on stages, below), and
  its create refuses what a newer version stamped at the database's names (#985), sets aside what else
  it finds there on a build that allows no plaintext workspace (`setLeftoversAside`), and writes its
  own descriptor and `.enc` beside whatever else a later version keeps there. A later
  layout that moves or renames both files (a descriptor per profile, a database split in parts) still
  keeps a file at `config/workspace.json` that release 1 refuses (the line above): otherwise a "Go
  back" offers a second, empty workspace over it.
  Code: `main/services/workspace-vault.ts` `WorkspaceController.vaultExistsOnDisk`, `getState`,
  `createEncryptedVaultOnDisk`. Proof: `integration/workspace-vault.test.ts`, "a working database with
  its -wal and -shm and no key file: the create moves the three aside unchanged and starts an empty
  workspace (F-3)"; no row has a later layout without both files. [F-27 R1 M-3]
- **Stored document and image copies stay `HRAUMEN1` while the descriptor version is 2.** Release 1
  does not read the frame of a stored copy (`documents/<id><ext>.enc`, `images/<id><ext>.enc`) at the
  start or the unlock: it opens the workspace. A copy in another frame then fails wherever release 1
  decrypts it. A re-index, an OCR run or "Re-index all" marks that document failed, with an English
  reason, and takes it out of search; its preview and export fail, and that image session does not
  open. A new frame for stored copies needs a descriptor version above 2.
  One exception, benign: beside a stage in doubt the unlock reads the stored copy under the data key
  (`judgeSidecarStage`, `finishOutOfStoreStages`); a stored copy in a newer frame there throws, and the
  stage is left (T2.11 re-check n-4).
  Code: `main/services/workspace-vault.ts` `vaultFormatVerdict` (what it reads), `decryptFileAsync`;
  `main/services/ingestion/index.ts` `prepareDocument`; `main/services/ingestion/engine-failure.ts`
  `failureRowMessage`. Proof: `integration/workspace-vault-format-guard.test.ts`, the row "a staged
  document copy in a newer frame beside a v2 descriptor, no journal" (a stage is refused); no row yet
  feeds a stored copy in a newer frame. [F-27 review M-2]
- **Key-derivation parameters stay inside what release 1 derives under descriptor version 2.** Release
  1 accepts `scrypt` or `argon2id` only inside its bounds: key length 32; scrypt `N` a power of two from
  1,024 to 2^22, `r` 1 to 32, `p` 1 to 16; argon2id `m` 8 to 2^20 KiB (1 GiB), `t` 1 to 8, `p` 1 to 16.
  Inside them it derives only where its two libraries do. Scrypt runs with `maxmem` 256 MiB and needs
  `N` below 2^(16·`r`): it derives exactly when `N`·`r` is below 2^21 and, with `r` 1, `N` is at most
  2^15 (Node's check under OpenSSL is 128·`r`·(`N` + `p` + 2) bytes at most 256 MiB, which for these
  values is the same region; Electron's BoringSSL counts `N` + `p` + 1 blocks, the same region again).
  So `N` 2^17 with `r` 8, or 2^19 with `r` 3, derives, and 2^18 with `r` 8, 2^20 with `r` 2, or 2^16 and
  above with `r` 1 does not. Argon2id (`@noble/hashes`) needs `m` at least 8·`p` (`m` 8 to 127 with `p`
  16 fails) and a salt of at least 8 bytes (release 1 writes 16). The argon2id upper bounds were lowered
  in P2's security round (owner, 2026-11-25), so a descriptor inside
  them cannot keep an unlock attempt busy for many minutes (the worst case inside them measured about
  55 s of main-thread work on the reviewer's box, longer on a slower laptop; T2.7 security re-check 1);
  every descriptor a published release wrote (argon2id `m` 19,456, `t` 2, `p` 1) is far inside them. A parameter above its upper bound reads as
  "newer", refused before anything is written: a later version that needs more raises the descriptor
  version. One below a lower bound, of another type, or another key length fails the unlock as "Could
  not open", after the start's steps have run; its error names the type only. So does a descriptor
  inside the bounds that release 1 cannot derive with: it is not "newer", and every release-1 unlock of
  it fails as "Could not open" after the start's steps and the unlock's rekey recovery have run
  (nothing is lost, and the newer version still opens it). A later version that wants release 1 to
  open the workspace stays inside the region release 1 derives.
  Code: `main/services/security/crypto.ts` `KDF_UPPER_BOUNDS`, `validateKdfBounds`,
  `kdfParamAboveBounds`, `deriveKey` (the `maxmem` of each call). Proof: `unit/crypto.test.ts` (the
  out-of-bounds table); `unit/crypto-argon2-maxmem.test.ts`; `integration/workspace-vault-format-guard.test.ts`,
  the row "a failed lock’s leftovers beside a v2 descriptor whose argon2id m is above this build’s
  bound". No row derives at a value inside the bounds that release 1 cannot derive: the corners above
  were run on Node 24.13.0 (OpenSSL) in P2's docs round; Electron's BoringSSL region follows from its
  memory check and was not run (a named proof gap). [W-64; T2.9 R1-6 as
  built; T2.7 security L-1; F-27 R1 M-1]
- **No field that matters under descriptor version 2 or journal version 1.** Release 1 builds the
  descriptor anew from its six fields (`version`, `mode`, `kdf`, `saltB64`, `verifier`, `dataKey`), with
  its own default key derivation, at every password change, and a version-1 journal anew from its three
  (`version`, `staged`, `remove`) whenever it settles one. A field it does not know is gone after that.
  A later version never adds one that matters there: it raises the version, which release 1 refuses.
  Code: `main/services/workspace-vault.ts` `buildEnvelopeDescriptor`, `rewrapVaultKey`,
  `settleRekeyJournal`, `writeRekeyJournal`. Proof: `integration/password-change.test.ts`, "a legacy
  scrypt vault silently upgrades to Argon2id under DEFAULT_KDF" (the rebuild), "a descriptor field this
  version does not know is gone after a password change (F-27 (d))" and "a journal it rewrites keeps
  only its three fields: one this version does not know is gone (F-27 (d))". [F-27 (d); T2.11 S-3]
- **A stage counts only once its version-2 descriptor is on the drive.** Under a version-1 descriptor
  release 1 rolls every stage back: it deletes each staged file and the journal. With no descriptor, no
  `.enc` and no journal, its start deletes `hilbertraum.sqlite.enc.new` and that file's `.tmp`. A later
  version never relies on a stage before the version-2 descriptor that wraps the stage's data key is
  written (that write is the commit point).
  Code: `main/services/workspace-vault.ts` `recoverPendingRekey`, `discardPendingRekey`,
  `discardOrphanedStage`. Proof: `integration/password-change.test.ts`, "changePassword — crash at every
  journal cut, every ciphertext class (#241)"; `integration/workspace-vault-format-guard.test.ts`, "a
  create cut short leaves its stage on an empty drive: the start removes it, and a workspace put back
  later opens". [W-64: "never stage before the descriptor exists"]
- **Every stage release 1 can roll forward without a key check is under the data key the descriptor
  wraps.** Under a version-2 descriptor release 1 rolls two kinds of stage forward at the start,
  before any password and with no key check: one a journal entry vouches for (it shreds the file at
  the target name and renames the stage onto it), and one no entry vouches for whose target is gone
  (`.enc` missing for the database stage, the stored copy missing for a document or image stage). A
  later version lists in a journal, and leaves beside a missing target, only stages made under that key.
  Code: `main/services/workspace-vault.ts` `recoverPendingRekey`, `applyPendingRekey`, `stageInDoubt`,
  `sidecarStagesInDoubt`.
  Proof: `integration/password-change.test.ts`, "changePassword — crash at every journal cut, every
  ciphertext class (#241)"; `integration/workspace-vault-format-guard.test.ts`, "a stage whose stored
  copy is gone: the start renames it into place, as before". [F-27 (a)]
- **A journal entry vouches only by a full path inside the workspace folder, with no link on the way.**
  To release 1 a version-1 entry lists a stage only when it ends `.enc.new`, is the stage's full path
  (compared resolved, and case-folded on Windows), and lies inside the workspace folder on the disk:
  no folder between the workspace folder and the file is a symbolic link or a junction, or resolves
  elsewhere. An entry by a relative name, under another drive root or through a link vouches for
  nothing: the stage is then judged as journal-less (the next two lines), and a stage outside the
  folder is acted on only at the unlock, when the open database lists its stored copy. A later version
  writes entries only in that form.
  Code: `main/services/workspace-vault.ts` `planRekeyJournal`, `insideWorkspace`, `folderContainment`,
  `pathKey`, `finishOutOfStoreStages`. Proof: `integration/password-change.test.ts`, "rekey journal —
  entries outside the workspace (#1014)"; `integration/vault-start-links.test.ts`.
  [Δ-P2-2 (D-3), #1014]
- **Never `.enc` and a waiting database stage under the same data key.** At the unlock release 1 judges
  a `hilbertraum.sqlite.enc.new` no entry vouches for, beside an `.enc` that is there. It rolls the
  stage over `.enc` when the stage opens under the data key and `.enc` does not. It deletes the stage
  when both open (it reads `.enc` as the newer copy), and when the stage does not open. A later version
  never writes `.enc` under a data key while a stage made under that key still waits beside it, and
  never makes a stage under the key `.enc` already opens with. Either copy can be the one lost: release
  1's unlock deletes such a stage when no entry vouches for it, with whatever only it holds; and its
  start rolls one a journal entry vouches for over `.enc` with no key check, so a newer `.enc` is lost.
  Code: `main/services/workspace-vault.ts` `stageInDoubt`, `resolveStageInDoubt`, `encOpensUnder`.
  Proof: `integration/workspace-vault-format-guard.test.ts`, "a staged database no rekey journal vouches
  for (#973)"; `integration/vault-recovery-guards.test.ts`, "a password change whose staged database
  cannot be moved into place (#1027)" and "a stale staged copy the unlock cannot delete: the workspace
  opens at .enc, and the lock of that session deletes the stage (#1027)". [Δ-P2-2 (D-2), #1027; F-27 (b)]
- **No file named `*.enc.new` in `documents/` or `images/` that is not a stage, under the data key the
  descriptor wraps, of the stored copy of that name.** One no entry
  vouches for: with its stored copy gone, release 1's start renames it into place; beside a stored
  copy, the unlock swaps it in only when it opens under the data key and the stored copy does not, and
  deletes it otherwise (also when its length differs from the stored copy's, or another name shares its
  file).
  Code: `main/services/workspace-vault.ts` `scannedSidecarStages`, `sidecarStagesInDoubt`,
  `judgeSidecarStage`. Proof: `integration/workspace-vault-format-guard.test.ts`, "staged document and
  image copies no rekey journal vouches for (#1001)". [W-64: "never leave a `*.enc.new` release 1 can
  meet unless …"]
- **`hilbertraum.sqlite.recovery` is a plaintext SQLite copy that a failed lock or a crash left, and
  nothing else.** At the unlock, after the password, release 1 does one of four things with a file at
  that name. Stamped above its own and possibly the freshest copy (not older than `.enc` by file time,
  or `.enc` missing): it refuses the unlock and writes nothing after that (the steps before the
  password check, the rekey recovery among them, may have written; §7.2). Stamped above its own and older than
  `.enc`: it leaves the file, unencrypted, and opens `.enc`. A database it can read that is newer than
  `.enc` (or `.enc` missing): it encrypts the file over `.enc` and shreds it. Anything else (older, or
  no SQLite database): it shreds the file. And a start that keeps a working copy first shreds whatever
  is at the name. A later version keeps the file a plaintext SQLite database, leaves one only after a
  failed lock or a crash (it is the workspace unencrypted on the drive), and puts nothing else there.
  Code: `main/services/workspace-vault.ts` `unlockEncryptedVault`, `recoveryMayBeFreshest`,
  `preserveNewerPlaintext`, `keepOnlyCopy`. Proof: `integration/workspace-vault-format-guard.test.ts`, "a
  .recovery newer than .enc: the unlock refuses it before anything is written, every file byte for
  byte" and "a .recovery older than .enc (a spent leftover): the unlock opens the workspace and leaves
  the copy byte for byte"; `integration/vault-recovery-guards.test.ts`, "`.recovery` guards". [F-27 (c),
  (e); W-64]
- **A session that ended without a lock is lost at any release-1 start.** At every start of an
  encrypted workspace where it sweeps (it runs no sweep behind a workspace folder that is a link),
  release 1 shreds the working file `hilbertraum.sqlite`, its `-wal` and `-shm`, and
  `hilbertraum.sqlite.tmp`. It keeps the working file (as `.recovery`) in two cases only. One: the
  file is newer than `.enc`, has no `-wal` or `-shm` beside it and reads as a database. Two: `.enc` is
  missing and no staged `hilbertraum.sqlite.enc.new` file lies beside it; release 1 then first replays
  the `-wal` into the file, and keeps it when it reads as a database (a damaged one is discarded; a
  `-wal` the replay cannot empty, or may not write, blocks the start with nothing removed; T2.11
  re-check n-1). With a staged file there, the stage is the snapshot and the working file is
  shredded. A live write-ahead log beside an `.enc` is shredded whatever the stamp says. A later version
  cannot promise crash recovery on a drive release 1 may still open.
  Code: `main/services/workspace-vault.ts` `WorkspaceController.runStartSteps`,
  `preserveNewerPlaintext`, `keepOnlyCopy`, `shredStalePlaintext`.
  Proof: `integration/workspace-vault.test.ts`, "CODE-1b: a mid-session crash leftover (live -wal/-shm) is still shredded — the documented power-cut
  trade-off" and "#892: live sidecars beside the session’s working file %s: swept as before, and the
  notice". [W-64]
- **The working database stays in WAL mode, and no session relies on `hilbertraum.sqlite-journal`.**
  Release 1 runs the workspace database in WAL mode (every build since before v0.1.50) and tells a
  clean close from a crash by the `-wal` and `-shm` alone. A rollback journal is no name its start
  knows: the sweep leaves a `hilbertraum.sqlite-journal`, and the salvage can keep a working file
  beside one (no `-wal` or `-shm`) as `.recovery` without it. Its unlock shreds the journal before it decrypts
  `.enc`, since SQLite would play it back into that fresh copy at the open's first read (pages of a
  later session mixed into the snapshot, or "damaged" on an intact `.enc`). The one exception is an
  unlock that has just rolled `.recovery` forward: the copy it decrypts is then that kept working file,
  and SQLite plays the journal back into it at the open. A create on a build that allows no plaintext
  workspace sets the journal aside with the working file, its `-wal` and `-shm` (the line on names,
  below: since P2's docs round, before which SQLite deleted it unshredded at the create's open). A later version runs the working database in WAL mode in every session and
  never relies on a `-journal` surviving a release-1 start or unlock: a session it ends mid-transaction
  in another journal mode is lost in release 1, as the line above says of any session that ended
  without a lock, or comes back without that transaction.
  Code: `main/services/workspace-vault.ts` `unlockEncryptedVault` (the `-journal` shred before the
  decrypt), `cleanSidecars`, `preserveNewerPlaintext`, `setLeftoversAside`; `main/services/db.ts`
  `applyPragmasAndMigrations` (`PRAGMA journal_mode = WAL`).
  Proof: `integration/workspace-vault.test.ts`, "a hot -journal a rollback-mode session left beside an
  intact .enc: the unlock removes it first and opens the snapshot, never damaged (F-27 R1 M-2)" and "a
  torn working file with its own hot -journal, kept as .recovery: the unlock rolls it forward and leaves
  the journal for SQLite to play back (F-27 R1 M-2)" and "a working database with a hot -journal, its
  -wal and -shm, no key file (%s): the create sets all four aside together and deletes nothing".
  [F-27 R1 M-2, m-12; T2.D S-b]

**File names in the workspace**

- **No stored file in `documents/` or `images/` has a name that holds `.parse` or ends `.tmp`.** At
  every start of an encrypted workspace where it sweeps (not behind a workspace folder, or one of the
  two folders, that is a link), before any password, release 1 overwrites and removes every file
  directly in those two folders whose name passes one of the two tests; it uses such names only for
  transients. A later version stores nothing it wants kept under such a name, and adds no readable
  file type whose stored copy (`<id><ext>`, `<id><ext>.enc`) would get one.
  Code: `main/services/workspace-vault.ts` `shredStalePlaintext`; `main/services/ingestion/index.ts`
  `prepareDocument` (the stored copy's name); `main/services/ingestion/parsers/index.ts`
  `supportedExtensions`. Proof: `integration/workspace-vault.test.ts`, "shredStalePlaintext sweeps
  crash-left .parse/.tmp transients under documents/ AND images/, keeping stored copies";
  `integration/repo-hygiene.test.ts`, "no stored copy takes a name the start sweep shreds (app-update
  F-27, W-64)", which fails when a readable file type would give its stored copy such a name. The row
  builds the name `<id><ext>[.enc]` itself: it does not bind the naming in `prepareDocument`, and the
  image copies are outside it. [W-64]
- **The stored-copy columns name only that row's own copy.** Release 1 shreds the file those columns
  lead to when it lies in the store folder, with no check that the file is the row's own. Deleting a
  document shreds the copy its resolver finds (`documents/<stored_name>` when `stored_name` is a bare
  name that starts with the row's id, otherwise the file at the recorded `stored_path`) only when that
  file is inside `documents/`, judged from the workspace folder with no link on the way; else only the
  row goes. In an encrypted workspace a re-index that finds a copy in the store whose name does not end
  `.enc` encrypts it to `<that path>.enc`, points the row there and shreds the file it found; a
  plaintext copy outside the store counts as no copy: the re-index imports the original into the store
  again, or fails as its source missing, and writes or removes nothing outside the store. A row whose id
  is not a bare name fails as its source missing before any store path is built. Deleting an image
  session, or clearing the image history, shreds `images/<stored_name>` only for a bare name inside
  `images/`. Behind a `documents/` or `images/` folder that is a link to a folder elsewhere nothing is
  shredded. And every read that finds the copy elsewhere than the row says rewrites `stored_path` and
  `stored_name`. A later version keeps `documents.stored_name` the bare name `<id><ext>[.enc]` of that
  row's own copy, `stored_path` a path to that same file, `documents.id` a bare name, and
  `image_sessions.stored_name` a bare name in `images/` that only that session uses. It never points a
  row at a shared copy in the store: release 1 would destroy it.
  Code: `main/services/ingestion/stored-copy.ts` `locateStoredCopy`, `resolveStoredCopy`;
  `main/services/ingestion/stored-copy-leaf.ts` `canonicalLeafFor`, `storedCopyLeaf`;
  `main/services/workspace-vault.ts` `storeHoldsFile`; `main/services/ingestion/index.ts`
  `deleteDocument`, `prepareDocument` (the id check, the legacy-migration branch);
  `main/services/vision/history.ts` `storedImageToShred`, `deleteImageSession`, `clearImageSessions`.
  Proof: `integration/stored-copy-portability.test.ts`, "T3: shreds the stored copy after the store dir
  moved (privacy, not disk space)" and "T3c: never shreds a file belonging to a DIFFERENT document";
  `integration/image-history.test.ts`, "shreds the stored image and CASCADE-removes its turns" and "a
  row whose stored_name leads out of the store: the row goes, the file it names stays (F-3)";
  `integration/document-delete-derivatives.test.ts`, "a row whose stored_path names a file outside the
  store: the row goes, the file stays byte for byte (F-3)" and the linked-store rows (N-2);
  `integration/encrypted-documents.test.ts`, "a legacy row whose stored_path names a plaintext file
  outside the store: the re-index leaves that file (F-3)" and "a row whose id leads out of the store:
  the re-index writes nothing outside it and the file there stays (N-3)". [F-27 review M-3; the guard
  in release 1, FU-P2-6, built in P2's security round; S-b; N-2; N-3]
- **A later version removes its own orphans.** Release 1 deletes only the files it knows: a document's
  stored copy when the document is deleted, an image session's when the session is. A file a later
  version keeps for a row in a form release 1 does not know stays behind when release 1 deletes the row.
  Code: `main/services/ingestion/index.ts` `deleteDocument`; `main/services/ingestion/stored-copy.ts`
  `locateStoredCopy`. Proof: none yet (`integration/document-delete-derivatives.test.ts` shows release 1
  shredding its own copy, not that it leaves every other file). [W-64: "stored copies are swept by the
  newer version"]
- **Nothing of a later version's own under a name release 1 deletes or replaces.** Beside the names
  above, in `workspace/`: `hilbertraum.sqlite.enc.tmp` and `hilbertraum.sqlite.tmp` (removed and written
  anew by every lock and every unlock: since P2's security round every write temp is removed by its
  name, a link as the link, and created anew, `openWriteTemp`),
  `hilbertraum.sqlite.enc.new.tmp` and `rekey-journal.json.tmp` (removed at every start and unlock),
  at a create on a build that allows no plaintext workspace, a leftover `hilbertraum.sqlite` with its
  `-wal`, `-shm` and `-journal` moved together to the first suffix free for all four (`.quarantine`, then
  `.quarantine-<n>`, n from 1 to 64) and a `hilbertraum.sqlite.recovery` to the first free
  `hilbertraum.sqlite.recovery.quarantine[-<n>]` (never over anything there; with none free the create
  fails and writes nothing; `setLeftoversAside`),
  `rekey-journal.json` (rewritten or removed as stages settle), `rekey-journal.json.corrupt` (a regular
  file there is replaced by a journal release 1 cannot parse; with something else at that name the
  journal goes to the first free `rekey-journal.json.corrupt-<n>`, n from 1 to 64), and in
  `zim-transient/` every `library.<n>.xml` and `meta-<n>/` (removed at the app's start, at lock, at
  quit and at every session start). In `config/`: `workspace.json.tmp`
  (removed and written anew at every create and password change), `working-copy-lost.json.tmp` (removed and written
  anew when release 1 records a lost session), `working-copy-lost.json` (replaced when release 1 records
  one, and removed once it reads as release 1's own: `"v": 1` with a text `enc`). In `documents/` and
  `images/`: `<stored copy>.tmp`. In `logs/`: `app.log.enc` and its `app.log.enc.tmp` (written anew
  whenever release 1 saves its log, unless the file is in a newer frame), `app.1.log.enc` and its
  `app.1.log.enc.tmp` (replaced when the log rotates, unless in
  a newer frame, and removed when a journal's `remove` list names a file of that name), and a plain
  `app.log` or `app.1.log` (shredded on an encrypted workspace). And `workspace/hilbertraum.sqlite-journal`
  (shredded by an unlock, or set aside by a create: the line on WAL mode, above).
  Code: `main/services/workspace-vault.ts` `openWriteTemp`, `encryptFile`, `decryptFile`,
  `setLeftoversAside`, `recoverPendingRekey`, `clearRekeyJournal`,
  `quarantineName`, `settleRekeyJournal`, `writeVaultDescriptor`, `writeWorkingCopyLostMarker`,
  `removeWorkingCopyLostMarker`, `judgeSidecarStage`, `removeRotatedLog`; `main/services/logging.ts`;
  `main/services/zim/transients.ts` `cleanupZimTransients`.
  Proof: `integration/password-change.test.ts`, "a journal that cannot be parsed is quarantined as
  .corrupt, never deleted; in-store classes still roll forward" and "the rotated log is deleted by the
  v1→v2 change (nothing reads it) and untouched by a v2 re-wrap"; `integration/workspace-vault.test.ts`,
  "the rekey journal's write temp is never written through a link (#1014)";
  `integration/workspace-vault-destruction.test.ts`, "a marker an older build left behind after it
  locked again (another snapshot now) is stale: no notice, and removed"; `unit/zim-transients.test.ts`,
  "removes the actual library build and meta dir in BOTH workspace modes and leaves every neighbour
  byte-identical"; `unit/logging.test.ts`, "rotates the encrypted log to app.1.log.enc once it grows
  past MAX_BYTES" and "shreds a stale plaintext app.log left by an older build on first encrypted
  attach". [F-27 (e); T2.11 re-check n-5]

**Rows release 1 reads, resets and creates again**

- **`documents.status` holds only release 1's seven values.** They are `queued`, `extracting`,
  `chunking`, `embedding`, `indexed`, `failed` and `deleted`. Release 1 reads any other value as
  `failed`, searches and scopes only `indexed` documents, and offers "Try again" on a failed row
  whose reason it cannot name; that re-index removes the document's statements and invoices (see
  "Extractions"). Release 1 never stores `deleted` (it builds that status in memory for a row that is
  gone), but it hides a stored `deleted` row from its lists: such a document is out of search, cannot
  be deleted by the user there, and keeps its stored copy and chunks. A later version keeps a state of
  its own in a column of its own.
  Code: `main/services/ingestion/index.ts` `toStatus`, `listDocuments` (`status != 'deleted'`);
  `main/services/rag/index.ts` and `main/services/skills/scope-documents.ts` (`d.status = 'indexed'`);
  `renderer/screens/documents/format.tsx` `isRetryableFailure`. Proof: none yet for a value release 1
  does not know. [F-27 review M-5 (a); F-27 R2 m-7]
- **Work left in progress is reset by release 1.** Whenever its documents list is read while nothing
  of its own runs, release 1 resets what it finds in progress. A document that is `queued`,
  `extracting`, `chunking` or `embedding` becomes `failed` with the reason "interrupted". A
  `tree_status` of `building` and an `extract_status` of `extracting` become `pending`. A `skill_runs`
  row that is `started` and was created before the app started becomes `failed`. A later version never
  leaves a row in one of these states for work it means to resume itself.
  Code: `main/ipc/registerDocsIpc.ts` (the `listDocuments` handler); `main/services/ingestion/index.ts`
  `reconcileStuckDocuments`, `reconcileStuckTrees`, `reconcileStuckExtracts`;
  `main/services/skills/run.ts` `reconcileStuckSkillRuns`. Proof: `integration/docs-ipc.test.ts`,
  "reconciles a prior-run stuck document and flags a stale-embedding document (M5 + M7)";
  `integration/whole-doc-analysis.test.ts`, "reconcileStuckTrees flips a stale building tree to pending
  (resumable)". [F-27 review M-5 (b)]
- **A document's title keeps its file extension.** On every import and re-index release 1 takes the
  extension of `documents.title` to pick the parser, the MIME type and the stored copy's name. It never
  renames a document itself. A title without its extension, or with another one, makes every release-1
  re-index of that document fail as a type it cannot read, or read it as the wrong type.
  Code: `main/services/ingestion/index.ts` `prepareDocument`; `main/services/ingestion/parsers/index.ts`
  `selectParser`. Proof: `integration/ingestion.test.ts`, "marks an unsupported file type as failed"; no
  row yet renames a title. [F-27 review M-5 (c)]
- **Chunk ids do not survive a release-1 re-index.** Every release-1 re-index of a document ("Re-index",
  OCR, "Re-index for deep index", "Re-index all") deletes its `embeddings`, `chunks`, `tree_nodes` (with their edges),
  `extraction_records` and statements and invoices, sets its `tree_status` and `extract_status` to
  `stale` where one was set (a `NULL` stays `NULL`), and writes the chunks again under new random ids. The text can differ from before: an OCR run
  adds pages, and a re-index whose stored copy is gone imports the original file again. A later
  version's own derived data is not told. So whatever a later version derives from a document's text or
  keys by a chunk, tree node or extraction record id either hangs off `chunks(id)` or `documents(id)`
  with `ON DELETE CASCADE` (it then goes with the re-index), or is keyed to the document and a position
  of its own and checked against `documents.fully_chunked` (release 1 writes the time of every
  successful index there) before it is used; a state column of its own is never the only proof that
  such data is current. A later version that stores its vectors under a new model id makes release 1
  offer this re-index for every document ("Search", below).
  Code: `main/services/ingestion/index.ts` `prepareDocument` (the chunk-replace transaction),
  `finalizeDocument` (`fully_chunked`). Proof: `integration/ingestion.test.ts`, "re-indexes a document,
  replacing its chunks"; `integration/whole-doc-analysis.test.ts`, "re-index tears the tree down
  (stale), and a rebuild reuses the cache despite chunk-id churn"; no row hangs a later table off a
  chunk. [F-27 R1 M-4, R2 M-2]
- **A document release 1 could not have indexed leaves search at any release-1 re-index.** The re-index
  sets the document to `extracting` first and fails it (`failed`, with one of release 1's own reasons)
  for a file above its size limits (1 GiB, 64 MiB for the text formats), a type it has no parser for,
  more than 1,000 chunks, or a parser's cap or timeout. Its stored copy and its old chunks stay, but
  release 1 searches only `indexed` documents, and for a type it cannot read it offers no retry. "Re-index
  all" runs this over every document. A later version that adds a file type or raises a limit knows
  this; when it meets such a row back from release 1 it indexes the document again itself.
  Code: `main/services/ingestion/index.ts` `prepareDocument` (the size check, `selectParser`, the
  over-cap gate, the catch that stores `failed`); `main/services/ingestion/limits.ts`
  `DEFAULT_INGESTION_LIMITS`; `main/services/ingestion/chunker.ts` `MAX_CHUNKS_PER_DOCUMENT`. Proof:
  `integration/ingestion-limits.test.ts`, "M13/C4: re-indexing an over-cap document fails BEFORE
  deleting its existing chunks, and clears fully_chunked"; `integration/ingestion.test.ts`, "marks an
  unsupported file type as failed". [F-27 R2 M-4]
- **A row of a new kind never goes into `messages`.** To release 1 every `messages` row whose `kind`
  is not `'compaction'` is a message of the chat: it lists it and, through the `messages_fts_ai`
  trigger, finds it in chat search; it sends it to the model when its `role` is `user` or `assistant`,
  and lists any other role as `system`, not sent. A regenerate takes the chat's last listed row: when
  that is not an `assistant` row, it deletes nothing and answers after it. The newest `'compaction'`
  row of a chat (by rowid) is the chat's summary: release 1 puts its `content` into the prompt as the
  summary and skips every turn up to its `covers_through_rowid` (`NULL` reads as 0, nothing skipped).
  A later version keeps a tool call, a hidden note or any other new kind of row in a table of its own,
  and writes a `'compaction'` row only as release 1 reads one: plain summary text in `content` that
  covers every turn up to `covers_through_rowid`, newest last.
  Code: `main/services/chat.ts` (every transcript query filters `kind IS NOT 'compaction'` and nothing
  else; `rowToMessage`, `listConversationTurns`, `getLatestCheckpoint`, `deleteLastAssistantMessage`);
  `main/services/db.ts` `MESSAGES_FTS_TRIGGERS`. Proof: `integration/conversation-search.test.ts`
  and `integration/chat-compaction.test.ts` pin the one kind release 1 knows; no row yet feeds another
  kind, role or compaction form. [F-27 review M-6; F-27 R1 m-3, R2 m-5]
- **`messages` rows keep their rowids.** Release 1 orders the turns of a chat by `created_at` and then
  by the table's implicit `rowid`, and a checkpoint names the last row it covers by that rowid
  (`covers_through_rowid`). A later version never renumbers them: no rebuild of `messages` that does
  not copy `rowid`, and no `VACUUM`, which may renumber an implicit rowid (a snapshot by `VACUUM INTO`
  is §7.8's question). Release 1 itself gives one row a new rowid: the answer a failed regenerate puts
  back (the next line).
  Code: `main/services/chat.ts` (the queries ordered by `m.rowid`, and those that read
  `covers_through_rowid`). Proof: `integration/chat-compaction.test.ts` (the checkpoint rows); no row
  yet renumbers a rowid. [F-27 review M-6; F-27 R1 m-11, R2 m-4]
- **What hangs off a chat's last answer does not survive a release-1 regenerate, a failed one
  included.** A regenerate deletes the chat's last answer (the delete cascades) and, when the new answer
  fails, is stopped before its first token, or is cut by a model stop, a lock or a quit, inserts the old
  row again: the same `id` and `created_at`, release 1's 17 columns only, its `result_tables` rows, and a
  new rowid. A successful regenerate removes the row for good. (One with a review on it is refused.) A
  later version keeps what must survive that in a table of its own, keyed by the message `id`, with no
  foreign key onto `messages`, and removes its own orphans; a column of its own on `messages` reads
  `NULL` (or its default) on a row put back; it never names a `messages` row by rowid except as release
  1's checkpoints do.
  Code: `main/services/chat.ts` `deleteLastAssistantMessage`, `restoreMessage`;
  `main/ipc/chat-stream.ts` (the regenerate's restore legs). Proof:
  `integration/regenerate-result-table-restore.test.ts`, "a regenerate whose grounded generation FAILS
  restores the table byte-identically", "a Stop BEFORE the first token restores the table
  byte-identically" and "CONTROL — a SUCCESSFUL regenerate still drops the old table (the answer was
  replaced)"; no row feeds a later version's column or table. [F-27 R2 M-1]
- **A chat's scope narrows only through release 1's fields of `scope_v2_json`.** Release 1 reads
  `collectionIds`, `documentIds`, `packIds`, `includeArchived` and `documentsOff` there and ignores
  every other field. A scope a later version narrows only by a field of its own (tags, folders, an
  exclude list, a date range) is, to release 1, an object with empty lists: the explicit "All
  documents", so release 1 answers that chat from the whole library. Its next scope change stores its
  own fields only, and the later field is gone. A later version resolves a narrowing of its own into
  `documentIds` (or `collectionIds`) as well, or accepts that.
  Code: `main/services/collections.ts` `parseDocumentScope`; `main/services/chat.ts`
  `serializeDocumentScope`. Proof: `integration/zim-regressions.test.ts` (the `documentsOff` parse rows);
  no row feeds a field release 1 does not know. [F-27 R2 M-8]
- **The two built-in collections exist, and "in no collection" does not survive a release-1 open.** At
  every open release 1 creates a collection of `type` `library` and one of `type` `temporary` when
  there is none, and files into the Library every `indexed` document that has no membership and a
  `NULL` `origin_json`. A later version expresses "filed nowhere" in another way. Any `origin_json`
  that is not `NULL`, whatever its shape, keeps a document out of that backfill (it is the backfill's
  test for a generated document): a later version that stores a new kind of origin there gives each such document
  that must be filed a membership row itself, or accepts that release 1 shows it in no collection.
  Code: `main/services/db.ts` `seedCollections` (`d.origin_json IS NULL`). Proof:
  `integration/collections.test.ts`, "seeds exactly one Library and one Temporary, undeletable +
  idempotent on re-open" and "files indexed non-generated unfiled docs into Library; skips generated +
  unindexed". [F-27 review m-12; F-27 R2 re-check 1 n-2]
- **Every place a document is filed is a `document_collections` row.** Release 1's "Delete project
  with its documents" deletes, with its stored copy, every document of that project that has no
  `document_collections` row for another collection (a Library member is never deleted so). A later
  version that files documents by any other means (a table of its own for folders, tags or shared
  spaces, a nested project, a link from a chat) also keeps a membership row release 1 can see for each
  document that must survive that delete.
  Code: `main/services/collections.ts` `projectOnlyDocumentIds`; `main/ipc/registerCollectionsIpc.ts`
  (the delete handler, which runs `deleteDocument` on each). Proof:
  `integration/collections-ipc.test.ts`, "delete-project "withDocuments" never deletes a Library member
  (C2)"; no row files a document by another means. [F-27 R2 M-5, R1 m-6]
- **A new shape of stored JSON is a new column.** Release 1's re-index of a PDF reuses the recognized
  pages in `documents.ocr_json`: a `pages` list whose entries have a whole-number `pageNumber` and a
  text `text`. In another shape it finds no page: in a PDF with a text layer the text of the scanned
  pages is gone from the index without a word; a PDF that is all scan fails the re-index as a scan, so
  it leaves search and "Make searchable" is offered again (T2.11 re-check n-2). The other JSON columns
  it reads tolerantly read as absent in a shape it does not know. And release 1 writes these JSON
  columns whole whenever it writes them, so a field of a later version's there lasts only until then:
  `conversations.scope_v2_json` and `scope_json` (every scope change), `documents.summary_json` (every
  summary), `tree_meta_json` (every deep-index build), `scanned_pages_json` (every PDF re-index),
  `ocr_json` (every OCR run), `pending_destination_json` (cleared when the document is filed),
  `messages.skill_offer_json` and `evidence_reviews.freshness_ack_json`.
  Code: `main/services/ingestion/index.ts` `parseOcr`, `prepareDocument`;
  `main/services/ingestion/parsers/pdf.ts` (the scan check, `PDF_SCAN_DETECTED_MESSAGE`); the writers
  of those columns (`chat.ts`, `collections.ts`, `ingestion/index.ts`, `analysis/tree-build.ts`,
  `analysis/node-vectors.ts`, `evidence-pack/freshness.ts`). Proof:
  `integration/ocr-task.test.ts`, "preview shows the recognized per-page text and re-index reuses it (no
  re-OCR)"; no row yet feeds another shape or a field of a later version's. [F-27 review m-11; F-27 R2
  m-1]
- **A column release 1 reads as a closed set holds only release 1's values.** Release 1 reads any other
  value as its default, acts on it so, and stores its own value over it when the user acts:
  `documents.lifecycle` (anything but `temporary` and `archived` is `permanent`, and only `archived` is
  kept out of search, so a document a later version marks as binned, hidden or expired is searched and
  quoted); `evidence_reviews.status` (anything but `ready` is `draft`: editable, and "Mark ready" stores
  `ready` over it); `evidence_review_items.decision` (`not_reviewed`, which keeps a review from being
  ready), `kind` (`block`), `block_kind` and `evidence_review_links.reviewer_relation` (none),
  `link_origin` (`reviewer`); `conversations.mode` (`chat`); `messages.role` (`system`, above);
  `messages.truncated_cause` (`context`: "raise the context size"); `documents.tree_status` and
  `extract_status` (a value release 1 does not know reads as no tree, or no extraction, in its
  documents list, and its re-index sets any value that is set to `stale`, a `NULL` staying `NULL`);
  `collections.type` (a type release 1 does not know is passed on as it is, and only `library` and
  `temporary` behave specially; whether a collection can be deleted, with its documents, is its
  `builtin` flag, not its type); and every
  `image_sessions` row is an image session ("Clear history" deletes every row and shreds each bare
  `stored_name` in `images/`). A later version puts a new state, kind or cause into a column or table
  of its own; a document that must stay out of release 1's answers is `archived` in
  `documents.lifecycle`, the one value release 1 keeps out of search.
  Code: `main/services/collections.ts` `docLifecycle`, `rowToCollection`, `deleteCollection` (the
  `builtin` check); `main/services/retrieval-scope.ts`
  (the `archived` exclusion); `main/services/evidence-reviews.ts` `normalizeStatus`, `normalizeDecision`,
  `normalizeItemKind`, `normalizeBlockKind`, `normalizeLinkOrigin`, `normalizeRelation`;
  `main/services/chat.ts` `rowToConversation`, `rowToMessage`, `parseTruncationCause`;
  `main/services/ingestion/index.ts` `treeStatusOf`, `extractStatusOf`, `prepareDocument` (the reset to
  `stale`); `main/services/vision/history.ts` `clearImageSessions`. Proof: none feeds a value release 1
  does not know. [F-27 R2 M-7, R1 m-7; R2 re-check 1 n-1; R1 re-check 1 r-1, r-2]
- **`runtime_events` is a short log, not a store.** Whenever release 1 records an event and the table
  would hold more than 5,250 rows, it deletes all but the newest 5,000, ordered by `created_at` as text
  and then rowid, whatever the event type. Its Settings → Diagnostics "Export" writes every kept row's
  `message` and `metadata_json` as stored to a plaintext file the user picks (`activity-log.json`), and
  the list shows an `event_type` it does not know by its raw name. A later version writes `created_at`
  as `toISOString()` does, puts no content, name, path or secret into `message` or `metadata_json`,
  picks type names that read well raw, and keeps nothing there that it needs later (a history it must
  keep, such as §8.6's update events beyond release 1's 5,000 newest, is a table of its own).
  Code: `main/services/audit.ts` `recordEvent`, `pruneAuditEvents`, `AUDIT_MAX_ROWS`,
  `AUDIT_PRUNE_SLACK`; `main/ipc/registerAuditIpc.ts` (the export);
  `renderer/screens/settings/DiagnosticsTab.tsx` `auditLabel`. Proof: `integration/audit.test.ts`,
  "recordEvent prunes back to the ceiling once an insert crosses ceiling + slack"; no row prunes a later
  version's event. [F-27 R1 M-5, R2 M-6]

**Stored messages**

The app stores some of its own messages as text in the workspace: a failed document's reason, the fixed
answers, default titles, the benchmark warnings (§7.6, F-26).

- **A code names only a key release 1 knows, with release 1's placeholders under release 1's names.**
  Release 1 reads a stored string as a code only when the whole string is `hr:<key>`, with an optional
  `?<name>=<value>&…` whose values are percent-encoded as `encodeURIComponent` writes them. It shows the
  message when `<key>` is in its own catalog and every placeholder of that key's English is given under
  release 1's name for it (`ext`, `mbps`, `model`, `tps`, `library` in the five stored messages that
  have one). For any other well-formed code (a key it does not know, a placeholder missing, a parameter
  given twice, a value that does not decode) it shows "This text comes from a newer version of
  HilbertRaum, and this version can’t show it." A later version codes only release 1's keys in that
  form; for any other message, plain English reads better in release 1 than that line.
  Code: `shared/persisted-messages.ts` `CODE_RE`, `codeMessage`; `renderer/lib/displayMap.ts`
  `classifyServerCopy`. Proof: `unit/display-map.test.ts`, "a stored code this version knows reads as
  its key (F-26)", "a stored code this version does not know reads as the newer-version line (F-26,
  C02)", "what is a code is decided on the whole string (F-26)". [F-26; T2.12 R2 m-2, m-3, b-4]
- **Release 1's whole catalog is a frozen namespace.** A code may name any key of release 1's catalog,
  and release 1 shows that key's text for it. A key that is ever coded is never renamed, removed or
  given another meaning.
  Code: `shared/persisted-messages.ts` `codeMessage`. Proof: `unit/display-map.test.ts`, "every key of
  the catalog can be written as a code (F-26)". [T2.12 R2 m-4 = R1 m-3]
- **A plural key is coded with its concrete form, and values are shown as given.** Release 1 looks the
  coded key up as it is: it picks no plural form for a code, so a base key without its form (`.one`,
  `.other`) is a key it does not know. It puts each value into the text unchanged, empty and multi-line
  ones included.
  Code: `shared/persisted-messages.ts` `codeMessage`; `shared/i18n/index.ts` `t`.
  Proof: `unit/display-map.test.ts`, "names any key of this version’s catalog, reads in an English UI,
  and percent-decodes its values". [T2.12 R1 m-4, m-6]
- **The seven messages release 1 acts on are never reworded.** Release 1 does more than show them:
  `main.ingest.pdfScanDetected` (the row is offered "Make searchable", not a retry),
  `main.ingest.imageNeedsOcr` (the photo remedy), `main.ingest.fileTooLarge`,
  `main.ingest.tooManyChunks`, `main.ingest.unsupportedType` (no retry is offered),
  `main.chat.defaultTitle` (the first message renames the chat), `main.benchmark.warnSlowRead` (a fresh
  reading replaces the line). It knows each by its one English value or by its code. A later version
  that needs other words adds a new key.
  Code: `main/services/ingestion/index.ts` (`scanDetected`); `renderer/screens/documents/format.tsx`
  `isRetryableFailure`; `main/services/chat.ts` `maybeSetTitleFromFirstMessage`;
  `main/services/benchmark.ts` `upsertSlowReadWarning`. Proof: `unit/display-map.test.ts`, "the keys
  marked actedOn are exactly the ones release 1 acts on" and "a key release 1 acts on keeps its one
  value". [F-26; T2.12 R2 M-5]
- **The English of a stored message stays readable for ever.** Release 1 knows a stored message by its
  English at the Kit tag. When a later version changes that English, the old value joins the alias
  table in the same change, and no alias is ever removed. That rule keeps release 1's rows readable in
  later versions. The other way round, release 1 shows a later version's reworded English as it is:
  untranslated, under the failure lead, and never acted on. A later version that wants release 1 to
  translate a message stores the code of release 1's key.
  Code: `shared/persisted-messages.ts` `PERSISTED_ALIASES`, `buildPersistedMessageParser`.
  Proof: `unit/display-map.test.ts`, "each history ends with the current English, and its earlier values
  are exactly the key’s aliases"; the fixture `fixtures/display-map/values.json`. [F-26]
- **A key never switches between plain text and a template.** The alias rules refuse an old template
  as the alias of a plain key, and an old plain text as the alias of a template key that has a
  placeholder now. A later version adds a new key instead.
  Code: `shared/persisted-messages.ts` `buildPersistedMessageParser`. Proof: `unit/display-map.test.ts`,
  the alias-refusal tables under "an old value kept in the alias table reads as its key (F-26)".
  [T2.12 re-check 2, R1]
- **A stored message or code fits in 4,096 UTF-16 units.** Release 1 reads a longer string as no stored
  message: it shows it as it is and acts on nothing in it.
  Code: `shared/persisted-messages.ts` `MAX_STORED_LENGTH`. Proof: `unit/display-map.test.ts`, "a stored
  string longer than 4,096 units is no persisted message (F-26)". [F-26; T2.12 R1 M-1]
- **Release 1 originates no code, and versions before it show a code as it is.** A later version stores
  a code only where it accepts that v0.1.66 and older show the raw `hr:…` text.
  Code: none writes one. Proof: `unit/display-map.test.ts`, "this version never writes a code (F-26,
  D-9)". [T2.12 D-9, R2 m-5, b-6]
- **Never a failure release 1 does not know, plain or coded, whose re-index would lose something.** On
  a failed document release 1 offers "Try again" for every reason it cannot name: a code it does not
  know, and any plain text that is none of its own. That re-index runs release 1's own import,
  replaces the reason, and removes what was derived from the document (see "Extractions"). And a
  slow-read warning in a code release 1 does not know stays beside release 1's fresh one.
  Code: `renderer/screens/documents/format.tsx` `isRetryableFailure`; `main/services/benchmark.ts`
  `upsertSlowReadWarning`. Proof: `unit/documents-format.test.ts`, "a failure stored as %s: retry
  offered %s"; `integration/benchmark.test.ts`, "upsertSlowReadWarning owns the slow-read warning in its
  coded form too". [T2.12 b-5; F-27 review M-5]
- **A failed document's reason never reads as one of release 1's old raw failures.** At every engine
  health check release 1 rewrites the reason of failed documents that match its texts from before
  those messages existed: a reason that starts `llama-server exited before becoming healthy` and reads
  as a load failure, eight exact texts of the search model (such as `terminated`, `fetch failed`, `The
  operation timed out.`), a llama-server start failure, and a reason that starts `Embedding request
  failed: HTTP `, `Embedding count mismatch:`, `Embedding dimension mismatch:` or `Embedding response
  mixes indexed and unindexed entries`. A later version stores none of these as a reason of its own.
  Code: `main/services/ingestion/engine-failure.ts` `rewriteEngineFailureRows`,
  `rewriteSearchModelFailureRows`, `LEGACY_SEARCH_MODEL_TEXT`; `main/services/engine-health.ts`.
  Proof: `integration/engine-health.test.ts`, "rewrites failed rows holding the raw loader line, leaves
  others alone, and is idempotent" and "rewrites the raw search-model failures, leaves every other row
  alone, and is idempotent". [F-27 review M-5 (d)]

**Extractions (bank statements and invoices)**

- **The two extractor numbers only rise.** Release 1's are 11 (bank statements) and 13 (invoices). A
  number is never used again for different output, and a deliberate rollback of a bad extractor ships a
  higher number.
  Code: `main/services/skills/tools/bank-statement.ts` `BANK_EXTRACTOR_VERSION`;
  `main/services/skills/tools/invoice.ts` `INVOICE_EXTRACTOR_VERSION`.
  Proof: `unit/skills-bank-statement-tool.test.ts` and `unit/skills-invoice-tool.test.ts` (the pinned
  numbers). [G-34; T2.13 (a)]
- **The stamp is a plain integer, and never `NULL` or a lower number on rows a later version wants
  kept.** Release 1 reads `extractor_version` as one of three. `NULL` or an integer below its own: it
  extracts the document again and replaces every statement or invoice of that document, with what
  hangs off them. An integer equal to its own: it reuses the rows. Anything else (a higher integer, a
  real, text, a blob): it serves the rows as stored, with a one-line note, and never extracts over that
  document.
  Code: `main/services/skills/run.ts` `EXTRACTOR_VERDICT_SQL`, `extractorVerdict`,
  `holdsNewerExtraction`, `runDomainExtractionInner` (the guard). Proof: `integration/skills-run.test.ts`,
  "G-34 (a) — the extractor-version verdict, both tables: NULL or lower re-extracts, equal is current,
  anything else is newer" and "G-34 (a) — no bank extraction ever runs over a newer version’s
  statement"; `integration/skills-invoice.test.ts`, "G-34 (a) — no invoice extraction ever runs over a
  newer version’s invoice". [G-34 (a); T2.13 (e)]
- **Anything that hangs off a statement or invoice needs that row stamped above release 1's number
  first.** A row with release 1's own number is "equal" to release 1: its Extract buttons replace the
  document's rows, and the corrections on them go too.
  Code: `main/services/skills/tool-runs.ts` (the two Extract runs, `replaceExisting`);
  `main/services/skills/run.ts` `deleteBankStatementsForDocument`, `deleteInvoicesForDocument`.
  Proof: none yet for an equal stamp: the rows of `integration/skills-run.test.ts`, "G-34 (a) — no bank
  extraction ever runs over a newer version’s statement", show the guard holding for a newer stamp
  only. [T2.13 (b); R1 M-4]
- **A user's own choice is never kept only in a column release 1 writes.** On a newer version's rows
  release 1 still writes `bank_transactions.category_id`, `bank_statements.categorized_by_model`,
  `bank_transactions.reconciled` and `invoices.totals_reconciled` when the user runs Categorize, asks a
  category question or runs a check. And release 1 never reads `bank_corrections`: a corrected figure
  it should show is written into the row's own column.
  Code: `main/services/doctasks/handlers/categorize.ts`; `main/services/skills/run.ts`
  `persistCategorization`, `runBalanceValidation`; `main/services/skills/invoice-run.ts`
  `runInvoiceTotalsValidation`. Proof: `integration/skills-run.test.ts`, "$name runs on a newer
  version’s statement as stored (no re-extract)"; `integration/skills-analysis-bank.test.ts`, "a category
  question on a newer reading writes labels and changes no amount, row or correction". [T2.13 (c), D-4]
- **Release 1's delete and re-index remove every statement, invoice and correction of the document, at
  any version.** Six actions do it: deleting the document, "Re-index", OCR, "Re-index for deep index",
  "Re-index all", and deleting a project with its documents.
  Code: `main/services/skills/run.ts` `purgeSkillDataForDocument`; `main/services/ingestion/index.ts`
  `purgeDocumentDerivatives` and the chunk-replace transaction of `prepareDocument`.
  Proof: `integration/invoice-audit-ia1.test.ts`; `integration/document-delete-derivatives.test.ts`.
  [T2.13 (d), D-6, R1 M-3]
- **Corrections live where release 1 never deletes them.** A later version keeps a user's corrections
  in a table release 1 does not know, with no foreign key onto release 1's statement or invoice rows (a
  cascading key would make release 1's re-index delete them), keyed by the document and a stable row
  identity. It removes its own orphans after release 1 deletes a document.
  Code: `main/services/skills/run.ts` `purgeSkillDataForDocument` (what release 1 deletes: its own
  tables only). Proof: none yet for a re-index or a delete; `integration/db-schema-meta.test.ts`, "N5: a
  key and a table this build does not know survive two opens, value for value", shows only that such a
  table survives an open. [T2.13 (g'), D-7]
- **Doubt is said only through the values release 1 knows.** Release 1 hedges an invoice answer only on
  exactly `'suspect'` and `'suspect-confirmed'` in `invoices.text_quality`, compared exactly
  (`'SUSPECT'` reads as normal text); any other value reads as normal text. Two sibling columns of
  statements and invoices are read the same closed way. In `date_order_inferred` only `'default'` adds
  the date caveat (`'evidence'` and everything else add none). In `dropped_row_count` a number above 0
  takes back the "whole document" claim, and `NULL` reads as 0.
  Code: `main/services/skills/analysis/invoice.ts` `loadInvoiceMeta`;
  `main/services/skills/analysis/bank-statement.ts` `loadDateOrderInferred`, `loadDroppedRowCount`.
  Proof: `integration/skills-analysis-invoice.test.ts` (the text-quality rows); no row yet feeds a
  value release 1 does not know. [T2.13 (f), R2 M-3; F-27 review m-10]
- **A document's newest row is the newer version's.** Release 1 shows the statement or invoice picked
  by `ORDER BY created_at DESC, id DESC`, compared as text. A later version writes `created_at` in
  release 1's form (`toISOString()`), so its row sorts first, and never leaves an older-version or
  `NULL`-stamped row as the latest beside a newer one: release 1 would serve that older reading for
  good, since its guard keeps it from reading the document again.
  Code: `main/services/skills/run.ts` `latestBankStatementId`; `main/services/skills/invoice-run.ts`
  `latestInvoiceId`. Proof: `integration/skills-analysis-bank.test.ts` and
  `integration/skills-analysis-invoice.test.ts`, the rows of "… a newer version’s … is served as
  stored, C08 its last line (G-34 (a))". [T2.13 (h); R1 M-1 = R2 M-1, R2 N-2]
- **Rows a later version writes pass release 1's row schemas.** These are `TRANSACTION_ROW_SCHEMA` and
  the invoice header, line-item and totals schemas. Every date (`date`, `value_date`, `invoice_date`,
  `due_date`) is `YYYY-MM-DD`. Every currency is exactly three capital letters (the invoice header's
  may be `NULL`). `description` is non-empty, and `vendor`, `recipient` and `invoice_number` are
  non-empty or `NULL`. Amounts are numbers, and `source_page` is an integer of 1 or more. Every integer
  release 1 reads (`row_index`, `source_page`, `dropped_row_count`) stays below 2^53. A statement or
  invoice stays within release 1's row caps (`MAX_TRANSACTIONS`, `MAX_LINE_ITEMS`, 10,000 each). One
  row that fails any of these fails release 1's run-bar tools and its exports for the whole statement
  or invoice.
  Code: `main/services/skills/tools/bank-statement.ts` `TRANSACTION_ROW_SCHEMA`, `MAX_TRANSACTIONS`;
  `main/services/skills/tools/invoice.ts` `HEADER_SCHEMA`, `LINE_ITEM_SCHEMA`, `TOTALS_SCHEMA`,
  `MAX_LINE_ITEMS`. Proof: `unit/skills-transaction-schema-parity.test.ts`;
  `unit/skills-bank-statement-tool.test.ts`; `unit/skills-invoice-tool.test.ts`. [T2.13 (i), R2 M-2]

**Settings**

- **A value under one of release 1's settings keys is one release 1 could have written.** Release 1
  reads each row of a key it knows as stored, with no check (only its own writes are checked): the same
  JSON type, and for `gpuMode`, `theme` and `workspaceMode` one of release 1's values. The exceptions are
  `uiLanguage`, where a language release 1 does not know reads like `system` and the row is kept, and
  `gpuAutoDisabledEngine` (P3), which is read through `engineBuildStampOf`: any other shape reads as no
  stamp (below). "Could
  have written" includes the bounds release 1 applies only when it writes, since it uses a stored
  number as it is: `contextTokens` and `contextTokensOverride` from 2,048 to 131,072; `ragTopKInitial`
  and `ragTopKFinal` from 1 to 200; `ragMaxContextTokens` from 256 to 131,072; `ragMinSimilarity` from
  0 to 1; `localApiPort` from 1,024 to 65,535; a model id of at most 512 characters (`activeModelId`
  stays a manifest id string: release 1 names it in C09 when it cannot list it, §7.6), the GPU engine
  stamp's `version` and `backend` of at most 128 each (below), `gpuLastError` of
  at most 4,096, a list of at most 10,000 texts, and an object of at most 256 KB as JSON. A new
  meaning, or a wider range, is a new key: release 1 ignores a key it does not know and leaves its row.
  Code: `main/services/settings.ts` `getSettings`, `updateSettings`, `RETRIEVAL_TUNING_BOUNDS`.
  Proof: `integration/db-settings.test.ts`, "a uiLanguage only a newer build knows resolves like system
  and its row is kept (downgrade on a shared drive)". `unit/settings-write-gate.test.ts` pins the write
  side only: no row yet reads a stored value outside these bounds. [W-64; F-27 review m-9]
- **A new field in one of the four normalized records lasts only until release 1 writes that record.**
  `lastBenchmark`, `benchmarkHistory`, `modelPlacements` and `gpuProbe` are each built anew from release
  1's own fields when it reads them, and stored that way when it writes them. A field it does not know
  is dropped then, and so is an entry its rules reject (a history entry with no machine identity, a
  placement whose `backend` is not `gpu` or `cpu`).
  Code: `shared/benchmark-schema.ts` `normalizeBenchmarkResult`, `normalizeBenchmarkHistory`,
  `normalizeModelPlacements`, `normalizeGpuProbe`; `main/services/settings.ts` `updateSettings`.
  Proof: `unit/benchmark-schema.test.ts`; `unit/settings-write-gate.test.ts`, "drops an entry with no
  machine identity, and keeps one record per machine" and "drops a record that is not a placement, and
  one filed under the wrong model id". [W-64, which says three: the code has four]
- **`local_api_token` row 1 holds the local API key itself, in release 1's form.** Whenever release 1
  uses the key (a local API request, Settings showing it), it serves the row's `token` as the
  credential when it starts `hr-` and has at least nine more characters, and otherwise writes a new
  random key over the row. A later version that keeps keys in another form (a hash, another prefix,
  more than one key) uses a table of its own and leaves this row to release 1: a key in another form
  is replaced the first time release 1 uses the API, and every client the user set up then fails in the
  later version; and a hash stored there with the `hr-` prefix would be accepted by release 1 as the
  key itself.
  Code: `main/services/local-api/token.ts` `getOrCreateToken`, `isWellFormedToken`;
  `main/services/local-api/lifecycle.ts`; `main/ipc/registerLocalApiIpc.ts`. Proof:
  `unit/local-api-token.test.ts`, "re-mints over a tampered/malformed stored row instead of serving it
  as a credential". [F-27 R2 M-9]
- **A GPU auto-disable carries the engine build it was set under** (W-70, P3). Release 1 keeps a set
  `gpuAutoDisabled` unless `gpuAutoDisabledEngine` names a build other than the one in its own
  `runtime/llama.cpp/<os>/` (`version` or `backend` differs, as exact text); a flag with no stamp it
  can read stays on the processor (§7.6). A later version therefore:
  1. whenever it writes `gpuAutoDisabled: true`, writes `gpuAutoDisabledEngine` in the same step and
     before the flag: `{ "version", "backend" }` copied from the install marker of the engine folder
     that ran (its own `<os>@<pin>/`, or release 1's while it still runs that one), or `null` when it
     does not know; it never leaves an older stamp beside a flag it set;
  2. keeps `gpuAutoDisabled` a JSON boolean, and `gpuAutoDisabledEngine` either `null` or a plain
     object whose `version` and `backend` are non-empty strings of at most 128 characters; anything more
     goes into a new key (release 1 reads only those two fields, ignores others, and drops them when it
     writes the key);
  3. may clear the flag for its own reasons (after an engine install of its own, say); the stamp may
     then stay or be `null` (release 1 does not read it while the flag is false);
  4. keeps the marker's `version` and `backend` as F-24 has them (the stamp is compared with them as
     exact text).
  Code: `main/services/runtime/gpu-failure.ts` `createGpuFailureRecorder`, `ownEngineBuild`;
  `main/services/engine-health.ts` `healEngineLoadState`, `rearmGpuForOtherEngine`;
  `main/services/settings.ts` `engineBuildStampOf`. Proof: `integration/engine-health.test.ts`,
  "healEngineLoadState: a GPU flag set under another engine build is tried again (W-70)";
  `integration/gpu-failure.test.ts`, "createGpuFailureRecorder: the engine build the flag was set under
  (W-70)"; `unit/settings-write-gate.test.ts`, "gpuAutoDisabledEngine accepts only { version, backend }
  …"; `integration/db-settings.test.ts`, "a GPU engine stamp of another shape reads as none …". [W-70;
  T3.11]

**Search**

- **The two keyword indexes keep their names, columns, tokenizer and triggers.** Release 1 creates
  `chunks_fts(text, chunk_id UNINDEXED)` and `messages_fts(content, message_id UNINDEXED)` only when
  they are absent, with FTS5's default tokenizer, and keeps each in step through five triggers (the
  index's name plus `_ai`, `_ad`, `_ad_legacy`, `_au`, `_au_legacy`: `chunks_fts_ai` and so on) and the
  `fts_rowid` column on `chunks` and `messages`. At every open it checks, per table, that all five
  exist and hold their markers: `fts_rowid` in each, and `new.kind` in the messages `ai`, `au` and
  `au_legacy` (that
  guard keeps checkpoint rows out, and release 1's chat search has no filter of its own). If not, it
  drops the five, writes its own and fills `fts_rowid` again. Its triggers insert into those column
  names, its queries read the first column and join on the second, and its query builder is written for
  the default tokenizer. A later version keeps all of it, and gives a trigger of its own on `chunks` or
  `messages` another name (release 1 leaves that one alone).
  Code: `main/services/db.ts` `CHUNKS_FTS_TRIGGERS`, `MESSAGES_FTS_TRIGGERS`, `FTS_STYLE_MARKERS`,
  `ensureFtsRowidSync`, `ensureChunksFts`, `ensureMessagesFts`; `main/services/fts.ts`
  `buildFtsMatchQuery`; `main/services/rag/hybrid.ts`; `main/services/chat.ts` `searchMessages`.
  Proof: `integration/fts-rowid-sync.test.ts`, "a healthy workspace is not rewritten on reopen: a current
  trigger in other bytes still counts as current (#737)" and "opening twice migrates once: triggers
  rewritten, handles backfilled, no duplicate FTS rows, search intact". [W-64]
- **A changed embedding or summary recipe changes the stored model id.** Release 1 searches every
  vector tagged with its active embedding model's id as if its own recipe made it, and reuses a cached
  summary filed under the same content hash and model id as if its own prompt made it. A later version
  that changes how a vector or a summary is made (the prefix, the pooling, the size, the prompt) stores
  the result under another model id, and its vectors in a table of its own: `embeddings` holds one row
  per chunk (`chunk_id` is its primary key), so a vector of a new recipe written there replaces release
  1's. While "Go back" is offered, the rows under release 1's embedding model stay, and the
  `activeEmbeddingModelId` setting stays a model release 1 lists. Otherwise release 1 finds nothing by
  meaning, flags every indexed document as needing a re-index and offers "Re-index all", which runs
  the re-index of "Chunk ids do not survive a release-1 re-index" (and removes every statement, invoice
  and correction, "Extractions") over the whole library. `summary_cache` is a cache release 1 trims:
  each deep-index build deletes its oldest rows beyond 50,000 (by default) by `created_at`, whatever
  their model id; nothing else lives there.
  Code: `main/services/embeddings/index.ts` (the `embedding_model_id` filter of the vector search);
  `main/services/embeddings/resident-cache.ts`; `main/services/analysis/tree-build.ts` (the
  `summary_cache` lookup by `content_hash` and `model_id`); `main/services/analysis/node-vectors.ts`;
  `main/services/ingestion/index.ts` `listDocuments` (`staleEmbeddings`); `main/services/db.ts`
  (`embeddings`); `main/services/analysis/summary-cache.ts` `evictSummaryCache`.
  Proof: `integration/vector-search-resident-iteration.test.ts`, "filters search to the active
  embedding_model_id so a mock→real switch cannot blend spaces (Phase 10)";
  `integration/whole-doc-analysis.test.ts`, "a rebuild over a warm summary_cache costs 0 model calls";
  `unit/summary-cache-eviction.test.ts`, "prunes a cache past the HILBERTRAUM_SUMMARY_CACHE_MAX_ROWS cap
  down to the cap, keeping the NEWEST rows". [W-64; F-27 R1 M-4, R2 M-3, m-3]

**Knowledge packs and skills**

(T2.14's stored values and readers, W-71 and W-65. The other rules of the `skills` table are in §6.11.)

- **`knowledge_packs.unavailable_reason` is release 1's to overwrite.** Release 1 writes `missing`,
  `identity_mismatch` and `newer_format` there, reads a value it does not know as "unavailable, no
  reason" (the panel says "File missing", "The archive file could not be found — is the drive plugged
  in?", the picker "not available") and,
  at the reconcile of every session, replaces whatever is there with its own verdict. A later version
  reads `newer_format`, and any value it does not know, as "judge again", clears it once its own tools
  read the file, and never keeps a meaning of its own only in that column (v0.1.66 already reads
  `newer_format` as "File missing", then clears it and hands the file to its own kiwix tools).
  Code: `main/services/zim/packs.ts` `toStoredReason`, `fromStoredReason`, `reconcile`. Proof:
  `unit/zim-packs.test.ts`, "a known pack whose file is now in a newer format is kept from every tool,
  stored as newer_format, and readable again once the file is" and "an unavailable reason this version
  does not know (a newer version’s) reads as unavailable with no reason, and the next reconcile heals
  it" (the main side only: no renderer row feeds an unknown reason). [T2.14 R2-1 (a), R2-5]
- **The rest of a `knowledge_packs` row is release 1's cache, and `zim/` holds packs only.** At every
  session's reconcile release 1 rewrites `leaf`, `recorded_path`, `size_bytes` and `unavailable_at` from
  the file it finds (path healing), and resets `searchable` to `NULL` whenever `searchable_key` moves;
  that key includes the size and time of release 1's own `kiwix-serve`, so the verdict is judged again
  each time the two versions alternate. It registers, as an enabled pack, every `*.zim` file in the
  drive's `zim/` folder that no row knows, and honours `removed_at` as "never bring back" (its insert
  never touches a row that exists). A later version keeps nothing of its own only in those columns,
  keeps no `*.zim` file in `zim/` that is not a pack, and keeps `removed_at` set on a pack the user
  removed.
  Code: `main/services/zim/packs.ts` `reconcile` (the file walk and the path healing, the
  `searchable_key` reset, the `INSERT … ON CONFLICT(id) DO NOTHING`). Proof: `unit/zim-packs.test.ts`
  (the reconcile rows); no row feeds a later version's column value. [F-27 R2 m-2]
- **A pack release 1's tools cannot read carries a ZIM major above 6.** Release 1 judges a pack file by
  two header fields only: the ZIM magic and the `uint16` major at offset 4, "above 6" its one refusal
  that keeps the row. A known row whose file has another magic reads as "Different archive" ("… remove
  this pack and add the file again"). So a later version registers an archive release 1 cannot read only
  in a format whose major is above 6, and adds no new kind of `knowledge_packs` row.
  Code: `main/services/zim/identity.ts` `readZimHeader`, `zimFormatTooNew`; `main/services/zim/packs.ts`
  `resolvePack`. Proof: `unit/zim-packs.test.ts`, "a newer-format archive never registered gets no row
  from the reconcile, and kiwix-manage never sees it" and "T11 same basename at two locations, …" (the
  header-magic mismatch). [T2.14 R2-1 (b), sheet decision 5]
- **The outcome code `newer-format` is kept for ever.** Release 1 (and v0.1.66) drop a
  `messages.pack_outcomes_json` element whose code they do not know: that pack's line is missing from
  the chat's notice, and the summary counts one less. A later version keeps `newer-format` and its
  catalog key in every build, and accepts that a new code of its own is invisible in release 1.
  Code: `main/services/chat.ts` `PACK_OUTCOME_REASONS`, `parsePackOutcomes`. Proof:
  `integration/chat.test.ts`, "reads back a stored newer-format outcome (W-71)". [T2.14 R2-1 (c)]
- **A skill for a newer version is one release 1 can parse.** Release 1 counts a skill as made for a
  newer version (C06/C07, X03) only when its frontmatter is YAML it parses and declares
  `compatibility.minAppVersion` as plain `MAJOR.MINOR.PATCH` above release 1; any other skill it cannot
  accept is counted under "could not be read … SKILL.md is missing, invalid, or unreadable". An installed
  row whose folder now holds such a skill is marked unavailable, its `enabled` and `disabled_reason`
  left; a later version's reconcile clears `unavailable_at` on it and never reads it as "the user's files
  are gone".
  Code: `shared/skill-manifest.ts` `failedSkillNeedsNewerApp`; `main/services/skills/registry.ts`
  `discoverSkillsInDir`, `reconcileSkills`. Proof: `integration/skills-registry.test.ts`, "an installed
  skill a newer version rewrote keeps its row: unavailable, enabled and reason untouched, counted as
  newer (W-65)"; the golden set `f25-skills/` (§6.11). [T2.14 R2-1 (d), R1-5]

### 7.8 The migration framework (planned, P10)

- **A three-phase open**: repairs per connection, an ordered ladder of migration steps, repairs on every
  open; a registry with a frozen baseline step; a ledger of applied steps; `user_version` as the
  compatible version (W-36). Where the ledger lives (keys in `schema_meta`, or a table of its own) is
  T10.3's decision (CF-3, Δ-P2-3): release 1's frozen part is `schema_meta`'s shape, "upsert its own key
  only" and "never delete a key or a table it does not know" (§7.4). Once T10.3 is in the build, the
  framework writes `last_writer` and gives `<applied_through>` its meaning, replacing the interim
  constant.
- **A migration worker** with progress on the unlock screen; on quit or lock it is stopped and its work
  discarded (W-37; M-D4 is asked in P10).
- **A snapshot by moving the old `.enc`** at the post-migration checkpoint, with a recovery rule
  designed with `.recovery` and the rekey journal; a plaintext workspace uses `VACUUM INTO` (W-38; M-D3,
  the retention, is asked in P10). Never a copy of `config/workspace.json`, which would keep an old
  password valid. `VACUUM INTO` may renumber the implicit rowids of `messages`, which release 1's
  checkpoints name (§7.7, "`messages` rows keep their rowids"): P10 proves that a snapshot put back
  keeps them (T10.7's rowid links) or takes that copy with SQLite's backup API (F-27 R1 m-11, R2 m-4).
- **Tests and fixtures** (W-39): history and chained fixtures from v0.1.50 to the latest release,
  committed as logical SQL text and loaded with an explicit `{ defensive: true }` (spike 7, §10.6); an
  all-paths schema-equality test; a compatibility test against the previous release's reader snapshot;
  a frozen-step hash guard.
- **Frozen** (F-15): released migration step ids and their source hashes.
- "Go back" is hidden once the workspace's version number is above what the target version reads
  (§6.10); this also covers a vault-format change.

### 7.9 Recorded limits of P2's reviews

P2's reviews left these limits as built, each accepted in its task's review disposition (the ids in
brackets are the reviews' own; FU-P2-n are P2's follow-up issue candidates). The user-facing account
is in [`known-limitations.md`](known-limitations.md) ("App updates:
what release 1 does with a newer version's files"). Limits already written beside their rule above
are not repeated: the engine install's (§6.7), G-43 (c) and the salvage behind a linked workspace
(§7.3), W-68's and W-71's (§7.6).

- **The vault guard (T2.9):** an artifact that cannot be read when the format verdict runs counts as
  "not newer", so a newer build's uncommitted stage may be deleted (R1-5, R2-7); the lock, the exit lock
  and the quit never re-read the format: one instance per drive is assumed (R2-5); the two "still swept"
  cases have no newer-stamped row (R2-6); no `.enc` frame, journal or `.recovery` a release itself wrote
  is a fixture yet (P10's history fixtures, R1-9); a damaged only copy whose `-wal` cannot be written back
  blocks the start with "try again" and loses nothing that could be opened (S-c); the lock keeps its
  skip of the pending-`-wal` check for a file the probe calls damaged, unreachable on a full drive (S-d);
  a damaged plaintext copy whose bytes at the stamp's offset read above this build's is kept and refused
  as newer (re-check N-2); with a store folder a user keeps behind a link, a v1 → v2 password change
  stages copies there that its own swap no longer finds (no published release wrote v1; re-check R2 N-1).
- **The start path (T2.15, T2.16):** every file error of the rekey recovery answers #242's "another
  program is holding a recovery file", also where waiting cannot help (R1 A-2); `EROFS` from `open`,
  `utimes` or `ftruncate` counts as `other`, not "not writable" (R1 A-3; a one-line fix candidate); a
  throw in the `whenReady` callback before the guarded runner, and a throw after `ctx` exists, are
  outside the failure state's promises (R1 A-4, A-6); W-82 is proven in three rows, not one (R2 A2); a
  start that blocks instead of throwing has no answer (R2 A3); a journal that cannot be read just now is
  quarantined as if it did not parse (R2 B3); an admitted entry outside the store folders with neither
  file is kept for good (R2 B5); a store folder whose junction leads to a volume with no drive letter
  reads `unknown` and is handled as a real folder (S-4 = R1 N-1); a deferred entry inside by its text but
  behind a directory link is still stat'ed through it, and start-time reads go on through a linked
  workspace folder or a file link at a fixed name, so such a link can make the start reach a network
  path before any password (R1 N-2, S-3, T2.7 security L-3: follow-up FU-P2-2); a link-named stage is
  also left out of the format verdict's frame read and the v1 discard (S-5); an admitted entry whose
  `<stage>.tmp` is a name `rm` cannot remove still blocks with "try again" (R1 B-6, the other half); no
  real UNC share was run, the "no call names it" row uses a path no host answers (R2 B1).
- **The stamp (T2.2):** `previous` reads null for no table, no row and an unreadable object alike, and
  `'unreadable'` covers more causes still (R1-4, R1-5); the stamp names the version, not the build (R1-8);
  it is not written ahead of the migrations, and the shape P10 hands over is T10.3's (R1-7, R2 minors); no
  row fails it at the `COMMIT`; the vault suites run with the stamp unset (one forced run, 880 passed);
  a code from an unlock that then fails, or from a retry that fails at the exit lock or the plaintext
  close, is logged late or never (R2 minors, re-check R2); a crashed session keeps the stale value (R1
  N1-2).
- **Stored messages (T2.12):** `hr:common.labelValue?label=…&value=…` shows free text as the app's own,
  with no failure lead (R1 m-1); a model answer, a review snapshot or a title that is exactly a
  well-formed code shows as that catalog text or C02 (R1 m-2 = R2 m-9), and a typed title
  `hr:main.chat.defaultTitle` is renamed by the next message (R1 m-8); the search snippet, the chat
  export, Copy, the model's history, the evidence-pack export, the review rename prefill and the export
  file names carry a code raw (X-1 to X-5, R2 m-1); two interpolated aliases that overlap are not refused
  (R1 N-2).
- **Extractions (T2.13):** the run bar shows a guarded Extract as an ordinary "done", and a correction
  kept only in `bank_corrections` shows uncorrected under C08 (R1 M-5 = D-10); a guarded Extract on a
  document whose newer row has no usable id says "Extracted 0 transactions." while the run-bar tools say
  "Read the statement first" (damage only; re-check N-1); the `''`/`NULL`-id guard rows exist for the
  bank table only (N-2); R2's minors (a gap between the guard and the delete nothing reaches, odd column
  values that fail a chat turn without writing, labels a plain category question overwrites).
- **Knowledge packs and skills (T2.14):** a known archive renamed while in a newer format reads
  "missing" (S-3 = R1-3); C05 shows only when the whole add fails and its first failed file is the
  newer one (R2-4); an old row whose folder was removed reads "Needs newer app" if a different newer
  skill later lands in a folder of that name (R2-3a); an import that throws between its reconcile and
  the registry's refresh shows a newly marked row as "Files missing" until the next reconcile (R2-3b).
- **F-27's own list (T2.11):** a refused file whose name holds `.parse` is stored as `<id>.parse.enc`,
  which the start's sweep shreds, leaving the failed row without its copy (S-1; follow-up FU-P2-4); the
  image history's stored names are covered in words only (S-6). P2's docs round (F-27 R1 M-2): after a
  roll-forward the journal is left for SQLite, so when that unlock's open fails before SQLite plays it
  back, `.enc` holds the torn copy, and the next unlock shreds the journal and opens that copy without
  it (it needs a later version that broke the WAL duty, §7.7). (The create's set-aside, which left the
  journal for SQLite to delete, takes it along since that round, S-b.)
- **Manifests and skills (T2.7's F-23/F-25 reviews):** an app skill only a later version bundles stays
  an undeletable "Files missing" row after a "Go back" (R2 m-2); the detail view describes a later
  version's skill by release 1's rules, and an unknown stored permission reads as release 1's ceiling
  ("cannot access the network"), on rows release 1 cannot run (R2 m-4, re-check R1-n1); a delete that
  keeps the files says "Skill deleted" with no log line, and after a stat that proves nothing a readable
  folder comes back as a new row, off (R1-n2); the skill export and the loader follow a stored row's
  `path` unchecked, for reads only (R1-n3; follow-up FU-P2-7); the goldens freeze a one-folder reader,
  while release 1 reads its bundle with the drive as overlay once P8 lands (MJ-7, P8's to test).
- **The security round (T2.7):** files set aside at a create stay on the drive, unencrypted, until a
  person deletes them (S-c, owner: keep and document); with a hand-set relative `HILBERTRAUM_DRIVE_ROOT`
  (the launchers always pass a full path) the journal's own entries are relative, so none vouches at the
  start and an interrupted password change waits for the unlock, which judges its stages under the data
  key (S-d, accepted); a copy placed beside an existing workspace can replace it at the next unlock,
  its rows and settings included: the roll-forward trusts a plaintext copy it cannot authenticate; the
  replacement is visible (the whole workspace at once), and the store guard bounds what its rows can
  delete (F-3's remainder, re-checks 1 and 2); a store a user keeps behind a link of their own keeps a deleted document's or
  image's encrypted copy (N-2's cost); the preview, export and OCR decrypt temps are named after the
  document's id with a random suffix, so a crafted id could put that short-lived temp outside the store
  (follow-up FU-P2-8).
- **The scripts (T2.10):** a pretty-printed engine marker is fetched again by the `.sh` twin with
  `--commercial` and kept by the `.ps1` twin (round 2); the `.sh` twin's gone-file check misses a gone
  file whose name holds a comma, or one recorded only in the top-level map when a nested map follows it
  (round 3; the app refuses such a copy at its start as `missing`); no golden vector has a nested
  `binaries` map that records a hash for a required file (QA re-check 2).

---

## 8. Policy keys, `update.log`, the drive-release record

_Status: as built in P3 on the phase branch (PR-3 pending; the second Fable review of F-8, F-11 and
F-13, T3.7, pending): the policy keys and their reader (§8.1), the app's `update.log` writer and its
startup, failed-start and unlock lines (§8.2), the drive version in the Copy report (§8.3),
`config/kit-support.txt` (§8.4), the `drive-release.json` reader and the builders' helper (§8.5), the
pins (§8.7). Planned: the support-end and age notices and the update rows of the support details (P6),
the readers' callers at the import and the hand-off (P6, P7), their `update.log` events (P6, P7), the
audit events (§8.6), the in-app writer of `drive-release.json` (P8). The names, grammars and read
contracts below freeze in release 1. Absent keys and an absent record mean today's behavior._

### 8.1 Policy keys (F-8, G-14 (c) built the simple way, U1 (b))

As built in P3 (T3.1 and its fix round): the reader `readUpdatePolicy` and the verdict
`updateInstallVerdict` in `main/services/policy.ts`, the SemVer 2.0.0 grammar and order in
`main/services/updates/version.ts` (no imports, so P4's release tools load it through type stripping;
P4's T4.2 extends it, CF-28), and the golden `tests/fixtures/readers/f8-policy/`. Both functions answer in
tokens only: `install` is `allowed`, `managed` or `invalid`, `file` is `read`, `none` or `unreadable`,
and the verdict for one version adds `above-max`. Frozen:

| Key | Meaning in release 1 |
|---|---|
| `updates.allow_user_install` | absent or `true` allows; `false` blocks every install ("Updates are managed by your organization", `managed`), whatever `max_version` says; any other value, `null` included, blocks as "the update policy on this drive has an invalid value" (`invalid`) |
| `updates.max_version` | absent: no cap; a strict SemVer 2.0.0 string allows versions up to and including it, in SemVer 2.0.0 order (pre-releases ordered, build metadata ignored); strict means at most 256 characters, ASCII, no `v`, no blanks, no leading zeros; any other value blocks as invalid; an update version that does not parse is above every cap |
| `updates.allow_online_check` | a **reserved name**: the Kit builders write `true` explicitly (U1 (b)); release 1 reads no value of it, junk included, and never ORs it into the network ceiling or the status line; its meaning belongs to the online-check version after release 1, which may refine it |
| `network.allow_update_checks` | unchanged: `false` everywhere, and the sell gate's refusal of `true` stays as it is |

The `updates.max_version` table:

| `allow_user_install` | `max_version` | Result |
|---|---|---|
| `false` | anything | every install blocked (`managed`) |
| absent or `true` | absent | allowed |
| absent or `true` | a version X | versions up to and including X allowed (SemVer 2.0.0 order, pre-releases included); a version above X is `above-max` |
| absent or `true` | a junk value | blocked: the update policy on this drive has an invalid value (`invalid`) |
| a junk value | anything | blocked as invalid |

- **The `updates` block.** A present `updates` that is not an object is invalid; `"updates": {}` means
  every key absent; unknown keys inside it are ignored; key names are exact and case-sensitive, so a
  misspelt key blocks nothing. Precedence: `managed` before `invalid`, both known before the update file
  is read; `above-max` needs the update's version. `maxVersion` is reported only while installs are
  allowed: it is null for `managed` and `invalid` (T3.1's D-1, confirmed).
- **A missing or damaged `policy.json`** keeps the signed import **allowed** and reports
  `file: unreadable`, so an administrator's typo that lifted a block is visible: missing on a prepared
  drive (`config/drive.json` there), or damaged on any root (empty, malformed, a top level that is not an
  object, a folder, a read error, over 1,048,576 bytes, not UTF-8, UTF-16 included); a root with neither
  file reports `none` and shows nothing. One leading UTF-8 byte-order mark is skipped (`loadPolicy`
  still reads such a file as malformed); invalid UTF-8 inside a string becomes U+FFFD; with a duplicate
  key the last one wins; a link at the name is followed, as `loadPolicy` follows it, so a dangling link
  reads as a missing file and a folder as `unreadable`. "Policy file unreadable" in Settings → Updates
  and in Diagnostics (P6) comes from this `file: unreadable`, never from
  `PolicyStatus.policyFilePresent`, which is `true` for a malformed file (CF-29).
- **A junk value blocks while a damaged file allows**, on purpose: a junk value is an administrator's
  edit, shown as invalid, while a damaged file must not block the signed repair. This is a deliberate
  exception to "a damaged policy never fails open" (G-14: a blocked import is a management control, not
  a security boundary, and updates are signed); [`security-model.md`](security-model.md) records it.
  Its cost: a read error of a moment, or an editor's save caught half-written, lifts a block for that one
  read (T3.1's review, R1-2; [`known-limitations.md`](known-limitations.md)).
- **Two readers, two answers for a missing file.** `loadPolicy` (the privacy and network posture) fails
  safe: on a provisioned drive a packaged build's missing or malformed file gives the strict defaults.
  `readUpdatePolicy` is a reader of its own, not a `PrivacyPolicy` field, and answers a missing file the
  opposite way ("allowed, unreadable"), because the `updates` keys are a management control, not a
  ceiling a lost file may loosen. Neither changes the other's answer; the typed `PrivacyPolicy`
  literals are unchanged.
- **When it is read**: from disk at every call, outside `loadPolicy`'s cache (the full audit's F-30,
  §12.4), so an administrator's
  edit counts without a restart, even one that keeps the file's size and time; a developer build and a
  packaged one read it alike. Its callers are P6's import and P7's "Restart and update" and "Continue
  the update" (CF-31 aligns the moments' names); in P3 only the sell gate reads it (§9.5). **Once
  `updates/applying/` exists the policy no longer stops it**: the start files parse nothing and
  resume, and "Continue the update" is not gated, because a half-done swap must finish. The admin
  section says so: block before the hand-off, or remove the staged update.
- **The writers.** A Kit's policy is the DIY posture plus `"updates": {"allow_online_check": true}`,
  written only through `prepare-drive -Kit` (`--kit`), which only `build-commercial-drive` passes at its
  step 1 (`buildPolicyJson({ kit: true })`; `script-drift.test.ts` pins the Kit literal in both twins).
  DIY and developer drives get no `updates` key, and their `policy.json` bytes are unchanged (pinned
  per twin and posture). `network.allow_update_checks` stays `false`; the install keys stay absent
  unless a managed Kit asks for them (a builder switch is a follow-up). On a Kit the old key no longer
  governs a later online check, so the admin section names `updates.allow_online_check`. The sell gate
  requires the Kit's key and refuses a junk install key (T3.8, §9.5).
- **Later-writer duty** (T3.1's review, R1-3): a later writer never widens the `max_version` grammar and
  never changes the types of `allow_user_install` (a boolean) or `updates` (an object): release 1 reads
  any other value as invalid and blocks every install.

### 8.2 `updates/update.log` (F-11, W-14)

A plaintext, content-free log on the drive, readable before unlock, for support:
- append-only lines, ASCII except the opaque time field of a `cmd` line (§5.3); every line starts with a
  writer token (`r1-app`, `r1-launcher`, `lb`, `apply-<version>`) and an OS token; a line written by
  `cmd` carries the raw `%date% %time%` as an opaque field and may carry no ISO time (both are formatted
  by the locale, and `wmic` is gone from current Windows 11). The OS tokens, the line frame and the time
  field: §5.3 (table B.2); the events of the hand-off, the apply and the start files: §5.4–§5.6;
- **content-free by each event's typed fields** (as built in P3, Δ-66): tokens, versions, codes and
  counts, no free text, no placeholders, no paths; the app writes only registered events, each key
  with one token rule or a closed list (§5.3). The app's writer reports an error only by its code (when
  it passes the token rule E) and its bare system call (`bareSyscall`), never by a message: never
  `failureForLog`'s `message`, nor `causeFailure`'s `sqlite` or `kind`, which carry free text. The
  redaction of `app.log` (#975) covers `app.log` only on its way out of the app, never this file, which
  `cmd` and bash write too;
- every message the user is shown is logged with its `UPD-*` reference code (§5.7, §5.8): P6's and P7's
  events, with `code` registered as a closed list (CF-41);
- **the startup line** (T3.2): the app version, the engine pins of the app's own bundled
  `runtime-sources.yaml`, the drive record's `app_version` and `format`, `drive_format_version` and the
  app's SQLite version (W-68), once per start of a prepared drive;
- **a failed start** (T3.2): the app version, the failure's cause, its code and its bare system call,
  written in the guarded start runner's catch (§7.3);
- **the unlock line** (T3.10; CF-23): one line after every unlock attempt, a success and every refusal,
  with the result and only that result's fields (§5.3): the workspace file's own `user_version` (read
  from its header before the migrations, which would make it this build's `SCHEMA_VERSION`) and the
  `last_writer` stamp found before the overwrite, passed through `parseLastWriter`, so only its parsed,
  bounded fields are written; for a refusal its reason as a token, `workspace_schema_unreadable` (W-68,
  T2.14) included. **It is the only durable trace of a refused unlock**: the app log and the audit line
  of a session spent at the unlock screen do not outlive the quit (T2.14 R2-6). It is also the only
  write a refused unlock makes: `workspace/` and `config/` stay byte for byte;
- **how to read the unlock line** (T3.10's review, m-2 and m-5):
  - `result=error` with a `writer` key means that the open finished: inside the vault every failure
    after the stamp is another result, so a step after the open threw. That session ran (the database is
    open, migrated and stamped again), and the next attempt finds the workspace open and writes no line,
    so the log shows one `error` and no `ok` for it;
  - no line is written for an unlock of a workspace that is already open, or for a password that is not
    a string; a create writes none;
  - a stamp stored as a BLOB or a number reads `writer=none`, not `unreadable`;
  - in developer builds only, the plaintext workspace's open writes the same line at the start, after
    the startup line (`ok`, or `workspace_newer` for a newer database left closed). Its newer-database
    line has no `found` key, while an unlock's has one; a plaintext start whose open fails for another
    reason writes no unlock line (its `start-failed` line covers it); and the plaintext header is read
    without its `-wal`, so after a session that ended uncleanly its `user_version` can lag;
- the file so holds the time of every start and of every unlock attempt, wrong passwords included,
  readable without the password. Example lines, from T3.10's real-app run on a scratch drive (a wrong
  password, then the right one):

  ```
  r1-app win32 startup version=0.1.66 llama=b12110 whisper=v1.8.6 kiwix=3.8.1 release=absent drive_format=absent sqlite=3.53.4 t=2026-11-26T00:35:50Z
  r1-app win32 unlock result=wrong_password t=2026-11-26T00:35:52Z
  r1-app win32 unlock result=ok user_version=1 writer=0.1.66 applied=interim t=2026-11-26T00:35:52Z
  ```
- the unlock line's other recorded limits are in [`known-limitations.md`](known-limitations.md): a
  throw inside the unlock handler's own catch would write no line; the refusals before the key
  derivation write a line at no cost, so a hostile renderer could flush the log; and forty attempts push
  the startup line out of the support copy's last 40 lines, so P6's copy takes the newest `startup` line
  on its own (CF-40);
- a write failure is swallowed and counted, so a read-only or full drive never breaks the start; the
  cap is 64 KiB, trimmed by the app to its newest 32 KiB from a line boundary, never while
  `updates/applying/` exists (§5.3);
- `PRIVACY.md` says the file is plaintext, content-free and on the drive.

### 8.3 "Copy details for support" and the Copy report (W-16)

- **The Copy report** in Settings → Diagnostics gains the app version, the drive content version, the last
  update and the staged update (P3 the versions, P6 the update rows). As built in P3 (T3.5): the app
  version was already in the "App & runtime" card and the report; the card gains the row "Version
  recorded on the drive" right under "App version", always shown, and the report the same line right
  after the app-version line. Its value is the record's `app_version` as written (a technical value,
  never translated), "not recorded" when the drive has no valid one (a root that is no prepared drive
  included), or "unknown" when the drive status could not be read. It comes from a main-side field,
  `DriveStatus.driveAppVersion`, which `buildDriveStatus` fills at every call, with no cache, from
  `driveAppVersion(readDriveRelease(root))` on a prepared drive only (§8.5;
  [`data-contracts.md`](data-contracts.md)). The labels are `diag.app.driveVersion` and
  `diag.app.driveVersionNone`, in all ten catalogs.
- **"Copy details for support"** is a frozen, content-free button on the unlock screen's sheet (§3.4), in
  Settings → Updates and on every update refusal and outcome notice, callable while locked (§3.5). It
  copies: the reference code of the notice it sits on; the app version and OS; the root apps per system
  with their versions; the start files matched against the payload; `drive-release.json`
  `app_version`; `kit-support.txt`; the policy state ("unreadable" included); the staged version;
  `updates/applying/` with its launch and hand-off counts and its start acknowledgement;
  `unconfirmed.txt`; the last 3 valid lines of `last-result.txt`; the last 40 non-empty lines of
  `update.log`; the free space; whether the drive is writable. No paths. A row still runs the
  copied text through the log redaction and asserts it comes back unchanged. The exact labels, values
  and order: §5.9 (table B.10).
- A persistent "Last update attempt" line (the outcome and the version) in Settings → Updates and on the
  unlock screen.
- It sits beside a named support contact (the Kit's support address on the project page and the
  packaging).

### 8.4 Support end and age (G-13 (b), G-29 (a), F-12, W-17)

- **The support end date is per Kit**: `config/kit-support.txt`, one line `YYYY-MM`, written only by the
  Kit builder, once (`config/` is outside the reconcile). A later extension is an owner action, never
  an app write. The plan's reading, which counsel checks (U10): the support period runs per unit placed
  on the market, so a Kit sold later gets a later date; the value comes after counsel, and the builder
  refuses to build a Kit without one.
- **Frozen, as built in P3** (F-13's write-once half; T3.3b; the reader `readKitSupport` in
  `main/services/updates/kit-support.ts`; golden `tests/fixtures/readers/f13-drive-release/kit-support.json`):
  - the file holds one month, `YYYY-MM`: four ASCII digits, a hyphen, two ASCII digits from 01 to 12
    (ISO 8601's calendar month);
  - only the Kit builder writes it, once per Kit; `prepare-drive`, the app and every later version never
    write, rewrite or delete it, and it is byte-identical after an update, a fallback and "Go back";
  - what every reader accepts: a regular file (by `lstat`: a link of any kind, a folder or a pipe at the
    name is damaged, never followed or opened; a `config/` that is itself a link is followed, as for
    `drive-release.json`), at most 64 bytes, holding one leading UTF-8 byte-order mark or none, then the
    month, then nothing, one LF or one CR LF;
  - anything else is damaged (`not-a-file`, `empty`, `too-large`, `not-a-month`) and never guessed at;
    a failed read is `unreadable` with its errno token only; no file (`ENOENT`, `ENOTDIR`) is `absent`.
    `readKitSupport` is synchronous, never throws, caches nothing and logs nothing;
  - the reader checks the form only, never a range: whether the month is past is the support
    computation's (F-12). P6's T6.4a computes from the parsed month and adds no parse of its own (CF-37);
  - the builder's bytes: the month and one LF, 8 bytes, ASCII, no byte-order mark, created exclusively
    (never through or over a link or an existing file). The sell gate accepts only these bytes (§9.5).
- **What the app shows** (P6): the date only when the file holds a month. "Copy details for support" shows
  the month, `absent` or `unreadable`, and a damaged stamp as `unreadable` (§5.9); a drive without one
  (a DIY drive) shows no support date, only the age reminder.
- **The writer, as built** (replaceable): `build-commercial-drive -SupportEnd <YYYY-MM>`
  (`--support-end` in the `.sh` twin) is required on every run but `-VerifyOnly`, a dry run included: an
  exact `YYYY-MM`, not before the building computer's current UTC month, with no upper bound. The month
  is echoed in words before step 1 ("kit-support.txt: support ends December 2031 (2031-12)"). Write-once
  as built: the same month in the builder's bytes is kept untouched; another month, a file that is not
  the builder's 8 bytes (a hand edit's CR LF or byte-order mark included), a link or a folder is refused
  (exit 1) before step 1; unsold stock is stamped again by deleting `config/kit-support.txt` on purpose.
  The builders run the helper `scripts/lib/write-kit-support.mjs` as `node --no-warnings`, right before
  the drive record (§8.5). The check at dispatch (the stamp not earlier than the dispatch month plus the
  declared period) is the Kit ritual's (P11c, CF-37), not the builder's.
- **The build date** has one source: the release commit's committer date, written at build time into a
  generated JSON beside `keys.json` and pinned by the release guard (§2.7); never a file's modification
  time, which a copy to exFAT resets. Its name and shape: §5.10 (table B.11).
- **The age reminder**: offline, 6 months after the build date; a dismissal hides it for 6 months, then
  it shows again; on Home and in Settings → Updates (G-29 (a)). It says that newer versions, if there
  are any, are listed at the update address. The page answers "you're up to date" where the Kit's line
  has nothing newer.
- **The end-of-support notice** is worded so it stays true if the period is later extended: the support
  period stated at purchase ended on the date, HilbertRaum keeps working as it is, and newer versions,
  if there are any, are listed at the address.
- **The clock rules**: both notices say "according to this computer's date"; both stay silent while the
  clock is before the build date. **Past `max(build date, support end)` + 3 years the notice is
  reworded, never suppressed**: a correct clock four years after the support end is exactly when a Kit
  left in a drawer needs it.
- Golden dates (§10.2): the build date − 1 day, both sides of the bound, the build date + 10 and + 30
  years. Counsel is asked how the support period is counted before F-12 freezes.

### 8.5 `config/drive-release.json` (F-13, W-20)

As built in P3 (T3.3a and its fix round, T3.3b): the reader `readDriveRelease` in
`main/services/updates/drive-release.ts`, the helper `scripts/lib/write-drive-release.mjs`, the golden
`tests/fixtures/readers/f13-drive-release/` (whose `read` and `noCache` groups are F-13's; its
`artifacts`, `tree` and `writes` groups follow the replaceable helper and P6's freeze of the root names).

**What release 1 reads, frozen:**
- the reader returns one of four kinds: `absent` (no file: `ENOENT`, `ENOTDIR`); `unreadable` (it is
  there, but the read failed just now: its errno token only, no constraint for that read only, nothing
  cached); `damaged`, with one fault (`not-a-file`, `empty`, `too-large`, `not-json`,
  `not-an-object`); or `record`, holding `appVersion`, `format` and `highestVersionSeen`, each
  `absent`, `invalid` or `valid` with its value;
- only `app_version` reaches a decision (the version rule, §2.5, through `driveAppVersion`): its valid
  value, otherwise null, no constraint. `format` and `highest_version_seen` are returned for the log
  only and never acted on: a record with `format` 2 or 99 has its `app_version` read as usual, so a
  later `format` bump never stops release 1, and a breaking layout takes a new file name;
  `highest_version_seen` is a reserved name. The startup line is where "logged" happens (`release`,
  `release_format`, §5.3);
- anything but a regular file at the name (a folder, a named pipe, a symbolic link or junction, to a
  record or to nothing) is `damaged not-a-file`, never opened or followed; 0 bytes is `damaged empty`;
  over 1,048,576 bytes is `damaged too-large` and never opened; exactly 1,048,576 bytes is read;
- one leading UTF-8 byte-order mark is removed; a second one, or one after any other byte, makes the
  file no JSON. The text is decoded leniently: bytes that are not UTF-8 inside an unknown field do not
  damage the record; inside `app_version` they make it invalid;
- only own fields count (a field under an own `__proto__` key is no field); with a duplicate key the
  last one counts; keys are compared byte for byte (`Format` and `"app_version "` are unknown), with
  JSON escapes in keys decoded;
- `app_version` and `highest_version_seen` are valid only as SemVer 2.0.0 (T3.1's parse), ASCII, at most
  64 bytes, compared byte for byte and never trimmed; anything else, `null` included, is `invalid`: it
  counts as absent and is logged as invalid;
- `format` is valid as a safe integer of at least 1 (`1.0` reads as 1); anything else (0, −1, 1.5,
  `1e400`, 2^53 + 1, `"1"`, `null`) is invalid;
- no cache: a rewrite of the same size and time is seen at the next read; the reader never throws and
  logs nothing;
- the open (the fix round): one `lstat` first, then an open that adds `O_NOFOLLOW` and `O_NONBLOCK` on
  macOS and Linux, then a check on the descriptor that a regular file was opened, else
  `damaged not-a-file`. What remains of the window between the `lstat` and the open: on Windows a link
  put at the name then is followed to the file it names; on macOS and Linux it fails the open as
  `unreadable` (`ELOOP`), not `damaged`, both no constraint (kept as built); a file cut to 0 bytes then
  reads as `not-json`;
- **a `config/` that is itself a link is followed** (a recorded residual, the #1047 class shared with
  `policy.json` and `drive.json`: whoever can place the link can write the file; pinned by a read
  vector);
- release 1 never writes the file. (Release 1 also carries P8's in-app writer, §6.9, §6.10, under
  G-40 (b), so P8's T8.2 sheet settles this sentence and T3.7's review checks it: CF-32.)

**What every writer keeps:**
- the bytes: UTF-8 without a byte-order mark, LF, a two-space indent; the writer's own fields first
  (`format`, `app_version`, `systems`, `files`), then every other field of an existing record in
  `JSON.parse`'s own-key order (an own `__proto__` and `highest_version_seen` included); never a record
  over 1,048,576 bytes;
- **unknown fields are kept, as far as a double holds them** (T3.3a's review, M1): release 1's helper
  rewrites a record through `JSON.parse` and `JSON.stringify`, so a later writer's own fields must
  survive a round trip through an IEEE double parser: integers beyond ±(2^53 − 1) and wide values go in
  strings; no duplicate keys; no meaning in key order, number spelling or whitespace. A golden `writes`
  vector pins what the helper does to such a record (2^53 + 1 becomes `9007199254740992`, `1e400`
  `null`, `-0` `0`, `1.0` `1`; a duplicate keeps its first place with the last value);
- **the owned fields**: an older builder's helper may rewrite `format`, `app_version`, `systems` and
  `files` at any time, in release 1's shape and with `format` back to 1, so a later shape takes new
  field names and no later reader infers its own fields from `format`; `format` stays informational;
- **a damaged record is replaced**: the helper writes a fresh one (with one warning line, exit 0), and
  the damaged record's unknown fields are lost; a folder or a link at the name is refused instead;
- `highest_version_seen`: the highest version that confirmed a start on this drive, written only after a
  confirmation (P8 fixes the rule, T8.2); release 1 never acts on it (§2.5), and the helper never writes
  it;
- `app_version` = the version of the apps at the root after the writer's operation: the confirmed new
  version after an update, the target after "Go back", unchanged after an automatic fallback; valid up to
  64 bytes (P4 refuses a longer payload version, CF-36). A writer that did not place the apps itself
  (`prepare-drive`, the Kit builder's last writing step) writes, as built (the kept rule): the one
  version when every root app carries it (one version for all means one app per system, since the
  version is part of the name); otherwise an existing valid value that a root app still carries by its
  exact name, so a re-run never drops a lagging system's floor and the kept value is never ahead of the
  root (a root `*.app` never carries one); otherwise it omits the field, which means no constraint;
- `systems` lists the systems with an app at the root, sorted; `files` lists the path and lower-case
  sha256 of the root app files, the four start files (`Start HilbertRaum.cmd`,
  `Start HilbertRaum.command`, `start-hilbertraum.sh`, `READ ME FIRST.txt`) and every regular file under
  `runtime/`: links are never followed (`runtime/` itself included), `._*` and `.DS_Store` are skipped,
  nothing comes from `config/`, `models/`, `docs/`, `logs/`, `workspace/` or `updates/`, and paths are
  sorted by UTF-16 code unit. The bytes depend on the tree alone, so both builder twins write the same
  record by running the one helper;
- the root names (not frozen here: F-18 is P6's, CF-33): an app carries a version by its exact,
  case-sensitive name, never by a prefix; a folder `*.app` that does not start with a dot is a macOS app
  of no known version; a file named `*.app`, a folder named like an app file and a link are no app. P6
  decides the case rule (the Windows start file's glob matches without case);
- the support end is **not** in this file (§8.4).

**Who writes it**: the node helper `scripts/lib/write-drive-release.mjs`
(`--target <drive root> [--dry-run]`), which loads the app's own reader module through Node's type
stripping (Node 22.18 or later), so the read, the version check, the root-name rule and the serializer
have one definition. It refuses a target that is not a prepared drive, a `config/` that is not a real folder, an existing
record it cannot read just now, and a folder or link at the record's name; it writes through
`drive-release.json.tmp`, a flush and a rename, then reads the record back (exit 1 with "the record was
written but could not be read back as written; check the drive" when that fails); a reader that cannot
be loaded gives one line and exit 1, nothing written. Every line it prints starts with
`drive-release.json`.
- `build-commercial-drive`: as **the last writing step, before the final check**: an un-numbered block
  after `verify-models --generate` (step 6) and before the gate (step 7), inside the verify-only guard,
  right after the support-end stamp (§8.4); the seven step numbers are unchanged. `-VerifyOnly` writes
  neither file; `-DryRun` plans both and writes neither; `-SkipPackage` writes the stamp and a record
  without `app_version`. After apps copied by hand, the record is written again
  (`node --no-warnings scripts/lib/write-drive-release.mjs --target <drive>`) before `-VerifyOnly`, or the
  builder is run again with `-AppArtifact`. Both builder twins run the helpers as `node --no-warnings`
  (Node's type-stripping warning would print a local path), show only the lines that start with the
  helper's file name, and stop the build on a non-zero exit; `node` 22.18 or later on `PATH` is checked
  before step 1;
- `prepare-drive`: at its end when `node` is on `PATH`, on every run (`-Force` or not; unknown fields
  kept); without `node`, or when the helper fails, one line and exit 0; under `-Kit` it leaves the record
  to the builder; it never writes `kit-support.txt`;
- the new version rewrites it after its confirmation and before "Go back" (§6.9, §6.10; P8).

`config/drive.json`'s `drive_format_version` and `config/checksums.json` are written by the drive scripts
(`prepare-drive` writes `drive_format_version`; `verify-models --generate` writes `checksums.json`) and
read by no rule; release 1 only logs `drive_format_version` (§8.2).

### 8.6 Audit events (W-18)

Content-free events in the workspace's audit log: `update_staged`, `update_applied`,
`update_rolled_back`; `update_check` and `update_download_*` are reserved for the online-check version.
An event that happens before unlock goes to `update.log` only. The engine download after an update
records the existing `engine_install_*` events with its own `trigger`.

### 8.7 Pins on the user's computer (W-15)

The user-data folder is shared by every version and every Kit on one computer, so (as built in P3,
T3.4):
- `appId`, the app scheme and the name the user-data folder derives from are pinned, as spike 8 found
  them (§10.6), and never changed: on Windows the folder is `%APPDATA%\@hilbertraum\desktop`, named by
  the `name` of the app's `package.json`, which carries no `productName`. The pins are
  `packaging.test.ts`'s "the user-data folder's name never moves": (i) `apps/desktop/package.json` is
  named `@hilbertraum/desktop`; (ii) it carries no `productName` and no `build` object, and
  electron-builder's `extraMetadata` sets nothing but `version`; (iii) `src/main` moves `userData` only
  for a developer run, never renames the app (`setName`, `app.name =`), and takes the single-instance
  lock at module top level after that move; (iv) no start file, script, workflow or app source passes
  `--user-data-dir` or `--profile-directory` (three developer tools that pass a scratch one on purpose
  are named: `scripts/verify-mac-build.sh`, `scripts/check-netlog.mjs`, `scripts/release/run-hold.ps1`),
  and no start file sets `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `XDG_CONFIG_HOME` or `HOME` for the
  app; (v) `appId` `space.hilbertraum.app`, the scheme `hilbertraum`, and `productName` and
  `executableName` `HilbertRaum` stay. A move of the folder above it (`app.setPath('appData', …)`) is not
  pinned yet (T3.4's S-a): T3.4's review fix round is to add it to (iii);
- **a check on the packaged build asserts the path itself** (T1.11 S8-1; T3.4's Q1): the step "Check
  the packaged app's user-data folder (app-update W-15)" in `release.yml`'s `build-win` leg starts the
  portable exe just built the way a user does (a scratch drive root, no profile switch) and waits for
  `%APPDATA%\@hilbertraum\desktop\lockfile`, which exists only while an instance holds that profile; it
  fails when none appears there within 5 minutes or when the start leaves a lockfile anywhere else. It
  runs on every `v*` tag and every dispatch of the workflow (its first run is a dispatch on the branch
  before PR-3, with the owner's OK), the release job needs it, and P11c's T11.15 runs it on the release
  head; a `packaging.test.ts` row pins its wiring;
- an allow-list pins the renderer's `localStorage` keys (`repo-hygiene.test.ts`): Chromium recreates a
  store it cannot open, so nothing whose loss changes behavior may live there. The list holds four UI
  preferences that fall back to a default when lost (`hilbertraum.uiLanguage`,
  `hilbertraum.chat.listCollapsed`, `hilbertraum.docs.railCollapsed`,
  `hilbertraum.docs.locationsMoreOpen`); nothing is kept in IndexedDB; the screenshot harness
  `renderer/preview/`, which never ships, is left out;
- `portable.unpackDirName: true` joins these pins once #1043's fix reaches the integration branch (an
  open item for the phase running then);
- for every electron-builder, NSIS or Electron major bump, P11c re-runs two checks that
  [`packaging.md`](packaging.md)'s pre-ship checklist holds as items 14 and 15: the name inside each
  built `app.asar`, and the portable stub's hold on the drive-root exe, measured by
  `scripts/release/run-hold.ps1` (moved from the spike's working papers with its `lib.ps1` and
  `T11Native.cs`, every path a parameter).

---

## 9. Release side and ritual

_Status: planned (P5; release 1 itself is P11c), except the sell gate's M1 half, as built in P3
(§9.5). The release tools are replaceable; the published assets and the keys are permanent._

### 9.1 The deploy stop and the integration branch

- The whole wave lives on one integration branch, `feat/app-updates` (G-2 (b)). Every phase pull request
  targets it with green CI (`ci-success` is required there through the existing ruleset, G-41);
  `master` reaches it only through sync pull requests. `master` receives the wave once, through one
  final pull request merged with a merge commit.
- Until then `master`'s `BUILD_STATE.md` points at the branch and lists the files release 1 freezes
  (G-42), so other work on `master` asks before it changes them.
- **No version tag before release 1**, on any branch. One exception: a files-only GitHub release whose
  tag does not start with `v` (§9.7).

### 9.2 Release 1 on `master` after the final pull request

After the final merge, release 1's release pull requests land on `master` through CI: the version bump
and its CHANGELOG section; the production `keys.json` (§2.7); the Windows code-signing (Authenticode)
wiring once the certificate exists; the approved `SECURITY.md` "Supported versions" text; then, right
after the tag, the release-1 import-reader snapshot and the release record (also into `kit/<version>`).

Release 1 is tagged on `master`:
- once every system's real-hardware tests passed (G-15 (a): every Kit carries all three systems; a
  failing system holds release 1, never a reduced Kit);
- with the production keys and the Kit's support end date (§8.4) in place;
- with the update walk re-run on `master`'s head and, for a Windows Kit, on the signed artifact;
- and it is published only after the key proof (§2.8) passed on its draft artifacts.

**Versions**: `master` stays at 0.1.66 through the deploy stop. Release 1 is the next minor version;
its patch numbers belong to its fix line (§9.6); the next release from `master` is the minor after it.

### 9.3 The release ritual (W-23)

1. A `v*` tag runs `release.yml` (it runs on any branch): it builds the three apps, the payload (its
   `files[]` lists every member, the apply scripts and the start files included) and the SBOM (from
   `npm sbom` with the lockfile, plus hand-written entries for Electron as shipped and the engine pins;
   kept out of the signed payload). The release is a **draft**, flagged pre-release.
2. The owner smoke-tests the draft's artifacts, then runs the signing tool **offline** ("sign what you
   tested"): it rebuilds the payload from the smoke-tested files plus the tag checkout and signs only if
   it is byte-identical to CI's; it checks the engine entries against `runtime-sources.yaml` at the tag;
   it refuses a payload whose `requires.linux` is not a string of dot-separated decimal integers, which
   every release-1 Kit would refuse (§2.4; the pre-publish check refuses it too); it prints the version,
   the channel and `min_upgrade_from` and waits for a typed confirmation. It can add a signature to an
   existing envelope in a second offline session (rotation). Routine releases are signed by the active
   key alone.
3. The update file builder (in process, the container of §4) writes the full update file and one per
   system set; they are uploaded to the draft with the envelope `hilbertraum-release.dsse.json`. The
   update file's name is outside the `HilbertRaum-*` prefix that the sell gate and the start files scan.
   Member 0 is the signed envelope, so the builder runs only after the owner's offline signing: **the
   owner runs it** (`build-hrupdate.mjs`, T5.4) on any computer of theirs (it needs no key) and uploads
   the update files to the draft release, which keeps CI away from releases (§9.8; owner 2026-11-24).
4. **The pre-publish check** (the draft check) verifies the envelope against the key set of **every
   supported released tag**, checks that every asset is there with its hash, that the name table
   written into the two apply scripts matches the payload's `install_as` values (§5.5, "Name tables"),
   and the pre-release flag for the channel.
5. **Publish.** Only stable (Kit) releases carry an envelope (§2.6). A Kit release: pre-release unticked,
   "Set as latest" ticked; an older line's fix release: "Set as latest" unticked; from release 1 on,
   every other release stays flagged pre-release (G-11: option (a) is the plan's recommendation; decided
   in P5, §11.2).
6. **The post-publish check**, after every publish: fetch
   `releases/latest/download/hilbertraum-release.dsse.json` anonymously, verify it, assert the tag and
   the channel, re-hash the published assets.
7. The buyer notice and, for a security release, the advisory (§3.2).

**Per engine-pin bump** (T5.13): every committed manifest's weights load on the new engine; a model it
cannot load moves behind `min_app_version` with a replacement; the new version's arguments run on
release 1's pin (§6.6).

**Per release offered to Kits, the reach of each system** (G-24 (a)): the ritual refuses to offer a
release that raises a system's OS floor (an Electron major that drops an OS version) to the Kit channel
while any supported Kit release stated a lower floor at sale; those Kits stay on a floor line, and on a
multi-system Kit the whole drive stays there.

### 9.4 Which file Kit buyers get (G-36, G-27)

- Kit buyers are offered **one** update file, for all systems, in the buyer notice, on the project page
  and on the release page's Kit line. The per-system files are listed only in the admin section.
- The apply installs only the systems whose app is already at the root: a Windows-only drive never gains
  a Mac or Linux app it did not carry (§5). The import's free-space check counts the whole file.
- Update files stay under GitHub's 2 GiB per-asset limit, with a warning at 1.9 GiB; a larger one is
  hosted on the project's mirror. Today's full update file is about 0.5 GB, without engines.

### 9.5 The sell gate (W-33)

A Kit is built only with the builders of its own release tag, from that release's signed assets. The
gate, which both builders call, also:
- takes the release's `.dsse.json`, verifies it with the production keys, and requires every root app's
  sha256 to match it, so a local or walk build can never become a Kit;
- refuses an empty key set;
- requires `drive-release.json` with `app_version` equal to the apps, and `config/kit-support.txt`
  (as built in P3, below);
- requires every root start file and `READ ME FIRST.txt` to match the sha256 the signed payload lists;
- requires the drive's `runtime-sources.yaml` to equal the Kit app's bundled copy, and
  `DRIVE-NOTICES.md` to be generated from it;
- refuses any file in `updates/` (a Kit ships with no `updates/` folder; a smoke start is made on a copy;
  as built in P3);
- refuses a root app with the read-only attribute, and `prepare-drive` has the same check (W-33,
  Δ-37; as built in P3): release 1's launch counter would never count on such an app (§11.3);
- repeats the timestamp-countersignature check on the Kit's exe; the check at dispatch that
  `kit-support.txt` is not earlier than the dispatch month plus the declared period is the Kit ritual's
  (P11c's checklist, CF-37), since the builder refuses only a past month (§8.4);
- from P8 on: the manifests and pins match the app version, and a pin folder (§6.6) is checked like the
  live one.

**As built in P3** (T3.8, the M1 half of W-33, `commercial-drive.ts`; replaceable tooling, nothing here
is frozen; its review is pending). The gate's `checks` gain `kitUpdatesKey`, `releaseRecordCurrent` and
`supportEndStamped` (19 in all), and it:
- requires `policy.json` to hold an own `updates` object whose own `allow_online_check` is `true`, read
  by a private reader of the gate's own (never through `policy.ts`, never fed into the network ceiling),
  so U1 (b) is enforced at sale (T3.1's review R1-1; this answers CF-30 for every Kit built since); and
  refuses a Kit whose `readUpdatePolicy` answers `invalid` (a junk `allow_user_install` or
  `max_version`), since release 1 would block every import on it for good (owner, 2026-11-26), while
  `managed`, a deliberate `false`, passes; a non-object `updates` gets the Kit-key line alone;
- requires `config/drive-release.json` to read as a record whose valid `app_version` equals the one
  version the root's apps carry (`rootArtifactOf`, `chooseAppVersion`'s `single`, §8.5). An absent,
  unreadable or damaged record, one with no valid `app_version` or another version, and apps of no single
  version each get one line that names the way out: write the record again with
  `node --no-warnings scripts/lib/write-drive-release.mjs`, then check again, since `-VerifyOnly` writes
  nothing (a folder or link at the name is deleted first);
- requires `config/kit-support.txt` to read as a month whose bytes are exactly the builder's 8
  (`readKitSupport`, `formatKitSupport`): a hand edit's CR LF or byte-order mark, or a missing line
  feed, is refused; there is no range check (above). Its lines name `build-commercial-drive -SupportEnd`;
- refuses a Kit with any entry in `updates/` ("this drive was started: delete the updates/ folder"):
  `updates` joins `USER_DATA_DIRS` and both builders' own lists; an empty `updates/` passes, like an empty
  `logs/`;
- fails `runtimeHashed` (`optionalRuntimesConsistent` for the knowledge-pack tools) for a file in an
  engine folder that the copy's map does not record, found by exactly `installedFileKeys`' walk (never the
  marker, a top-level `cpu/`, `cpu.new/` or `cpu.old/`, macOS `._*`, `.DS_Store` or `__MACOSX/`; a link
  counts only when it resolves to a file; a folder that cannot be listed fails closed), checked only
  over a map that hashes every required file, with the names #729 reported left out. This closes #1025's
  unrecorded library at the moment of sale (T3.12's review, M-2). The line names deleting the file, or
  the engine folder and building again: `fetch-runtime --commercial` skips a copy whose map hashes the
  required files;
- judges the root apps by `rootArtifactOf`, the helper's one classifier (§8.5), and refuses an extracted
  `*.app` folder, a hidden one included (owner, 2026-11-26: a Kit ships the macOS app as its zip; this
  reverses #233's earlier acceptance, since a folder carries no version the record could name), a name
  whose version segment is no version, any other root file named `hilbertraum-*` in any case (the
  Windows start file matches without case; the classifier itself stays case-exact until P6, CF-33), and
  a root app with no write bit (`mode & 0o222`; on Windows the read-only attribute);
- and both `prepare-drive` twins refuse a root app (the three root globs, any case) with no write bit
  before they write anything, in a dry run too: one line per app, exit 1 (W-33, T1.11 P3-3).

The problems are listed in this order: posture, the Kit key, weights, reviews, user data, notices,
engines, source bundle, OCR, skills, platform matrix, apps, start files, record, support end. The `.ps1`
builder hands the gate its own target (`$NodeTarget`, one trim rule); neither builder adds a native
pre-flight line of its own for the record, the stamp, the Kit key or the engine walk.

Limits as built (also in [`known-limitations.md`](known-limitations.md)): a locally compiled macOS or
Linux voice engine (`runtime/whisper.cpp/mac`, `…/linux`) has no marker, and no gate check looks at it
(a follow-up candidate: a marker for a locally compiled engine); the engine walk does not see files under
a top-level `cpu*/` folder of a copy whose family has no such build, a link to a folder, or a dangling
link (no installer records them either); `drive-release.json`'s `files[]` is not checked for freshness
(T5.10 hashes the apps and start files against the payload); "read-only" means the write bits or the
read-only attribute, not an access list that denies writing (§11.3's other case); the gate follows a
link at `updates/` (the app refuses one; exFAT holds no links); and the record is not compared with
`--app-version` on its own line (an artifact of another version gets its own line).

### 9.6 The fix line (G-16, W-54)

- `kit/<version>` is cut at release 1's tag and joins the branch ruleset, with a separate rule for `v*`
  tags.
- Security-only releases are tagged from it with the Kit release's own drive content. A fix is a pull
  request into `kit/<version>` and, where it applies, one into `master`.
- Before a fix release is offered to Kits, the walk "Kit tag → fix tag" passes on every sold system, and
  the first real signed fix file is imported into the real release-1 artifact.
- An AI engine fix can ship on the line (a download after the update, or the escape hatch, §6.5).
- An older line's fix release is published with "Set as latest" unticked.
- How the line follows Electron majors is open (G-25, §11.2).

### 9.7 A files-only release before release 1

Before release 1, a GitHub release whose tag does not start with `v` (no app, nothing for sale; the
owner publishes it) may host engine files: the Mac and Linux voice-engine builds (§6.8) and, under
G-28's option (a), the signed Windows engines. `release.yml` does not run for it.

### 9.8 What only the owner does

Agents never generate, hold or use signing keys, sign, tag, publish or edit releases, merge pull
requests, procure certificates, email buyers, post advisories or make legal statements. Agents draft;
the owner acts.

### 9.9 Duties for the support period

- Immutable releases are on before release 1, and releases are never deleted.
- Every published release has a second home outside GitHub (an offline copy and an EU mirror); the plan
  is to keep the domain of §3.3 and both its sub-paths for ten years.
- A toolchain archive per Kit tag (the npm cache for the tag's lockfile, the Electron zips, the
  electron-builder cache, the Node installers, the engine archives, the runner image versions), so a Kit
  tag stays rebuildable; Kit branches pin explicit runner labels; a yearly rebuild drill.
- A withdrawal playbook for a bad release (a valid signature never expires): untick Latest, retitle the
  release "WITHDRAWN: use vX", publish a fix with a higher version, send the advisory and the buyer
  email; dry-run once before release 1.

---

## 10. Test record

_Status: planned. Each phase records here what it proved, as built._

### 10.1 Tiers

| Tier | Where | Runs | Proves |
|---|---|---|---|
| Unit | `apps/desktop/tests/unit` | every pull request, every CI leg | pure rules: the PAE, the parser, the version rule, the grammars, the validators, the policy matrix |
| Integration | `apps/desktop/tests/integration` | every pull request, every CI leg | the real file system, the in-process update file reader, SQLite, the vault and the scripts on temporary roots; IPC against real services; an injected fetch for the network; the reader snapshots |
| Renderer | `apps/desktop/tests/renderer` | every pull request | states, copy keys, accessibility roles; all ten catalogs complete |
| Dev-app end to end | the app driven over the Chrome DevTools protocol | per phase, locally | UI → IPC → main on a scratch drive root |
| Packaged walk | `tests/manual/update-walk.test.ts` (`HILBERTRAUM_UPDATE_WALK=1`) | locally from P7; as a workflow on Windows, macOS and Ubuntu from P11a; before each Kit release | the real apps, start files and apply scripts, parked kill points, the fallback, the old version's notices |
| Hardware | the owner, with written step lists | P11a, P11b, P11c | Smart App Control, Gatekeeper, an exFAT unplug, antivirus, timing on the Kit's SSD and on USB 2 |
| Real network | manual, once | the first signed release | GitHub's redirects, the download servers |

**Reader snapshots** (W-53): single-file builds of release 1's readers (envelope, payload, version
rule, update file reader, policy, `drive-release.json`, the descriptor guard, the database open), made
by a committed script from the tag. A per-pull-request suite feeds files the current code writes
through them. P2 creates the recipe with a v0.1.60 snapshot; release 1's import-reader snapshot is made
right after its tag, because the pre-publish check runs it over every Kit update file from the first fix
release on.

**Upgrade coverage**: the tiers above prove what an upgrade must carry over: the app itself (apps, start
files, the swap, the fallback, "Go back"); the workspace database (migrations, the old-reader guards,
data the new version wrote read by release 1 after "Go back"); model manifests; skills; engines;
`policy.json`, `drive.json`, `workspace.json`, `kit-support.txt` and `drive-release.json` byte-identical
after an update, a fallback and "Go back"; the drive docs; the user's computer (the user-data folder,
the Chromium profile, the macOS cache).

### 10.2 Golden contracts and reviews

- Every frozen contract (§1.6) has a golden test. Its expected values live in data fixtures with an
  origin other than the code under test: the DSSE specification's PAE example, the RFC 8032 vectors,
  negative vectors written from the specification without reading the verifier, envelopes signed by an
  independent tool. A committed sha256 manifest locks the fixtures, and `repo-hygiene.test.ts` checks
  it.
- Goldens are split into "the old reader accepts X" and "the current writer emits X".
- Two independent reviews per frozen item, with different lenses; the second lists the item's consumers
  itself before it reads the change's impact notes.
- A deliberate mutation in the production owner of every new row proves the row can fail.
- Committed sha256-locked fixtures are test inputs, not generated files.

### 10.3 The protocol model (W-59)

An executable model of the drive's state machine checks the update protocol: the import, staging, the
hand-off, the apply journal, the start-file rules with their markers and counter, the fallback, the
confirmation, "Go back", the outcome notices and the version rule, under kills, unplugs, moves between
computers and systems, antivirus, blocked helpers, read-only drives, clock jumps, damaged staging,
re-imports and a second update. It is kept with the wave's working papers, outside the repository.
- **Rule**: the protocol tables of §4 and §5 are entered into the model before the owner sees them, and
  every rule family runs to an empty frontier. The model is re-run on every change to F-5–F-7, F-19,
  F-20, F-22, the apply script, "Go back" (W-21, W-22) or the engine-folder rules (W-30, W-67); a new
  counterexample blocks the change until it is fixed or the owner accepts it as a residual. It is an
  extra check, never one of the two reviews.
- **Done for the tables the owner approved on 2026-11-24**: every rule family ran to an empty frontier
  at an adversary budget of 2, after its first counterexample on the tables was fixed (rule 2's pick,
  §5.6) and the forward apply was made to leave one app per system in `updates/previous/` (§5.5).
- **Its known gaps**, so an empty frontier is never read as covering them: the migration and vault schema
  are outside the model; an import cut by an unplug and a new version that shows no window on any
  computer are not produced by it; a second Kit on the same computer is not an event; the file-level
  rules of the engine folders (§6.6, §6.7) are below its abstraction (one atomic "folder + marker"); the
  state "`updates/applying/` holding only the scripts" (§5.5 "Nothing to resume") enters it with P7's
  re-run; on the larger configuration three of its invariants were checked on a sample of the quiet
  states (30,000 of 537,059), and P8's re-run checks them all.
- The model's counterexamples are named CE-n (§12.2); each becomes a walk row in P7.

### 10.4 The update walk (W-35)

- The old and the new version are built from **throw-away copies** of the source (a worktree at the tag
  or the head in the walk's own temporary folder; a tag's copy runs its own `npm ci` from the tag's
  lockfile), with a per-run test public key written into `keys.json` and the version set by
  `-c.extraMetadata.version=<version>-e2e`. One process generates the key pair, builds, signs the new
  version's payload and discards the private key; nothing is uploaded. A new version that never
  confirms is a stub app that exits at once.
- Kill points are **parked**: on Windows an exclusive handle on step k's file, so the script's own retry
  parks there; in bash a harness-side `BASH_ENV` DEBUG trap or a `PATH` stub for `mv`. Every row asserts
  the state in the middle before recovery.
- Runs started by the start files or the scripts are judged by observables that need no test hook
  (`update.log`, `updates/applied/`, the process list, the root tree); data checks run on a second start
  of the bare exe with `--remote-debugging-port`.
- The workflow `update-walk.yml` runs on a push to a `walk/**` branch before the final pull request and
  by `workflow_dispatch` after it. From the first update after release 1 on, the old version is built
  from the Kit tag. Its Windows legs include Windows 11 on ARM (GitHub's `windows-11-arm` runner, the
  x64 portable exe under emulation; owner 2026-11-24).
- No harness queries the Restart Manager about a running apply script: the query breaks it (§5.5, the
  cmd rules).

### 10.5 Real media and real people

- **The test-drive acceptance** (G-45 (a), W-79), in a drive root folder of its own on the project's
  used exFAT test drive (a USB stick prepared and used by older versions), after a full backup the owner
  confirms: **stage A** (P11a) takes a v0.1.56 DIY drive that was really used, runs one session on
  v0.1.66, then moves it to the release-1 candidate by the documented manual path, and proves every user
  file byte-identical; **stage B** (P11b) takes release 1
  to a test-signed new version through the real update path, with "Go back", an engine change, an unplug
  during the swap and a new version that exits at once.
- **The owner's hardware legs**: spike 2 (Smart App Control and the "unsigned from USB" attack-surface
  rule on the signed Windows artifact) in P11c; in P11a spike 3 (macOS), spike 4b (Linux on a real
  stick), a reduced spike 5 (a hard unplug), the browser leg (a large file downloaded from an email link
  in four browsers), the read-only leg, the restart timing on the Kit's SSD and USB 2 (G-39 (a), O22),
  which also runs on a Defender-only PC (PC D: the hand-off's times, the in-flight probe timed from the
  click on a never-seen build, a deep root with `LongPathsEnabled=0`; §5.4, §5.6), and a Windows VM
  with the Japanese system locale for the start files (§5.6); the full spike 5 and spike 6 (timing) in
  P11b.
- **Buyer sessions** (G-38 (a)): five moderated sessions (three on Windows and two on a Mac, one of them
  with a two-system Kit and one on a managed PC) with the notice, the page and a test-signed file on a P7
  build, before the second part of the release-1 copy is approved.

### 10.6 Spike verdicts

The spikes of P1 measure what the design must not guess. Each has a verdict file (question, setup,
method, numbers, verdict) in the wave's working papers, outside the repository. The method review T1.11 read spikes 1, 1b, 8, 9, 10 and 10b and found each "sound with
limits"; its finding ids are in §12.5. Spikes 4a (Linux, in WSL2) and 7 (the history fixture) had no
method review; their rows name their own limits. Each verdict names its Electron version (43.8.10) and is re-run
on an Electron major bump before M1.

**One box** (T1.11 C-4), a limit of every row below: all finished spikes ran on one computer, Windows
11 Insider build 26300 (de-DE), x64, Norton 360 the active antivirus with Defender passive (and, unless
a row says otherwise, every timed file's hash already known to Norton), `LongPathsEnabled=1`, Windows
Terminal the default terminal; spike 4a ran inside WSL2's Ubuntu 24.04 on the same box. Release builds of Windows, an active Defender and the other systems are
covered later, by the walk (§10.4) and the owner's legs (§10.5).

| Spike | Question | Verdict | Supports | Limits (T1.11) | Open legs: owner |
|---|---|---|---|---|---|
| 1 (T1.1) | How long the Windows portable stub holds the drive-root exe after the app quits, on NTFS, exFAT USB 3 and exFAT USB 2, for today's stub and #1043's per-start one; whether a hidden, detached apply that waits, renames and starts is flagged | Holds, bounded: once the app's process is gone the stub releases the exe in 0.22–0.27 s and exits in 0.42–0.62 s (45 runs, both stubs, all three media); a 247 MB workspace locks in ~10 s on exFAT USB 3, before the spawn; 15 of 15 detached applies ran, none flagged | `budget 30` (§5.4); the stub's order behind the Windows wait (§5.5); part of the spawn → `started` time (§5.4) | no active Defender (S1-1); known hashes (S1-4); one start form (S1-5); the order rests on electron-builder's `portable.nsi`, not on the poll (S1-3); a slow PC or a hard-disk `%TEMP%` not measured, and build B leaves its ~480 MB `%TEMP%\ns*.tmp` folder after a killed start or a power loss (S1-8) | the Defender PC, cold starts, the lock on USB 2, the real hand-off's timing: P11a (T11.3a, T11.8, O22); the exFAT and FAT32 VHD leg, the reduced unplug: P11a; the full unplug: P11b (spike 5); the leftover folder: #1043's fix; a slow PC: unowned |
| 1b (T1.1b) | Is the drive-root exe held for the whole start, from the double-click to the window, also while the antivirus sandboxes a never-seen build? (F-7 (d)'s write-open probe against a rename test) | Holds: the write-open probe reads "held" from the stub's process creation to its exit, 2,457 of 2,457 samples over 18 starts (both stubs, NTFS and exFAT USB 3, two never-seen first starts that Norton sandboxed for 71.7 s and 77.9 s); "free" only before the stub's process exists (21–143 ms after the start request); a rename test is no probe ("free" for 0.57–9.8 s while the stub has not opened its exe); a failed cmd redirection leaves ERRORLEVEL unchanged | the in-flight probe and its `if exist` guard (§5.6); the Windows wait by the same probe (§5.5); the `\|\|` / `if exist` rule (§5.6); spike 1's order, 18 of 18 | the time before the stub's process exists measured under Norton only (P3-1); the wait not run inside an apply (P3-4); a read-only root exe silences the counter (P3-3); no USB 2 | PC D's row (Defender, a never-seen build, timed from the click through the start file; it can reopen §5.6's text before the M1 commit) and a USB 2 root: P11a (T11.3a); the probe wait and the first move's retry in a real apply: P7 (T7.2); the two-start race: accepted (§11.3) |
| 4a (T1.6) | The static-runtime AppImage on a stock Ubuntu 24.04 (WSL2) without libfuse2, with and without `APPIMAGE_EXTRACT_AND_RUN=1`; replacing it while it runs on exFAT; this computer's glibc read as the `linux` floor will read it; the detached bash hand-off from the packaged AppImage | Holds: the static runtime (`toolsets.appimage: "1.0.3"`, type2-runtime `dd6cebe`) starts without libfuse2, normally and under extract-and-run (3 of 3 each; the legacy runtime fails 3 of 3), with `APPIMAGE` absolute and `APPDIR` holding the exe in every start; a running image is renamed and replaced in ≤ 14 ms on ext4, FUSE exFAT and drvfs while it keeps reading its own bytes and the new one starts beside it; table B's spawn holds 52 of 52 (its own session, outlives the app and the old mount, renames 67–224 ms after the app's exit; dash only: `started` 1 of 1); glibc reads `"2.39"` from `glibcVersionRuntime`. Three Scripts and rule-1 faults, fixed by measured forms: rule 1 as a terminal's session leader (0 of 4 → 6 of 6), the bash final step (an empty `applying/` on FUSE exFAT and drvfs, a bad cwd → 5 of 5), a zombie's wait (24 s → 63 ms). The static runtime needs fuse3's `fusermount3` (else exit 127), keeps its extract-and-run folder, and no AppImage starts from `noexec` | G-6 (a)'s runtime and F-21's `APPIMAGE` lookup (§3.6); `requires.linux` (§2.4); the macOS and Linux spawn, Linux half (§5.4); the wait's `stat` test, the bash final step and the bash rules (§5.5); `start-hilbertraum.sh`'s rule 1 and the `.command`'s `trap` line, provisional (§5.6) | not method-reviewed (T1.11 read the Windows spikes); the spike's own limits: WSL2 Ubuntu 24.04 only; exFAT through FUSE and drvfs, no kernel exFAT; the probe app, so the real app's `comm` `HilbertRaum` is inferred; a pseudo-terminal, not a terminal emulator's window; `boot` at rest only | kernel exFAT (udisks2's options, `showexec`, the final step with an open `apply.sh`), fuse3 on stock Ubuntu 24.04/25.10 and Fedora desktops, an extract-and-run folder planted by another user, a real terminal's window close, `boot` after a sleep and a clock step, the real app's AppImage, `/bin/sh` that is bash (Fedora): P11a (spike 4b, T11.3a); macOS (`comm`, `stat`, `nohup` and a closed Terminal window, the `.command`'s rule 1): P11a (spike 3); a second instance, a stale lock, `sync` per step: P7 (T7.2); an unplug mid-apply: P11a (the reduced spike 5) |
| 7 (T1.5) | One history fixture from tag v0.1.50 built with that tag's own toolchain: do the full-text-search shadow rows restore under `defensive: true`? | The binary holds: v0.1.50's own toolchain still installs (`npm ci` 25.5 s, 814 MB) and made the fixture (`user_version` 0, 38 tables, two FTS5 tables with 10 shadow tables); HEAD's `openDatabase` opens it with `defensive: true` and migrates it to `user_version` 1 in Node 24.13, Electron 37 and the packaged Electron 43: no release-1 defect. A `.dump` text **fails** under `defensive: true`, at `INSERT INTO sqlite_schema`, not at the shadow rows (through one `exec()` it leaves an empty file that HEAD opens as a fresh workspace with no error); "content tables + `'rebuild'`" gives an empty FTS index that passes `integrity-check`; the logical form (the FTS rows inserted through the virtual table with their rowids) holds under both settings. `node:sqlite`'s `defensive` default differs by runtime (absent on Node 22.21.1, off on 24.13.0, on on 24.22.1 and in Electron 43); a dump that renumbers implicit rowids silently breaks `covers_through_rowid` | no frozen value: the fixture recipe of T10.6a (logical SQL text, every implicit rowid kept, never a shadow table or `writable_schema`, loaded with an explicit `{ defensive: true }` in one `exec()`; accepted by the orchestrator, Δ-40), T10.7's normalisation list (row counts, the rowid links), and an explicit `{ defensive: true }` in `openDatabase` (P2, T2.2) so that tests run as the app does (§7.8) | not method-reviewed; the spike's own limits: one tag, a plaintext workspace only (no `.enc`), NTFS on Windows only; CI's current Node 22.x patch not measured; the logical form does not reproduce the physical FTS segment layout | chained fixtures, the other tags, regeneration that is byte-identical and the `.enc` form: P10 (T10.6b, T10.5); CI's Node 22.x legs and generation and loading on macOS and Linux: P10 (T10.7); the migration time on a large workspace: P10; a later step that touches FTS internals (`'optimize'`, `'merge'`, a tokenizer change) needs a fixture made from a binary: unowned |
| 8 (T1.2) | What `app.getPath('userData')` and the single-instance lock derive from in a packaged build, what changes them, and whether `--user-data-dir` redirects them | Holds: the profile is `%APPDATA%\@hilbertraum\desktop`, named by the `name` of the asar's `package.json` (it has no `productName`); the exe's name, folder and drive letter, `version`, `appId` and electron-builder's `productName` do not move it; the lock (a message window titled with the path, `<userData>\lockfile`, a startup mutex) separates two builds; `--user-data-dir` redirects it; two starts of one build shared the stub's `%TEMP%` folder (#1043, found here) | W-15's pins (§8.7, P3); why the apply waits for the stub (§5.5; the times are spike 1's, S8-6) | the pins check names, not the runtime path, and nothing re-measures per Electron major (S8-1, S8-2); the shared-folder text describes build A, not release 1's build B (S8-3); Windows only | a packaged-build check of the runtime path: built in P3 (T3.4: `release.yml`'s `build-win` step, §8.7), re-run in P11c (T11.15); a cross-version lock row per Electron major: P11c (T11.5c); macOS, Linux and a clean Windows account: P11a (T11.8); a redirected or roaming `%APPDATA%`: a known limitation (P7, T7.D) |
| 9 (T1.3) | Can the in-process strict ustar reader read a ~450 MB update file in one pass, hashing while it writes, in Electron's main process, and at what cost in time, memory, event-loop stalls and free space on NTFS, exFAT USB 3 and USB 2? | Holds (G-5 (c)): 450.6 MB staged in 1.6–2.6 s on NTFS and 15.1–15.9 s on USB 2; one reused 1 MiB buffer keeps the stalls ≤ 43 ms and memory at +6.4–9.8 MB (a read stream: 66–155 ms, +73–89 MB); exFAT allocates about 32 × the write size ahead of the data; a cut file is refused in 31–75 ms, before any write; no file left after 414 refusals; a rename to an `.exe` name costs 240–391 ms on a stick (S-P1-14) | table A's header and end rules (§4.3); the reads, staging under the final name in `.incoming-<v>/`, the free-space formula's last term and the progress rule (§4.5). Not the caps: 4 MiB, 64 signatures and 4,096 members follow F-1 and what a later file carries (S9-1, C-12; §4.3) | no cap was approached (S9-1); the run-ahead measured on one driver (S9-3); every file warm in the cache (S9-9); known hashes and stand-in archives (S9-8); one file size (S9-5) | a cold source and a cold re-hash: P11b (spike 6), P11a (O22); Defender (rename retries, the close scan) and the peak free bytes on macOS and Linux exFAT and the Kit SSD: P11a (T11.3a); a 2 GiB run and the `ENOSPC` and `EFBIG` rows: P6; FAT32: P11a's VHD leg; an unplug while staging: P11a, P11b (spike 5) |
| 10 (T1.4) | Does a detached `cmd.exe` spawned by packaged Electron 43.8.10 outlive the app and its stub, with the exact argument list, environment and working folder, under 12 awkward drive roots and a `subst` letter on NTFS and exFAT; the start file's resume line; the apply lock; a working folder at the path-length limit; a parent inside a job? | Holds: 72 of 72 hand-offs; spawning the `.cmd` itself gives `EINVAL`; rule 1 resumes and counts under 11 of 12 roots (never under a root holding `%PATH%`, a limit of every `.cmd` start file); the handle lock excludes and releases; a working folder of 259 characters or more gives `ENOENT` 2 ms after `spawn()`; inside a kill-on-close job the apply dies with the job (S-P1-11) | the Windows spawn, its environment and the failed-spawn classes (§5.4); rule 1's text (§5.6, with spike 10b's prefix); the cmd lock and the cmd rules (§5.5) | the spike's working folder was the exe's folder, now the resolved drive root (S10-1, §5.4); batch-file locking (S10-2, closed by spike 10b); other system locales (S10-3); `LongPathsEnabled=1` only (S10-6); more root characters, other start forms, UNC roots (S10-7); known hashes (S10-5) | the Japanese-locale VM and a deep root with `LongPathsEnabled=0` (PC D): P11a (T11.3a); Windows 11 on ARM: P11a (T11.1); the extra root characters: P7 (T7.4a); UNC roots: a known limitation (P7, T7.D); the read-only marker failure: P11a (the read-only leg); an exFAT unplug: P11a, P11b (spike 5); the bash half: measured by spike 4a (row 4a); macOS: P11a (spike 3) |
| 10b (T1.4b) | With `LockBatchFilesWhenInUse` = 1, and then at 0 again: does the apply still remove its own `applying\`, can a running start file be replaced, does rule 1's resume still resume and finish? | At 1 the planned self-delete fails (0 of 18: the new exe's stub inherits the running script's handle); removing first and starting last holds (34 of 34 at 1; the final text v7, 12 of 12 at 0); a resume could never replace its own start file at 1 (0 of 17) until rule 1's `(goto) 2>nul & ` prefix (4 of 4 at 1; at 0, 0 of 136 starts differ from spike 10); at 0 a start file replaced by rename reads on in the new file (12 of 12) | the apply's final line and the CE-1 order (§5.5); rule 1's prefix (§5.6); the start-file replacement's retry and deferral (§5.5); every path ending in one parsed block (§5.6); the cmd rules on locked scripts, `(goto)` and the Restart Manager, and the reason for the 10 s acknowledgement (§5.4, §5.5) | the final line measured at 1 by its parts only (pass 3); the value-1 spawn that ran no line is likely, not proven, the harness's query (P3-2); a lone `apply.cmd` held at the `rmdir` (P3-5, now §5.5 "Nothing to resume"); the prefix ends a calling batch file and a `cmd /k` console (P3-6, §11.3); one cmd build (P3-8) | the final line at 1, 40 value-1 spawns, the lone-`apply.cmd` resume: P7 (T7.2); the value and one self-delete run on each walk host and the Smart App Control PC: P11a (T11.8); `DelayedExpansion=1` with the lock on, start files on a network share: unowned |

---

## 11. Open items and non-goals

### 11.1 Open owner calls

- **G-17's exact path**: the owner types it; `<G17-ADDRESS>` until then, final by the release-1 tag
  (§3.3).
- **G-18's native readers**: whether native speakers also read the frozen strings in the eight languages
  the owner does not read; decided before the release-1 copy freezes. Where a reader is chosen but not
  found in time, those strings may show in English for that language.
- **G-28**: code signing of the AI engines for Windows Kits; deferred, deadline before P5 writes release
  1's engine list (§6.8).
- **U9, U10 and U11**: answered after counsel. U10's value (the support period) is needed before the
  first Kit is built (§8.4).

### 11.2 Decided in their phases

None of §11.1's calls is decided yet. Decided in P1 by the owner (and, where marked, the orchestrator),
2026-11-24, one line each:
- U7's reading: the automatic fallback stops once any system confirmed a good start; "Go back" stays
  offered on a confirmed system (§6.10).
- Table B's six calls: the drive-app precondition (`UPD-NOT-DRIVE-APP`), the `pause` after the counter's
  messages, English-only start-file lines, `confirmed/<v>_<os>`, `helper-blocked` per computer and boot,
  the notice for at most 60 s (§5.12).
- The protocol tables of §4 and §5, every value; P11a's Defender row can reopen its own row (spike 4a's
  rows are settled, below).
- G-24's `linux` floor fails closed: a floor that doesn't parse, or a glibc that can't be read, refuses
  the import with `UPD-CANT-CHECK-LINUX-FLOOR` (§2.4, §5.12).
- Spike 4a's fixes (with the orchestrator): the wait's zombie test, the bash final step and
  `start-hilbertraum.sh`'s rule 1 as measured; the `.command`'s `trap '' HUP` line provisional until
  P11a's spike 3 (§5.5, §5.6).
- After a failed spawn that removed `applying/`, the same computer may try again at once; on both paths
  at most three hand-offs per computer and boot, whichever record counts them (`finish-<n>` now spawns
  on all three markers; the review's V-2; §5.4, §5.7, §5.12 question 9).
- Who builds the update file: after the offline signing the owner runs the builder on any computer of
  theirs and uploads the files to the draft release (the review's R-10; §9.3 step 3).
- (The orchestrator) member 0's header with the right magic: only a checksum failure is
  `UPD-FILE-DAMAGED`, a wrong type, name or size field `UPD-NOT-AN-UPDATE` (the review's V-1; §4.3,
  §4.7).
- Rule 2's pick when `updates/previous/` holds no unique app: the first one the start file's glob lists
  (§5.6).
- The kill-on-close job: an accepted residual (§5.4, §11.3).
- The method review's majors: a Defender-only PC in the pre-release timing leg (§10.5); batch-file
  locking measured on the spike box (spike 10b, §10.6); a Japanese-system-locale VM leg (§10.5);
  Windows 11 on ARM in the walk (§10.4).
- #1043 (two starts of one build shared the stub's unpack folder): to be fixed on `master` before release 1 (open);
  spike 1 measured both stub builds (§5.11, §10.6).
- Copy deck part 1 and its glossary, with the action labels "Install update from a file…", "Restart and
  update" (a staged update), "Continue the update" (`updates/applying/` exists) and "Go back to version
  {n}".

Decided in P3 by the owner, 2026-11-25 and 2026-11-26, one line each:
- #234's switch stays off for ever ("tolerate, document"): the pre-spawn check is no defence against
  whoever can write the engine folder, and says so (§6.7, §11.4).
- A GPU auto-disable flag without an engine stamp is kept (every workspace flagged before release 1);
  the cross-system re-arm on one Kit is accepted ("the Mac gets its GPU back"; a known limit) (§7.6).
- Home shows its existing "Choose a model" state for an active model release 1 cannot list, beside
  the one-time C09 notice; no new copy (§7.6).
- At sale, an unpacked macOS `.app` at a Kit's root is refused, reversing #233's acceptance, and so is
  a junk update policy key; a deliberate `false` passes (§9.5).
- The cost of the pre-spawn check was measured on a local stand-in copy of the same size (§6.7).

Decided later, each in its own phase: G-10 (where the walk runs, P7), G-11 (the channel mechanics, P5:
`prerelease: true` kept, the pre-publish check refuses a Kit release still flagged pre-release), G-25
(how a fix line follows Electron's support window, P5, with counsel), M-D3 and M-D4 (P10), U5 (with the
online check after release 1).

### 11.3 Accepted residuals

- A spent newer `.recovery` older than `.enc` stays unencrypted after a release-1 unlock (G-43 (c), §7.3).
- A drive that cannot be written after an interrupted engine swap starts no engine until it is writable
  (G-44 (b), §6.7).
- The limits P2's reviews recorded for the workspace guards, the readers and the engine install (§6.7,
  §7.9).
- The limits P3's reviews recorded, each beside its rule: the update policy (§8.1), `update.log` (§5.3,
  §8.2), `drive-release.json` (§8.5), the pre-spawn check (§6.7), W-70 (§7.6) and the sell gate (§9.5).
- Spike 4a covers Ubuntu 24.04 in WSL2 only, with exFAT through FUSE and drvfs; the static AppImage
  runtime (and whether fuse3 comes with a stock desktop), the kernel exFAT driver and a real terminal's
  window close stay unproven on Ubuntu 25.10, Fedora and a real stick until spike 4b runs in P11a.
- No AppImage starts from a drive mounted `noexec` (exit 126), so such a drive cannot run HilbertRaum on
  Linux at all, update or not; the apply itself still runs from it (`<sh> ./apply.sh`). The static
  runtime needs fuse3's `fusermount3` and `/dev/fuse` (without them only extract-and-run starts), and
  keeps its extract-and-run folder in `$TMPDIR`, one per version (spike 4a; docs in P7, CF-21).
- Offline Kits get AI engine updates only from a file (G-31 (b)); every release offered to release-1
  Kits keeps working on release 1's engine where a system has not installed the new one (G-35 (a)).
- An old but genuine update file can move a Kit up to an outdated version, never down (G-19 (b)).
- A stolen key stays trusted on every Kit that never installs the release that drops it (K1, §2.1).
- A root exe with the read-only attribute (or on a root the user may not write to) makes §5.6's
  in-flight probe read "in flight" at every start, so R1's counter never counts and a broken new
  version never falls back; the start file logs `counter-skip reason=in-flight`, and the sell gate and
  `prepare-drive` refuse a root artifact without a write bit or with the read-only attribute (as built in
  P3, T3.8; W-33, §9.5; T1.11 P3-3; `known-limitations.md`, T7.D); a root the user may not write to by
  its access list is not checked.
- Rule 1's `(goto) 2>nul & ` prefix (§5.6) ends a batch file that `call`s the start file (its next line
  does not run, and it exits 0, not its own code) and a console kept open with `cmd /k`, while an
  update is in progress; the resume itself starts. No repo script or test `call`s the start file while
  `updates\applying\` exists (T1.11 P3-6; `known-limitations.md`, T7.D).
- The kill-on-close job: an apply spawned by an app that runs inside a job which kills its processes
  when it closes dies with the job, since a detached spawn from Node never asks to break away. Kit
  starts run in no such job; `updates/applying/` stays, and rule 1 or "Continue the update" resumes it
  (§5.4; owner 2026-11-24, S-P1-11).
- Two start files whose in-flight probes both run before the first one's stub process exists (≤ 0.15 s
  under Norton) both count: one extra count at most; no start-file lock is added (§5.6;
  `known-limitations.md`, T7.D).
- A start of the old version whose stub process does not exist yet when the apply's probe reads "free"
  (the ≤ 0.15 s from the start request to the process, under Norton), and exists without a handle when
  the apply's first move runs, is not seen by that move (§5.5 "Wait, Windows"; `known-limitations.md`,
  T7.D). The time before the process exists was measured under Norton only; P11a's Defender row
  measures it there (§5.6).
- A start file started by hand in the very milliseconds in which the apply replaces it by rename could
  read mixed lines with batch-file locking off (`LockBatchFilesWhenInUse` = 0, as on the spike box); not
  measured (§5.5 "Start files").
- Under a drive path holding `%<a defined variable>%` (or `!` with `^` on a computer with
  `DelayedExpansion=1`) no line of a `.cmd` start file runs; the bare exe finishes an update through
  "Continue the update" (§5.6; `known-limitations.md`, T7.D).
- On macOS and Linux release 1's counter has no in-flight probe, so a start in flight in the rare state
  where release 1's start files sit at the root while `unconfirmed.txt` names the root's version can be
  counted (§5.6, §5.11); on macOS the apply's own start through the `.command` counts once in that
  state too (§5.6, spike 3 decides).
- On a drive that cannot be written, an outcome notice shows at every start, since release 1 cannot
  record that it was shown (§5.3, W-51).

### 11.4 Non-goals

- A background or startup update check (U2); any update identifier, telemetry or analytics.
- TUF, electron-updater, Squirrel, the NSIS installer target, an unpacked app folder (U4).
- Delta updates or patching `app.asar`: the asar-integrity fuse forbids it on Windows and macOS; updates replace whole apps on every system.
- The derived-data rebuild queue and new derived stamps; the embedder swap.
- Changing `userData`, `productName` or `appId`: they are only pinned (§8.7).
- Turning on `REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES`.
- Paid licensing or an entitlement check of any kind: updates are free and unmetered, every release is a
  public GPL build.
- Wiring Authenticode or notarization before the owner has the certificates.
- An `updates/incoming/` folder or a startup scan of any folder for update files: "Install update from a
  file…" covers it.
- A macOS pre-extract by the old version (the update's own scripts may do it).
- Model weights inside the update file: weights stay user downloads; the update file carries manifests
  only.
- A project-owned update host.

### 11.5 Before the first Kit is sold (outside the updater)

The buyer notification channel and the advisories page; `SECURITY.md` "Supported versions" for the Kit
and the reporting runbook; the support end date on the shop page and the packaging; counsel's answers;
for a Windows Kit, a signed release 1; the key proof (§2.8); the second home, the domain, the
succession file and a deputy, a dry run of the withdrawal playbook; the system requirements printed with
the Kit (G-26); release 1 on an Electron major with at least 4 months of upstream support left; and
G-33's manifest change, so that a fresh Kit started offline on a computer without a usable graphics card
recommends a model it carries.

---

## 12. Legends

### 12.1 The §-anchor legend

Cite this record as **`app-updates.md §N`**, or `app-updates.md §N.M` for a numbered subsection; always
with the document's name, since "§6" alone means something else in every other record. The numbers are
stable from the first pull request of the wave: a later section's new material is added as a new
subsection at the end of its section, never by renumbering.

| § | Holds |
|---|---|
| §1 | scope, the owner's decisions and the plan's gates, the frozen-forever rule, the frozen contracts F-1–F-27 |
| §2 | trust: the keys and their custody, the envelope, the payload, the version rule, the channel, the release guard, the key proof, the fork rule |
| §3 | finding and importing an update: no online check, the addresses, the entry points, the locked channels, the refusals before reading |
| §4 | staging and the update file container (protocol table A) |
| §4.1 | how to read table A, and why its caps are set for a 2035 file |
| §4.2 | table A.1: the staging names |
| §4.3 | table A.2: the container (the ustar subset, the `HRUPDATE` prefix, member 0, the `payloadType`, the caps, the end, the header walk) |
| §4.4 | table A.3: the member-name rule (F-18) and the root globs release 1 reads |
| §4.5 | table A.4: staging (the order, the free-space formula, the reads, the `.incoming-<v>` folder, the commit, the sweep, the removals) |
| §4.6 | table A.5: the grammars of `staged.txt` and `staged.json` |
| §4.7 | table A.6: the verdicts of the container and of staging, with their codes |
| §4.8 | the cases table A was checked against |
| §5 | the hand-off, the apply script, the start files, "Continue the update", the outcome codes and notices (protocol table B) |
| §5.1 | how to read table B: "frozen since", the system, version and token spellings, the common text rules G0 |
| §5.2 | table B.1: every file and folder name of the hand-off, the apply and the start files |
| §5.3 | table B.2: the grammars of `handoff.txt`, `journal.txt`, `unconfirmed.txt`, `launch-count.txt`, `last-result.txt`, `last-result.seen`, the `update.log` line frame, and the app's own `update.log` lines (the registered events, the token rules, the trim) |
| §5.4 | table B.3: the hand-off (order, the drive-app precondition, pre-check, the `finish-<n>` cap, the spawn per system, the environment, failed-spawn classes, the removal of a finished or dead `applying/`, the start acknowledgement, `budget`, "Continue the update", the kill-on-close residual) |
| §5.5 | table B.4 and B.5: the apply script (arguments, lock, wait, nothing to resume, move order, the start files' replacement, the new app's start, the CE-1 rule, cmd and bash rules) and the journal states |
| §5.6 | table B.6 and B.7: the start files (rule 1's exact text, the fall-through, the counter, rules 2 and 3, every path ending in one parsed block) and every line they print |
| §5.7 | table B.8: the confirmation (F-22) and the offers at a start (F-19) |
| §5.8 | table B.9: the `last-result.txt` codes and the `UPD-*` reference codes with their copy keys |
| §5.9 | table B.10: the "Copy details for support" fields |
| §5.10 | table B.11: the build-date file, the `drive-release.json` reader's types and every writer's rules, `kit-support.txt`'s form |
| §5.11 | the cases table B was checked against |
| §5.12 | table B's owner decisions and open values |
| §6 | drive content, AI engines, the first start after an update, "Go back" |
| §7 | the workspace guards, the last-writer stamp, the later-writer duties, the migration framework |
| §8 | the policy keys, `update.log`, the support details, the support end and age, `drive-release.json`, the audit events, the pins |
| §9 | the release side and its ritual, the fix line, the sell gate |
| §10 | the test record, the protocol model, the walk, real media, the spike verdicts and their one-box limit |
| §11 | open items, the calls decided in P1, residuals and non-goals |
| §12 | these legends |
| §12.5 | the model, surprise and method-review ids that §4, §5, §10.6 and §11.3 cite, each with what it found |

### 12.2 The owner-call and code legend

The ids below come from the wave's analysis and implementation plan, working papers kept outside the
repository. A new code comment names this document with the id ("app-updates.md §6", "app-updates
U1"), because the same spellings mean other things elsewhere (§12.4); the citations already on the
branch are resolved by §12.3, and the model, surprise and method-review ids of the protocol tables by
§12.5.

| Family | Meaning | Defined in |
|---|---|---|
| U1–U11 | the owner's calls on the update channel and policy | §1.3 |
| K1–K5 | the owner's calls on the signing keys | §1.3, §2 |
| M-D1–M-D4 | the owner's calls on workspace migrations | §1.3, §7 |
| G-1–G-45 | the plan's gates: decisions the owner took or the plan recommended | §1.4, §11.2 |
| W-1–W-84 | the plan's work items; each one's decided contract is in the section of its subject | the section that names it; the cited ones in §12.3 |
| F-1–F-27 | the frozen contracts | §1.6 |
| `T<phase>.<n>` | a task of the plan (T6.3 is task 3 of phase P6; `T<phase>.D` is its docs task; T1.8 wrote the protocol tables, T1.11 reviewed the spikes' method) | the section of its subject; the cited ones in §12.3 |
| `CE-<n>`, `CE-D<n>`, `CE-F<n>` | a counterexample the protocol model found (CE-D: found by the model's review, CE-F: in the engine model); each is closed by a rule in the cited section | §10.3; the cited ones in §12.3 and §12.5 |
| `S-P1-<n>` | a surprise a spike of P1 found (the wave's surprise register); its disposition is in the row that cites it | §12.5 |
| `S1-<n>`, `S8-<n>`, `S9-<n>`, `S10-<n>`, `C-<n>`, `P3-<n>` | findings of the method review T1.11: per spike, across the spikes (`C-`), and in its third pass over spikes 1b and 10b (`P3-`) | §10.6, §12.5 |
| `P2-<n>` | a finding of spike 10b's own second part (the runs at `LockBatchFilesWhenInUse` = 0; P2-5: the harness's Restart Manager query) | §12.5 |
| `CF-<n>` | a carried fact in the wave's ledger: a fact one phase hands to a later one | — |
| `R-<n>`, `V-<n>` (as "the T1.12 review R-5") | findings and value remarks of this record's independent review (T1.12) | the citing row |
| an id after a task id, such as `R1-2`, `R1 m-1`, `M-2`, `N-4`, `S-1`, `Q2` or `D-1` (as "T3.12's review R1 m-1", "T3.11's S-1") | a finding of that task's reviews (`R1`, `R2`: the first and second reviewer; `M` major, `m` minor, `N` from a re-check), or a surprise (`S`), question (`Q`) or decision (`D`) of its report, in the wave's working papers; provenance, each closed or recorded by the row that cites it | the citing row |
| a letter in brackets after a gate or call id (`G-19 (b)`, `G-21 (b')`, `U1 (b)`, `G-5 (c)`) | the option chosen in the plan; the decision is as §1.3 and §1.4 word it | §1.3, §1.4 |
| "the orchestrator" | the session that ran the wave for the owner; its calls are marked as its own | §11.2 |
| v5, v6, v7 | successive texts of the cmd apply's final line measured in spike 10b (v7 is §5.5's) | §5.5 |
| `L1-<n>`, `L2-<n>` | findings of the two lens reviews of the protocol tables ("lens 1" and "lens 2" of T1.8); each is closed by the row that cites it | the citing row |
| spike `<n>` `DD<m>` | design delta m of spike n's verdict file | §10.6 |
| plan-rule change `<n>`; T1.8 stage `<n>` | one of the 22 plan rules the protocol tables changed (21: §5.5 "Nothing to resume"; 22: §5.6 "Every path ends in one parsed block"); a step of T1.8 (stage 3: the protocol model's run on the tables, §10.3) | the citing row |
| `GAP-<n>`, `A-<n>`, `B-<n>`, `UX-<n>`, `CC-<n>`, `CC5-<n>` | findings of the plan's own reviews: the end-to-end walk-through's gaps, the lenses A and B of plan review 3 ("lens A"), the UX review of plan review 5, the plan's consistency passes; provenance, each closed by the row that cites it | the citing row |
| `Δ-<n>` | a plan delta in the wave's ledger: a dated change of the plan, with its cause | — |
| `O<n>` | an item of the owner's track (O22: the restart timing on the owner's media, before the M1 cut, P11a) | §10.5 |
| C1–C17 | the plan's constraints (C9: no new dependency class, the update file read in process; C10: the ten-catalog rule for UI strings, which the start files' English-only lines are outside of; C12: the rules of the scripts) | the citing row |
| `PA-<n>` | historical: a plan-review finding id of the wave's implementation plan, a working paper outside the repository; it is provenance, never a contract | — |
| P0–P14 | the wave's phases: P0 decisions and baseline; P1 spikes and this record; P2 workspace and old-reader guards; P3 supportability, policy keys and the drive-release record; P4 trust core; P5 release side; P6 import, staging and the Updates tab; P7 hand-off, apply and start files; P8 drive content and engines; P9 the online check (after release 1); P10 the migration framework; P11a, P11b, P11c the walks and release 1; P12 the wave review; P13 follow-ups; P14 the close | this row |
| M0–M3 | the plan's content tiers: M1 what release 1 freezes for the oldest Kit, M2 drive content and engines, M3 the migration framework, M0 the launch conditions outside the updater; release 1 meets M1, M2 and M3 | §1.2 |

### 12.3 App-update ids already cited on the branch

Found at the record's first version (a search over `apps`, `docs`, `scripts` and
`launchers`, plus one search for gate ids). Each is listed with the section of this record that carries
it and the files that cite it.

| Id | Meaning | § | Cited in |
|---|---|---|---|
| CE-F1 | a marker written last let a quit after the move reinstall over the kept copy; the rule: the marker is written inside the new copy before any move | §6.6, §6.7 | `runtime-download.ts`, `engine-swap.test.ts`, `architecture.md` |
| CE-F10 | an interrupted engine swap on a drive that cannot be written; "start the complete copy where it lies" is not built in release 1 (a residual) | §6.7, §11.3 | `runtime-download.ts`, `architecture.md` |
| F-14 | the update channels callable while locked and after a failed start | §3.5 | `registerStartFailureIpc.ts`, `data-contracts.md` |
| F-24 | the AI engine contract | §6.7, §6.11 | `data-contracts.md` |
| G-28 | code signing of the AI engines for Windows Kits, deferred | §6.8, §11.1 | `assets.ts`, `assets.test.ts`, `script-execution.test.ts`, `binary-verifier.test.ts`, `data-contracts.md`, `security-model.md` |
| PA-225 | historical (the review that made #986 a work item) | — | `architecture.md` |
| T6.3 | P6 registers F-14's channels on the start-failure context | §3.5 | `registerStartFailureIpc.ts`, `data-contracts.md` |
| T8.5a | P8's engine download or file install into a folder of its own, reusing `stageEngineInstall` | §6.5, §6.6 | `runtime-download.ts` |
| T8.5c | the two reviews of release 1's own engine swap as built, and its rows owed on real media | §6.7, §10.5 | `architecture.md` |
| W-4 | the import entry points | §3.4 | `WorkspaceGate.tsx` |
| W-5 | staging, which reuses the rename retry of `fs-retry.ts` | §4 | `fs-retry.ts` |
| W-14 | `updates/update.log` | §8.2 | `backend-start.ts`, `data-contracts.md` |
| W-30 | the new version's AI engine in a folder of its own | §6.5, §6.6 | `runtime-download.ts`, `architecture.md`, `data-contracts.md` |
| W-66 | a newer working copy is kept (#985) | §7.1, §7.2 | `db.ts`, `workspace-vault.ts`, `workspace-vault-format-guard.test.ts`, `db-probe.test.ts`, `security-model.md`, `build-log.md` |
| W-67 | release 1's own engine install swaps, never deletes first (#986) | §6.7 | `runtime-download.ts`, `engine-swap.test.ts`, `architecture.md`, `build-log.md` |
| W-82 | a start that fails still serves the update path (#1015, #1024) | §3.5, §7.3 | `registerStartFailureIpc.ts`, `backend-start-failure.test.ts`, `data-contracts.md` |

No U-, K- or M-D- id of this family is cited on the branch yet.

### 12.4 Same spellings, other families

These are **not** app-update ids:
- `F-01`–`F-41`: the full audit of 2026-07-16 (its table in [`architecture.md`](architecture.md)); that audit writes `F-01`–`F-09` padded and `F-10` up unpadded, the same spellings as this record's F-10–F-27, so read an `F-n` by its document;
- `F-1`–`F-8` beside `FA-1`–`FA-4`: the translation audit; "review V F-n" and "review R F-n": security
  review findings in the vault and shutdown code;
- `U1`–`U7`: the skills audit of 2026-07-03 and its phases;
- `W-6`: a sub-point of follow-ups wave 5 (small talk in a documents chat);
- `M-D1` in [`build-log.md`](build-log.md): a finding of the 2026-06-13 audit;
- `PA-4`: a finding of the #808 audit;
- `G-5`, `G-13`, `G-15`, `G-17` near follow-ups waves (for example `skills/registry.ts`,
  `reviewSession.ts`, the engine-swap record): gates of those waves.

### 12.5 Model, surprise and method-review ids in this record

The protocol tables (§4, §5), the spike verdicts (§10.6) and the residuals (§11.3) cite these ids as
provenance. Each is closed by the row that cites it; this table says what each one found.

| Id | What it found | Closed in |
|---|---|---|
| CE-1 | the protocol model: on the normal path no app started (the start file the apply started met `applying/`, resumed, lost the lock and exited) | §5.5, the CE-1 rule |
| CE-D1 | start-file starts during the new version's slow first start armed a fallback that rolled back a version which had confirmed meanwhile | §5.5, J1 (T-aborted) |
| CE-D4 | a reverse apply killed after its swap and resumed moved the newer version back in: two apps at the root | §5.5, after table B.5 |
| CE-D5 | a resumed forward apply of a version that had already confirmed wrote `unconfirmed.txt` again | §5.5, J2 |
| CE-D6 | an old app that hangs in its quit keeps the single-instance lock and swallows the start the apply makes | §5.4, "End of the app"; §5.5, `timeout` |
| CE-D7 | removing `applying/` during a resume, or ending an apply without undoing its moves, left a half-done swap at rest that no rule repairs | §5.4, "After a failed spawn"; §5.5, T-io-error |
| CE-D9 | moving the new version in before the old one out left two apps at the root mid-swap | §5.5, "Move order" |
| CE-D10 | a new version that removed its own half-done `applying/` on a two-system drive left mixed versions at rest | §5.5, after table B.5 |
| CE-F5 | the engine model: release 1's counter fell back from a version that another system had already confirmed | §5.6, the counter (i) |
| S-P1-11 | a detached spawn from Node never breaks away from a kill-on-close job (spike 10) | §5.4, §11.3 |
| S-P1-13 | a never-seen build's first start under Norton took 46 s to the app's process (spike 1; spike 1b: up to 78 s to the window) | §5.11 |
| S-P1-14 | on a stick a rename to an `.exe` name costs about 240 ms with Norton on | §4.5, §4.8 |
| S1-1 | no hand-off was timed under an active Defender | §5.4 (the Defender PC, §10.5) |
| S1-2 | the in-flight probe was never sampled during a start | §5.6 (spike 1b) |
| S1-3 | the stub's order (unpack folder gone before the rename) rests on electron-builder's `portable.nsi`, not on the poll | §10.6 (spike 1b, 18 of 18) |
| S1-4, S10-5 | every timed exe's hash was already known to Norton | §10.6 |
| S1-5 | one start form was timed | §10.6 |
| S1-8 | a slow PC or a hard-disk `%TEMP%`; build B's leftover unpack folder after a killed start | §10.6 (#1043's fix) |
| S8-1 | the profile pins check names, not the runtime path | §8.7, §10.6 |
| S8-2 | nothing re-measures the single-instance lock across Electron majors | §10.6 |
| S8-3 | the shared-unpack-folder text described build A, not release 1's build B | §10.6 |
| S8-6 | spike 8's close times are coarse; spike 1's are the ones cited | §5.4, `budget` |
| S9-1 | spike 9's proposed caps contradicted F-1 and were never exercised | §4.3 |
| S9-2 | member names could meet the staging folder's own files | §4.2, §4.4 (`files/`) |
| S9-3 | the free-space formula rested on one driver and a flat per-file term | §4.5 |
| S9-4 | the 1 MiB read is an implementation constant, not a format value | §4.5 |
| S9-5 | one file size (450 MB) was measured | §10.6 |
| S9-6 | a zero-filled partial download of the full length needed its own verdict | §4.7 |
| S9-8 | known hashes and stand-in archives in the staged file | §10.6 |
| S9-9 | the re-hash was measured warm only | §10.6 |
| S10-1 | the proposed working folder was the exe's folder, not the drive root the app resolved | §5.4, `cwd` and the precondition |
| S10-2 | batch-file locking (`LockBatchFilesWhenInUse` = 1) was unmeasured | §5.4, §5.5 (spike 10b) |
| S10-3 | rule 1 was tested under the de-DE system locale only | §5.6 (the Japanese-locale VM, §10.5) |
| S10-6 | the deep-root rows ran with `LongPathsEnabled=1` only | §10.6 (the Defender PC) |
| S10-7 | more root characters, other start forms, UNC roots | §10.6 |
| C-3 | Windows 11 on ARM was covered by no leg | §5.4, §10.4 |
| C-4 | every spike ran on one box | §10.6 |
| C-6 | the 10 s acknowledgement had no measured number | §5.4 |
| C-7 | the worst case of a never-seen first start is O22's to state | §5.11 |
| C-12 | the member-count cap needed a reason from what a later file carries | §4.3 |
| P2-5 | spike 10b: a Restart Manager query about a running apply script breaks it | §5.5, the cmd rules |
| P3-1 | the in-flight probe's time before the stub's process exists was measured under Norton only | §5.6 (the Defender PC's row) |
| P3-2 | the value-1 spawn that ran no line is likely the harness's query, not reproduced at value 1 | §5.4 |
| P3-3 | a read-only root exe silences the counter | §9.5, §11.3 |
| P3-4 | the probe can read "free" while a holder still refuses the move | §5.5, the first move's retry |
| P3-5 | an `applying/` holding only `apply.cmd` is outside release 1's removal rule | §5.5, "Nothing to resume" |
| P3-6 | rule 1's prefix ends a calling batch file and a `cmd /k` console | §11.3 |
| P3-7 | release 1's start file read on after a `pause` or after its last `start` | §5.6, "Every path ends in one parsed block" |
| P3-8 | both addenda ran on one cmd build | §5.12; the walk hosts (§10.6) |
