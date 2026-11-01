import { join } from 'node:path'
import type { GpuDevice } from '../../src/shared/types'

// The measured cards and the committed catalog. It imports no main-process value, so a pure service suite can use it
// without an `electron` mock; `performance-fixture.ts` re-exports both for its own suites.

/** The repo's committed `model-manifests/`, absolute. */
export const CATALOG_MANIFESTS: string = join(__dirname, '..', '..', '..', '..', 'model-manifests')

/**
 * The four measured cards, as the probe lists them (MiB). Figures only: a row whose outcome turns on
 * a figure these do not hold keeps its own literal, and says so. Spread to vary one:
 * `{ ...CARDS.RTX_3090, freeMb: 4096 }`.
 */
export const CARDS: Record<'RTX_3080_TI' | 'RTX_3090' | 'GTX_1070_TI' | 'RTX_3060_LAPTOP', GpuDevice> = {
  // tests/fixtures/list-devices-b11146-vulkan-rtx3080ti.txt; model-benchmarks.md, the hardware table, leg 3.
  RTX_3080_TI: { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12084, freeMb: 11316 },
  // tests/fixtures/placement-b9849-partial-62of66-mtp.txt; model-benchmarks.md, the hardware table, leg 7.
  RTX_3090: { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24822, freeMb: 23575 },
  // model-benchmarks.md, the hardware table, leg 2. The b11146 captures of this card read 7,484-7,490 free.
  GTX_1070_TI: { id: 'Vulkan0', name: 'NVIDIA GeForce GTX 1070 Ti', totalMb: 8273, freeMb: 7504 },
  // tests/fixtures/placement-b9849-partial-18of33-np4.txt; leg 4. Vulkan1: that laptop lists its iGPU first.
  RTX_3060_LAPTOP: { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMb: 5994, freeMb: 5226 }
}
