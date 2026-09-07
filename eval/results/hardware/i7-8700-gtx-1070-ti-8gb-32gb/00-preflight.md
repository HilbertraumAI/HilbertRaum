### Preflight: i7-8700-gtx-1070-ti-8gb-32gb (desktop, single discrete card)

Session 2026-09-07 on a desktop machine (chassis type 3). Legs detected from the probe, not typed in. This is the card the protocol names for leg 2 ("the reviewer's GTX 1070 Ti: 8,273 total / 7,504 free idle").

- **Runtime:** `<drive>\runtime\llama.cpp\win\llama-server.exe` → `version: 9849 (799fcc04a)`, built with Clang 20.1.8 for Windows x86_64. Runs on this machine (no application-control block).
- **Raw `--list-devices` (the app's own probe, desktop carrying VS Code + browser + two chat apps at the time):**
  ```text
  Available devices:
    Vulkan0: NVIDIA GeForce GTX 1070 Ti (8273 MiB, 7504 MiB free)
  ```
  One device, discrete, listed first; no integrated device. The probe's "free" figure is the `VK_EXT_memory_budget` budget, not a driver free count: `vulkaninfo` heap 0 reads size 8,059 MiB (7.87 GiB) / budget 7,291 MiB (7.12 GiB) — the probe prints 8,273 / 7,504 because it sums the two device-local heaps (heap 0 + the 214 MiB heap 2 below: 8,059 + 214 = 8,273; 7,291 + 213 = 7,504) — while `nvidia-smi` at the same moment reported 8,192 MiB total / 1,318 MiB used / 6,742 MiB free.
- **Vulkan heaps (`vulkaninfo`, NVIDIA driver 582.66, Vulkan API 1.4.312):**
  | heap | size | budget | flags |
  |---|---|---|---|
  | 0 | 8,450,473,984 B (7.87 GiB) | 7,645,167,616 B (7.12 GiB) | DEVICE_LOCAL |
  | 1 | 17,149,493,248 B (15.97 GiB) | 16,344,188,928 B (15.22 GiB) | host (none) |
  | 2 | 224,395,264 B (**214.00 MiB**) | 224,264,192 B (213.88 MiB) | DEVICE_LOCAL |
  **This card exposes the separate 214 MiB BAR heap** (no resizable BAR on a GTX 1070 Ti), so protocol question (e) — do Vulkan allocations ever land in it — can be exercised here; each start's log is checked for it.
- **Drivers:** NVIDIA 582.66 (Windows driver store 32.0.15.8266; `vulkaninfo` driverVersion 582.66.0.0, DRIVER_ID_NVIDIA_PROPRIETARY).
- **CPU:** Intel Core i7-8700 (6 cores / 12 logical) → the app's `--threads` default is 6 (`sidecar.ts` `defaultThreadCount`: ⌊cpus/2⌋).
- **RAM:** 34 298 990 592 B = 31,9 GiB → 32 GB.
- **OS:** Windows 11 Pro 25H2, build 26200.9168.
- **Card class:** discrete total 8,273 MiB per the probe (8,192 per `nvidia-smi`) → the 7–8.5 GB band → **leg 2**. No integrated device → no leg 5. Nothing else detected.
- **Models (SHA-256 verified against the manifest):**
  | leg | manifest id | file | bytes | sha256 |
  |---|---|---|---|---|
  | 2 | `qwen3.5-9b-ud-q4kxl` | `qwen3.5-9b-ud-q4kxl.gguf` | 5,966,095,584 (5.56 GiB) | `6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293` ✔ |
  The manifest does not opt into MTP (no `speculative_decoding`), so every start here is rung 1 (no `--spec-*`); it recommends `recommended_context_tokens: 8192` and carries `estimated_context_cache_gib: 0.4`.
- **Reconstructed rung-1 argv** (what the sidecar spawns; both starts use it verbatim):
  ```text
  llama-server --host 127.0.0.1 --port <n> --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 6 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
  ```
  Sources: `--host/--port/--model/--ctx-size/--threads` `sidecar.ts:525-535` (`buildArgs`); `--ctx-size` value from `launchContextTokens` `models.ts:176-181` (override ?? manifest 8192); `--threads` `sidecar.ts:90-98`; `--batch-size/--ubatch-size` `sidecar.ts:513-524` with the value `min(ctx, 2048)` from `llama.ts:460` (`CHAT_MAX_PHYSICAL_BATCH`); `--jinja --reasoning-format deepseek -lv 4` = `CHAT_SERVER_ARGS` `llama.ts:39`; rung 1 adds nothing (`factory.ts:763-764`, no `-ngl`/`--device`). The app never passes `--fit-target`, `--fit-ctx` or `-np`, so the binary's defaults apply (fit on, fit-target 1024 MiB, `-np` auto).
- **§6.6 prediction under test:** star = `qwen3.5-4b-ud-q4kxl` (8 GB row, every RAM column ≥ 16). The 9B's threshold is 8,014 MiB against the probed 7,504 MiB free → predicted NOT to fit fully; `--fit` is expected to trim (fewer layers offloaded, or a smaller context), which is protocol question (a). Leg 2 starts the 9B at 8k twice: on an idle desktop and with ~1 GB of ordinary desktop use.
- **Desktop-use note:** with a browser plus two chat apps and VS Code open, `nvidia-smi` reads 1,318 MiB used — that is the "~1 GB use" condition for this card. The idle baseline is taken with the browser and chat apps closed; `nvidia-smi` before each spawn is recorded in the comment.