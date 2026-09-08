### App view: `ryzen-7-5800h-rtx-3060-laptop-6gb-14gb` · #391 part (a) — what the app shows at 14 GB RAM

Performance screen > Copy report, pasted by the operator 2026-09-08, from the source build running out of the repo checkout (`npm run dev`) on `hw/391-ryzen-7-5800h-rtx-3060-laptop-6gb-14gb-20260908` — off `master`, so **after #386 / #387 / #390**. Drive root is the dev workspace described in `00-preflight.md`. No model was running, so there is no "Dein Modell" row. Stored verbatim as `app-report-391-part-a.txt`.

**All four rows of the issue's table are confirmed — but the profile row needed a re-measure to appear, and that is the finding.**

| row | #391 expected | reported | verdict |
|---|---|---|---|
| Grafikspeicher tile | `5,9 GB VRAM (RTX 3060 Laptop GPU)` | `5,9 GB VRAM (NVIDIA GeForce RTX 3060 Laptop GPU)` | ✔ |
| basis | Grafikspeicher | **Grafikspeicher** | ✔ |
| ★ | `gemma4-e2b-it-qat-q4` (unchanged) | Gemma 4 E2B Instruct QAT Q4 | ✔ — the #321 comment's correction holds; **not** the 4B |
| Profil | BALANCED | **LITE**, then **BALANCED** after one re-measure | ✔ only after a re-measure |

The Klein/Nutzbar rating word is not part of the Copy report text — it carries the tile's figure and device name only. The basis flipping to **Grafikspeicher** is the observable proof that the card is now the budget device, i.e. that #387 is live on this build.

```text
Zugewiesenes Profil: LITE                                          <- first report
Empfohlen für den nächsten Start: Gemma 4 E2B … (Grafikspeicher)
Letzter Lauf: 7.9.2026, 19:26:19
```

#### Why it first read LITE — measured, not guessed

`Zugewiesenes Profil` is **not recomputed live**. It is a field of the persisted benchmark record. Read out of this workspace's settings table (`workspace/hilbertraum.sqlite`, key `lastBenchmark`, read-only):

```
profile:         "LITE"
finishedAt:      2026-09-07T17:26:19.883Z     = "Letzter Lauf 7.9.2026, 19:26:19"
tokensPerSecond: 62.6
speedIdentity:   { memoryClass: "cpu", deviceName: null, contextTokens: 8192, backend: "gpu" }
gpu:             null
```

That record was written by the **pre-#387 build** — `memoryClass: "cpu"` and `gpu: null` are precisely what the 6,144 MiB gate did to this card. Meanwhile `gpuProbe` had been re-probed the same morning (`probedAt: 2026-09-08T06:23:15.375Z`, Vulkan1 at 5,994 / 5,226). Hence one report showing a **post**-#387 recommendation next to a **pre**-#387 profile.

No second gate is involved: `gpuUsefulForProfile` reads the same constant #387 lowered (`shared/gpu-rules.ts`, `GPU_BUMP_MIN_VRAM_MB = USABLE_VRAM_MB`). The derivation on the committed code:

```
classifyProfile(13.9, { gpuUseful: true, tokensPerSecond: 62.6 })
  ramGb 13.9 <= 16                                             -> LITE
  gpuUseful (5,994 >= USABLE_VRAM_MB 5,120, not integrated)     -> BALANCED
  tps 62.6 not < VERY_LOW_TOKENS_PER_SECOND (3)                 -> no downgrade
```

One press of the measure action, nothing else changed, confirmed it:

```text
Geschwindigkeit: 62,9 Token / Sek. (… am 8.9.2026, über 64 Token)
Zugewiesenes Profil: BALANCED                                      <- second report
Letzter Lauf: 8.9.2026, 09:05:38
```

Speed moved 62,6 → 62,9 tok/s, i.e. not at all, so the profile moved on `gpuUseful` alone.

**Worth a decision of its own:** a gate change ships the new recommendation basis immediately while leaving the profile label on the same screen describing the previous build's verdict, until someone happens to re-measure — and nothing prompts them to. The report does timestamp it ("Letzter Lauf"), so it is not *silent*; it is still one screen showing two builds' answers side by side. Not filed as an issue, owner's call.

#### The BALANCED verdict #391 asks for

**It does not look wrong on this machine — and the reason it is safe is that it costs nothing.**

1. **The profile does not choose the model when RAM is known.** `buildModelList` (`services/models.ts:1235-1244`) uses `recommendChatModelId` (rule C + RAM) whenever `machineRamGb != null`; `recommendModelId(profile, …)` is only the legacy no-RAM path. Measured here: the ★ is the E2B in **both** reports, before and after the bump. BALANCED is a label on the Performance screen, not a lever.
2. **The label is defensible on this hardware.** The card genuinely accelerates — this session measured the 4B fully offloaded **33/33 at 59.4 tok/s**, the app's own benchmark reads **62.9 tok/s**, and September measured the E2B **36/36 at 86 tok/s**. Calling that LITE — the same step as a machine with no usable card at all — was the less accurate of the two labels. On this scale a 32 GB CPU-only box is also BALANCED, and this laptop beats one at chat inference.
3. **What is coarse is the rule, not this answer.** The bump is a flat +1 on a single boolean, so a 5,120 MiB card and a 24 GB card earn the same step. That is the part with no measurement behind it. It did not misfire here.

Where the label overstates, for the record: 14 GB RAM + 6 GB VRAM cannot hold a 9B — measured this session at **20/33, 4.15 tok/s**. A reader who takes BALANCED to mean "mid-size models are comfortable" would be wrong. The ★ does not make that mistake, because it never consults the profile.
