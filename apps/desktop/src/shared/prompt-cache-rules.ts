// The ONE rule for llama-server's host-RAM prompt cache on the chat sidecar — issue #512 (owner
// decisions 1 and 2, 2026-09-27), replacing the #399 D5 family list. Shared and PURE (no node:, no
// electron, no DB) so the runtime's argv builder and its tests read the same rule.
//
// WHAT THE CACHE IS FOR. When something else takes the one chat slot (`-np 1`, issue #319), the
// server writes the evicted conversation to a host-RAM prompt cache so it can restore the prefix
// instead of re-processing it when that conversation comes back.
//
// WHY THERE IS NO FAMILY LIST ANY MORE. On b9849, 13 of 17 measured chat models (recurrent state:
// qwen3.5/3.6/3.8; sliding window: gemma4) could not restore a saved prompt, so #399 D5 passed
// `--cache-ram 0` for those four families. On b11146 (#512) qwen3.5 and gemma4 DO restore: 48 of
// ~1,700 tokens re-prefilled on return, and the answer byte-identical to a `cache_prompt: false`
// recompute. qwen3.6 and qwen3.8 share qwen3.5's architecture and are ON by owner ruling. Record:
// `docs/model-benchmarks.md` §6.6 "#512 amendment".
//
// WHAT REPLACES IT. A manifest that still cannot restore on the pinned runtime says so with
// `disable_prompt_cache: true`, which maps to the code-owned `--cache-ram 0` — the manifest states a
// fact and never supplies arguments (the `speculative_decoding` precedent). The manual smoke
// `tests/manual/prompt-cache-smoke.test.ts` tells whoever adds a manifest whether it needs the field.
// Every other chat model gets a ceiling scaled to the machine: 1/8 of total RAM, never more than
// llama.cpp's own 8,192 MiB default. When the cache is full, llama.cpp drops the oldest entry.

/** llama.cpp's own `--cache-ram` default (MiB) — also our ceiling (#512 decision 2). */
export const PROMPT_CACHE_MAX_MIB = 8192
/** The prompt cache may use 1/N of the machine's total RAM (#512 decision 2). */
export const PROMPT_CACHE_RAM_DIVISOR = 8

/**
 * The `--cache-ram` value (MiB) for a machine with `totalRamBytes` of RAM:
 * `min(8192, floor(total MiB / 8))`. 8 GB → 1,024 · 16 GB → 2,048 · 32 GB → 4,096 · 64 GB and
 * more → 8,192. A junk reading (not a positive finite number) gets the ceiling, which is exactly
 * what llama.cpp would use with no flag at all.
 */
export function promptCacheRamMib(totalRamBytes: number): number {
  if (!Number.isFinite(totalRamBytes) || totalRamBytes <= 0) return PROMPT_CACHE_MAX_MIB
  const totalMib = totalRamBytes / (1024 * 1024)
  return Math.max(1, Math.min(PROMPT_CACHE_MAX_MIB, Math.floor(totalMib / PROMPT_CACHE_RAM_DIVISOR)))
}

/**
 * The chat sidecar's prompt-cache args, appended to `CHAT_SERVER_ARGS`: always exactly one
 * `--cache-ram`. `['--cache-ram', '0']` when the manifest sets `disable_prompt_cache: true` (that
 * wins over the RAM ceiling), else `['--cache-ram', <promptCacheRamMib>]`.
 *
 * `-cram, --cache-ram N` — "set the maximum cache size in MiB (default: 8192, -1 - no limit,
 * 0 - disable)" — verbatim from the pinned b11146 binary's `--help`.
 */
export function promptCacheServerArgs(opts: {
  disablePromptCache?: boolean
  totalRamBytes: number
}): readonly string[] {
  if (opts.disablePromptCache === true) return ['--cache-ram', '0']
  return ['--cache-ram', String(promptCacheRamMib(opts.totalRamBytes))]
}
