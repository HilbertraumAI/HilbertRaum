### Preflight: i9-14900k-rtx-3080-ti-12gb-64gb (desktop, hybrid iGPU + discrete)

Session 2026-09-07 on a desktop machine (chassis type 3), the first hardware session for this issue. Legs detected from the probe, not typed in.

- **Runtime:** `<drive>\runtime\llama.cpp\win\llama-server.exe` → `version: 9849 (799fcc04a)`, built with Clang 20.1.8 for Windows x86_64. Runs on this machine (no application-control block).
- **Raw `--list-devices` (the app's own probe, desktop carrying VS Code + ordinary use):**
  ```text
  Available devices:
    Vulkan0: NVIDIA GeForce RTX 3080 Ti (12084 MiB, 11316 MiB free)
    Vulkan1: Intel(R) UHD Graphics 770 (32606 MiB, 48060 MiB free)
  ```
  The discrete card is listed FIRST; the iGPU second. The probe's "free" figure is the `VK_EXT_memory_budget` budget, not a driver free count: `vulkaninfo` heap 0 on the 3080 Ti reads size 12,084 MiB (11.80 GiB) / budget 11,316 MiB (11.05 GiB) while `nvidia-smi` at the same moment reported 12,288 MiB total / 2,556 MiB used / 9,529 MiB free. The iGPU's "48,060 MiB free" exceeds its own 32,606 MiB total (shared host memory; budget > size).
- **Vulkan heaps (`vulkaninfo`):** RTX 3080 Ti — heap 0 device-local 11.80 GiB (budget 11.05 GiB), heap 1 host 31.84 GiB (budget 46.93 GiB). **No separate 214 MiB BAR heap on this card** (resizable BAR exposes the whole 12 GB as one device-local heap), so protocol question (e) cannot be exercised here. Intel UHD 770 — one device-local heap 31.84 GiB (host memory).
- **Drivers:** NVIDIA 610.88 (Windows driver store 32.0.16.1088, Vulkan 1.4.341); Intel 32.0.101.7082 (Vulkan 1.4.323).
- **CPU:** Intel Core i9-14900K, 32 logical processors → the app's `--threads` default is 16 (`sidecar.ts` `defaultThreadCount`: ⌊cpus/2⌋).
- **RAM:** 68,379,852,800 B = 63.7 GiB → 64 GB.
- **OS:** Windows 11 Home 25H2, build 26200.9168.
- **Card class:** discrete total 12,084 MiB per the probe (12,288 per `nvidia-smi`) → the 9.5–12.5 GB band → **leg 3**. Integrated + discrete both present → **leg 5** as well (this is a desktop with an iGPU, not the hybrid laptop the leg was written for; the device-order question is still answerable: discrete first here).
- **Models (verified SHA-256 against the manifests):**
  | leg | manifest id | file | bytes | sha256 |
  |---|---|---|---|---|
  | 3 | `gemma4-12b-it-qat-q4` | `gemma4-12b-it-qat-q4.gguf` | 6,975,879,296 (6.50 GiB) | `93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b` ✔ |
  | 5 | `qwen3.5-9b-ud-q4kxl` | `qwen3.5-9b-ud-q4kxl.gguf` | 5,966,095,584 (5.56 GiB) | `6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293` ✔ |
  Neither manifest opts into MTP (no `speculative_decoding`), so every start here is rung 1 (no `--spec-*`); both recommend `recommended_context_tokens: 8192`.
- **Reconstructed rung-1 argv** (what the sidecar spawns; every start below uses it verbatim, plus the one varied flag where noted):
  ```text
  llama-server --host 127.0.0.1 --port <n> --model <drive>\models\chat\<file>.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
  ```
  Sources: `--host/--port/--model/--ctx-size/--threads` `sidecar.ts:525-535` (`buildArgs`); `--ctx-size` value from `launchContextTokens` `models.ts:176-181` (override ?? manifest 8192); `--threads` `sidecar.ts:90-98`; `--batch-size/--ubatch-size` `sidecar.ts:513-524` with the value `min(ctx, 2048)` from `llama.ts:460`; `--jinja --reasoning-format deepseek -lv 4` = `CHAT_SERVER_ARGS` `llama.ts:39`; rung 1 adds nothing (`factory.ts:763-764`, no `-ngl`/`--device`). The app never passes `--fit-target`, `--fit-ctx` or `-np`, so the binary's defaults apply (fit on, fit-target 1024 MiB, `-np` auto).
- **§6.6 prediction under test:** star = `qwen3.5-9b-ud-q4kxl` (12 GB row, RAM ≥ 16). Gemma 12B's threshold is 11,159 MiB against the probed 11,316 MiB free → predicted to fit fully with 157 MiB to spare (leg 3 tests exactly that margin); the 9B (8,014 MiB) is predicted to fit comfortably (leg 5).
- **Desktop-use note:** the machine's "idle" baseline still carries the VS Code session that drives this run; `nvidia-smi` before each start is recorded in the comment, and the "~1 GB use" repeat of leg 3 adds a browser on top.
