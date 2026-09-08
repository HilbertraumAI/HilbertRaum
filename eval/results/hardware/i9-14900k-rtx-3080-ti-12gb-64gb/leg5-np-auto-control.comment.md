### Start: i9-14900k-rtx-3080-ti-12gb-64gb · leg 5 · np-auto-control
1. **File:** `qwen3.5-9b-ud-q4kxl` · `qwen3.5-9b-ud-q4kxl.gguf` · 5,966,095,584 B (5.56 GiB) · sha256 `6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build) · Windows 11 Home 10.0.26200 · driver NVIDIA 32.0.16.1088; Intel 32.0.101.7082 · heaps: RTX 3080 Ti heap 0 device-local 11.80 GiB; no separate BAR heap · Intel UHD 770 one host-memory heap
3. **Argv:** `llama-server --host 127.0.0.1 --port 64748 --model <drive>/models/chat/qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1 -np 4` (source: the shipped argv with `--extra "-np 4"` appended, so the command line carries `-np 1 -np 4` and llama.cpp takes the LAST — confirmed in the log (`n_slots = 4`). Everything else identical to `leg5-np1-verify`, run minutes later in the same session.)
4. **Memory at start:** device_info Vulkan0 RTX 3080 Ti 11,316 / 12,084 MiB · Vulkan1 Intel UHD 770 48,060 / 32,606 MiB (raw order: discrete first, integrated second — unchanged) · nvidia-smi 2645/12288 MiB used/total (9440 free) · desktop: idle, same session as `leg5-np1-verify` — the weight file is in the OS page cache (load 5.2 s against that run's 17.5 s), which is the whole point of this control
5. **Fit outcome:** offloaded **33/33** layers to GPU · buffers: Vulkan0 KV **256.00 MiB**, Vulkan0 **RS 201.00 MiB** (4 cells, 32 layers, **4 seqs**, 0 rs_seq) — i.e. the four-slot recurrent state the baseline had · **n_seq_max 4, kv_unified false, n_slots 4, n_ctx_slot 2048**
6. **Peak use:** 8702 MiB used (nvidia-smi, 1 s polling; +6057 MiB over the pre-spawn figure; 8637 MiB right after load, 2639 MiB after stop) during 2015-token prefill / 33-token decode
7. **Speed:** decode 103.09 tok/s (`predicted_per_second`, 33 tokens in 0.3 s) · prefill 2833.6 tok/s (`prompt_per_second`, 2015 tokens in 0.7 s) · load to /health 5.2 s
8. **Varied:** `-np 4` instead of the shipped `-np 1`, run WARM so the speed comparison isolates the slot count instead of the page cache
9. **App view:** not read — argv reconstruction, app closed.
**Predicted vs measured:** **Two findings.** (1) **Speed: no effect.** Warm, four slots decoded 103.09 tok/s and prefilled 2,834; warm, one slot decoded 99.89 and prefilled 2,318. The +21 % that `leg5-np1-verify` appeared to show against the COLD baseline was page-cache warmth, not `-np`. This reproduces the #182 finding (no throughput effect at ctx 8192) on a second machine and model, and confirms that #319's case for `-np 1` rests entirely on the 150.75 MiB of card memory it returns — not on speed. Caveat: the control's decode sample is 33 tokens (it hit a stop) against the other run's 512, so treat 103.09 as indicative; both sit at ≈ 100 tok/s. (2) **An explicit `-np 4` is NOT what the app used to do, and is worse.** Passing no `-np` at all gave `kv_unified = true` with `n_ctx_slot = 8192` — four sequences sharing one 8,192-cell cache. Passing `-np 4` explicitly gives `kv_unified = false` and **`n_ctx_slot = 2048`**: the context is SPLIT four ways. So the pre-#319 default was the benign form of four slots, and this control's slot count is not a like-for-like re-creation of it. It does not affect the memory figures compared here (KV 256.00 and RS 201.00 match the baseline exactly), and it is a useful reminder for anyone tempted to pass a slot count explicitly.
<details><summary>Load-log excerpt (redacted, 39 lines)</summary>

```text
# leg5-np-auto-control — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 64748 --model <drive>/models/chat/qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 16 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1 -np 4
0.00.720.282 I cmn  common_param: device_info:
0.00.756.441 I cmn  common_init_: fitting params to device memory ...
0.00.756.442 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.756.446 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.190.032 I common_params_fit_impl: projected to use 5983 MiB of device memory vs. 11111 MiB of free device memory
0.01.190.036 I common_params_fit_impl: will leave 5128 >= 1024 MiB of free device memory, no changes needed
0.01.190.041 I common_fit_params: successfully fit params to free device memory
0.01.190.046 I common_fit_params: fitting params to free memory took 0.40 seconds
0.01.308.033 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3080 Ti) (0000:01:00.0) - 11312 MiB free
0.01.433.674 I print_info: n_ctx_train           = 262144
0.01.433.684 I print_info: n_swa                 = 0
0.01.433.684 I print_info: is_swa_any            = 0
0.01.433.696 I print_info: n_ctx_orig_yarn       = 262144
0.01.433.707 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.01.779.580 I load_tensors: offloading output layer to GPU
0.01.779.584 I load_tensors: offloading 31 repeating layers to GPU
0.01.779.585 I load_tensors: offloaded 33/33 layers to GPU
0.01.779.588 I load_tensors:   CPU_Mapped model buffer size =   545.62 MiB
0.01.779.588 I load_tensors:      Vulkan0 model buffer size =  5133.63 MiB
0.03.783.195 I llama_context: n_ctx         = 8192
0.03.783.195 I llama_context: n_ctx_seq     = 2048
0.03.783.197 I llama_context: kv_unified    = false
0.03.783.201 I llama_context: n_ctx_seq (2048) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.03.783.993 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.03.784.875 I llama_kv_cache:    Vulkan0 KV buffer size =   256.00 MiB
0.03.941.632 I llama_memory_recurrent:    Vulkan0 RS buffer size =   201.00 MiB
0.03.941.640 I llama_memory_recurrent: size =  201.00 MiB (     4 cells,  32 layers,  4 seqs  0 rs_seq), R (f32):    9.00 MiB, S (f32):  192.00 MiB
0.03.958.334 I sched_reserve:    Vulkan0 compute buffer size =   392.44 MiB
0.03.958.342 I sched_reserve: Vulkan_Host compute buffer size =    72.07 MiB
0.04.267.028 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 2048, kv_unified = 'false'
0.04.267.076 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 2048
0.04.267.091 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 2048
0.04.267.104 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 2048
0.04.267.116 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 2048
0.04.267.216 I srv          init: idle slots will be saved to prompt cache upon starting a new task
0.04.294.653 I srv  update_slots: all slots are idle
0.06.456.766 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 2048, n_keep = 0, task.n_tokens = 2015
0.07.488.059 I srv  update_slots: all slots are idle
```
</details>
