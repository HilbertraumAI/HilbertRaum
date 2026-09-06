// The speed and read thresholds the main services AND the Performance screen rate figures by
// (PR #303 audit N3: the screen used to re-declare all three, a drift waiting to happen). One
// definition each, shared and pure; the services re-export them under their historical names
// (`SLOW_PICK_TOKENS_PER_SECOND` in models.ts, `VERY_LOW_TOKENS_PER_SECOND` and
// `SLOW_EFFECTIVE_READ_MBPS` in benchmark.ts) so every existing import site is unchanged.

/**
 * A decode speed STRICTLY below this reads "Slow" — the picker's #95 step-down gate
 * (model-benchmarks.md §6.5). Calibrated on the chunk basis and deliberately NOT retuned for
 * the #291 decode-only figure: the gate is an order-of-magnitude crawl test.
 */
export const SLOW_TOKENS_PER_SECOND = 5

/**
 * Tokens/sec strictly below this downgrades the hardware PROFILE one step (spec §11.3).
 * Distinct from `SLOW_TOKENS_PER_SECOND` on purpose — the two thresholds serve different
 * surfaces (the legacy profile vs the picker / the screen's rating).
 */
export const VERY_LOW_TOKENS_PER_SECOND = 3

/**
 * Effective READ throughput (MB/s) below this earns the slow-read warning and the "Slow" drive
 * rating (#110). Separates the USB-stick class (~70 MB/s measured) from SSDs (430+) with
 * margin on both sides; checksum-pass samples stay above it on any healthy SSD.
 */
export const SLOW_READ_MBPS = 100

/**
 * The safety margin (MiB) llama.cpp's `--fit` keeps free on the card: the `--fit-target`
 * default of 1 GiB, which the app never overrides (it passes neither `-ngl` nor
 * `--fit-target` — architecture.md GPU record §5.2). The "Your model" partial-offload copy
 * names it, so the figure lives here rather than as a literal in three catalog strings
 * (PR #303 audit DR4): change the constant and every sentence follows.
 */
export const FIT_TARGET_MARGIN_MB = 1024

/**
 * How much of the card may already be in use and still count as "free at start" (MiB). Above
 * this the partial-offload copy blames what else held the card; below it the fit's own
 * reservations (working buffers + `FIT_TARGET_MARGIN_MB`) are the reason. Read by the
 * Performance screen's "Your model" row (PR #303 audit DR4 — it used to be a renderer-local
 * literal beside the hard-coded margin).
 */
export const CARD_FREE_SLACK_MB = 1536
