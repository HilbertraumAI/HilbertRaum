// The ONE rule for "does llama-server's host-RAM prompt cache do this model any good?" — issue
// #399, owner decision D5, 2026-09-09. Shared and PURE (no node:, no electron, no DB) so the
// runtime's argv builder and its tests read the same list, and so the measured basis lives beside
// the rule instead of as an inline literal at a call site.
//
// WHAT THE CACHE IS FOR. When something else takes the one chat slot (`-np 1`, issue #319), the
// server writes the evicted conversation to a host-RAM prompt cache — 8,192 MiB of it by default —
// so it can restore the prefix instead of re-processing it when that conversation comes back.
//
// WHAT WAS MEASURED. On 11 of our 14 chat models it CANNOT restore it. The server saves the
// conversation and then silently re-prefills the whole prompt anyway: llama.cpp cannot rebuild
// either a recurrent state or a sliding-window cache from a saved prompt (llama.cpp PR #13194).
// A fourteen-model sweep on `i9-9900x-rtx-3090-24gb-128gb` — raw `llama-server`, the app's argv
// shape at `--ctx-size 8192 -np 1`, no MTP, every model fully offloaded, three requests per start
// (conversation A → an unrelated B takes the slot → back to A) — split them exactly along the
// architecture line, with three positive controls that DID restore (a dense Qwen, a Qwen MoE and a
// Mistral, each re-prefilling only 14–21 tokens of a ~1,470-token return prompt):
//
//   RE-PREFILLED, recurrent state   qwen3.5 (2b, 4b, 9b, 35b-a3b)  ·  qwen3.8 (three 27b quants)
//   RE-PREFILLED, sliding window    gemma4 (e2b, e4b, 12b, 26b-a4b), n_swa 512 / 1024
//   RESTORED                        qwen3 (dense + moe)  ·  mistral3
//
// So on those eleven the cache is pure waste: 14.86–343.59 MiB of host RAM written per eviction
// and never read once. `--cache-ram 0` gives that back and costs nothing.
//
// Record + evidence: `docs/model-benchmarks.md` §6.6 "2026-09-09 correction (#399)"; PR #445,
// `eval/results/hardware/i9-9900x-rtx-3090-24gb-128gb/issue399-arch-sweep-*`.
//
// WHY THIS IS A FAMILY LIST AND NOT AN ARCHITECTURE PROBE. The manifests already carry `family:`,
// and the measured split maps onto it exactly. We could ask the GGUF header instead, but that
// would be an inference from metadata we have not validated against this outcome; the list is what
// was actually measured, and #446 tracks the entries that were not.

/**
 * Manifest `family:` values whose models CANNOT restore an evicted chat prefix, so llama-server's
 * host prompt cache is written and never read for them. Measured, not inferred — see the module
 * comment for the sweep and its evidence.
 *
 * NOT on this list, deliberately: `qwen3.6` and `granite` (#446). `qwen3.6` is almost certainly
 * affected — same lineage as the `qwen3.8` 27Bs that failed — but its weights were broken symlinks
 * on the test rig and it was never started, and `granite-4.1-8b-q4` was not on that rig at all.
 * They stay off until someone measures them.
 */
export const PROMPT_CACHE_RESTORE_BROKEN_FAMILIES: readonly string[] = ['qwen3.5', 'qwen3.8', 'gemma4']

/**
 * The chat sidecar args this model's family needs for the prompt cache, appended to
 * `CHAT_SERVER_ARGS`. `['--cache-ram', '0']` for a family measured to lose the restore, `[]` for
 * everything else.
 *
 * THE DEFAULT IS DELIBERATELY CACHE-**ON**, including for a family nobody has measured and for a
 * model with no manifest family at all. The asymmetry decides it: turning the cache off on a model
 * that CAN restore costs real prompt-cache restores on every hand-back, while leaving it on for a
 * model that cannot merely continues a waste we can already name and bound. So an unmeasured family
 * keeps today's behaviour, and adding one here requires a measurement.
 *
 * `-cram, --cache-ram N` — "set the maximum cache size in MiB (default: 8192, -1 = no limit,
 * 0 = disable)" — verified present on the pinned b9849 binary (`799fcc04a`) before this shipped.
 */
export function promptCacheServerArgs(family: string | null | undefined): readonly string[] {
  if (!family) return []
  return PROMPT_CACHE_RESTORE_BROKEN_FAMILIES.includes(family) ? ['--cache-ram', '0'] : []
}
