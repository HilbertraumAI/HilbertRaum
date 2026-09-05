import { MAX_BENCHMARK_HISTORY } from '../../shared/types'
import type { AnswerSpeed } from '../../shared/ipc'
import type { BenchmarkResult, ObservedAnswerSpeed } from '../../shared/types'

// The Performance screen's model (benchmark.md "Performance screen"): one benchmark result
// per COMPUTER the drive has been used on, and the session's observed figures. Pure
// helpers plus one module-level session latch (precedent: `latestEffectiveRead` in
// read-speed.ts): no DB, no IPC, no I/O, so the IPC layer composes them and the tests
// drive them directly.

/** The fields of a result that identify the computer it was measured on. */
export type MachineFields = Pick<BenchmarkResult, 'os' | 'arch' | 'cpuModel' | 'cpuCores' | 'ramGb'>

/**
 * Fingerprint of the computer a result belongs to: OS, arch, CPU model + cores, and RAM
 * rounded to whole GB (`os.totalmem()` can drift by a few MB between boots of the same
 * machine; the Models screen rounds the same way). Returns null when the result carries
 * no usable identity (a detection failure, or a blob persisted before these fields were
 * reliably filled), so callers treat "unknown" as "keep what we have", never as "moved".
 */
export function machineKey(fields: MachineFields | null | undefined): string | null {
  if (!fields) return null
  if (!fields.cpuModel || !(fields.ramGb > 0)) return null
  return [fields.os, fields.arch, fields.cpuModel, fields.cpuCores, Math.round(fields.ramGb)].join('|')
}

/**
 * The history after a fresh result: the entry for the same machine is replaced, the
 * newest result leads, and the list is capped at `MAX_BENCHMARK_HISTORY` (the oldest
 * OTHER machines fall off; this machine's entry always survives). A result with no
 * machine identity is not recorded: it could never be matched again.
 */
export function upsertHistory(history: readonly BenchmarkResult[], result: BenchmarkResult): BenchmarkResult[] {
  const key = machineKey(result)
  if (key == null) return [...history]
  const others = history.filter((entry) => machineKey(entry) !== key)
  return [result, ...others].slice(0, MAX_BENCHMARK_HISTORY)
}

/** The history entry measured on the machine `key` names, or null. */
export function findMachine(history: readonly BenchmarkResult[], key: string | null): BenchmarkResult | null {
  if (key == null) return null
  return history.find((entry) => machineKey(entry) === key) ?? null
}

/** Every history entry EXCEPT the one for `key` (the "other computers" list), newest first. */
export function otherMachines(history: readonly BenchmarkResult[], key: string | null): BenchmarkResult[] {
  return history
    .filter((entry) => key == null || machineKey(entry) !== key)
    .sort((a, b) => (a.ranAt < b.ranAt ? 1 : a.ranAt > b.ranAt ? -1 : 0))
}

// ---- Session latch: the last finished chat answer's speed (#290 payload + context) ----

let lastAnswer: ObservedAnswerSpeed | null = null

/** Record a finished answer's speed (called by the chat-stream observer in index.ts). */
export function recordAnswerSpeed(speed: AnswerSpeed, modelId: string | null, now: () => Date = () => new Date()): void {
  lastAnswer = {
    tokensPerSecond: speed.tokensPerSecond,
    ttftMs: speed.ttftMs,
    tokens: speed.tokens,
    modelId,
    at: now().toISOString()
  }
}

/** The last finished answer of this session, or null before the first one. */
export function latestAnswerSpeed(): ObservedAnswerSpeed | null {
  return lastAnswer
}

/** Test seam. */
export function resetPerformanceForTests(): void {
  lastAnswer = null
}
