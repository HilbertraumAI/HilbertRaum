# Docs, references & comment-weight audit — 2026-08-20

Scope: **stale prose, broken references, and comment weight** across the living markdown
(11 root + 17 `docs/`, ≈49,500 lines) **and** the code comments (309 `.ts`/`.tsx` files under
`apps/desktop/src`, ≈100,800 lines, 31,682 comment lines). Reference liveness covers internal
markdown links, `§`-citations, external URLs, and the `model-manifests/` `download.url` set
(URL **and** upstream hash).

Deliberately **not** audited (owner conventions, per the brief and `CLAUDE.md`):
`docs/build-log.md`'s internal staleness (frozen verbatim archive — only reachability checked),
`BUILD_STATE.md` history gaps (retention budget), missing "Last updated" stamps, `§`-number
collisions in `architecture.md`, and deleted plan files (folded into `§`-numbered design records).

Finding ids are stable; later work should cite them.

---

## Remediation status (updated 2026-08-20, after the fix pass)

The audit below is the working paper and is **not** rewritten as findings close — it stays the
record of what was true when the pass ran. This table is the ledger.

| Finding | Status | Where |
|---|---|---|
| **A-1 A-2 A-3** README: withdrawn models recommended, tier sentences, missing successor rows | **fixed** | Phase 2 |
| **A-4 A-5** `model-policy.md`: catalog rows + the live-mapping note | **fixed** | Phase 2 |
| **A-6** `benchmark.md`: the live-recommendation table | **fixed** | Phase 2 |
| **A-7** `model-benchmarks.md` §6.5 rules 3 + 5 | **fixed** (dated amendments; historical body untouched) | Phase 3 |
| **A-8** five stale manifest rank comments | **fixed** | Phase 4 |
| **B-1** `gemma4-12b-it-qat-q4` upstream re-upload | **fixed 2026-08-20** — the measurement wave ran (i9-9900X + RTX 3090) and found the corrected checkpoint indistinguishable: all 100 §2 answers byte-identical, RSS delta 44 kB, VRAM identical, §9.1 legs green. Owner decision: repoint **in place** (both `sha256` fields + `size_bytes`), NOT a successor id — the file was superseded, not deleted, so a successor would duplicate a provably identical entry. Accepted cost recorded in `known-limitations.md` + `CHANGELOG.md`. Record: `model-benchmarks.md` §9.6 | [#201](https://github.com/HilbertraumAI/HilbertRaum/issues/201) |
| **B-2** the drift check verified liveness, not byte-identity | **fixed** (the ritual is now written down) | Phase 5 |
| **B-3** four rounded `size_bytes` | **FILED — owner's call between a measured correction and a policy sentence** | [#202](https://github.com/HilbertraumAI/HilbertRaum/issues/202) |
| **C-1 … C-5** the Node floor | **fixed** | Phase 1 |
| **D-1** four unresolvable links in the archive | **fixed** (de-linkified as the 2026-07-12 pass did; header records the completed sweep) | Phase 5 |
| **D-2 D-3 D-4** | **no action — recorded so a later sweep does not "fix" them** | — |
| **E-1** 16 of 140 IPC channels undocumented | **fixed** — 140/140, re-verified mechanically | Phase 7 |
| **E-2** the 2026-08 waves' accepted gaps | **fixed** — new **Speculative decoding (MTP)** and **Model catalog & downloads** sections, plus the two #194 items | Phase 7 |
| **E-3** `release-issues-section.sh` undocumented | **fixed** | Phase 5 |
| **E-4** `BUILD_STATE.md` headroom | **fixed, and the cause with it** — 1,968 → **763** lines. The whole-file cap was draining the dated entries while §3 + §5 (80% of the file) had no drain; replaced by per-section budgets + a "§5 carries no closed round as a narrative" guard, both red-verified. Found en route: items 7, 8, 12, 13 and §8 all held LIVE residuals under complete-sounding headings. |
| **F-1 F-2** the two extractor-version histories | **fixed** — ~198 → ~101 comment lines, 35→35 and 22→22 citations preserved (verified mechanically), no measured number touched | Phase 6 |
| **F-3** seven signature-restating JSDoc one-liners | **no action — not worth the churn** | — |

---

## 0. Headline

The repo is in **good** shape on references and comment discipline — most of the mechanical
checks came back clean, with hard evidence (§6 below). The real damage is concentrated in **one
theme**: the issue-#196 successor wave (PR #199, 2026-08-20) landed in the manifests, the tests,
`CHANGELOG.md`, `DRIVE-NOTICES.md` and `model-benchmarks.md` §9.5 — **and did not reach the
catalog-facing prose**. `README.md`, `docs/model-policy.md` and `docs/benchmark.md` still tell a
public reader that the recommended 24 GB and ≥32 GB chat models are two files whose upstream
source was deleted the same day. That is the brief's archetype, live, on the repo's landing page.

Second, independent, and equally user-facing: **one live manifest URL now serves different bytes
than the manifest pins** (`gemma4-12b-it-qat-q4`) — a guaranteed checksum failure for anyone who
downloads it. Per the brief this is reported and **not** repointed.

| Severity | Confirmed | Suspected |
|---|---|---|
| High | 6 | 0 |
| Medium | 7 | 1 |
| Low | 6 | 4 |
| Info | 5 | 0 |

---

## 1. Theme A — the #196 successor wave never swept the catalog prose

**Root cause (one, shared by A-1…A-8).** On 2026-08-20 two waves landed in sequence:
the #196 *interim* (withdraw the three Qwen3.8 static K-quants, hand the 24 GB / ≥32 GB tiers
**back** to the Qwen3.6 pair) and, later the same day, the #196 *successor wave* (PR #199) which
measured the `UD-*` replacements and **restored** the generational handover. Data, tests and the
wave record carry the second state; the hand-written catalog prose still describes the first.

**Shared evidence (checked, not inferred):**

- Committed manifest ranks (`grep '^recommendation_rank:' model-manifests/chat/*.yaml`):
  `qwen3.8-27b-ud-q4km` = 3, `qwen3.8-27b-ud-q5km` = 3, `qwen3.8-27b-q4/q5/q6` = 0 (all three
  with `download.withdrawn`), `qwen3.6-27b-q4/q5` = **1**.
- The production picker, replayed against the committed catalog (`recommendModelIdByRam`
  algorithm re-implemented from `apps/desktop/src/main/services/models.ts:872-897` and run over
  the real YAML):
  `8–11 GB → qwen3.5-4b-ud-q4kxl · 12–15 → gemma4-e2b-it-qat-q4 · 16–23 → qwen3.5-9b-ud-q4kxl ·
  24–28 → qwen3.8-27b-ud-q4km · ≥32 → qwen3.8-27b-ud-q5km`.
- The tests that pin it: `apps/desktop/tests/integration/benchmark.test.ts:234-235` and
  `apps/desktop/tests/integration/committed-catalog.test.ts:279-281`, both asserting the `ud-`
  ids at 24 and 32.
- `CHANGELOG.md:51` already says the right thing ("**Qwen3.8 27B UD-Q4_K_M** at 24 GB and
  **UD-Q5_K_M** at ≥32 GB"), so the repo contradicts itself between two public files.
- Live `HEAD` on the three withdrawn URLs: **404** (re-verified in this audit).

### A-1 — README recommends two undownloadable models · CONFIRMED · **HIGH**

`README.md:250-251` — the chat-model table marks `Qwen3.8 27B Q4_K_M` "**Recommended 24 GB**"
and `Qwen3.8 27B Q5_K_M` "**Recommended ≥32 GB**". Both are rank 0 with `download.withdrawn`;
their URLs 404. `README.md:252` presents `Qwen3.8 27B Q6_K` as a selectable "quality ceiling for
24 GB GPUs" — also withdrawn, also unobtainable on a fresh drive.

*Impact:* a new user on a 24 GB machine reads the landing page, picks the named model, and gets a
refusal card (or, pre-#196, a 404 mid-download). This is exactly the failure the wave existed to
prevent, surviving in the one file most readers see first.

*Fix:* mark the three withdrawn rows as withdrawn/installed-base-only, and move the
"Recommended" labels to the successors (see A-3).

### A-2 — README's RAM-tier sentence names the withdrawn files, twice · CONFIRMED · **HIGH**

`README.md:89` ("What you need (DIY)") and `README.md:222` ("Supported models") both read
`… 24 GB → Qwen3.8 27B (Q4) · ≥32 GB → Qwen3.8 27B (Q5)`. The picker returns
`qwen3.8-27b-ud-q4km` / `qwen3.8-27b-ud-q5km` (evidence above).

*Secondary, same lines:* the `16–20 GB` band is understated — `qwen3.5-9b-ud-q4kxl` actually holds
16–23 GB (the next comfortable band starts at `recommended_ram_gb: 24`). Low severity, but it is
the same sentence.

*Fix:* one sentence, both occurrences → `24 GB → Qwen3.8 27B (UD-Q4_K_M) · ≥32 GB → Qwen3.8 27B
(UD-Q5_K_M)`.

### A-3 — the three shipped successors are absent from the README table · CONFIRMED · **HIGH**

`README.md:229-256` lists 23 chat models. `qwen3.8-27b-ud-q4km`, `qwen3.8-27b-ud-q5km` and
`qwen3.8-27b-ud-q6k` — the current 24 GB pick, the current ≥32 GB pick, and the current 24 GB-GPU
ceiling — have **no row**. Their measured numbers exist (`model-benchmarks.md` §9.5;
manifest headers), so this is a transcription gap, not a measurement gap.

*Fix:* three rows with the manifests' committed `size_on_disk_gb` / `recommended_min_ram_gb`
(16.5 GB/21, 19.8 GB/23, 22.0 GB/26).

*Note (not a finding):* `gemma-4-26b-q4`, `gemma4-coding-q8` and `qwen3.5-9b-q8` are also absent
from the table, but `model-policy.md:153-154` documents them as user-added local-test stubs with
no `download` block — deliberate.

### A-4 — `model-policy.md` catalog table asserts the reverted tiers as current · CONFIRMED · **HIGH**

`docs/model-policy.md:28` — Qwen3.6 27B Q4: "**The recommended 24 GB pick again since
2026-08-20**". `:29` — Qwen3.6 27B Q5: "**The recommended ≥32 GB pick again since 2026-08-20**".
Neither is auto-recommended at any RAM value — **and both rows also print `— (rank 3)` in the
Auto-tier column while their manifests carry `recommendation_rank: 1`**, so the row is wrong twice.
`:30` / `:31` — the Qwen3.8 Q4/Q5 rows state "the 24 GB tier went back to Qwen3.6 Q4" / "the ≥32 GB
tier went back to Qwen3.6 Q5".
`:33` — the Qwen3.5 35B-A3B row says "the Qwen3.8 Q5 holds ≥32 since 2026-08-16" (that file is now
rank 0; `ud-q5km` holds it).
`:36` — the Gemma 26B-A4B row calls `qwen3.6-27b-q4` "the 24 GB pick" and "rank 3".
The table also has **no rows** for the three `ud-` successors, while §"Withdrawn upstream sources"
(`:400-405`) and the MTP paragraph (`:263-266`) *do* name them — the doc contradicts itself.

*Fix:* update the six row cells; add three rows.

### A-5 — `model-policy.md`'s tier note contradicts the test it cites · CONFIRMED · **HIGH**

`docs/model-policy.md:66-72` states the live mapping as "…**24 GB → Qwen3.6 27B Q4, ≥32 GB →
Qwen3.6 27B Q5**", explicitly "asserted in `benchmark.test.ts`". That file asserts the opposite
(`benchmark.test.ts:234-235` → `qwen3.8-27b-ud-q4km` / `qwen3.8-27b-ud-q5km`). The same paragraph
lists "the withdrawn Qwen3.8 trio … never auto-recommended", which is true of the *withdrawn* trio
but reads as if the whole family is out.

*Fix:* replace the two tier names; keep the withdrawn-trio clause, scoped to the three static
K-quants.

### A-6 — `benchmark.md`'s "live, real-hardware recommendations" table is wrong · CONFIRMED · **HIGH**

`docs/benchmark.md:112-119` — the table introduced as "the live, real-hardware recommendations"
lists `24 GB → qwen3.6-27b-q4` and `≥ 32 GB → qwen3.6-27b-q5`, with a parenthetical that stops at
"handed BACK on 2026-08-20". Replay + both pinning tests say `ud-q4km` / `ud-q5km`.

This is the most load-bearing of the four prose copies: it is the doc a contributor reads to learn
what the recommender does.

*Fix:* two table cells + extend the parenthetical with the successor wave (§9.5 / PR #199).

### A-7 — `model-benchmarks.md` §6.5 claims a pin that no longer holds · CONFIRMED · **MEDIUM**

`docs/model-benchmarks.md:418-419` (§6.5 rule 3): "the step moves 24 GB boxes `qwen3.6-27b-q4` →
`qwen3.5-9b-ud-q4kxl` and ≥32 GB boxes `qwen3.6-27b-q5` → `qwen3.6-27b-q4`".
`docs/model-benchmarks.md:430-432` (§6.5 rule 5): the no-signal mapping "(… 24 → Qwen3.6 27B Q4,
≥32 → Qwen3.6 27B Q5) **stays pinned untouched** in `committed-catalog.test.ts` and
`benchmark.test.ts`".

Both files now pin the successors, and the ≥32 GB step-down lands on `qwen3.8-27b-ud-q4km`
(`committed-catalog.test.ts:463-465`, comment: "the UD successor since the #196 successor wave
restored the §9.4 handover"). §6.5 already carries dated amendment notes for #153; it is missing
one for #196.

*Fix:* one dated amendment note under §6.5 (the doc's own convention) — do **not** rewrite the
historical body.

### A-8 — four manifest comments still describe the reverted tiers · CONFIRMED · **MEDIUM**

Wrong comments, ranked above merely verbose ones per the brief:

| File | Line | Says | Actually |
|---|---|---|---|
| `model-manifests/chat/qwen3.8-27b-q4.yaml` | 22-23 | "The 24 GB tier goes back to qwen3.6-27b-q4 (rank 3 again)" | `ud-q4km` holds 24 GB; `qwen3.6-27b-q4` is rank 1 |
| `model-manifests/chat/qwen3.8-27b-q5.yaml` | 20-21 | "the tier goes back to qwen3.6-27b-q5 (rank 3 again…)" | `ud-q5km` holds ≥32 GB; rank 1 |
| `model-manifests/chat/qwen3.8-27b-q6.yaml` | 18 | "the q5 sibling wins the ≥32 GB RAM tier" | that q5 is rank 0; `ud-q5km` wins |
| `model-manifests/chat/gemma4-26b-a4b-it-qat-q4.yaml` | 18-23 | "the 24 GB pick qwen3.6-27b-q4 … keeps the Qwen the tier pick (rank 3)" | 24 GB pick is `ud-q4km`; Qwen3.6 Q4 is rank 1 |
| `model-manifests/chat/qwen3.5-35b-a3b-ud-q4kxl.yaml` | 20 | "never the auto-pick (qwen3.6-27b-q5, rank 3, holds ≥32 GB)" | `ud-q5km`, rank 3, holds ≥32 GB |

The `qwen3.6-27b-q4/q5` manifests themselves **were** updated correctly ("restores the §9.4
generational handover the §9.5 interim reverted") — further evidence the sweep was partial, not a
deliberate freeze.

*Fix:* five comment edits. `npm test` must still run (a comment edit inside a manifest is read by
`committed-catalog.test.ts`'s YAML parse).

---

## 2. Theme B — manifest download integrity

### B-1 — a live URL now serves different bytes than the manifest pins · CONFIRMED · **HIGH**

`model-manifests/chat/gemma4-12b-it-qat-q4.yaml:20` / `:25` / `:27`.

| | Committed | Upstream today |
|---|---|---|
| sha256 | `faff1a63667fac17ac5e777f47114688fcefea96e220e211aaa8d62c2c4561f1` | `93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b` |
| size_bytes | 6 975 877 728 | 6 975 879 296 (+1 568) |

**Evidence** — two independent methods, both run in this audit:
1. `HEAD https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf/resolve/main/gemma-4-12b-it-qat-q4_0.gguf?download=true`
   with `redirect: manual` → **302**, `x-linked-etag: "93567e57…"`, `x-linked-size: 6975879296`.
2. `GET https://huggingface.co/api/models/google/gemma-4-12B-it-qat-q4_0-gguf/tree/main` →
   `gemma-4-12b-it-qat-q4_0.gguf`, `lfs.oid = 93567e57…`, `lfs.size = 6975879296`.

*Impact:* worse than a 404. The URL is alive, so the downloader will pull ~7 GB and then fail
SHA-256 verification with no explanation a user can act on. The model is **rank 2**, listed in
`README.md:245` as the "Phase-29 12–14B benchmark winner", so it is a realistic pick.

*Per the brief, this audit does NOT repoint the manifest.* Manifest numbers are measured, never
estimated: a substitution needs its own measurement wave (re-download, on-disk SHA-256, and — since
the file changed — at minimum a re-confirmation that the quant/architecture is unchanged before the
existing §9 numbers may be carried over). **Reported and stopped.**

*Interim option worth the owner's call:* the repo already has the exact mechanism for
"pinned file is not obtainable as pinned" — `download.withdrawn`. It is dated prose, not a number,
so applying it needs no measurement. That would make the AI-Model card explain the situation
instead of offering a download that cannot verify.

### B-2 — the #196 blast-radius sweep proved liveness, not byte-identity · CONFIRMED · **MEDIUM**

`docs/model-benchmarks.md:1135-1139` (§9.5) records: "Every committed `download.url` in the catalog
was re-checked the same day (28 URLs, `HEAD` + redirects): **only the three Qwen3.8 manifests are
dead.** The Qwen3.6 pair is intact — URL alive AND the upstream LFS OIDs still equal the committed
hashes". Same claim in `BUILD_STATE.md` (2026-08-20 #196 entry).

That is accurate as written, and it is why B-1 slipped through: **hash equality was verified for
two manifests, liveness for all of them.** This audit re-ran hash equality for all 32 committed
`download.url`s and found exactly one drifted (B-1).

Two smaller precision notes on the same sentence: the count is now **32 URLs across 31 manifests**
(the vision manifest carries two), and "28" counted manifests-with-a-download-block at the time,
not URLs.

*Fix:* the durable fix is a CI-free maintainer command or a documented ritual —
"re-check URL **and** upstream OID for every `download.url`" — recorded wherever the catalog
ritual lives (`model-policy.md` "Withdrawn upstream sources" is the natural home). Cheap, and it
converts B-1's class from "found by luck" to "found on schedule".

### B-3 — four manifests carry rounded, not measured, `size_bytes` · CONFIRMED · **LOW**

| Manifest | Committed | Upstream actual | Δ |
|---|---|---|---|
| `qwen3-4b-instruct-q4.yaml` | 2 700 000 000 | 2 497 280 256 | −8.1 % |
| `qwen3-8b-instruct-q4.yaml` | 5 000 000 000 | 5 027 783 488 | +0.6 % |
| `qwen3-14b-instruct-q4.yaml` | 9 300 000 000 | 9 001 752 960 | −3.3 % |
| `qwen3-30b-a3b-q4.yaml` | 18 600 000 000 | 18 556 685 824 | −0.2 % |

All four `sha256` values still match upstream exactly, so the *weights* are correct; only the
declared size is an estimate. This is **already tolerated by design** —
`apps/desktop/src/main/services/assets.ts:528-536` says `size_bytes` "is DECLARED metadata … and
can be a rounded estimate", and `modelWeightMaxBytes` grows the cap by 25 % / ≥128 MiB precisely so
a rounded value cannot truncate a download (BUG `dl-size-cap-2026-07-03`).

*Why it is still a finding:* it sits in visible tension with the repo's own repeated rule that
"manifest numbers are measured, never estimated" (`architecture.md` MTP record §7; `BUILD_STATE`
#196 entries). Either the four values get their measured bytes (a one-line edit each, and the
upstream OIDs already confirm the file), or `model-policy.md` says out loud that `size_bytes` is
the one field allowed to be approximate. Both are cheap; leaving the contradiction is the only bad
option.

---

## 3. Theme C — the Node floor moved and three docs did not

`apps/desktop/package.json:26-28` and root `package.json` declare `"node": ">=22.12"`.
`docs/architecture.md:10185` records the change explicitly in the DEP-4 wave table:
`engines.node` | `>=22.5` → **`>=22.12`** (Electron 43's own floor).

Four living places still promise the old floor:

| id | Location | Text | Severity |
|---|---|---|---|
| **C-1** | `README.md:16` | `[![Node ≥ 22.5]…](package.json)` — a badge that *links to the file it contradicts* | MEDIUM |
| **C-2** | `README.md:99` | "**Node.js ≥ 22.5** (24 recommended…)" | MEDIUM |
| **C-3** | `CONTRIBUTING.md:53` | "Requires **Node.js ≥ 22.5** (Node 24 recommended), **per `package.json` `engines`**" | MEDIUM |
| **C-4** | `docs/packaging.md:482` | "`22.x` is the `engines.node >= 22.5` floor the app promises to run on" | LOW |
| **C-5** | `.github/workflows/ci.yml:61` | comment: "22.x is the `engines.node >=22.5` floor the app promises to run on" | LOW |

CI itself is unaffected (`node-version: 22.x` resolves to the newest 22), so this is a pure
documentation defect — but C-3 is the contributor-onboarding path, and a contributor pinned to
Node 22.5–22.11 will follow it into an `EBADENGINE` they were told could not happen.

**Not a finding:** `BUILD_STATE.md:203` ("It needs Node ≥ 22.5. Electron 33 bundles Node 20…") is a
dated decisions-log entry about `node:sqlite`'s own floor, correct in its own frame.

*Fix:* five one-line edits, `>=22.12`. The badge URL also needs its `%E2%89%A5%2022.5` segment
changed.

---

## 4. Theme D — reference integrity

This came back **clean**, which is itself the finding: the `§`-anchor legend discipline works.
Evidence is in §6.

### D-1 — `docs/build-log.md` carries four repo-root-relative links · CONFIRMED · **LOW**

`docs/build-log.md:9645, 9650, 9652, 9659` link to `docs/packaging.md`,
`apps/desktop/src/main/ipc/registerDocsIpc.ts`, `apps/desktop/src/main/services/drive.ts` and
`apps/desktop/src/renderer/styles.css`. From `docs/`, those resolve to `docs/docs/packaging.md`,
`docs/apps/...` — i.e. nowhere. All four targets exist at the repo root.

This is a **verbatim-move artifact**: the entries were correct in `BUILD_STATE.md` (repo root) and
moved verbatim, as the retention rule requires. The archive's *internal staleness* is by design and
not flagged; a link that cannot resolve in either direction is corruption of the pointer, which the
brief does ask about ("audit only that it is reachable and uncorrupted").

`repo-hygiene.test.ts:294-299` allowlists build-log to exactly one relative link
(`../BUILD_STATE.md`), so these four are inside a fenced/quoted region the gate does not see.

*Fix (owner's call):* either prefix the four with `../` (a byte edit inside a verbatim archive —
arguably a violation of "frozen") or leave them and record the artifact in the archive's header.
Recommend the header note: it preserves the verbatim guarantee.

### D-2 — `README.md:110` `../../releases/latest` fails every local checker · CONFIRMED · **INFO**

A deliberate GitHub-relative link: from `/HilbertraumAI/HilbertRaum/blob/master/README.md` it
resolves to `/HilbertraumAI/HilbertRaum/releases/latest`. Correct on github.com, unresolvable on
disk. Recorded so a future link sweep does not "fix" it. No action.

### D-3 — two comment `§`-citations use item numbers, not headings · CONFIRMED · **INFO**

`apps/desktop/src/renderer/components/LocalIndicator.tsx:6` cites `guidelines §1.2` and
`apps/desktop/src/renderer/components/Dialog.tsx:104` cites `guidelines §1.6`.
`docs/design-guidelines.md` §1 "Design principles" is an unnumbered `<ol>`; both citations mean
principle **2** and principle **6**, and both are correct in content ("privacy is the ambient
state"; "primary dialog button on the right"). Resolvable by a human, invisible to a checker.
No action recommended — flagged only so it is not mistaken for a break later.

### D-4 — a ledger row cites a bullet as a section · CONFIRMED · **INFO**

`docs/architecture.md:5829` (DOC-N1 row) points at "`security-model.md` §6.4 caps bullet".
`docs/security-model.md` has no numbered sections; the target is the bullet at
`security-model.md:1107` which literally begins "**§6.4 caps**" (a *skills-plan* anchor). It
resolves by string match. No action.

---

## 5. Theme E — coverage gaps (nothing here is *wrong*, only *absent*)

### E-1 — 16 of 140 IPC channels are absent from `data-contracts.md` · SUSPECTED · **LOW**

`docs/data-contracts.md` is designated the single home for the IPC surface (CLAUDE.md; README's
doc table). Cross-checking every `IPC` key in `apps/desktop/src/shared/ipc.ts` (140 channels)
against the doc, these 16 appear under neither their key nor their channel string:

`useModel (runtime:use)` · `setConversationDefaultSkill (chat:setDefaultSkill)` ·
`writeClipboard (clipboard:write)` · `documentCoverage (analysis:coverage)` ·
`listAllExtractions (analysis:listAll)` · `imageListSessions (images:listSessions)` ·
`imageGetSession (images:getSession)` · `imageDeleteSession (images:deleteSession)` ·
`translateGetActive (translate:getActive)` · `setCollectionArchived (collections:setArchived)` ·
`pickSkillPackage (skills:pick)` · `previewSkillPackage (skills:preview)` ·
`exportSkill (skills:export)` · `acknowledgeSkillWarning (skills:acknowledgeWarning)` ·
`skillReconcileStatus (skills:reconcileStatus)` · `modelVerifyProgress (models:verifyProgress)`

Marked **suspected** because `data-contracts.md` is structured as accumulated per-phase records,
not a normative channel table, so "complete channel coverage" may never have been the contract.
The question for the owner is whether it is: if yes, this is a 16-row backfill; if no, one sentence
in the doc header saying so closes it permanently.

### E-2 — the 2026-08 waves' "Not built" decisions never reached `known-limitations.md` · SUSPECTED · **LOW**

`docs/known-limitations.md` contains no reference to issues **#182, #188, #190, #194 or #196**, and
no "speculative"/"withdrawn" entry. Several of those waves closed with explicit consciously-accepted
gaps in `BUILD_STATE.md` — e.g. #194's "**Not built:** a per-row error surface … and a main-owned
cancellable job for one document", #196's installed-base residual and the "successors are never
inherited by family resemblance" rule, #182's tokens/sec-probe watch item.

Each of those *is* recorded in a `§`-numbered design record, which the doc-lifecycle rule permits,
so this is a routing question, not a lost fact: does `known-limitations.md` still aim to be the
one place a user finds accepted gaps? The Local API section (`:2136-2166`, added 2026-08-20) says
yes for that wave and is excellent — which makes the neighbours' absence look like an omission
rather than a policy.

*Note:* the audit found **no** entry in `known-limitations.md` describing a limitation that has
since been fixed. That was the higher-risk direction, and it is clean.

### E-3 — one script is undocumented in the packaging script table · CONFIRMED · **LOW**

`scripts/release-issues-section.sh` is invoked by `.github/workflows/release.yml:212` but appears
in no living doc. `docs/packaging.md:280-290`'s script table covers the other seven.

### E-4 — `BUILD_STATE.md` has 56 lines of headroom · CONFIRMED · **INFO**

1,944 / 2,000 lines and 164 KB / 300 KB against the budget enforced by
`repo-hygiene.test.ts:337-341`. Not a defect; recorded because the next wave close-out will need an
archive pass before it can write its entry, and discovering that mid-PR is expensive.

---

## 6. What was checked and came back clean (the evidence behind "good shape")

These are not findings. They are the negative results, recorded so the next audit can skip them or
detect a regression against them.

| Check | Method | Result |
|---|---|---|
| Internal markdown links | All 53 `.md` files, every `[text](target)`, path **and** `#anchor` (GitHub slug rules, both directions root ↔ `docs/`) | **0 broken** outside D-1/D-2 |
| External URLs | 299 unique URLs from markdown, source comments, manifests, scripts; `HEAD` (with `GET` retry on 403/405/501), redirects followed | **3 dead**, all the known-withdrawn Qwen3.8 trio, all already carrying `download.withdrawn`. Remaining failures are `example.test` / `example.com` test fixtures and two URL *prefixes* |
| `§`-citations to living docs | Every `<doc> §N` citation across `**/*.{md,ts,tsx,mjs,ps1,sh,yaml}` resolved against that doc's actual heading set (numbered headings + legend rows) | **0 unresolvable** (the 3 candidates are D-3/D-4, all resolvable in fact) |
| `spec §N` namespace collision | The MVP-spec legend (`architecture.md:11547`) and the EP-1 legend (`architecture.md:9798`) both exist and partition the namespace by authoring file | correct; no ambiguity |
| Retired-plan citations | `wholedoc-truncation-fix-plan`, `skills-s13-plan`, `skills-audit-2026-07-03`, `skills-plan`, `whole-document-analysis`, `context-compaction-plan`, `image-understanding`, `brand-refresh-plan`, `full-doc-skills`, `skills-tools-audit-2026-06-26` | every one lands in a living topic doc with a `§`-anchor legend |
| Manifest `download.url` liveness | All 32 committed URLs + 8 `runtime-sources.yaml` URLs | 3 dead (the withdrawn trio), 37 alive |
| Manifest hash pinning | All 30 HuggingFace URLs, upstream LFS OID via `x-linked-etag` **and** the HF tree API | **29 exact matches**, 1 drift (**B-1**) |
| Backticked file paths in docs | Every `` `path.ext` `` in living markdown resolved on disk | no live-source path is dead. Apparent misses are retired plan/audit docs (deliberate), on-drive runtime paths (`config/drive.json`), build outputs (`out/main/index.mjs`), or explicitly-removed code the doc *says* was removed (`filing-suggestions.ts`, `registerStubIpc.ts`) |
| Commented-out code in `src/` | 8,610 comment blocks, code-shape heuristic | **0** |
| TODO / FIXME / XXX / HACK in `src/` | grep | **2**, both genuinely open (a manual `translategemma-smoke` reconfirmation; a single-document tool-runner note) |
| Comment-cited identifiers | 2,216 distinct `` `identifier` `` mentions inside comments, resolved against the whole source + test + script + manifest corpus | **0 unresolved** — no comment names a renamed or deleted symbol |
| Doc-vs-code constants (spot) | skill caps (6 env vars + defaults) vs `services/skills/limits.ts`; local-API port 4980, `BODY_MAX_BYTES` 1 MiB, `MAX_CONNECTIONS` 16, 30 s waiter cap vs `services/local-api/*`; `DEFAULT_SETTINGS` vs `data-contracts.md`; 226 shipped packages vs `THIRD-PARTY-NOTICES.md` | all match |
| Script flags in docs | `prepare-drive.{ps1,sh}` params, `--with-assets` default model set, `fetch-models --only`, `verify-models --generate` | all match; the ~10.4 GB default-set figure recomputes correctly |
| Model sizes / min-RAM in README | 23 table rows vs `size_on_disk_gb` / `recommended_min_ram_gb` | all match (one rounding nit: 0.8B "~0.6 GB" vs manifest 0.7) |
| `CHANGELOG.md` | tags, version links, release posture, `release.yml:160-170` wiring | **correct** — v0.1.57 current, 8 public releases acknowledged, `[Unreleased]` covers #196/#182/#188/local-API. The archetype from the brief is already fixed here |
| `DRIVE-NOTICES.md` / `THIRD-PARTY-NOTICES.md` | generated + drift-gated (`drive-notices.test.ts`, `third-party-notices.test.ts`) | current, including all three `ud-` successors |
| `docs/skills-overview.md` | 9 bundled skills vs `app-skills/`, versions gated by `skills-skillmd-parity.test.ts` | complete |
| `known-limitations.md` | scanned for limitations since fixed | **none found** |

---

## 7. Theme F — comment weight

**Verdict: the codebase's comments are carrying their weight.** 31,682 comment lines across
~100,800 source lines (31 %) is high, and it is deliberate: the sample reads as decisions,
rejected alternatives, invariants and citations — precisely the class the brief says must survive.
Two examples of what a blanket "shorten comments" pass would have destroyed:

- `apps/desktop/src/main/services/assets.ts:528-536` — why the download body cap is `size_bytes`
  **+25 %** and not `size_bytes`, with the exact failure it fixes ("stops at 95 %, then checksum
  wrong on resume") and the bug id.
- `apps/desktop/src/shared/types.ts:2525-2545` — why `identity: 'unresolved'` is distinct from a
  missing document, and why freshness may only say "cannot verify".

Mechanical CUT candidates came back at **0 commented-out code, 0 shipped TODOs, 0 stale identifier
references, 3 section-divider "restatements"** (`// ---- Chat: sources ----` above a catalog block
— structural, keep) and **7 one-line JSDoc that restate a field name** (`/** Rename a collection. */`
above `renameCollection`). The seven are not worth a PR; noted and dismissed.

That leaves two real REWRITE candidates, both of the same shape.

### F-1 — `INVOICE_EXTRACTOR_VERSION` history: 112 comment lines · CONFIRMED · **MEDIUM (rewrite, not cut)**

`apps/desktop/src/main/services/skills/tools/invoice.ts:115-226`.

The block has two halves that should be treated differently:

- **Load-bearing — keep verbatim (≈16 lines).** What the constant stamps, the `!==`-not-`<` staleness
  rule and *why* (SKA-26/R9: a rollback must re-extract too), the re-extract-vs-serve-stale-figures
  decision, and the **BUMP THIS** invariant with its "a pure refactor does not need a bump" carve-out.
  Nothing else in the repo records that.
- **Changelog — rewrite (≈90 lines).** Thirteen numbered entries, each retelling in 4–10 lines what a
  named audit finding already holds (`skills-remediation R5 (audit §5.7)`,
  `invoice-audit-2026-07-06 IA-3 (T-2/T-3/…)`, `skills-audit-2026-07-03 R7 (SKA-1, SKA-2, SKA-14)`).
  Every one of those anchors resolves through the `architecture.md` `§`-anchor legends, and the
  underlying diffs are in git.

*Proposed shape:* keep the header + invariant; collapse the history to one line per version —
`12 — IA-2 (T-1): MONEY_RE sign must be glued to the magnitude.` — preserving **every** citation and
**every** number, dropping the retelling. ~112 lines → ~32.

*Risk:* low but non-zero — the per-version prose is the only place the *behavioural* meaning of an
old stamp is written down. Mitigation: the one-line index keeps the audit id, which is the real
pointer. Worth a moment of owner agreement before executing.

### F-2 — `BANK_EXTRACTOR_VERSION` history: 86 comment lines · CONFIRMED · **MEDIUM (rewrite, not cut)**

`apps/desktop/src/main/services/skills/tools/bank-statement.ts:84-169`. Identical structure,
11 entries, same treatment. The two blocks cross-reference each other correctly (the shared
`money.ts` T-6 change bumped both, and each says so) — that cross-reference is load-bearing and must
survive the rewrite.

*Combined:* ~198 comment lines → ~60, with zero citations and zero measured numbers lost.

---

## 8. Phased remediation plan

Cheapest and safest first. Every phase is a **feature branch + PR with green `ci-success`**;
`npm test` and `npm run typecheck` run on every phase including the docs-only ones (a comment
inside a template literal or a stray `import` in a string can break the build —
`repo-hygiene.test.ts` already guards one such trap).

Phases are independent unless noted, so any subset can run.

### Phase 0 — report only *(done: this file)*
No repo change beyond this document. Nothing below runs without your go-ahead.

---

### Phase 1 — the Node floor · 5 one-line edits · docs-only · **safest**
Fixes **C-1 … C-5**. `README.md:16` (badge URL), `README.md:99`, `CONTRIBUTING.md:53`,
`docs/packaging.md:482`, `.github/workflows/ci.yml:61` → `>=22.12`.
*Risk:* none. No behaviour, no numbers, no `§` anchors.
*Verification:* `npm test`, `npm run typecheck`, plus a grep proving no `22.5` floor claim remains.

### Phase 2 — the catalog prose sweep (Theme A) · **highest value**
Fixes **A-1 … A-6**. Four files, all prose, all pointing at data that already exists:
`README.md` (tier sentence ×2, three withdrawn rows re-labelled, three successor rows added),
`docs/model-policy.md` (six row cells + the tier note + three new rows),
`docs/benchmark.md` (two table cells + the parenthetical).
*Inputs:* every number comes from the committed manifests and `model-benchmarks.md` §9.5 — nothing
is measured or estimated here.
*Risk:* low. No `§` renumbering, no anchor changes.
*Verification:* `npm test` + `npm run typecheck`; re-run the recommender replay and diff it against
the prose; confirm `CHANGELOG.md:51` and the new README text agree.

### Phase 3 — the dated amendment notes (Theme A, records) · docs-only
Fixes **A-7**. One dated amendment note under `model-benchmarks.md` §6.5 rules 3 and 5, in the
doc's own established style (as #153 got). **Historical body untouched, no renumbering.**
*Risk:* low. Separate from Phase 2 because it edits a design *record*, which has stricter rules than
catalog prose — worth its own review.

### Phase 4 — the five stale manifest comments · comment-only
Fixes **A-8**. Five YAML comment blocks. Wrong comments, so ranked above anything in Phase 6.
*Risk:* low, but manifests are parsed by `committed-catalog.test.ts` — the full suite is the gate.
*Verification:* `npm test` (catalog invariants + validator), `npm run typecheck`.

### Phase 5 — reference hygiene · docs-only · tiny
Fixes **D-1** (a note in `docs/build-log.md`'s header recording the verbatim-move link artifact —
recommended over editing the archive body) and **E-3** (one row in `docs/packaging.md`'s script
table for `release-issues-section.sh`).
*Risk:* none.

### Phase 6 — the two extractor-version histories · comment-only · **needs your call first**
Fixes **F-1, F-2**. ~198 comment lines → ~60, preserving every citation, every number, both
invariants and the cross-reference between the two files.
*Risk:* low mechanically, medium editorially — this deletes prose the repo deliberately wrote.
I would want your yes on the *shape* (one line per version, audit id preserved) before touching it.
*Verification:* `npm test`, `npm run typecheck`, plus a diff review that no `audit §`/`SKA-`/`IA-`
anchor and no numeric value was dropped.

### Phase 7 — coverage backfills · docs-only · **needs a policy decision, not just a fix**
**E-1** (16 IPC channels) and **E-2** (2026-08 waves' accepted gaps) are each a *scope* question
before they are an edit:
- E-1: is `data-contracts.md` normatively complete for the channel surface? If yes → 16-row
  backfill. If no → one clarifying sentence in its header, and the finding closes forever.
- E-2: does `known-limitations.md` still aim to be the single user-facing home for accepted gaps?
  If yes → entries for #182/#188/#194/#196 (the facts already exist in the design records). If no →
  a header sentence pointing at the records.

Also folds in **E-4** (archive a closed wave from `BUILD_STATE.md` to `docs/build-log.md` to restore
headroom) if you want it done pre-emptively rather than at the next wave close-out.

---

### Not in any phase — needs a measurement wave, not an edit

**B-1** (`gemma4-12b-it-qat-q4` upstream re-upload). Per the brief and the repo's own rule, a
substitution is not a doc fix: it needs a download, an on-disk SHA-256, and a decision about whether
the existing §9 numbers still describe the new bytes. **Reported and stopped.**

The one thing that *is* a same-day, no-measurement option is applying the existing
`download.withdrawn`-style honesty to it so the AI-Model card explains the mismatch instead of
offering a download that will fail verification — but even that is a product decision (the file is
obtainable, just not as pinned), so it is yours to make, not mine to assume.

**B-2** (add "verify upstream OID, not just liveness" to the catalog ritual) is a natural rider on
whichever wave takes B-1.

**B-3** (four rounded `size_bytes`) is either a four-line measured correction inside that same wave,
or one sentence in `model-policy.md` declaring the field approximate — your call which.

---

## 9. Method & reproducibility

Every mechanical result above came from a script run against this working tree at
`50c5a4eb` (branch `docs/changelog-per-version-release-notes`, clean). The scripts live in the
session scratchpad and are disposable; the checks they perform are:

1. **Link check** — walk all `.md`, parse `[text](target)`, skip fenced blocks, resolve relative
   paths on disk and `#fragments` against a GitHub-compatible heading slugger (punctuation
   stripped, spaces → `-` one-for-one, duplicate-suffix counter).
2. **URL check** — extract every `https?://` from markdown, source, manifests and scripts; `HEAD`
   with redirects, `GET` retry on 403/405/501, 25 s timeout, concurrency 8.
3. **Manifest check** — parse `download:` blocks; `HEAD` with `redirect: 'manual'` to read
   HuggingFace's `x-linked-etag` (the git-LFS OID = the file's SHA-256) before the CDN redirect
   replaces it; independently confirm via `https://huggingface.co/api/models/<repo>/tree/main`.
   *(Following redirects here is the trap: the CDN's own ETag is not the LFS OID and produces a
   100 %-false-positive mismatch rate.)*
4. **`§`-citation check** — build each living doc's section set from its numbered headings and
   legend-table rows; resolve every `<docname> §N` citation in `**/*.{md,ts,tsx,mjs,ps1,sh,yaml}`.
5. **Recommender replay** — re-implement `comfortableOrder` / `preferRanked` /
   `recommendModelIdByRam` from `models.ts` and run them over the committed YAML for RAM values
   4…64, then cross-check against `benchmark.test.ts` and `committed-catalog.test.ts`.
6. **Comment extraction** — tokenize `//` runs and `/* */` blocks across `apps/desktop/src`
   (8,610 blocks / 31,682 lines), then run detectors for commented-out code, changelog-shaped
   prose, signature-restating JSDoc, next-line restatement, and comment-cited identifiers that no
   longer exist anywhere in the corpus.

`npm run typecheck` was run as a baseline and is clean at audit time.
