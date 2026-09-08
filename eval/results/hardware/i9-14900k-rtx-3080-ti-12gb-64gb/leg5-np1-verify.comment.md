### Start: i9-14900k-rtx-3080-ti-12gb-64gb · leg 5 · np1-verify
1. **File:** `qwen3.5-9b-ud-q4kxl` · `qwen3.5-9b-ud-q4kxl.gguf` · 5,966,095,584 B (5.56 GiB) · sha256 `6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build) · Windows 11 Home 10.0.26200 · driver NVIDIA 32.0.16.1088; Intel 32.0.101.7082 · heaps: RTX 3080 Ti heap 0 device-local 11.80 GiB; no separate BAR heap · Intel UHD 770 one host-memory heap
3. **Argv:** `llama-server --host 127.0.0.1 --port 53379 --model <drive>/models/chat/qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1` (source: the app's argv AFTER PR #386 — identical to the leg-5 baseline except `-np 1`, which is now part of `CHAT_SERVER_ARGS` (llama.ts:39) rather than a variant. `--host/--port/--model/--ctx-size/--threads` sidecar.ts:525-535; ctx 8192 = manifest `recommended_context_tokens`; threads 16 = ⌊32/2⌋; `--batch-size/--ubatch-size 2048` = min(ctx, 2048); rung 1 adds nothing — no `-ngl`, no `--device`, no `--fit-target`)
4. **Memory at start:** device_info Vulkan0 RTX 3080 Ti 11,316 / 12,084 MiB · Vulkan1 Intel UHD 770 48,060 / 32,606 MiB (raw order: discrete first, integrated second — unchanged) · nvidia-smi 2699/12288 MiB used/total (9386 free) · desktop: idle as this machine gets — app closed, no browser, VS Code open; nvidia-smi 2,699 MiB desktop use before the start (baseline run: 2,743)
5. **Fit outcome:** offloaded **33/33** layers to GPU, every buffer on Vulkan0 · fit pass: "projected to use **5856** MiB of device memory vs. 11262 MiB of free device memory", "will leave 5406 >= 1024 MiB, no changes needed" (baseline: 6,007 projected) · buffers: Vulkan0 model 5,133.63 MiB, CPU_Mapped model 545.62 MiB, Vulkan0 KV **256.00 MiB**, Vulkan0 **RS 50.25 MiB** (1 cell, 32 layers, **1 seq**, 0 rs_seq: R 2.25 + S 48.00), Vulkan0 compute 416.16 MiB, Vulkan_Host compute 96.07 MiB · **n_seq_max 1, kv_unified false, n_slots 1, n_ctx_slot 8192** · rung 1
6. **Peak use:** 8671 MiB used (nvidia-smi, 1 s polling; +5972 MiB over the pre-spawn figure; 8609 MiB right after load, 2720 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 99.89 tok/s (`predicted_per_second`, 512 tokens in 5.1 s) · prefill 2318.4 tok/s (`prompt_per_second`, 2015 tokens in 0.9 s) · load to /health 17.5 s
8. **Varied:** `-np 1` — but as the app's OWN argv since PR #386, not as a protocol variant. This is the leg-5 baseline re-run on the shipped configuration, one argument different, same machine, same model, same context, same idle state.
9. **App view:** not read for this start — the run reconstructs the sidecar argv directly (the app was closed, as the baseline's desktop note requires). The picker figures it would use are stated under predicted-vs-measured.
**Predicted vs measured:** **Holds, to within 1 MiB.** PR #386 recomputed the seven cache terms for ONE slot on the rule that the KV cache is sized in CELLS from `--ctx-size` and counted once, while only the RECURRENT state is per-sequence. Measured here against the leg-5 baseline, same machine and model: **KV 256.00 → 256.00 MiB, unchanged** ✔; **recurrent state 201.00 → 50.25 MiB**, which is 201.00 / 4 exactly ✔; **n_ctx_slot 8192 either way**, so the conversation window is untouched ✔. Cache total 457.00 → 306.25 MiB against the manifest's new `estimated_context_cache_gib: 0.3` = 307.2 MiB — **0.95 MiB out**. The fit's own projection fell 6,007 → 5,856 MiB, a 151 MiB saving that matches the 150.75 MiB the recurrent state gave back. **NOT a speed result — read the control.** This start decoded 99.89 tok/s against the leg-5 baseline's 82.71, which looks like a +21 % win and is not one: the baseline was a COLD read of the weight file (load 18.5 s, prefill 121.9 tok/s) while this one was warm (load 17.5 s, prefill 2,318). The same-session warm control at four slots (`leg5-np-auto-control`) decoded **103.09 tok/s** — if anything faster than one slot, and well inside noise. So `-np 1` shows **no throughput effect** on this machine, exactly as the #182 note found on the rig; its whole value is the 150.75 MiB of card memory, which is what #319 adopted it for. One residue for §5 item 22 (e): the app's fit estimate for this model reads **7,830 MiB against a measured card need of 5,856** — still 1.34× conservative, and the dominant term is the base weights charging the card for the 545.62 MiB that stays `CPU_Mapped`, not the working share.
<details><summary>Load-log excerpt (redacted, 36 lines)</summary>

```text
# leg5-np1-verify — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 53379 --model <drive>/models/chat/qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1
0.00.158.144 I cmn  common_param: device_info:
0.00.167.571 I cmn  common_init_: fitting params to device memory ...
0.00.167.571 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.167.574 I common_params_fit_impl: getting device memory data for initial parameters:
0.00.617.284 I common_params_fit_impl: projected to use 5856 MiB of device memory vs. 11262 MiB of free device memory
0.00.617.288 I common_params_fit_impl: will leave 5406 >= 1024 MiB of free device memory, no changes needed
0.00.617.294 I common_fit_params: successfully fit params to free device memory
0.00.617.299 I common_fit_params: fitting params to free memory took 0.44 seconds
0.00.734.553 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3080 Ti) (0000:01:00.0) - 11312 MiB free
0.00.866.371 I print_info: n_ctx_train           = 262144
0.00.866.381 I print_info: n_swa                 = 0
0.00.866.381 I print_info: is_swa_any            = 0
0.00.866.392 I print_info: n_ctx_orig_yarn       = 262144
0.00.866.402 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.13.993.889 I load_tensors: offloading output layer to GPU
0.13.993.894 I load_tensors: offloading 31 repeating layers to GPU
0.13.993.894 I load_tensors: offloaded 33/33 layers to GPU
0.13.993.897 I load_tensors:   CPU_Mapped model buffer size =   545.62 MiB
0.13.993.897 I load_tensors:      Vulkan0 model buffer size =  5133.63 MiB
0.16.760.453 I llama_context: n_ctx         = 8192
0.16.760.453 I llama_context: n_ctx_seq     = 8192
0.16.760.456 I llama_context: kv_unified    = false
0.16.760.461 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.16.760.818 I llama_context: Vulkan_Host  output buffer size =     0.95 MiB
0.16.761.396 I llama_kv_cache:    Vulkan0 KV buffer size =   256.00 MiB
0.16.900.636 I llama_memory_recurrent:    Vulkan0 RS buffer size =    50.25 MiB
0.16.900.645 I llama_memory_recurrent: size =   50.25 MiB (     1 cells,  32 layers,  1 seqs  0 rs_seq), R (f32):    2.25 MiB, S (f32):   48.00 MiB
0.16.927.203 I sched_reserve:    Vulkan0 compute buffer size =   416.16 MiB
0.16.927.212 I sched_reserve: Vulkan_Host compute buffer size =    96.07 MiB
0.17.299.568 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 8192, kv_unified = 'false'
0.17.299.586 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.17.299.709 I srv          init: idle slots will be saved to prompt cache upon starting a new task
0.17.332.844 I srv  update_slots: all slots are idle
0.19.114.223 I slot   operator(): id  0 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.25.108.898 I srv  update_slots: all slots are idle
```
</details>
