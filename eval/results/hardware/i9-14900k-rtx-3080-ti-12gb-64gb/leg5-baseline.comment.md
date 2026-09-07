### Start: i9-14900k-rtx-3080-ti-12gb-64gb · leg 5 · baseline
1. **File:** `qwen3.5-9b-ud-q4kxl` · `qwen3.5-9b-ud-q4kxl.gguf` · 5,966,095,584 B (5.56 GiB) · sha256 `6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build) · Windows 11 Home 25H2 build 26200.9168 · driver NVIDIA 610.88 (Vulkan 1.4.341); Intel 32.0.101.7082 (Vulkan 1.4.323) · heaps: RTX 3080 Ti heap 0 device-local 11.80 GiB (budget 11.05 GiB), heap 1 host 31.84 GiB; no separate BAR heap · Intel UHD 770 one host-memory heap 31.84 GiB
3. **Argv:** `llama-server --host 127.0.0.1 --port 65303 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4` (source: identical to the leg-3 baseline: `--host/--port/--model/--ctx-size/--threads` sidecar.ts:525-535; ctx 8192 = manifest `recommended_context_tokens` via models.ts:176-181; threads 16 = ⌊32/2⌋ sidecar.ts:90-98; `--batch-size/--ubatch-size 2048` = min(ctx, 2048) llama.ts:460 at sidecar.ts:513-524; `--jinja --reasoning-format deepseek -lv 4` = CHAT_SERVER_ARGS llama.ts:39; rung 1 adds nothing, factory.ts:763-764 — no `-ngl`, no `--device`, no `--fit-target`/`--fit-ctx`/`-np`)
4. **Memory at start:** device_info Vulkan0 RTX 3080 Ti 11,316 / 12,084 MiB · Vulkan1 Intel UHD 770 48,060 / 32,606 MiB (raw order: **discrete first**, integrated second) · nvidia-smi 2743/12288 MiB used/total (9341 free) · desktop: idle as this machine gets — app closed, no browser, VS Code open; nvidia-smi ~2.7 GB desktop use
5. **Fit outcome:** offloaded **33/33** layers to GPU — every layer on **Vulkan0 (the RTX 3080 Ti)**; the iGPU (Vulkan1) received no buffer at all (it appears only in the `device_info` listing; `llama_prepare_model_devices: using device Vulkan0 … 11312 MiB free`) · fit pass: `12084 = 11111 + (6007 = 5133 + 457 + 416) + -5034`, "projected to use 6007 MiB vs. 11111 MiB free, will leave 5104 >= 1024 MiB, no changes needed" (the fit read 11,111 MiB free at that instant, the device line 11,312) · buffers: Vulkan0 model 5,133.63 MiB, CPU_Mapped model 545.62 MiB (token embeddings), Vulkan0 KV 256.00 MiB, Vulkan0 **RS (recurrent state) 201.00 MiB** (4 cells, 32 layers, 4 seqs: R 9 MiB + S 192 MiB), Vulkan0 compute 416.44 MiB, Vulkan_Host compute 96.07 MiB, output 3.79 MiB · no SWA (n_swa 0) · n_parallel auto → 4, kv_unified true, n_slots 4, n_ctx_slot 8192 · **rung 1**
6. **Peak use:** 8788 MiB used (nvidia-smi, 1 s polling; +6045 MiB over the pre-spawn figure; 8726 MiB right after load, 2686 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 82.71 tok/s (`predicted_per_second`, 512 tokens in 6.2 s) · prefill 121.9 tok/s (`prompt_per_second`, 2015 tokens in 16.5 s) · load to /health 18.5 s
8. **Varied:** none (baseline) — this is a desktop with an iGPU, run as leg 5 per the detection rule; it answers the device-order and placement questions but NOT the laptop-power-management part of #320
9. **App view:** starred **`qwen3.5-9b-ud-q4kxl`** = this model ("Empfohlen für den nächsten Start: Qwen3.5 9B (UD-Q4_K_XL) (Grafikspeicher)", current source build 0.1.59 against the drive; the drive's packaged v0.1.57 predates the picker) · memory class **discrete** · budget device **NVIDIA GeForce RTX 3080 Ti, 11.8 GB VRAM** — the picker did NOT take the first-listed device blindly; here the discrete card is also first, so this machine cannot distinguish `selectBudgetDevice` from a devices[0] read (a real Intel-first laptop still has to) · "Your model" estimate for the 9B: formula need 8,014 MiB vs 11,316 free = fits (the 9B was not the selected model in the app during this session, so its row was not rendered)
**Predicted vs measured:** **Holds.** §6.6 stars the 9B on a 12 GB card and predicts a full fit (8,014 MiB need); measured: 33/33 layers on the discrete card, the fit projected 6,007 MiB (5,104 MiB spare), decode 82.7 tok/s. The manifest's 0.4 GiB cache term matches the measured 457 MiB (256 KV + 201 RS) almost exactly; the 15 % working share (≈ 860 MiB on 5,690 MiB of weights) overestimates the measured 416 MiB compute buffer. Leg-5 answers: layers land on the discrete device, the iGPU is never used, and the driver lists the discrete card first on this desktop (Vulkan0), so the Intel-first ordering #332 asks about does not occur here.
<details><summary>Load-log excerpt (redacted, 40 lines)</summary>

```text
# leg5-baseline — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 65303 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
0.00.148.686 I cmn  common_param: device_info:
0.00.151.719 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.167.576 I cmn  common_init_: fitting params to device memory ...
0.00.167.576 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.167.580 I common_params_fit_impl: getting device memory data for initial parameters:
0.00.664.463 I common_params_fit_impl: projected to use 6007 MiB of device memory vs. 11111 MiB of free device memory
0.00.664.469 I common_params_fit_impl: will leave 5104 >= 1024 MiB of free device memory, no changes needed
0.00.664.474 I common_fit_params: successfully fit params to free device memory
0.00.664.480 I common_fit_params: fitting params to free memory took 0.48 seconds
0.00.791.820 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3080 Ti) (0000:01:00.0) - 11312 MiB free
0.00.948.996 I print_info: n_ctx_train           = 262144
0.00.949.007 I print_info: n_swa                 = 0
0.00.949.007 I print_info: is_swa_any            = 0
0.00.949.018 I print_info: n_ctx_orig_yarn       = 262144
0.00.949.029 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.13.890.104 I load_tensors: offloading output layer to GPU
0.13.890.109 I load_tensors: offloading 31 repeating layers to GPU
0.13.890.109 I load_tensors: offloaded 33/33 layers to GPU
0.13.890.112 I load_tensors:   CPU_Mapped model buffer size =   545.62 MiB
0.13.890.114 I load_tensors:      Vulkan0 model buffer size =  5133.63 MiB
0.16.065.860 I llama_context: n_ctx         = 8192
0.16.065.860 I llama_context: n_ctx_seq     = 8192
0.16.065.861 I llama_context: kv_unified    = true
0.16.065.866 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.16.066.261 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.16.066.804 I llama_kv_cache:    Vulkan0 KV buffer size =   256.00 MiB
0.16.225.638 I llama_memory_recurrent:    Vulkan0 RS buffer size =   201.00 MiB
0.16.225.647 I llama_memory_recurrent: size =  201.00 MiB (     4 cells,  32 layers,  4 seqs  0 rs_seq), R (f32):    9.00 MiB, S (f32):  192.00 MiB
0.16.242.678 I sched_reserve:    Vulkan0 compute buffer size =   416.44 MiB
0.16.242.684 I sched_reserve: Vulkan_Host compute buffer size =    96.07 MiB
0.18.447.772 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.18.447.791 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.18.447.795 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.18.447.795 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.18.447.795 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.18.447.871 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.18.494.605 I srv  update_slots: all slots are idle
0.20.143.185 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.42.865.140 I srv  update_slots: all slots are idle
```
</details>
