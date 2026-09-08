### Start: i9-9900x-rtx-3090-24gb-128gb · leg 7 · moe-host-mapped
1. **File:** `gemma4-26b-a4b-it-qat-q4` · `gemma4-26b-a4b-it-qat-q4.gguf` · 14,439,363,584 B (13.45 GiB) · sha256 `3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d`
2. **Runtime:** 9849 (799fcc04a) · Vulkan backend (b9849 Ubuntu build, GNU 11.4.0) · Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic · `run-start.mjs` in this directory, app closed, `--bin` = the drive's own `runtime/llama.cpp/linux/llama-server` (`--version` reads `9849 (799fcc04a)`). The weight was NOT on this machine: it was fetched from the manifest's own `download.url` (the one dev-time network action of this task) and verified byte count 14,439,363,584 and sha256 `3eca3b8f…eca51d` against the manifest before the start · driver NVIDIA 595.84 (Vulkan API 1.4.329) · heaps: `vulkaninfo` returned no heap block in this session, so `heaps.csv` is empty for this start; the `nvidia-smi` figures and the probe's free reading carry the memory story
3. **Argv:** `llama-server --host 127.0.0.1 --port 35395 --model <drive>/models/chat/gemma4-26b-a4b-it-qat-q4.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1` (source: the post-#386 harness argv, unchanged, with **no** `--extra` (the harness has carried `-np 1` itself since #388) and **`--mtp off`**. The `off` matters and is not a variation: the harness DEFAULTS to `--mtp on` (`run-start.mjs:26`), but this manifest carries no `speculative_decoding`, and `factory.ts:866` pushes rung 1a only when that field reads `'mtp'`. The app's first rung for this model is therefore plain **rung 1**, and passing the MTP flags would have measured something the app never launches)
4. **Memory at start:** device_info Vulkan0 23,797 / 24,822 MiB (probe immediately before the spawn; 8,502 free while loaded) · nvidia-smi 564/24576 MiB used/total (23564 free) · desktop: **idle**: X11 desktop plus an idle ComfyUI server (256 MiB resident), app closed; `nvidia-smi` 564 MiB used before the spawn
5. **Fit outcome:** offloaded **31/31** layers to GPU, a FULL offload, so the host-mapped figure below is clean. Fit pass: `projected to use 14943 MiB of device memory vs. 23766 MiB of free device memory`, `will leave 8822 >= 1024 MiB of free device memory, no changes needed` (rung 1's plain 1,024 target; nothing reduced) · buffers: Vulkan0 model 13,755.36 MiB + **CPU_Mapped model buffer size = 577.50 MiB**, the only CPU-side model buffer line in the capture · KV, an iswa pair, both at ONE sequence: non-SWA `160.00 MiB (8192 cells, 5 layers, 1/1 seqs)` + SWA `600.00 MiB (3072 cells, 25 layers, 1/1 seqs)` = **760.00 MiB** · compute: Vulkan0 428.07 + Vulkan_Host 88.08 MiB · output buffer Vulkan_Host 1.00 MiB · `n_slots = 1`, `n_ctx_slot = 8192`, `kv_unified = 'false'` · **rung 1** (no MTP: this manifest does not opt in)
6. **Peak use:** 17408 MiB used (nvidia-smi, 1 s polling; +16844 MiB over the pre-spawn figure; 15536 MiB right after load, 559 MiB after stop) during 2042-token prefill / 512-token decode
7. **Speed:** decode 68.42 tok/s (`predicted_per_second`, 512 tokens in 7.5 s) · prefill 272.3 tok/s (`prompt_per_second`, 2042 tokens in 7.5 s) · load to /health 7.0 s
8. **Varied:** nothing. One start, for one figure: `host_mapped_weights_mib` off a full offload
9. **App view:** n/a, the app was closed for this measurement. This is a placement figure, not a rung-selection or star question; the MoE is rank 2 and is never the automatic pick while a rank-3 model fits its tier
**Predicted vs measured:** **`host_mapped_weights_mib` = 577.50** for `gemma4-26b-a4b-it-qat-q4`, the last of the seven ranked chat models without one, closing BUILD_STATE §5 item 22 (e) point (1). The offload was full (31/31), which is the only condition under which this line is the embedding/output share rather than the share plus whatever did not fit. Threshold: `(13732.91 − 577.50) × 1.15 + 1.5 × 1024 + 1024` = 17,688.72, so **fits from 17,689 MiB**, down 664 from the whole-file 18,353 it carried while unmeasured. Against the fit's own projection of 14,943 the estimate moves from 1.23× to **1.18×**, still conservative, which is the safe direction. **Two things this start also settles, neither of which was asked for.** (1) The layer count is **31**, not the 36 the leg-4 write-up's phrasing might suggest for a Gemma; both numbers were read off the log rather than assumed. (2) The manifest's `estimated_context_cache_gib: 1.5` is a DERIVED figure that has never been measured, and it is **2.02× too high**: the two caches sum to 760.00 MiB against the 1,536 MiB the term claims, over by 776. The derivation in the manifest comment ("320 MiB full-attention + 1,200 MiB sliding-window cells") is exactly double the measured 160 + 600 on both halves, and the `-np 1` note attached to it is nonetheless correct: both caches are cell-sized and log `1/1 seqs`, so the slot count did not touch them. The cache term is a separate picker input with its own decision history and is left UNCHANGED here; correcting it would drop the threshold a further ~776 MiB and belongs in its own owner call. **Speed is a same-day figure, not a P0 one:** decode 68.42 tok/s (512 tokens in 7.5 s) and prefill 272.3 tok/s over 2,042 tokens, with `nvidia-smi` sampled every 2 s through the request reading the memory clock at **5001 MHz in every in-load sample** where this card's P0 is 9501, and the SM clock at 780 MHz drawing 132 W of a 350 W limit. That is the same parked clock state the #391 leg 7 verdict recorded on this rig; the MoE's ~3.8B active parameters are why it is still the fastest model measured on this card. Peak card use 17,408 MiB (+16,844 over the pre-spawn 564), 6,719 MiB still free at peak
<details><summary>Load-log excerpt (redacted, 49 lines)</summary>

```text
# leg7-moe-host-mapped : argv: llama-server --host 127.0.0.1 --port 35395 --model <drive>/models/chat/gemma4-26b-a4b-it-qat-q4.gguf --ctx-size 8192 --threads 10 --batch-size 2048 --ubatch-size 2048 --jinja --reasoning-format deepseek -lv 4 -np 1
0.00.132.824 I cmn  common_param: device_info:
0.00.138.708 I cmn  common_init_: fitting params to device memory ...
0.00.138.709 I cmn  common_init_: (for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on)
0.00.138.717 I common_params_fit_impl: getting device memory data for initial parameters:
0.01.172.893 I common_params_fit_impl: projected to use 14943 MiB of device memory vs. 23766 MiB of free device memory
0.01.172.897 I common_params_fit_impl: will leave 8822 >= 1024 MiB of free device memory, no changes needed
0.01.172.898 I common_fit_params: successfully fit params to free device memory
0.01.172.901 I common_fit_params: fitting params to free memory took 1.03 seconds
0.01.251.199 I llama_model_loader: - kv  21:                  gemma4.rope.freq_base_swa f32              = 10000.000000
0.01.251.208 I llama_model_loader: - kv  32:            gemma4.attention.key_length_swa u32              = 256
0.01.251.208 I llama_model_loader: - kv  33:          gemma4.attention.value_length_swa u32              = 256
0.01.251.209 I llama_model_loader: - kv  36:            gemma4.rope.dimension_count_swa u32              = 256
0.01.419.931 I llama_prepare_model_devices: using device Vulkan0 (NVIDIA GeForce RTX 3090) (0000:c1:00.0) - 23774 MiB free
0.01.827.571 W load: special_eog_ids contains '<|tool_response>', removing '</s>' token from EOG list
0.01.828.279 I load: special tokens cache size = 24
0.01.854.169 I print_info: n_ctx_train           = 262144
0.01.854.184 I print_info: n_swa                 = 1024
0.01.854.184 I print_info: is_swa_any            = 1
0.01.854.203 I print_info: freq_base_swa         = 10000.0
0.01.854.203 I print_info: freq_scale_swa        = 1
0.01.854.204 I print_info: n_embd_head_k_swa     = 256
0.01.854.204 I print_info: n_embd_head_v_swa     = 256
0.01.854.204 I print_info: n_rot_swa             = 256
0.01.854.205 I print_info: n_ctx_orig_yarn       = 262144
0.01.854.214 I load_tensors: loading model tensors, this can take a while... (mmap = true, direct_io = false)
0.02.903.528 I load_tensors: offloading output layer to GPU
0.02.903.532 I load_tensors: offloading 29 repeating layers to GPU
0.02.903.533 I load_tensors: offloaded 31/31 layers to GPU
0.02.903.537 I load_tensors:   CPU_Mapped model buffer size =   577.50 MiB
0.02.903.538 I load_tensors:      Vulkan0 model buffer size = 13755.36 MiB
0.06.511.228 I llama_context: n_ctx         = 8192
0.06.511.228 I llama_context: n_ctx_seq     = 8192
0.06.511.229 I llama_context: kv_unified    = false
0.06.511.234 I llama_context: n_ctx_seq (8192) < n_ctx_train (262144) -- the full capacity of the model will not be utilized
0.06.512.839 I llama_context: Vulkan_Host  output buffer size =     1.00 MiB
0.06.512.843 I llama_kv_cache_iswa: creating non-SWA KV cache, size = 8192 cells
0.06.515.839 I llama_kv_cache:    Vulkan0 KV buffer size =   160.00 MiB
0.06.522.038 I llama_kv_cache_iswa: creating     SWA KV cache, size = 3072 cells
0.06.534.168 I llama_kv_cache:    Vulkan0 KV buffer size =   600.00 MiB
0.06.606.520 I sched_reserve:    Vulkan0 compute buffer size =   428.07 MiB
0.06.606.524 I sched_reserve: Vulkan_Host compute buffer size =    88.08 MiB
0.06.726.103 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 8192, kv_unified = 'false'
0.06.726.117 I spec common_specu: no implementations specified for speculative decoding
0.06.726.118 I slot   load_model: id  0 | task -1 | new slot, n_ctx = 8192
0.06.726.226 I srv          init: idle slots will be saved to prompt cache upon starting a new task
0.06.739.719 I srv  update_slots: all slots are idle
0.08.778.406 I slot   operator(): id  0 | task 0 | new prompt, n_ctx_slot = 8192, n_keep = 0, task.n_tokens = 2042
0.23.759.779 I srv  update_slots: all slots are idle
```
</details>
