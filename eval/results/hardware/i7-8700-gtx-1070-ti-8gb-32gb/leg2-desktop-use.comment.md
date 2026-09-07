### Start: i7-8700-gtx-1070-ti-8gb-32gb · leg 2 · desktop-use
1. **File:** `qwen3.5-9b-ud-q4kxl` · `qwen3.5-9b-ud-q4kxl.gguf` · 5,966,095,584 B (5.56 GiB) · sha256 `6f5d30666c2d8ae16a306e616d95341dcf3cc46810df84d7e6f5a7d1e4c1b293`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Windows build) · Windows 11 Pro 25H2 build 26200.9168 · driver NVIDIA 582.66 (Vulkan 1.4.312) · heaps: GTX 1070 Ti heap 0 device-local 7.87 GiB, budget 7,291 MiB — read AGAIN with the browser and chat apps open: identical to the idle reading, the budget does not move · heap 2 = the 214 MiB BAR heap (budget 213.88 MiB)
3. **Argv:** `llama-server --host 127.0.0.1 --port 59024 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 6 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4` (source: identical to the leg-2 baseline (sidecar.ts:525-535, models.ts:176-181, sidecar.ts:90-98, llama.ts:460 + sidecar.ts:513-524, llama.ts:39, factory.ts:763-764); nothing varied)
4. **Memory at start:** device_info Vulkan0 7,504 / 8,273 MiB — the SAME figure as on the idle card, although nvidia-smi showed 1,078 MiB in use (+195 MiB over the idle baseline); a second `--list-devices` while the model was loaded read 6,587 free · nvidia-smi 1078/8192 MiB used/total (6982 free) · desktop: **~1 GB-class ordinary use** — Chrome with several tabs, Discord and Slack reopened, VS Code open; nvidia-smi 1,078 MiB used before the spawn (idle baseline: 883)
5. **Fit outcome:** offloaded **31/33** layers to GPU (Vulkan0) — **PARTIAL, byte-identical to the idle baseline**: the fit again read 6,898 MiB free (`8273 = 6898 + (6007 = 5133 + 457 + 416) + -4632`), again fell 133 MiB short of its 1,024 MiB target, again kept ctx 8192 and filled back-to-front to 31 layers ("Vulkan0: 31 layers, 5742 MiB used, 1155 MiB free") · buffers identical: Vulkan0 model 4,854.94 MiB, CPU_Mapped 824.31 MiB, Vulkan0 KV 256.00 MiB, Vulkan0 RS 184.25 + CPU RS 16.75 MiB, Vulkan0 compute 447.38 MiB, Vulkan_Host compute 128.44 MiB, output 3.79 MiB · same two Gated Delta Net warnings · n_parallel auto → 4, kv_unified true, n_slots 4 · **rung 1** · BAR heap: heap 2 budget again 213.88 → 29.25 MiB at load → 2.25 MiB during the request; heap 0 budget while loaded 6,680–6,706 MiB (baseline: 6,987–7,011, so the desktop apps DID show up as ≈300 MiB less budget once the server was resident, yet not in the pre-spawn reading)
6. **Peak use:** 6916 MiB used (nvidia-smi, 1 s polling; +5838 MiB over the pre-spawn figure; 6874 MiB right after load, 1076 MiB after stop) during 2015-token prefill / 512-token decode
7. **Speed:** decode 20.00 tok/s (`predicted_per_second`, 512 tokens in 25.6 s) · prefill 213.9 tok/s (`prompt_per_second`, 2015 tokens in 9.4 s) · load to /health 9.4 s
8. **Varied:** none — the protocol's "~1 GB of ordinary desktop use" repeat of the baseline. Note on prefill: the baseline's 120 tok/s was the first prompt ever run on this card with this build (Vulkan pipeline compilation for the 2,048-token batch inside the timing); this start's 214 tok/s is the warm figure; decode is unchanged (20.0 vs 20.2 tok/s)
9. **App view:** not repeated for this variant — the app view (starred `qwen3.5-4b-ud-q4kxl`, basis Grafikspeicher, budget device GTX 1070 Ti 8,1 GB "Nutzbar") is in the baseline comment; the pre-spawn probe the picker reads was identical (7,504 free), so the star cannot differ
**Predicted vs measured:** **Holds, and the variant changes nothing.** §6.6 predicts the 9B does not fit an 8 GB card at 8k and stars the 4B; with ~1 GB of desktop use the probe reported the SAME 7,504 MiB free as on the idle card, the fit read the SAME 6,898 MiB and landed the SAME 31/33 partial offload at the same 20.0 tok/s decode. On this NVIDIA driver (582.66) the `VK_EXT_memory_budget` figure the picker and the fit both reason from does not track other processes' pre-spawn use (the same finding as the RTX 3080 Ti on 610.88), so the picker's desktop-use question is moot here: the card's verdict is set by the fit's own ≈600 MiB self-overhead, not by what the desktop holds. Question (a): no, the 9B does not fully offload on an 8 GB card at 8k under the app's launch, idle or with ~1 GB of use.
<details><summary>Load-log excerpt (redacted, 57 lines)</summary>

```text
# leg2-desktop-use — argv: <drive>\runtime\llama.cpp\win\llama-server.exe --host 127.0.0.1 --port 59024 --model <drive>\models\chat\qwen3.5-9b-ud-q4kxl.gguf --ctx-size 8192 --threads 6 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4
0.00.165.302 I cmn  common_param: device_info:
0.00.168.150 I srv  llama_server: n_parallel is set to auto, using n_parallel = 4 and kv_unified = true
0.00.187.240 I cmn  common_init_: fitting params to device memory ...
0.00.187.241 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.187.247 I common_params_fit_impl: getting device memory data for initial parameters:
0.00.965.678 I common_params_fit_impl: projected to use 6007 MiB of device memory vs. 6898 MiB of free device memory
0.00.965.692 I common_params_fit_impl: cannot meet free memory target of 1024 MiB, need to reduce device memory by 133 MiB
0.00.965.693 I common_params_fit_impl: context size set by user to 8192 -> no change
0.00.965.694 I common_params_fit_impl: id=0, target=5874 MiB
0.01.638.387 I common_params_fit_impl: memory for test allocation by device:
0.01.638.396 I common_params_fit_impl: id=0, n_layer= 0, n_part= 0, overflow_type=4, mem=   498 MiB
0.01.638.397 I common_params_fit_impl: filling dense layers back-to-front:
0.02.343.706 I common_params_fit_impl: memory for test allocation by device:
0.02.343.713 I common_params_fit_impl: id=0, n_layer=33, n_part= 0, overflow_type=4, mem=  6007 MiB
0.02.343.715 I common_params_fit_impl: start filling device 0, delta=33
0.03.118.954 I common_params_fit_impl: memory for test allocation by device:
0.03.118.961 I common_params_fit_impl: id=0, n_layer=32, n_part= 0, overflow_type=4, mem=  5885 MiB
0.03.119.032 I common_params_fit_impl: set ngl_per_device_high[0].n_layer=32
0.03.826.870 I common_params_fit_impl: memory for test allocation by device:
0.03.826.878 I common_params_fit_impl: id=0, n_layer=31, n_part= 0, overflow_type=4, mem=  5742 MiB
0.03.826.880 I common_params_fit_impl: set ngl_per_device[0].n_layer=31
0.03.826.881 I common_params_fit_impl:   - Vulkan0 (NVIDIA GeForce GTX 1070 Ti): 31 layers,   5742 MiB used,   1155 MiB free
0.03.826.889 I common_fit_params: successfully fit params to free device memory
0.03.826.894 I common_fit_params: fitting params to free memory took 0.69 seconds
0.04.036.565 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce GTX 1070 Ti) (0000:01:00.0) - 7501 MiB free
0.04.309.342 I print_info: n_ctx_train           = 262144
0.04.309.356 I print_info: n_swa                 = 0
0.04.309.357 I print_info: is_swa_any            = 0
0.04.309.376 I print_info: n_ctx_orig_yarn       = 262144
0.04.309.393 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.05.471.652 I load_tensors: offloading output layer to GPU
0.05.471.659 I load_tensors: offloading 30 repeating layers to GPU
0.05.471.660 I load_tensors: offloaded 31/33 layers to GPU
0.05.471.663 I load_tensors:   CPU_Mapped model buffer size =   824.31 MiB
0.05.471.664 I load_tensors:      Vulkan0 model buffer size =  4854.94 MiB
0.08.312.914 I llama_context: n_ctx         = 8192
0.08.312.915 I llama_context: n_ctx_seq     = 8192
0.08.312.918 I llama_context: kv_unified    = true
0.08.312.926 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.08.313.522 I llama_context: Vulkan_Host  output buffer size =     3.79 MiB
0.08.315.152 I llama_kv_cache:    Vulkan0 KV buffer size =   256.00 MiB
0.08.333.945 I llama_memory_recurrent:        CPU RS buffer size =    16.75 MiB
0.08.504.974 I llama_memory_recurrent:    Vulkan0 RS buffer size =   184.25 MiB
0.08.504.997 I llama_memory_recurrent: size =  201.00 MiB (     4 cells,  32 layers,  4 seqs  0 rs_seq), R (f32):    9.00 MiB, S (f32):  192.00 MiB
0.08.553.359 W sched_reserve: layer 0 is assigned to device CPU but the fused Gated Delta Net tensor is assigned to device Vulkan0 (usually due to missing support)
0.08.584.363 I sched_reserve:    Vulkan0 compute buffer size =   447.38 MiB
0.08.584.375 I sched_reserve: Vulkan_Host compute buffer size =   128.44 MiB
0.08.909.814 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 8192, kv_unified = 'true'
0.08.909.851 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.08.909.858 I slot   load_model: id  1 | task -1 | new slot, n_ctx = 8192
0.08.909.859 I slot   load_model: id  2 | task -1 | new slot, n_ctx = 8192
0.08.909.860 I slot   load_model: id  3 | task -1 | new slot, n_ctx = 8192
0.08.910.089 I srv          init: idle slots will be saved to prompt cache and cleared upon starting a new task
0.08.996.042 I srv  update_slots: all slots are idle
0.11.188.028 I slot   operator(): id  3 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2015
0.46.215.756 I srv  update_slots: all slots are idle
```
</details>
