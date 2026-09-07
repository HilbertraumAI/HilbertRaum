# Preflight — `ryzen-7-5800h-rtx-3060-laptop-6gb-14gb` · legs 4 + 5

Session 2026-09-07. Everything below is detected, not typed in. Chassis type 10 = notebook, so
this is a laptop; two Vulkan devices with the integrated one enumerated FIRST, and the discrete
card reports **under** the runtime's 6,144 MiB usable gate — so this machine is simultaneously
**leg 4** (a 6 GB laptop card, the RAM pick partially offloaded) and **leg 5** (a hybrid laptop:
which device does the sidecar actually load onto). It is also the third measured data point for
issue #321 and the first one that is AMD-APU-first rather than Intel-first.

## Machine

| | |
|---|---|
| CPU | AMD Ryzen 7 5800H with Radeon Graphics — 8 cores / 16 logical → the app's `--threads` is **8** (`defaultThreadCount`, ⌊16/2⌋) |
| RAM | `Win32_ComputerSystem.TotalPhysicalMemory` = 14,877,257,728 B = **13.86 GiB**; the app reports `ramGb: 13.9` and the picker rounds it to **14** (`machineRamGb()`). 16 GB is installed; the APU carves out ~2 GB for the iGPU. |
| Chassis | `Win32_SystemEnclosure.ChassisTypes` = 10 (notebook) |
| OS | Windows 11 Home 22H2, build **22621.4387** |
| Vulkan | instance 1.4.321 |
| Machine key | `win32|x64|AMD Ryzen 7 5800H with Radeon Graphics|16|14` |

## Runtime

`<drive>\runtime\llama.cpp\win\llama-server.exe` → `version: 9849 (799fcc04a)`, built with
Clang 20.1.8 for Windows x86_64. **Matches the pin.** The binary runs here — no Smart App Control
block of the kind that stopped the PR #308 audit machine.

### Drive-root deviation (stated for the record, as in the i7-8550u preflight)

**No mounted drive root on this machine carries `runtime\llama.cpp\win\llama-server.exe`.** Every
filesystem drive root and every first-level directory under one was searched; there is no hit. The
portable AI Kit drives built for this project are not attached. What is used instead, with the
owner's confirmation, is the **app's own dev workspace**, which carries the complete drive layout
(`runtime\`, `models\`, `config\`, `workspace\`, `logs\`) and whose runtime the app downloaded and
checksum-verified itself. The runtime manifest and `llama-server --version` both match the pin, so
the binary under test is the shipped one — but this is a staged layout on the system disk, **not a
start from a Kit drive**. `<drive>` in every artefact of this session refers to it.

## Devices — raw `--list-devices` (the app's own probe, desktop idle)

```text
Available devices:
  Vulkan0: AMD Radeon(TM) Graphics (8886 MiB, 8441 MiB free)
  Vulkan1: NVIDIA GeForce RTX 3060 Laptop GPU (5994 MiB, 5226 MiB free)
```

**The integrated device is listed first** (the order leg 5 and #332 need recorded).

| | Vulkan0 | Vulkan1 |
|---|---|---|
| name | AMD Radeon(TM) Graphics | NVIDIA GeForce RTX 3060 Laptop GPU |
| `deviceType` | `INTEGRATED_GPU` | `DISCRETE_GPU` |
| Vulkan api / driver | 1.3.217 / 2.0.233 | 1.4.325 / **591.74**.0.0 |
| probe total / free | 8,886 / 8,441 MiB | **5,994 / 5,226 MiB** |
| `looksIntegrated`? | **yes** (`radeon(\(tm\))? graphics`) | no |
| `isUsefulDevice`? | no (integrated) | **no — 5,994 < 6,144** |

`nvidia-smi` reads the card as **6,144 MiB** total / 285 used / 5,710 free; `Win32_VideoController`
reports a truncated 4,095 MiB. The probe's **5,994** is what the picker sees and is therefore the
figure used throughout.

### Vulkan heaps

| device | heap | size | budget (idle) | flags |
|---|---|---|---|---|
| RTX 3060 Laptop | 0 | 5,994 MiB | 5,226 MiB | `DEVICE_LOCAL` |
| RTX 3060 Laptop | 1 | 7,094 MiB | 6,483 MiB | host |
| Radeon iGPU | 0 | 1,792 MiB | 1,702 MiB | `DEVICE_LOCAL` `MULTI_INSTANCE` |
| Radeon iGPU | 1 | 6,838 MiB | 6,496 MiB | host |
| Radeon iGPU | 2 | 256 MiB | 243 MiB | `DEVICE_LOCAL` `MULTI_INSTANCE` |

**Protocol question (e) has no subject on this card.** The RTX 3060 Laptop exposes exactly ONE
device-local heap (5,994 MiB) — there is **no separate small BAR heap** of the kind the RTX 3090
(246 MiB) and the GTX 1070 Ti (214 MiB) expose, so no allocation can land in one here. The iGPU's
256 MiB device-local heap is an APU carve-out, a different thing; it is sampled anyway.

The probe's 5,994 / 5,226 is exactly heap 0's size / budget — on the two single-heap-plus-BAR cards
measured earlier the probe figure was the SUM of the device-local heaps, so this machine also
records what the probe does when there is only one.

## Models (all three verified against their manifests)

| leg | manifest id | file | bytes | sha256 | vs manifest |
|---|---|---|---|---|---|
| 4 baseline | `gemma4-e2b-it-qat-q4` | `gemma4-e2b-it-qat-q4.gguf` | 3,349,516,256 | `fa401b55…6634` | ✔ |
| 4 partial | `qwen3.5-9b-ud-q4kxl` | `qwen3.5-9b-ud-q4kxl.gguf` | 5,966,095,584 | `6f5d3066…b293` | ✔ |
| extra | `gemma4-e4b-it-qat-q4` | `gemma4-e4b-it-qat-q4.gguf` | 5,154,941,280 | `676c3507…` | ✔ |

None carries `speculative_decoding: mtp`, so **rung 1a never applies on this machine** — the first
rung is always rung 1.

## Reconstructed app argv (rung 1)

```text
llama-server.exe --host 127.0.0.1 --port <n> --model <drive>\models\chat\<file>.gguf
  --ctx-size 8192 --threads 8 --batch-size 2048 --ubatch-size 2048
  --jinja --reasoning-format deepseek -lv 4
```

- `--host/--port/--model/--ctx-size/--threads`: `runtime/sidecar.ts:511` `buildArgs`, emitted at
  `:526/:528/:530/:532/:534`.
- `--ctx-size 8192` = `launchContextTokens` (`services/models.ts:176-183`): the override, else the
  manifest's `recommended_context_tokens` — 8192 for all three models — else the settings default.
- `--threads 8` = `defaultThreadCount()` (`sidecar.ts:90-98`), ⌊16/2⌋ on this CPU.
- `--batch-size/--ubatch-size 2048` = `min(ctx, CHAT_MAX_PHYSICAL_BATCH)` (`runtime/llama.ts:460`,
  constant at `llama.ts:49`), emitted only when a physical batch is requested (`sidecar.ts:513-523`).
- `--jinja --reasoning-format deepseek -lv 4` = `CHAT_SERVER_ARGS` (`runtime/llama.ts:39`), appended
  at `llama.ts:461`.
- Rung 1 adds nothing (`runtime/factory.ts:764`): **no `-ngl`, no `--device`**, and the app never
  passes `--fit-target`, `--fit-ctx` or `-np`, so the binary's own defaults apply (fit on,
  1,024 MiB target, `-np` auto). Rung 1a is skipped (no MTP manifest); rung 2 would be
  `--device none` (`factory.ts:770`).

## §6.6 prediction under test

The card reports **5,994 MiB — 150 MiB below** the 6,144 MiB `discrete` gate, so per §6.6's "The
6 GB row (N8)" this machine is a **RAM machine**: `nextStartMemory` → `cpu`, no budget device, and
the card path never runs. The predicted star is therefore the **RAM pick at 14 GB**, which the app
computes as **`gemma4-e2b-it-qat-q4`** — not the `qwen3.5-9b-ud-q4kxl` the leg-4 line assumes,
because that assumption comes from the 32-GB-RAM grid.

What the starts settle here:

1. Does `--fit` offload onto a card the picker classed away — and **onto which device**, given the
   iGPU is enumerated first and the app passes no `--device` (#320 (j), leg 5)?
2. The E2B fits the card's budget on the formula (need **4,746** ≤ free **5,226**), so a full
   offload is predicted; the 9B does not (need **8,014** > 5,226), so it is the partial-offload
   subject protocol question (f) actually asks about.
3. What the two cost in decode speed, and what the app's own "Your model" row says about them.

## Prior evidence already on record from this machine

The app started the E2B on its own at 11:11 UTC and persisted the placement, before any start of
this session:

- `backend: gpu`, **36/36 layers offloaded** — the fit DID use a card the picker classed away.
- `devices[]` files the 560.07 MiB compute buffer under **Vulkan1**, and `null` under Vulkan0 →
  the work went to the **discrete card**, not the iGPU. Leg 5's question, answered once already.
- `gpuModelMb: 1341.76` vs `cpuModelMb: 2152.5`, `gpuKvMb: 96`.
- `gpuFreeAtStartMb: 8441` — **the iGPU's** free figure. That field is the parser's documented
  "legacy summary field" (`placement.ts:134`: the first `device_info` row) and the snapshot is meant
  to re-attribute it to the SELECTED device (DR2) — but on this machine there IS no selected device,
  so a reader sees the iGPU's 8,441 MiB beside a start that ran on the RTX. `devices[]` carries the
  correct per-device split; only the summary field is misleading here.
- The app's benchmark measured **100 tok/s** on the E2B (`speedBasis: timings`, 64 tokens) while
  recording `speedIdentity.memoryClass: "cpu"` and `deviceName: null` — a GPU-speed sample labelled
  as a processor machine.
