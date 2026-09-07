### Preflight: i9-9900x-rtx-3090-24gb-128gb (desktop, single discrete card, Linux) · legs 7 + 1

Session 2026-09-07 on the rig (chassis type 3 = desktop, Linux). Legs detected from the probe, not typed in. This is the "rig" the protocol names for leg 1 and the 24 GB card for leg 7, so both boundaries the recomputed grid newly exposes at 24 GB (Q4 versus Q5) and the leg-1 varied-one-thing starts are measured here.

- **Runtime:** this machine carries no portable drive; the app's data root (`<drive>` below, the directory the dev build uses as its drive root) holds `models/chat/`, but its own `runtime/llama.cpp/linux/llama-server` is **b9585 (d73cd0767)**, not the pinned build. Every start below spawns the pinned Linux Vulkan build instead: `llama-b9849-bin-ubuntu-vulkan-x64.tar.gz`, sha256 `0fb2491604cbc468321bcaaa56991cfbc27fb0ac58b9597fd290a81b86da06d4` = the `runtime-sources.yaml` linux/vulkan entry, extracted locally → `version: 9849 (799fcc04a)`, built with GNU 11.4.0 for Linux x86_64. It links the distro Vulkan loader (libvulkan1 1.3.204); the NVIDIA ICD reports API 1.4.329.
- **Raw `--list-devices` (the app's own probe, b9849, idle desktop):**
  ```text
  Available devices:
    Vulkan0: NVIDIA GeForce RTX 3090 (24822 MiB, 23603 MiB free)
  ```
  One device, discrete, listed first; no integrated device (the only other Vulkan physical device is `llvmpipe`, a CPU-type device the probe does not list). As on the two Windows machines, the probe's figures are the sum of the device-local heaps' size and (budget − usage) from `VK_EXT_memory_budget`: 24,576 + 246 = 24,822 total; 23,408 + (221 − 25) ≈ 23,603 free. `nvidia-smi` at the same moment: 24,576 MiB total / 717 used / 23,344 free.
- **Vulkan heaps (`vulkaninfo`, NVIDIA driver 595.84, Vulkan API 1.4.329):**
  | heap | size | budget | usage (idle) | flags |
  |---|---|---|---|---|
  | 0 | 25,769,803,776 B (24.00 GiB) | 24,544,083,968 B (22.86 GiB; drifts by ±80 MiB between reads) | 0 | DEVICE_LOCAL |
  | 1 | 101,051,142,144 B (94.11 GiB) | same | 0 | host (none) |
  | 2 | 257,949,696 B (**246.00 MiB**) | 231,800,832 B (221.06 MiB) | 24.94 MiB | DEVICE_LOCAL |
  **This card exposes the separate 246 MiB BAR heap** (no resizable BAR active on this board), so protocol question (e): do Vulkan allocations ever land in it: is exercised here: every start samples the three heaps' `usage` via `vulkaninfo` before, after load, every 3 s during the request and after stop (`<stem>.heaps.csv`).
- **Drivers:** NVIDIA 595.84 (`vulkaninfo` driverVersion 595.84.0.0, driverName NVIDIA).
- **CPU:** Intel Core i9-9900X (10 cores / 20 logical) → the app's `--threads` default is 10 (`sidecar.ts` `defaultThreadCount`: ⌊cpus/2⌋).
- **RAM:** 134,734,856,192 B = 125.5 GiB → 128 GB.
- **OS:** Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic, X11 desktop session.
- **Card class:** discrete total 24,822 MiB per the probe (24,576 per `nvidia-smi`) → the 22–24.6 GB band → **leg 7**, plus the **leg 1** varied-one-thing starts (this is the rig). No integrated device → no leg 5. Nothing else detected.
- **Desktop state:** an idle ComfyUI server (a Python process, 256 MiB resident on the card) and the X desktop; `nvidia-smi` reads 717 MiB used before the first spawn. Nothing else touches the card during the session; the ~1 GB desktop-use repeat is not part of legs 1/7.
- **Models (SHA-256 verified against the manifests; sizes equal `size_bytes`):**
  | leg | manifest id | file | bytes | sha256 |
  |---|---|---|---|---|
  | 7 | `qwen3.8-27b-ud-q4km` | `qwen3.8-27b-ud-q4km.gguf` | 16,464,440,224 (15.33 GiB) | `322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482` ✔ |
  | 7 + 1 | `qwen3.8-27b-ud-q5km` | `qwen3.8-27b-ud-q5km.gguf` | 19,771,509,664 (18.41 GiB) | `2de73110cb254cbf09b54b717578dadff12ef1194e7271527e68202f39ba4bfd` ✔ |
  Both manifests opt into MTP (`speculative_decoding: mtp`), recommend `recommended_context_tokens: 8192` and carry `estimated_context_cache_gib: 1.1`; `recommended_ram_gb` 24 / 32, `recommended_min_ram_gb` 21 / 23, both rank 3.
- **Reconstructed argv.** Because both manifests opt into MTP, the app's FIRST rung on this card is **rung 1a** (`factory.ts:754-761`), gated at walk time by `speculativeVerdict` (`factory.ts:569-597`): weights in MiB + `MTP_VRAM_HEADROOM_MB` 3,584 (`factory.ts:111`) must fit ONE device's probed free figure: 15,702 + 3,584 = 19,286 and 18,856 + 3,584 = 22,440 MiB, both ≤ 23,603 → MTP on for both models. Baseline (rung 1a):
  ```text
  llama-server --host 127.0.0.1 --port <n> --model <drive>/models/chat/<file>.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 --spec-type draft-mtp --spec-draft-n-max 2
  ```
  Sources: `--host/--port/--model/--ctx-size/--threads` `sidecar.ts:511-538` (`buildArgs`); `--ctx-size` value from `launchContextTokens` `models.ts:176-183` (override ?? manifest 8192); `--threads` `sidecar.ts:90-98`; `--batch-size/--ubatch-size` `sidecar.ts:516-524` with the value `min(ctx, 2048)` from `llama.ts:460` (`CHAT_MAX_PHYSICAL_BATCH` `llama.ts:49`); `--jinja --reasoning-format deepseek -lv 4` = `CHAT_SERVER_ARGS` `llama.ts:39`, placed before the rung's extra args by `llama.ts:461`; `--spec-type draft-mtp --spec-draft-n-max 2` = `MTP_SERVER_ARGS` `factory.ts:95` (rung 1a); rung 1 (`factory.ts:764`) adds nothing. The app never passes `-ngl`, `--device`, `--fit-target`, `--fit-ctx` or `-np`, so the binary's defaults apply (fit on, fit-target 1024 MiB, `-np` auto).
- **Starts planned (six):** leg 7 baseline Q4; leg 7 baseline Q5 (this start is also the leg-1 baseline: same model, same argv); leg 1 varied one thing each from that baseline: `--ubatch-size` 2048 → 512 (`--batch-size` stays 2048), `-np` auto → 1, `--fit-target` 1024 → 512, MTP on → off (= plain rung 1).
- **§6.6 prediction under test:** the 24 GB row stars Q4 at every RAM column ≥ 24 (grid convention `freeMb` 23,552). On this probe's real figure, 23,603 MiB free, the 27B Q5's threshold (23,866) is missed by 263 MiB while Q4's (20,247) clears by 3,356, so rule C should demote the RAM pick (Q5 at 128 GB: rank 3, 32 GB tier) to **`qwen3.8-27b-ud-q4km`**. What the starts settle: whether Q5 at 8k nevertheless fully offloads under the app's launch (with and without MTP), i.e. whether the Q4-versus-Q5 boundary the original decision sheet put at 24 GB holds on a real 24 GB card, and whether the "Your model" estimate for both is right.
