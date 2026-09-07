### Start: i7-8700-gtx-1070-ti-8gb-32gb · leg 2 · baseline
1. **File:** `qwen3.5-9b-ud-q4kxl` · `qwen3.5-9b-ud-q4kxl.gguf` · 5,966,095,584 B (5.56 GiB) · sha256 `6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build) · Windows 11 Pro 25H2 build 26200.9168 · driver NVIDIA 582.66 (Vulkan 1.4.312) · heaps: GTX 1070 Ti heap 0 device-local 7.87 GiB (budget 7.12 GiB = 7,291 MiB), heap 1 host 15.97 GiB, heap 2 device-local **214.00 MiB BAR heap** (budget 213.88 MiB) — the probe's 8,273 / 7,504 is heap 0 + heap 2
3. **Argv:** `llama-server --host 127.0.0.1 --port 52804 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 6 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4` (source: `--host/--port/--model/--ctx-size/--threads` sidecar.ts:525-535 `buildArgs`; ctx 8192 = manifest `recommended_context_tokens` via models.ts:176-181; threads 6 = ⌊12/2⌋ sidecar.ts:90-98; `--batch-size/--ubatch-size 2048` = min(ctx, CHAT_MAX_PHYSICAL_BATCH) llama.ts:460 emitted at sidecar.ts:513-524; `--jinja --reasoning-format deepseek -lv 4` = CHAT_SERVER_ARGS llama.ts:39; rung 1 adds nothing, factory.ts:763-764 — no `-ngl`, no `--device`, no `--fit-target`/`--fit-ctx`/`-np` (binary defaults: fit on, 1024 MiB target, `-np` auto → 4))
4. **Memory at start:** device_info Vulkan0 7,504 / 8,273 MiB (idle probe; while the model was loaded a second `--list-devices` read 6,831 free — the budget figure moved by only 673 MiB while nvidia-smi showed +5,760 MiB) · nvidia-smi 883/8192 MiB used/total (7177 free) · desktop: idle as this machine gets — browser and chat apps closed, VS Code (driving the session) open; nvidia-smi 883 MiB used before the spawn
5. **Fit outcome:** offloaded **31/33** layers to GPU (Vulkan0) — **PARTIAL** · fit pass: `8273 = 6898 + (6007 = 5133 + 457 + 416) + -4632`, "projected to use 6007 MiB of device memory vs. 6898 MiB of free device memory", "**cannot meet free memory target of 1024 MiB, need to reduce device memory by 133 MiB**", "context size set by user to 8192 -> no change", then "filling dense layers back-to-front": 33 layers → 6007 MiB, 32 → 5885, 31 → 5742 → "Vulkan0: 31 layers, 5742 MiB used, 1155 MiB free" · buffers: Vulkan0 model 4,854.94 MiB, CPU_Mapped model 824.31 MiB (2 layers + token embeddings), Vulkan0 KV 256.00 MiB (8,192 cells, 4 unified slots), recurrent state Vulkan0 RS 184.25 MiB + CPU RS 16.75 MiB (201 MiB, 4 cells × 32 layers × 4 seqs), Vulkan0 compute 447.38 MiB, Vulkan_Host compute 128.44 MiB, Vulkan_Host output 3.79 MiB · warnings: "layer 0 is assigned to device CPU but the fused Gated Delta Net tensor is assigned to device Vulkan0", "fused Gated Delta Net (chunked) not supported, set to disabled" (partial-offload consequences) · n_parallel auto → 4, kv_unified true, n_slots 4, n_ctx_slot 8192, flash_attn auto → enabled · **rung 1** (default args, GPU auto-offload): the fit landed a partial offload silently, the ladder saw a healthy start. NOTE the fit's own free reading at decision time was **6,898 MiB, 606 MiB below the probe's idle 7,504** (its zero-layer pass read 7,501); on the probe figure 33/33 would have cleared the target (6,007 + 1,024 = 7,031 < 7,504). **BAR heap (question e): yes** — heap 2 budget fell 213.88 → 29.25 MiB at load (the 184.25 MiB RS buffer landed there) and → 2.25 MiB during the request (211.75 MiB used), while heap 0 budget moved only 7,291 → 6,987 MiB
6. **Peak use:** 6691 MiB used (nvidia-smi, 1 s polling; +5808 MiB over the pre-spawn figure; 6643 MiB right after load, 879 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 20.25 tok/s (`predicted_per_second`, 512 tokens in 25.3 s) · prefill 120.5 tok/s (`prompt_per_second`, 2015 tokens in 16.7 s) · load to /health 7.8 s
8. **Varied:** none (baseline). Attempt 1 of this start (same argv, same 31/33 fit, log kept as `leg2-baseline-attempt1`) was aborted by my runner: the first POST after a 200 `/health` got ECONNRESET (Norton Firewall runs on this machine), the runner exited, and the orphaned server then sat at 6,637 MiB for 4.7 min, drew a Windows Error Reporting `RADAR_PRE_LEAK_64` event, and ended on its own with nothing further in its log. The runner now closes every connection, retries on a reset, and always kills its child; attempt 2 saw no reset
9. **App view:** starred **`qwen3.5-4b-ud-q4kxl`** ("Empfohlen für den nächsten Start: Qwen3.5 4B (UD-Q4_K_XL) (Grafikspeicher)"; also "Empfohlen zum Zeitpunkt der Prüfung: Qwen3.5 4B") · memory class **discrete**, basis graphics memory · budget device **NVIDIA GeForce GTX 1070 Ti, 8,1 GB VRAM**, tile "Nutzbar" (probe total 8,273 MiB) · profile PRO, 31.9 GB RAM, report context 4,096 · the app started **Gemma 4 12B** on its own at launch (the drive's last-used model) and its check measured **8.5 tok/s over 64 tokens**; its "Dein Modell" row for that start reads: "Belegt 9,3 GB mit diesem Kontext. **32 von 49 Schichten auf der GPU, etwa 3,5 GB laufen aus dem RAM.** Die Karte war frei (7,3 von 8,1 GB), aber die Laufzeit reserviert zusätzlich 0,5 GB Arbeitspuffer und 1 GB Sicherheitsreserve und verschiebt ganze Schichten von der Karte, wenn die Summe knapp wird. Antworten langsamer." — so the placement parser read a REAL partial-offload load log on the pinned build and got it right (#329's question). No "Your model" estimate exists for the 9B on this machine since the app never ran it; the picker formula puts it at 8,014 MiB vs 7,504 free = does not fit, hence the 4B star. App = source build 0.1.59 (`npm run dev`, `HILBERTRAUM_DRIVE_ROOT` at the drive; the drive's packaged v0.1.57 has no Performance tab); the pasted reports are saved beside the JSON
**Predicted vs measured:** **Holds.** §6.6 predicts the 9B does NOT fit an 8 GB card (need 8,014 MiB vs 7,504 free) and stars the 4B; measured: llama.cpp's fit could not keep its 1,024 MiB target and offloaded 31/33 layers — a partial offload decoding at 20.2 tok/s, so protocol question (a) is answered no (with ~0.9 GB of desktop use). The margin is thin: the fit fell only 133 MiB short on its own free reading (6,898 MiB), and its actual requirement (6,007 + 1,024 = 7,031 MiB) is ≈980 MiB below the picker's 8,014 estimate (the 15 % working share assumes 858 MiB, measured compute is 416–447 MiB; the 0.4 GiB cache term is right on: KV 256 + RS 184 = 440 MiB). Both agree on the verdict; the picker would be wrong only on a card whose fit reads ≥ 7,031 MiB free — i.e. the probe's idle 7,504 minus ≤ 473 MiB of driver/desktop use — which this desktop did not meet. Question (e): the 214 MiB BAR heap IS used (RS buffer at load, staging during the request, 2 MiB left at peak).
<details><summary>Load-log excerpt (redacted, 57 lines)</summary>

```text
# leg2-baseline — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 52804 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 6 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
0.00.163.006 I cmn  common_param: device_info:
0.00.165.102 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.170.549 I cmn  common_init_: fitting params to device memory ...
0.00.170.550 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.170.557 I common_params_fit_impl: getting device memory data for initial parameters:
0.00.874.514 I common_params_fit_impl: projected to use 6007 MiB of device memory vs. 6898 MiB of free device memory
0.00.874.527 I common_params_fit_impl: cannot meet free memory target of 1024 MiB, need to reduce device memory by 133 MiB
0.00.874.528 I common_params_fit_impl: context size set by user to 8192 -> no change
0.00.874.529 I common_params_fit_impl: id=0, target=5874 MiB
0.01.516.730 I common_params_fit_impl: memory for test allocation by device:
0.01.516.739 I common_params_fit_impl: id=0, n_layer= 0, n_part= 0, overflow_type=4, mem=   498 MiB
0.01.516.749 I common_params_fit_impl: filling dense layers back-to-front:
0.02.169.007 I common_params_fit_impl: memory for test allocation by device:
0.02.169.015 I common_params_fit_impl: id=0, n_layer=33, n_part= 0, overflow_type=4, mem=  6007 MiB
0.02.169.018 I common_params_fit_impl: start filling device 0, delta=33
0.02.875.099 I common_params_fit_impl: memory for test allocation by device:
0.02.875.106 I common_params_fit_impl: id=0, n_layer=32, n_part= 0, overflow_type=4, mem=  5885 MiB
0.02.875.109 I common_params_fit_impl: set ngl_per_device_high[0].n_layer=32
0.03.543.502 I common_params_fit_impl: memory for test allocation by device:
0.03.543.510 I common_params_fit_impl: id=0, n_layer=31, n_part= 0, overflow_type=4, mem=  5742 MiB
0.03.543.513 I common_params_fit_impl: set ngl_per_device[0].n_layer=31
0.03.543.514 I common_params_fit_impl:   - Vulkan0 (NVIDIA GeForce GTX 1070 Ti): 31 layers,   5742 MiB used,   1155 MiB free
0.03.543.523 I common_fit_params: successfully fit params to free device memory
0.03.543.528 I common_fit_params: fitting params to free memory took 0.66 seconds
0.03.755.375 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce GTX 1070 Ti) (0000:01:00.0) - 7501 MiB free
0.04.015.240 I print_info: n_ctx_train           = 262144
0.04.015.254 I print_info: n_swa                 = 0
0.04.015.255 I print_info: is_swa_any            = 0
0.04.015.274 I print_info: n_ctx_orig_yarn       = 262144
0.04.015.289 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.04.493.704 I load_tensors: offloading output layer to GPU
0.04.493.712 I load_tensors: offloading 30 repeating layers to GPU
0.04.493.712 I load_tensors: offloaded 31/33 layers to GPU
0.04.493.715 I load_tensors:   CPU_Mapped model buffer size =   824.31 MiB
0.04.493.716 I load_tensors:      Vulkan0 model buffer size =  4854.94 MiB
0.07.225.600 I llama_context: n_ctx         = 8192
0.07.225.600 I llama_context: n_ctx_seq     = 8192
0.07.225.602 I llama_context: kv_unified    = true
0.07.225.607 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.07.226.099 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.07.228.995 I llama_kv_cache:    Vulkan0 KV buffer size =   256.00 MiB
0.07.246.695 I llama_memory_recurrent:        CPU RS buffer size =    16.75 MiB
0.07.306.737 I llama_memory_recurrent:    Vulkan0 RS buffer size =   184.25 MiB
0.07.306.751 I llama_memory_recurrent: size =  201.00 MiB (     4 cells,  32 layers,  4 seqs  0 rs_seq), R (f32):    9.00 MiB, S (f32):  192.00 MiB
0.07.322.710 W sched_reserve: layer 0 is assigned to device CPU but the fused Gated Delta Net tensor is assigned to device Vulkan0 (usually due to missing support)
0.07.344.836 I sched_reserve:    Vulkan0 compute buffer size =   447.38 MiB
0.07.344.846 I sched_reserve: Vulkan_Host compute buffer size =   128.44 MiB
0.07.616.079 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.07.616.100 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.07.616.104 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.07.616.105 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.07.616.105 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.07.616.261 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.07.693.018 I srv  update_slots: all slots are idle
0.09.626.268 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.51.644.710 I srv  update_slots: all slots are idle
```
</details>
