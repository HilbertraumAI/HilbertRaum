### Preflight: `i7-8550u-uhd-620-shared-8gb-laptop-16gb` · no leg detected

Hardware session run on this machine per the protocol above (2026-09-07). Detection first, legs derived from the probe, nothing typed in by hand.

| item | value |
|---|---|
| Runtime | `version: 9849 (799fcc04a)`, built with Clang 20.1.8 for Windows x86_64; runtime manifest b9849 / vulkan / win / x64. The binary **runs** here — Smart App Control is not blocking it, unlike the machine of the PR #308 audit |
| Raw `--list-devices` | `Vulkan0: Intel(R) UHD Graphics 620 (8119 MiB, 7457 MiB free)` — one device, integrated, listed first |
| `vulkaninfo` | one heap: 7.93 GiB size, 7.28 GiB budget, usage 0, `DEVICE_LOCAL`; `PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU`; API 1.3.215; driver `DRIVER_ID_INTEL_PROPRIETARY_WINDOWS` 101.2135 (WMI: 31.0.101.2135). No separate 214 MiB BAR heap on this device, so open question (e) cannot be answered here either. The probe's two numbers are heap 0 exactly: size 8,513,849,344 B = 8,119.1 MiB, `VK_EXT_memory_budget` 7,819,721,421 B = 7,457.4 MiB |
| WMI cross-check | Intel UHD Graphics 620, AdapterRAM 1 GiB — the usual WMI-vs-shared-heap gap; the probe's 8,119 MiB is what the picker sees |
| CPU / RAM / chassis | i7-8550U (4c/8t, Kaby Lake R) · 17,027,698,688 B = 15.86 GiB → 16 GB · ChassisTypes 10 = laptop |
| OS | Windows 11 Pro for Workstations 25H2, build 26200.9168 |
| `nvidia-smi` | not present (no NVIDIA device) |

**Legs detected: none.** One integrated device and no discrete device is the derivation rule's "anything else" case, so no start was made and this comment is the only one from this machine.

**Worth recording: on this card the size gate and the name gate disagree, and the name gate is what saves it.** The probe reports **8,119 MiB**, which clears `USABLE_VRAM_MB` (6,144) and lands squarely inside the protocol's "7–8.5 GB → leg 2" bucket. A size-only derivation would have called this an 8 GB card and run leg 2 against shared system memory. `looksIntegrated` matches on `/uhd/i`, so `isUsefulDevice` is false, there is no budget device, memory class is `cpu` and the RAM pick stands (`shared/gpu-rules.ts:25`, `:37`, `:68`). This is the same shape the #308 audit's finding R6 fixed for the current-generation Intel names — the older `uhd` pattern is doing the same job here on a 2017-era part, and the bias note above it ("a false positive only costs a too-small recommendation") is exactly why 8 GiB of shared memory does not become a card. The §6.6 grid has no row for this class, so there is no card prediction to test.

Expected pick on the RAM path: `qwen3.5-9b-ud-q4kxl` at 16 GB — comfortable stage, `recommended_ram_gb` 16 ≤ 16, rank 3, winning the disk-size tiebreak over the equally ranked 4B (`services/models.ts:906-931`) — unless a stored §6.5 speed step-down applies.

Of the leg models, `qwen3.5-9b-ud-q4kxl.gguf` (5,966,095,584 B, sha256 `6f5d3066…c1b293`) and `qwen3.5-4b-ud-q4kxl.gguf` (2,912,109,728 B, sha256 `b252c561…961bc7`) are on the drive and **both hashes were computed this session and match their manifests**; the 9B's hash is byte-identical to the file the leg-2 and leg-5 machines started, which cross-confirms those runs used the same weights. `gemma4-12b-it-qat-q4` and both `qwen3.8-27b-ud-*` are absent, and the 27Bs exceed this machine's RAM anyway.

**App argv reconstructed from source** (`origin/master` at `740b0f27`) for a rung-1 chat start of the 9B, recorded so a later leg on another machine can reuse it. Line numbers re-verified at this commit. `sidecar.ts` and `factory.ts` both changed between `7af98a45` (which the Iris Xe preflight cited) and `740b0f27`, but no argv-bearing line moved: the constants and the `buildArgs` block are byte-identical at both commits. Two citations in that earlier preflight are a few lines off and are corrected below — `CHAT_MAX_PHYSICAL_BATCH` is `llama.ts:49` and its use `:460` (not `:46` / `:449`), and the fit-margin constant is `models.ts:938` (not `:937`):

```
llama-server.exe --host 127.0.0.1 --port <p> --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf
  --ctx-size 8192 --threads 4 --batch-size 2048 --ubatch-size 2048
  --jinja --reasoning-format deepseek -lv 4
```

- `--host/--port/--model/--ctx-size/--threads`: `runtime/sidecar.ts:511-538` (`buildArgs`); threads = `max(1, floor(cpus().length / 2))` (`sidecar.ts:90-98`), **4** on this 8-logical box.
- `--ctx-size`: `launchContextTokens` = `contextTokensOverride ?? (manifest.recommendedContextTokens || settings.contextTokens)` (`services/models.ts:176-182`, spelled out at `services/chat.ts:1452`); the 9B manifest says `recommended_context_tokens: 8192`.
- `--batch-size/--ubatch-size`: `min(ctx, CHAT_MAX_PHYSICAL_BATCH = 2048)` (`runtime/llama.ts:49`, `:460`), emitted only when a physical batch is requested (`sidecar.ts:516-523`).
- `--jinja --reasoning-format deepseek -lv 4`: `CHAT_SERVER_ARGS` (`runtime/llama.ts:39`), appended at `llama.ts:461`.
- Rung 1 adds nothing — explicitly no `-ngl` / `--device` (`runtime/factory.ts:763-764`). Rung 1a would add `--spec-type draft-mtp --spec-draft-n-max 2` (`MTP_SERVER_ARGS`, `factory.ts:95`, pushed at `:758`) only for a manifest with `speculative_decoding: mtp`; of the leg models only `qwen3.8-27b-ud-q5km` carries it, so neither model here reaches rung 1a. Rung 2 is `--device none` (`factory.ts:770`), the only way the app forces CPU.
- No `--fit-target`, `--fit-ctx`, `-np`, `--parallel`, `-ngl` or `--device` on the chat path (repo-wide grep over `apps/desktop/src`: `--device` appears only in `embeddings/e5.ts:290`, `reranker/llama.ts:196`, `translation/runtime.ts:53`, `vision/runtime.ts:54` and `factory.ts:770`; `--parallel` only in `translation/runtime.ts:38` and `vision/runtime.ts:71`). The 1,024 MiB fit margin is llama.cpp's own `--fit-target` default, mirrored as `VRAM_FIT_MARGIN_MIB` (`services/models.ts:938`) but never passed. Env: `LLAMA_API_KEY` (`sidecar.ts:633`).

One deviation from step 1 of the protocol, flagged for the record: **no mounted drive root on this machine carries `runtime/llama.cpp/win/llama-server.exe`.** A complete AI Kit layout (runtime, models, model-manifests, config, workspace, launcher, portable .exe) is staged in a directory on the system disk instead, and the operator confirmed its use as the drive root for this session. The runtime manifest and the `llama-server` version both match the pin, so the binary under test is the shipped one; but this is a staged copy, not a start from the Kit drive.

Record: `eval/results/hardware/i7-8550u-uhd-620-shared-8gb-laptop-16gb/preflight.json` on branch `hw/318-i7-8550u-uhd-620-shared-8gb-laptop-16gb-20260907`. Legs 1, 4, 6 and 7 still need a machine; legs 2, 3 and 5 are covered by the two desktops above.
