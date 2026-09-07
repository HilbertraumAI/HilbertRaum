### Leg 5 — `ryzen-7-5800h-rtx-3060-laptop-6gb-14gb` · which device the sidecar loads onto

**Not a separate start.** Leg 5 asks a question the two leg-4 starts already answer on this machine,
so this comment reports what those two logs show rather than inventing a third start. Both are
posted above with their full argv, buffers and redacted logs.

**Caveat on the leg definition:** the protocol names leg 5 "a hybrid **Intel**-first laptop". This
box is **AMD-APU-first** (`AMD Radeon(TM) Graphics` from a Ryzen 7 5800H). The structural
condition — an integrated device enumerated FIRST, a discrete card second, no `--device` passed —
holds, so the leg's question is answerable here; whether an Intel iGPU behaves the same is **not**
settled by this machine, and #320's `looksIntegrated` completeness question is about Intel names
specifically. Leg 5 should be considered answered for the AMD-APU case only.

#### Raw device order (recorded, as the leg and #332 ask)

```text
Available devices:
  Vulkan0: AMD Radeon(TM) Graphics (8886 MiB, 8441 MiB free)      <- INTEGRATED, listed FIRST
  Vulkan1: NVIDIA GeForce RTX 3060 Laptop GPU (5994 MiB, 5226 MiB free)
```

`deviceType` confirms it: `INTEGRATED_GPU` for Vulkan0, `DISCRETE_GPU` for Vulkan1. The app's
`looksIntegrated` matches `AMD Radeon(TM) Graphics` correctly, so the picker excludes it — but the
picker excludes the RTX too, on size (5,994 < 6,144), which is what makes this machine leg 4 as well.

#### Where the layers actually landed

| | leg 4 baseline (`gemma4-e2b-it-qat-q4`) | leg 4 partial (`qwen3.5-9b-ud-q4kxl`) |
|---|---|---|
| offloaded | 36/36 | 18/33 |
| **Vulkan0 (iGPU)** | **nothing** | **nothing** |
| Vulkan1 model buffer | 1,341.76 MiB | 3,123.80 MiB |
| Vulkan1 KV | 96.00 MiB | 160.00 MiB |
| Vulkan1 RS | — | 100.50 MiB |
| Vulkan1 compute | 560.07 MiB | 498.00 MiB |
| host side | CPU_Mapped 2,152.50 MiB | CPU_Mapped 2,555.45, CPU KV 96.00, CPU RS 100.50 MiB |

**In both starts every GPU-side buffer is filed under `Vulkan1`. The integrated GPU received
nothing at all**, with no `--device` passed and the iGPU enumerated first.

#### Why — the fit only ever considered one device

The fit's own log never treats this as a two-device machine:

- E2B: `projected to use 1997 MiB of device memory vs. **5223 MiB of free device memory**` — that
  is the card's figure (probe 5,226), not the iGPU's 8,441, and not a sum.
- 9B: `projected to use 6007 MiB … vs. **5022 MiB of free device memory**`, then
  `start filling **device 0**, delta=33` → `- **Vulkan1** (NVIDIA GeForce RTX 3060 Laptop GPU): 18 layers, 3882 MiB used, 1140 MiB free`.

Note the mapping in that last pair: the fit's **`device 0` is `Vulkan1`**. The iGPU is not device 1
in the fit's numbering — it is absent from it. So on this machine llama.cpp b9849 had already
excluded the integrated device before the filling pass, and the "`--fit` spreads layers across
every listed device" premise behind #320 (j) / BUILD_STATE §5 22 (j) **did not materialise here**.

#### What this says about #320 (j)

On this hybrid laptop, passing `--device` to exclude the iGPU would change nothing: the runtime
already ignores it. That is one data point against the need for an argv change, and it comes from
the AMD-APU case; an Intel-first box (leg 5 as originally scoped) is still open, and so is the
`looksIntegrated` bare-name question, which this machine cannot exercise because its iGPU name
carries the `(TM)` form the table already matches.

#### Two side observations from the same logs

1. **The probe's free figure is static while the card is in use.** A second `--list-devices` taken
   *while* each model was loaded returned `Vulkan1 … 5226 MiB free` — **unchanged** — although
   nvidia-smi read 2,259 MiB used (E2B) and 4,159 MiB used (9B) at those moments. The GTX 1070 Ti
   session saw the figure move by 673 MiB in the same situation; here it moves by zero. Anything
   that re-probes to decide whether a *second* model fits alongside a running one would be reading
   a stale number on this driver.
2. **`ModelPlacement.gpuFreeAtStartMb` names the iGPU on this machine.** It is the parser's
   documented "legacy summary field" — the FIRST `device_info` row (`placement.ts:134`) — and the
   snapshot is meant to re-attribute the free/working figures to the SELECTED device (PR #303 audit
   DR2). With no budget device there is nothing to re-attribute to, so the app's persisted record
   for the E2B start carries `gpuFreeAtStartMb: 8441` (the iGPU's) beside a start that ran entirely
   on the RTX. `devices[]` in the same record is correct — it files the 560.07 MiB compute buffer
   under Vulkan1 and `null` under Vulkan0 — so only the summary field misleads, and only on a
   machine that has no budget device. Worth a line in #329 or a follow-up rather than a fix here.
