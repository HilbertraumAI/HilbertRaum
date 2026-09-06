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
