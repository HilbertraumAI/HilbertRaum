import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildModelList,
  estimateGraphicsNeedMib,
  fitsGraphicsMemory,
  graphicsBudgetMib,
  isSupportedRuntimeFormat,
  manifestFiles,
  recommendChatModelId,
  recommendModelIdByRam,
  weightsMib
} from '../../src/main/services/models'
import { isRealSha256, type ModelManifest } from '../../src/shared/manifest'
import type { ModelInfo } from '../../src/shared/types'
import { groupModelVariants, variantGroupFace } from '../../src/renderer/lib/modelLibrary'
import { orderPickerModels } from '../../src/renderer/lib/modelAvailability'
import { committedManifests } from '../helpers/catalog'
import { CATALOG_MANIFESTS } from '../helpers/gpu-fixtures'
import { validManifest } from '../helpers/manifest-fixtures'
import { modelManifestDocs } from '../helpers/repo-files'

// The COMMITTED model-manifests/ tree is what a real drive is provisioned from. These tests
// assert invariants directly against the on-disk catalog (mirrors the committed
// runtime-sources.yaml tests in assets.test.ts) — so a malformed or mis-promoted manifest
// fails CI, not a user's drive.

/**
 * The committed facts of every downloadable chat manifest. These are owner decisions, so literals are the right shape: a
 * manifest edit that moves one fails here, not on a user's drive. A NEW manifest needs no row (models are added without
 * code changes); a row whose manifest is gone fails, so nothing leaves the catalog unnoticed.
 *
 * Common to every row, asserted in the body: role chat, llama_cpp + gguf, apache-2.0, license review approved, a real hash
 * that the download block repeats, no mmproj (text-only: upstream vision weights ship no projector here). `profiles` is []
 * and `withdrawn` false unless a row says otherwise.
 *
 * - Ranks: the benchmark verdicts and owner decisions in model-benchmarks.md §6.2-§6.5, §9.3-§9.5. Issue #378 questions the
 *   F1 basis of some of them; a re-rank is a deliberate edit here.
 * - RAM: a silent mis-edit is how a rank-0 model becomes an auto-pick (the sweep in the §6.5 describe) or gets locked out of
 *   machines it fits. The 0.8B and 2B are deliberately tier-aligned with the 4B.
 * - ctx: the local runtime budget, never the native window. The 4B's cache term is computed at its 4,096.
 * - thinking: gates the Deep answer mode; a dropped flag removes Deep silently.
 * - TQ-2 (full-audit 2026-07-12): the 2507 stays rank 1 under the original 4B's rank 2, so the ordering cannot invert.
 * - withdrawn (#196): the three static Qwen3.8 K-quants. Their upstream files are gone, so they stay rank 0, kept as
 *   installed-base records. The Qwen3.6 pair's live sources are the point of `withdrawn: false` there.
 */
interface ChatFacts {
  family: string
  rank: number
  minRam: number
  recRam: number
  ctx: number
  thinking: boolean
  displayName: string
  profiles?: string[]
  withdrawn?: boolean
}

const CHAT_FACTS: Record<string, ChatFacts> = {
  'gemma4-12b-it-qat-q4': { family: 'gemma4', rank: 2, minRam: 14, recRam: 24, ctx: 8192, thinking: true, displayName: 'Gemma 4 12B Instruct QAT Q4' },
  'gemma4-26b-a4b-it-qat-q4': { family: 'gemma4', rank: 2, minRam: 20, recRam: 32, ctx: 8192, thinking: true, displayName: 'Gemma 4 26B-A4B Instruct QAT Q4' },
  'gemma4-31b-it-qat-q4': { family: 'gemma4', rank: 0, minRam: 24, recRam: 32, ctx: 8192, thinking: true, displayName: 'Gemma 4 31B Instruct QAT Q4' },
  'gemma4-e2b-it-qat-q4': { family: 'gemma4', rank: 3, minRam: 8, recRam: 12, ctx: 8192, thinking: true, displayName: 'Gemma 4 E2B Instruct QAT Q4' },
  'gemma4-e4b-it-qat-q4': { family: 'gemma4', rank: 0, minRam: 12, recRam: 16, ctx: 8192, thinking: true, displayName: 'Gemma 4 E4B Instruct QAT Q4' },
  'granite-4.1-8b-q4': { family: 'granite', rank: 0, minRam: 12, recRam: 16, ctx: 8192, thinking: false, displayName: 'Granite 4.1 8B Q4' },
  'ministral3-8b-instruct-2512-q4': { family: 'ministral3', rank: 2, minRam: 12, recRam: 16, ctx: 8192, thinking: false, displayName: 'Ministral 3 8B Instruct (2512) Q4' },
  'qwen3-14b-instruct-q4': { family: 'qwen3', rank: 1, minRam: 14, recRam: 24, ctx: 8192, thinking: true, displayName: 'Qwen3 14B Instruct Q4', profiles: ['PRO'] },
  'qwen3-30b-a3b-q4': { family: 'qwen3', rank: 0, minRam: 24, recRam: 32, ctx: 8192, thinking: true, displayName: 'Qwen3 30B-A3B (MoE) Q4' },
  'qwen3-4b-instruct-2507-q4': { family: 'qwen3', rank: 1, minRam: 8, recRam: 16, ctx: 4096, thinking: false, displayName: 'Qwen3 4B Instruct 2507 Q4' },
  'qwen3-4b-instruct-q4': { family: 'qwen3', rank: 2, minRam: 8, recRam: 16, ctx: 4096, thinking: true, displayName: 'Qwen3 4B Instruct Q4', profiles: ['TINY', 'LITE', 'UNKNOWN'] },
  'qwen3-8b-instruct-q4': { family: 'qwen3', rank: 1, minRam: 12, recRam: 16, ctx: 8192, thinking: true, displayName: 'Qwen3 8B Instruct Q4', profiles: ['BALANCED'] },
  'qwen3.5-0.8b-q6': { family: 'qwen3.5', rank: 0, minRam: 8, recRam: 16, ctx: 4096, thinking: true, displayName: 'Qwen3.5 0.8B Q6_K' },
  'qwen3.5-27b-ud-q4kxl': { family: 'qwen3.5', rank: 0, minRam: 24, recRam: 32, ctx: 8192, thinking: true, displayName: 'Qwen3.5 27B (UD-Q4_K_XL)' },
  'qwen3.5-2b-ud-q4kxl': { family: 'qwen3.5', rank: 0, minRam: 8, recRam: 16, ctx: 4096, thinking: true, displayName: 'Qwen3.5 2B (UD-Q4_K_XL)' },
  'qwen3.5-35b-a3b-ud-q4kxl': { family: 'qwen3.5', rank: 1, minRam: 24, recRam: 32, ctx: 8192, thinking: true, displayName: 'Qwen3.5 35B-A3B (UD-Q4_K_XL)' },
  'qwen3.5-4b-ud-q4kxl': { family: 'qwen3.5', rank: 3, minRam: 8, recRam: 16, ctx: 4096, thinking: true, displayName: 'Qwen3.5 4B (UD-Q4_K_XL)' },
  'qwen3.5-9b-ud-q4kxl': { family: 'qwen3.5', rank: 3, minRam: 12, recRam: 16, ctx: 8192, thinking: true, displayName: 'Qwen3.5 9B (UD-Q4_K_XL)' },
  'qwen3.6-27b-q4': { family: 'qwen3.6', rank: 1, minRam: 20, recRam: 24, ctx: 8192, thinking: true, displayName: 'Qwen3.6 27B Q4_K_M' },
  'qwen3.6-27b-q5': { family: 'qwen3.6', rank: 1, minRam: 24, recRam: 32, ctx: 8192, thinking: true, displayName: 'Qwen3.6 27B Q5_K_M' },
  'qwen3.8-27b-q4': { family: 'qwen3.8', rank: 0, minRam: 21, recRam: 24, ctx: 8192, thinking: true, displayName: 'Qwen3.8 27B Q4_K_M', withdrawn: true },
  'qwen3.8-27b-q5': { family: 'qwen3.8', rank: 0, minRam: 23, recRam: 32, ctx: 8192, thinking: true, displayName: 'Qwen3.8 27B Q5_K_M', withdrawn: true },
  'qwen3.8-27b-q6': { family: 'qwen3.8', rank: 0, minRam: 26, recRam: 32, ctx: 8192, thinking: true, displayName: 'Qwen3.8 27B Q6_K', withdrawn: true },
  'qwen3.8-27b-ud-q4km': { family: 'qwen3.8', rank: 3, minRam: 21, recRam: 24, ctx: 8192, thinking: true, displayName: 'Qwen3.8 27B UD-Q4_K_M' },
  'qwen3.8-27b-ud-q5km': { family: 'qwen3.8', rank: 3, minRam: 23, recRam: 32, ctx: 8192, thinking: true, displayName: 'Qwen3.8 27B UD-Q5_K_M' },
  'qwen3.8-27b-ud-q6k': { family: 'qwen3.8', rank: 0, minRam: 26, recRam: 32, ctx: 8192, thinking: true, displayName: 'Qwen3.8 27B UD-Q6_K' }
}

describe('committed catalog — chat manifest facts (owner decisions)', () => {
  const byId = new Map(committedManifests().map((m) => [m.id, m]))

  it.each(Object.entries(CHAT_FACTS))('%s holds its committed facts', (id, facts) => {
    const m = byId.get(id)
    expect(m, 'manifest present').toBeDefined()
    expect({
      family: m!.family,
      rank: m!.recommendationRank,
      minRam: m!.recommendedMinRamGb,
      recRam: m!.recommendedRamGb,
      ctx: m!.recommendedContextTokens,
      thinking: m!.supportsThinkingMode,
      displayName: m!.displayName,
      profiles: m!.recommendedProfiles,
      withdrawn: m!.download?.withdrawn !== undefined
    }).toEqual({ profiles: [], withdrawn: false, ...facts })
    expect([m!.role, m!.runtime, m!.format]).toEqual(['chat', 'llama_cpp', 'gguf'])
    expect(m!.license).toBe('apache-2.0')
    expect(m!.licenseReview.status).toBe('approved')
    expect(isRealSha256(m!.sha256), 'real sha256').toBe(true)
    expect(m!.download?.sha256, 'download hash equals top-level').toBe(m!.sha256)
    expect(m!.mmproj, 'text-only').toBeUndefined()
  })
})

/** The scripts' `field` / `Get-ManifestField`: the first line naming the key, at any indent; inline ` #` comment and outer quotes dropped. */
function flatField(text: string, key: string): string {
  for (const line of text.split(/\r?\n/)) {
    const hit = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`).exec(line)
    if (hit) return hit[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '')
  }
  return ''
}

describe('committed catalog — rules over every manifest', () => {
  it('a placeholder hash marks a local-test stub: no download block, rank 0, no legacy profile', () => {
    const stubs = committedManifests().filter((m) => !isRealSha256(m.sha256))
    expect(stubs.length, 'the local-test stubs; drop this row if they go').toBeGreaterThan(0)
    for (const m of stubs) {
      expect(m.download, `${m.id} download`).toBeUndefined()
      expect(m.recommendationRank, `${m.id} rank`).toBe(0)
      expect(m.recommendedProfiles, `${m.id} profiles`).toEqual([])
    }
  })

  it('every committed manifest names a runtime and format the app can run', () => {
    for (const m of committedManifests()) {
      expect(isSupportedRuntimeFormat(m.runtime, m.format), `${m.id}: ${m.runtime}/${m.format}`).toBe(true)
    }
  })

  // discoverManifests only checks ids: a copy-paste that shares a weight or a hash passes it.
  it('no two committed files share a drive path or a real hash', () => {
    const files = committedManifests().flatMap((m) => manifestFiles(tmpdir(), m))
    const paths = files.map((f) => f.localPath)
    expect(new Set(paths).size).toBe(paths.length)
    const hashes = files.map((f) => f.sha).filter(isRealSha256)
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  // docs/drive-layout.md: models/{chat,embeddings,reranker,transcriber,vision,translation}/, the same under model-manifests/.
  it('every weight sits under models/<role>/ and every manifest under model-manifests/<role>/', () => {
    for (const m of committedManifests()) {
      for (const f of manifestFiles(tmpdir(), m)) {
        expect(f.localPath.startsWith(`models/${m.role}/`), `${m.id}: ${f.localPath}`).toBe(true)
      }
    }
    for (const { path, doc } of modelManifestDocs()) {
      expect(path.replace(/\\/g, '/'), String(doc.id)).toMatch(new RegExp(`(^|/)model-manifests/${String(doc.role)}/`))
    }
  })

  // The key-order rule (shared/manifest.ts `files`): fetch-models and verify-models read a manifest flat, first match wins,
  // because they must run with no Node. A nested local_path / sha256 placed above the top-level one would poison them, and a
  // " #" in a value would truncate it.
  it('the flat first-match parser of the scripts reads what the YAML parser reads, on every committed manifest (#310 key order)', () => {
    for (const { path, text, doc } of modelManifestDocs()) {
      const download = (doc.download ?? {}) as Record<string, unknown>
      const review = doc.license_review as Record<string, unknown>
      const parsed: Record<string, unknown> = {
        id: doc.id,
        local_path: doc.local_path,
        sha256: doc.sha256,
        url: download.url,
        size_bytes: download.size_bytes,
        license: doc.license,
        license_url: download.license_url,
        status: review.status,
        withdrawn: download.withdrawn,
        bundled_on_preconfigured_drive: doc.bundled_on_preconfigured_drive
      }
      for (const [key, value] of Object.entries(parsed)) {
        expect(flatField(text, key), `${path}: ${key}`).toBe(String(value ?? ''))
      }
    }
  })
})

// §6.6 RULE C (PR #308 audit, adopted 2026-09-06; decisions 1, 2, 4, 7, 10, 11): on a discrete
// card the RAM pick stands wherever it fits the card's BUDGET — the probe's free memory (else
// total − 1,024), raw MiB — against `estimateGraphicsNeedMib` (offloadable weights × 1.15 + the manifest's
// context-cache term + the 1 GiB fit margin); where it does not, the highest-ranked eligible
// model; where nothing is eligible, the RAM pick (partial offload). The §6.5 step-down is
// confined to the eligible pool (R1/R2). Every figure below is pinned against the COMMITTED
// catalog so a manifest edit that moves a star fails CI, not a user's drive. The grid and the
// thresholds are the numbers model-benchmarks.md §6.6 states; the 8 GB row and the Gemma / MoE
// bands are predicted, not yet verified on hardware (G3).
describe('committed catalog — §6.6 rule C graphics-memory pick (PR #308 audit)', () => {
  const SHORT: Record<string, string> = {
    'qwen3.5-4b-ud-q4kxl': '4B',
    'gemma4-e2b-it-qat-q4': 'E2B',
    'qwen3.5-9b-ud-q4kxl': '9B',
    'gemma4-12b-it-qat-q4': 'G12',
    'gemma4-26b-a4b-it-qat-q4': 'MoE',
    'qwen3.8-27b-ud-q4km': 'Q4',
    'qwen3.8-27b-ud-q5km': 'Q5'
  }
  const RAM_COLUMNS = [8, 12, 16, 24, 32]
  /** The grid's free-memory convention: nominal GiB × 1024 − 1,024 MiB of idle desktop use (D3 median). */
  const freeMbOf = (nominalGb: number): number => nominalGb * 1024 - 1024
  const onCard = (chat: ModelManifest[], budgetMb: number, ramGb: number, signal?: { tokensPerSecond: number; measuredModelId: string }) =>
    recommendChatModelId(chat, { memoryClass: 'discrete', ramGb, budgetMb }, signal)
  const crawlOn = (measuredModelId: string) => ({ tokensPerSecond: 4, measuredModelId })
  const fitsBoth = (m: ModelManifest, budgetMb: number, ramGb: number): boolean =>
    fitsGraphicsMemory(m, budgetMb) && m.recommendedMinRamGb <= ramGb

  // (j) Decision 11: the seven config-derived cache terms (ubatch 2048; the 4B's figure is its
  // 4,096-token window), plus #473's measured translation term. EXACTLY these eight carry the
  // field; every other manifest defaults to 0.5 GiB. RECOMPUTED 2026-09-07 for ONE server slot
  // (issue #319: `CHAT_SERVER_ARGS` passes `-np 1`, replacing b9849's four unified slots). The
  // rule, measured on the pin (leg7-baseline-q5km
  // vs leg1-np-1 under `eval/results/hardware/i9-9900x-rtx-3090-24gb-128gb/`, same model and
  // context, one thing varied): the KV cache — and Gemma's sliding-window cache — is sized in CELLS
  // from `--ctx-size` and is counted ONCE at either setting (512.00 MiB both times); only the
  // RECURRENT state is per-sequence and drops exactly 4× (1,795.50 → 448.88 MiB). So the three
  // Gemma terms, which have no recurrent state, do not move at all, and each Qwen term loses three
  // quarters of its recurrent share. The two 27B figures use the MTP recurrent state (rs_seq 2 —
  // both manifests opt into `speculative_decoding`; §6.6 finding 3 recorded the old 1.1 GiB as
  // under-counting that case). Each manifest carries the full arithmetic in its own YAML comment.
  const CACHE_GIB: Record<string, number> = {
    'gemma4-12b-it-qat-q4': 2.4, // unchanged — no recurrent state
    'gemma4-26b-a4b-it-qat-q4': 0.8, // MEASURED 760.00 MiB (#412); was a derived 1.5
    'gemma4-e2b-it-qat-q4': 0.1, // unchanged — no recurrent state
    'qwen3.8-27b-ud-q4km': 0.9, // was 1.1: KV 512 + RS 448.88 (MTP, 1 seq) = 960.88 MiB
    'qwen3.8-27b-ud-q5km': 0.9, // was 1.1: same figures — the recurrent state is f32, quant-independent
    'qwen3.5-9b-ud-q4kxl': 0.3, // was 0.4: KV 256 + 1 × 48 = 304 MiB
    'qwen3.5-4b-ud-q4kxl': 0.2, // was 0.3: KV 128 + 1 × 48 = 176 MiB (at its 4,096 window)
    // #473: the translation sidecar, for its headroom gate — KV 256 (non-SWA) + 480 (SWA) = 736 MiB
    // at its 4,096 window (issue473-translategemma-full-offload, 49/49), rounded up.
    'translategemma-12b-it-q4': 0.75
  }
  // (j2) #321: the MEASURED host-mapped weight share `estimateGraphicsNeedMib` subtracts before
  // applying its 15 % working share. Each figure is the `CPU_Mapped model buffer size` of a
  // FULL-OFFLOAD start under `eval/results/hardware/` — a partial offload inflates that line with
  // the layers that did not fit (the 9B logs 545.62 at 33/33 but 824.31 at 31/33), so only
  // full-offload starts count. The five models #318 started carry the field, and #391 added the
  // last two — the 4B (PR #400, 33/33 on the RTX 3060 Laptop) and the MoE 26B (PR #409, 31/31 on
  // the RTX 3090, the only card that holds it). Those seven include all five RANK-3 models, so
  // every model rule C can ever star carries one: the E2B's threshold (2,271, next 3,838) and RAM
  // floor are both the lowest of any ranked model, so a rank-3 model is eligible whenever any
  // ranked model is, and `eligibleOrder` sorts rank first. NOT every ranked model, though — 8 of
  // the 15 ranked manifests carry none (rank 2: qwen3-4b-instruct-q4, ministral3-8b-instruct-2512-q4;
  // rank 1: qwen3-4b-instruct-2507-q4, qwen3-8b-instruct-q4, qwen3-14b-instruct-q4, qwen3.6-27b-q4,
  // qwen3.6-27b-q5, qwen3.5-35b-a3b-ud-q4kxl) and keep the whole-file base, which "Your model" uses
  // for one a user installs by hand. The assertion below pins that set exactly, so a future
  // measurement has to update this comment with it.
  // Deriving the split from the GGUF header instead is RETIRED — §5 item 22 (e).
  const HOST_MAPPED_MIB: Record<string, number> = {
    'gemma4-e2b-it-qat-q4': 2152.5, // leg 4, 36/36
    'qwen3.5-9b-ud-q4kxl': 545.62, // leg 5, 33/33
    'gemma4-12b-it-qat-q4': 787.5, // leg 3, 49/49
    'qwen3.8-27b-ud-q4km': 682.03, // leg 7, 66/66
    'qwen3.8-27b-ud-q5km': 682.03, // leg 1 `-np 1`, 66/66
    'qwen3.5-4b-ud-q4kxl': 497.31, // #391 leg 4 follow-up (b), 33/33 on the RTX 3060 Laptop
    'gemma4-26b-a4b-it-qat-q4': 577.5, // #391 last item, 31/31 on the RTX 3090 (the only card that holds it)
    'translategemma-12b-it-q4': 787.69 // #473, the translation sidecar's 49/49 start on the RTX 3080 Ti
  }
  it('pins the eight measured host_mapped_weights_mib values, and that no other manifest carries the field (#321, #473)', () => {
    const all = committedManifests()
    const byId = Object.fromEntries(all.map((m) => [m.id, m]))
    for (const [id, mib] of Object.entries(HOST_MAPPED_MIB)) {
      expect(byId[id], id).toBeDefined()
      expect(byId[id].hostMappedWeightsMib, `${id} host-mapped MiB`).toBe(mib)
      // A sanity bound the measurement itself must satisfy: the host-mapped share is a slice of
      // the weights, never the whole file (if it ever reads as the whole file, the figure was
      // taken from a partial-offload log).
      expect(mib, `${id} < weights`).toBeLessThan(weightsMib(byId[id]))
    }
    const carriers = all.filter((m) => m.hostMappedWeightsMib !== undefined).map((m) => m.id).sort()
    expect(carriers).toEqual(Object.keys(HOST_MAPPED_MIB).sort())
  })

  it('host-mapped weights are out of the BASE, not only the working share (§5 item 22 (e))', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    // The shape, spelled out rather than asserted through the constants so it stays legible:
    //   (weights − hostMapped) × 1.15 + cache + margin
    const e2b = byId['gemma4-e2b-it-qat-q4']
    const w = weightsMib(e2b)
    expect(estimateGraphicsNeedMib(e2b)).toBeCloseTo((w - 2152.5) * 1.15 + 0.1 * 1024 + 1024, 6)
    // Measured: llama.cpp projected 1,997 MiB and used ≈ 1,998 for this model (#318 leg 4). The
    // estimate stays ABOVE the measurement — conservative is the safe direction — but by 1.14×
    // rather than 2.4×.
    expect(estimateGraphicsNeedMib(e2b)).toBeGreaterThan(1998)
    expect(estimateGraphicsNeedMib(e2b) / 1998).toBeLessThan(1.2)
    // A ranked model with no measured figure keeps the whole file as its base — the conservative
    // direction, and the reason a missing field is safe. (This example used to be the 4B; it
    // carries a measured 497.31 since #391 leg 4 follow-up (b), so the 8B stands in for it.)
    const noFigure = byId['qwen3-8b-instruct-q4']
    expect(noFigure.hostMappedWeightsMib).toBeUndefined()
    expect(estimateGraphicsNeedMib(noFigure)).toBeCloseTo(
      weightsMib(noFigure) * 1.15 + (noFigure.estimatedContextCacheGib ?? 0.5) * 1024 + 1024,
      6
    )
    // And the 4B, now that it has one: the measurement moved its need by 497.31 × 1.15 = 571.9 MiB.
    const fourB = byId['qwen3.5-4b-ud-q4kxl']
    expect(estimateGraphicsNeedMib(fourB)).toBeCloseTo((weightsMib(fourB) - 497.31) * 1.15 + 0.2 * 1024 + 1024, 6)
    // Measured on the RTX 3060 Laptop: llama.cpp projected 3,261 MiB at 33/33. Conservative still,
    // but 1.18× rather than the 1.35× the whole-file base gave.
    expect(estimateGraphicsNeedMib(fourB)).toBeGreaterThan(3261)
    expect(estimateGraphicsNeedMib(fourB) / 3261).toBeLessThan(1.2)
  })

  it('pins the eight estimated_context_cache_gib values, and that no other manifest carries the field (#473)', () => {
    const all = committedManifests()
    const byId = Object.fromEntries(all.map((m) => [m.id, m]))
    for (const [id, gib] of Object.entries(CACHE_GIB)) {
      expect(byId[id], id).toBeDefined()
      expect(byId[id].estimatedContextCacheGib, `${id} cache GiB`).toBe(gib)
    }
    const carriers = all.filter((m) => m.estimatedContextCacheGib !== undefined).map((m) => m.id).sort()
    expect(carriers).toEqual(Object.keys(CACHE_GIB).sort())
  })

  // (e) The per-model thresholds in raw MiB (`estimateGraphicsNeedMib`, every ranked chat model):
  // the smallest whole-MiB budget each fits, pinned as the literal the §6.6 table states, with
  // the boundary asserted on both sides through `fitsGraphicsMemory`.
  const THRESHOLD_MIB: Record<string, number> = {
    'qwen3-4b-instruct-2507-q4': 4278,
    'qwen3-4b-instruct-q4': 4278,
    'qwen3.5-4b-ud-q4kxl': 3838, // was 4,410 until its host-mapped 497.31 was measured (#391)
    'gemma4-e2b-it-qat-q4': 2271,
    'qwen3-8b-instruct-q4': 7020,
    'ministral3-8b-instruct-2512-q4': 7239,
    'qwen3.5-9b-ud-q4kxl': 7285,
    'gemma4-12b-it-qat-q4': 10254,
    'qwen3-14b-instruct-q4': 11407,
    'gemma4-26b-a4b-it-qat-q4': 16972, // 18,353 → 17,689 (host-mapped, #391) → 16,972 (measured cache, #412)
    'qwen3.6-27b-q4': 19961,
    'qwen3.8-27b-ud-q4km': 19258,
    'qwen3.6-27b-q5': 22923,
    'qwen3.8-27b-ud-q5km': 22877,
    'qwen3.5-35b-a3b-ud-q4kxl': 25884
  }
  it('pins every ranked chat model\'s graphics-memory threshold in raw MiB (boundary on both sides)', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    const ranked = chat.filter((m) => m.recommendationRank > 0).map((m) => m.id).sort()
    expect(ranked).toEqual(Object.keys(THRESHOLD_MIB).sort())
    for (const m of chat.filter((m) => m.recommendationRank > 0)) {
      const t = THRESHOLD_MIB[m.id]
      expect(Math.ceil(estimateGraphicsNeedMib(m)), `${m.id} need`).toBe(t)
      expect(fitsGraphicsMemory(m, t), `${m.id} fits at ${t}`).toBe(true)
      expect(fitsGraphicsMemory(m, t - 1), `${m.id} does not fit at ${t - 1}`).toBe(false)
    }
    // The two figures the decisions turn on, spelled out: the 9B needs 7,285, under a nominal 8 GiB
    // but STILL over what an idle 8 GB card has FREE (7,168), so the 8 GB row stays the 4B; Gemma
    // 12B 10,254 = 10.0 GiB (2.4 GiB cache), where the PR's flat 0.5 GiB read 9.0 GiB.
    expect(THRESHOLD_MIB['qwen3.5-9b-ud-q4kxl']).toBeLessThan(8192)
    expect(THRESHOLD_MIB['qwen3.5-9b-ud-q4kxl']).toBeGreaterThan(8192 - 1024)
    expect(THRESHOLD_MIB['gemma4-12b-it-qat-q4']).toBeGreaterThan(10 * 1024)
    expect(THRESHOLD_MIB['gemma4-12b-it-qat-q4']).toBeLessThan(11 * 1024)
  })

  // (e2) Issue #412 backs its own decision. Correcting the MoE's context-cache term from a derived
  // 1.5 to the MEASURED 0.8 GiB drops its threshold 717 MiB (17,689 → 16,972), and the argument for
  // taking it was that the star cannot move. That is asserted here rather than reasoned about,
  // because two rule-C branches bypass the rank ordering the informal argument rested on: step 2's
  // `base && eligible(base)` takes the RAM pick BEFORE the ranked pool is consulted, and
  // `applySpeedSignal` gates a crawl on `eligible(measured)`, so widening eligibility can unlock a
  // step-down that was previously suppressed. The MoE is rank 2 behind five rank-3 models and its
  // 32 GB comfortable tier keeps it out of both branches — so it wins rule C NOWHERE, which is a
  // stronger statement than "the correction did not move it" and is what the manifest comment cites.
  it('#412: the MoE never wins rule C, at any budget, RAM size or speed signal', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    const moe = 'gemma4-26b-a4b-it-qat-q4'
    expect(chat.find((m) => m.id === moe)!.estimatedContextCacheGib).toBe(0.8)
    const budgets: number[] = []
    // Fine around the corrected threshold (where eligibility actually changed), coarse elsewhere.
    for (let b = 16_900; b <= 17_800; b++) budgets.push(b)
    for (let b = 1024; b <= 49_152; b += 37) budgets.push(b)
    const rams = [4, 8, 12, 14, 16, 20, 21, 23, 24, 31, 32, 48, 64, 128]
    for (const budget of budgets) {
      for (const ram of rams) {
        expect(onCard(chat, budget, ram), `budget=${budget} ram=${ram}`).not.toBe(moe)
      }
    }
    // …and with a crawl measured on every chat model, at the RAM sizes that clear its 20 GB floor.
    for (const measured of chat) {
      for (const budget of [16_972, 17_000, 17_688, 17_689, 20_480, 23_332, 32_768]) {
        for (const ram of [20, 24, 32, 64, 128]) {
          expect(onCard(chat, budget, ram, crawlOn(measured.id)), `measured=${measured.id} budget=${budget} ram=${ram}`).not.toBe(moe)
        }
      }
    }
  })

  // (d) The 30-point grid on the free-memory basis: cards {6, 8, 12, 16, 20, 24} GB as
  // `freeMb` = nominal × 1024 − 1,024 (idle desktop use; also what a probe without a free figure
  // yields for a card reporting its nominal total) × RAM {8, 12, 16, 24, 32}. Reference for the
  // CHANGE (not the pin): the total-basis rule-C grid in the audit's a7 read 9B on the 8 GB row
  // from RAM 16, Q4 on the 20 GB row from RAM 24 and Q5 at 24 GB / RAM 32. On the free basis the
  // 8 GB row stays the 4B: the 9B needs 7,285 against 7,168 free, 117 MiB short. The 20 and 24 GB
  // rows came back as the thresholds fell (#319, #321, §5 item 22 (e)): Q4 needs 19,258 against
  // 19,456 free, and Q5 22,877 against 23,552. The RTX 3090 reports 24,822 MiB, so its budget is
  // 23,798 and it stars Q5 too (pinned in `benchmark.test.ts`), which is what the hardware measured.
  const GRID: Array<[cardGb: number, picks: string]> = [
    [6, '4B / E2B / 4B / 4B / 4B'],
    [8, '4B / E2B / 4B / 4B / 4B'],
    [12, '4B / E2B / 9B / 9B / 9B'],
    [16, '4B / E2B / 9B / 9B / 9B'],
    [20, '4B / E2B / 9B / Q4 / Q4'],
    [24, '4B / E2B / 9B / Q4 / Q5']
  ]
  it('pins the 30-point rule-C grid on the free-memory basis (RAM 8 / 12 / 16 / 24 / 32)', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    // The RAM baseline the grid is read against.
    expect(RAM_COLUMNS.map((ram) => SHORT[recommendModelIdByRam(chat, ram, 'chat') ?? ''] ?? '?').join(' / ')).toBe('4B / E2B / 9B / Q4 / Q5')
    for (const [card, picks] of GRID) {
      const row = RAM_COLUMNS.map((ram) => {
        const id = onCard(chat, freeMbOf(card), ram)
        return SHORT[id ?? ''] ?? id
      }).join(' / ')
      expect(row, `${card} GB card (${freeMbOf(card)} MiB free)`).toBe(picks)
    }
  })

  // (h) Catalog property over the same grid: every star resolves, is ranked, and passes both
  // gates — the card and the RAM floor. (Replaces the earlier five-id denylist: a property, not
  // a list that a new rank-0 manifest could slip past.)
  it('every grid star resolves to a ranked model that fits the card AND passes the RAM floor', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    for (const [card] of GRID) {
      for (const ram of RAM_COLUMNS) {
        const budget = freeMbOf(card)
        const id = onCard(chat, budget, ram)
        const m = chat.find((x) => x.id === id)
        expect(m, `card=${card} ram=${ram} → ${id}`).toBeDefined()
        expect(m!.recommendationRank, `card=${card} ram=${ram} → ${id} rank`).toBeGreaterThan(0)
        expect(fitsBoth(m!, budget, ram), `card=${card} ram=${ram} → ${id} eligible`).toBe(true)
      }
    }
  })

  // (f) Decision 10 on the audit's own machine: the GTX 1070 Ti reports 8,273 MiB total /
  // 7,504 free on Windows Vulkan. The free-vs-total distinction decision 10 exists for is still
  // the point — but which model it lands on moved with the estimate, so read the numbers, not the
  // ids: at 7,504 free the 9B now fits (7,285), while a probe WITHOUT a free figure falls back to
  // total − 1,024 = 7,249 and it does NOT. Public `--list-devices` lines (audit D1/D3) pinned
  // beside it, in the picks the free basis gives them.
  //
  // The 9B on THIS card is the one place the §5 item 22 (e) change is load-bearing rather than
  // cosmetic, so the measurement behind it, from #318 leg 2 at four slots: the fit read 6,898 MiB
  // free, projected 6,007, and fell 133 MiB short of its own 1,024 MiB target — 31/33 layers,
  // 20.2 tok/s. `-np 1` (#319) returns 150.75 MiB of recurrent state, 17.75 more than that
  // shortfall, so the fit was expected to clear at 33/33 — and the app's estimate (7,285) still
  // sits ABOVE what the fit asks for (5,856 projected + its 1,024 target = 6,880), i.e. the
  // estimate remains the more conservative of the two. **MEASURED 2026-09-08 (#391 leg 2):
  // 33/33** on two starts — the fit read 7,350 MiB free under `-np 1`, projected 5,856 and left
  // 1,494 ≥ 1,024; 29.0 tok/s (was 20.2 at 31/33). Evidence:
  // eval/results/hardware/i7-8700-gtx-1070-ti-8gb-32gb/leg2-np1-verify.*
  it('judges the fit against the probe\'s free memory, else total − 1,024 (decision 10; the 1070 Ti case)', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    const gtx1070ti = { totalMb: 8273, freeMb: 7504 }
    expect(graphicsBudgetMib(gtx1070ti)).toBe(7504)
    expect(onCard(chat, graphicsBudgetMib(gtx1070ti)!, 16)).toBe('qwen3.5-9b-ud-q4kxl')
    expect(onCard(chat, graphicsBudgetMib(gtx1070ti)!, 32)).toBe('qwen3.5-9b-ud-q4kxl')
    const noFree = { totalMb: 8273 } as { totalMb: number; freeMb: number }
    expect(graphicsBudgetMib(noFree)).toBe(7249)
    // …and on the total − 1,024 fallback the same card does NOT reach it: 7,285 > 7,249. The
    // free-vs-total gap decision 10 exists for now straddles a threshold, which is the sharpest
    // form this assertion has taken.
    expect(onCard(chat, graphicsBudgetMib(noFree)!, 16)).toBe('qwen3.5-4b-ud-q4kxl')
    // Public lines: RTX 5060 8,151 / 7,573 free (Linux Vulkan) → 9B (7,285 fits); RTX 3080 Ti
    // 11,912 / 11,640 (CUDA) → 9B (Gemma 12B's 10,254 fits too but ranks below); RTX 3090
    // 24,575 / 23,332 (CUDA) → Q5 at RAM 32 (22,877 fits — it did not before §5 item 22 (e));
    // RTX 2060 6,144 / 5,136 → 4B.
    expect(onCard(chat, 7573, 32)).toBe('qwen3.5-9b-ud-q4kxl')
    expect(onCard(chat, 11_640, 32)).toBe('qwen3.5-9b-ud-q4kxl')
    expect(onCard(chat, 23_332, 32)).toBe('qwen3.8-27b-ud-q5km')
    expect(onCard(chat, 5136, 32)).toBe('qwen3.5-4b-ud-q4kxl')
  })

  // (a) R1: the speed step-down can no longer escape the RAM floor or the card. On the committed catalog every lower tier is
  // eligible whenever the pick is, so no committed input reaches the destination filter. The audit's two counterexamples are
  // therefore replayed on a copy with the one landing tier put out of reach. Synthetic owner: models.test "§6.5 step-down
  // applies ONCE to the candidate…".
  it('R1: a slow sample never steps to a model over the RAM floor or off the card', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    const e2b = 'gemma4-e2b-it-qat-q4'
    const nineB = 'qwen3.5-9b-ud-q4kxl'
    // RAM 20 / 20 GiB budget: base = 9B (fits, stands); a crawl on the MoE (a tier above) keeps it; a crawl on the 9B steps to the E2B.
    expect(onCard(chat, 20 * 1024, 20)).toBe(nineB)
    expect(onCard(chat, 20 * 1024, 20, crawlOn('gemma4-26b-a4b-it-qat-q4'))).toBe(nineB)
    expect(onCard(chat, 20 * 1024, 20, crawlOn(nineB))).toBe(e2b)
    // RAM 64 / 17 GiB budget: base = Q5 does not fit → the 9B.
    expect(onCard(chat, 17 * 1024, 64)).toBe(nineB)
    // The landing tier over the RAM floor, then off the card: the step has nowhere to go, and the 9B stays.
    const overFloor = chat.map((m) => (m.id === e2b ? { ...m, recommendedMinRamGb: 21 } : m))
    expect(onCard(overFloor, 20 * 1024, 20, crawlOn(nineB))).toBe(nineB)
    const offCard = chat.map((m) => (m.id === e2b ? { ...m, sizeOnDiskGb: 40 } : m))
    expect(onCard(offCard, 20 * 1024, 20, crawlOn(nineB))).toBe(nineB)
  })

  // (c) R2: a crawl measured on a model the card cannot hold says nothing about the fitting pick.
  it('R2: a crawl on a card-oversized model leaves the fitting pick unchanged', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    // RAM 24 / 12 GiB budget: base = Q4 (19,258 MiB) does not fit → the 9B (rank 3; Gemma 12B fits
    // at 10,254 but ranks 2). A 4 tok/s sample on the manually started Q4 is not in the eligible
    // pool → the 9B stays. (At the PR head the card pick here was Gemma 12B and the Q4 crawl
    // lowered it to the 9B — the audit's A2 reproduction; under rule C no oversized sample moves it.)
    expect(onCard(chat, 12 * 1024, 24)).toBe('qwen3.5-9b-ud-q4kxl')
    expect(onCard(chat, 12 * 1024, 24, crawlOn('qwen3.8-27b-ud-q4km'))).toBe('qwen3.5-9b-ud-q4kxl')
    expect(onCard(chat, 12 * 1024, 24, crawlOn('gemma4-26b-a4b-it-qat-q4'))).toBe('qwen3.5-9b-ud-q4kxl')
    // Those two return at the #52 guard (their tier is above the pick). This one reaches R2's own guard: the same tier as the
    // pick, but its 19,961 MiB does not fit a 19,500 budget, so it says nothing about the UD-Q4 that does.
    expect(onCard(chat, 19_500, 24)).toBe('qwen3.8-27b-ud-q4km')
    expect(onCard(chat, 19_500, 24, crawlOn('qwen3.6-27b-q4'))).toBe('qwen3.8-27b-ud-q4km')
    // …while a crawl on the 9B itself (right-sized, eligible) steps to the E2B as §6.5 intends.
    expect(onCard(chat, 12 * 1024, 24, crawlOn('qwen3.5-9b-ud-q4kxl'))).toBe('gemma4-e2b-it-qat-q4')
  })

  // (b) The sweep invariant (the audit's A1 with its expectation inverted): budgets 6–32 GiB in
  // 0.5 GiB steps × RAM 8–64, a 4 tok/s sample on the initial pick at every point. Every result
  // is eligible (fits the card AND passes the RAM floor) or equals the documented no-fit fallback
  // (the RAM pick without a signal). Eligibility is evaluated once per point.
  it('sweep: every stepped result is eligible or the documented no-fit fallback (3,021 points)', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    const byId = new Map(chat.map((m) => [m.id, m]))
    let points = 0
    const violations: string[] = []
    for (let budget = 6 * 1024; budget <= 32 * 1024; budget += 512) {
      for (let ram = 8; ram <= 64; ram++) {
        points++
        const base = recommendModelIdByRam(chat, ram, 'chat')
        const first = onCard(chat, budget, ram)
        const stepped = first ? onCard(chat, budget, ram, crawlOn(first)) : null
        for (const id of [first, stepped]) {
          const m = id ? byId.get(id) : undefined
          const ok = m != null && (fitsBoth(m, budget, ram) || id === base)
          if (!ok) violations.push(`budget=${budget} ram=${ram} first=${first} stepped=${stepped}`)
        }
      }
    }
    expect(points).toBe(3021)
    expect(violations).toEqual([])
  })

  // (k) Unknown RAM on the card path keeps the pre-rule-C `ramOk` semantics: the floor is open,
  // the card alone decides, in rank order. With no RANKED model fitting (a card under ~4.5 GiB
  // free) the fallback is STRICTLY ranked (owner decision 2026-09-06, #326): no rank-0 model is
  // ever the automatic pick, so the pick is the RAM pick — null when RAM is unknown too.
  it('unknown RAM (NaN / 0) on the card path: the floor is open, the card decides', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    for (const ram of [Number.NaN, 0]) {
      expect(recommendModelIdByRam(chat, ram, 'chat'), `ram=${ram} RAM pick`).toBeNull()
      expect(onCard(chat, 24_000, ram), `ram=${ram} 24,000`).toBe('qwen3.8-27b-ud-q5km')
      expect(onCard(chat, 7168, ram), `ram=${ram} 7,168`).toBe('qwen3.5-4b-ud-q4kxl')
      // 4,000 MiB now holds the E2B (2,271 since §5 item 22 (e); it read 4,746 before), so the
      // card path resolves where it used to fall through to a null RAM pick. Note what this does
      // NOT mean: a 4 GB card still never becomes the budget device, because `USABLE_VRAM_MB` is
      // 5,120. #321's stated reason for that floor ("nothing ranked fits 4,512 anyway") no longer
      // holds on the arithmetic; the floor was KEPT on a restated, measured reason instead (#321,
      // 2026-09-08).
      // SINCE #391 (leg 4 follow-up (b), 2026-09-08) the pick here is the **4B**, not the E2B:
      // its measured host-mapped 497.31 MiB dropped its need 4,410 → 3,838, which 4,000 now
      // clears. See the floor test below — this is the half of the restated reason that no
      // longer holds, and it is flagged there for the owner rather than papered over.
      expect(onCard(chat, 4000, ram), `ram=${ram} 4,000`).toBe('qwen3.5-4b-ud-q4kxl')
      expect(onCard(chat, 2270, ram), `ram=${ram} 2,270`).toBeNull()
    }
    // With KNOWN RAM, 4,000 MiB has a ranked fit so rule C takes it rather than falling back —
    // the RAM pick at 16 GB is the 9B, which does not fit, so this is the ordinary demotion, not
    // the no-fit path. Since #391 the demotion lands on the 4B (3,838) rather than the E2B.
    expect(recommendModelIdByRam(chat, 16, 'chat')).toBe('qwen3.5-9b-ud-q4kxl')
    expect(onCard(chat, 4000, 16)).toBe('qwen3.5-4b-ud-q4kxl')
    // The no-fit fallback itself is unchanged, just reached lower down: under the smallest ranked threshold nothing is
    // eligible, so the RAM pick stands, partially offloaded. #326's rank-0 exclusion is not reachable here: every rank-0 need
    // (the 0.8B's 2,304 is the lowest) sits above the E2B's 2,271. Its proof is models.test "where the RAM pick does not fit…".
    expect(onCard(chat, 2270, 16)).toBe(recommendModelIdByRam(chat, 16, 'chat'))
    expect(onCard(chat, 2270, 16)).toBe('qwen3.5-9b-ud-q4kxl')
  })

  // #321 (owner decision 2026-09-08): `USABLE_VRAM_MB` stays 5,120, and this is the MEASURED
  // basis that replaced #321's void "nothing ranked fits a 4 GB card anyway". If the floor is
  // ever lowered, this test is the evidence it has to argue against — so it asserts the cost,
  // not the constant (`gpu-rules.test.ts` pins the constant). Record: §6.6 N8 "Why 5,120 —
  // RESTATED".
  //
  // RESOLVED 2026-09-10 (#413), replacing the "⚠ WEAKENED BY MEASUREMENT — OWNER DECISION PENDING"
  // note this block carried since 2026-09-08. The erosion was real but rested on the wrong budget
  // figure. #391 moved the 4B's need 4,410 → 3,838, which clears the ~3,900 the N8 text called a
  // 4 GB card's probe-free budget — so on THAT figure the 4B, not the E2B, is the star and the
  // "smallest ranked model at every RAM size" argument survives only at 3,072. But 3,900 was never
  // a measurement: it is a fixture invented alongside the gate change itself (`freeMb: 3900` in
  // `picker-seams.test.ts`, `performance.test.ts`, `performance-gpu.test.ts`, commit `c3247fe5`),
  // and no 4 GB card has ever been probed. Every card that HAS been probed idles with the same
  // desktop-set reserve — 768 MiB on the RTX 3060 Laptop, 769 on the GTX 1070 Ti, 768 on the RTX
  // 3080 Ti, 1,014 on the RTX 3090, and those are floors — so a real 4 GB card's budget is nearer
  // 4,096 − 768 = 3,328, which the 4B does NOT clear. All THREE forms are asserted below: 3,072
  // (no free figure), 3,328 (the measured reserve — the one a real card would produce) and 3,900
  // (the fixture, kept so the one form that would weaken the argument stays visible rather than
  // being quietly dropped). The floor is unchanged, and since 2026-09-11 (#413) that is DECIDED
  // without a 4 GB measurement: keeping it self-corrects through the §6.5 step-down, a lowered
  // floor would not (§6.6 N8 "Decided 2026-09-11"). Reopen only on a real 4 GB card measured on
  // the §6.6 protocol.
  it('a 4 GB card: the smallest-ranked-model argument holds at both budget forms a real one produces (#321, #391, #413)', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    const fits = (budget: number) =>
      chat.filter((m) => m.recommendationRank > 0 && fitsGraphicsMemory(m, budget)).map((m) => m.id)
    // The no-free-figure form (total − 1,024): the E2B is still the ONLY ranked model that fits,
    // so every RAM size still collapses to it — the decision's original shape, intact.
    expect(fits(3072)).toEqual(['gemma4-e2b-it-qat-q4'])
    for (const ram of [8, 12, 16, 24, 32, 64]) {
      expect(onCard(chat, 3072, ram), `budget=3072 ram=${ram}`).toBe('gemma4-e2b-it-qat-q4')
    }
    // The probe-free form as a REAL 4 GB card would report it (#413): ~4,096 less the 768 MiB idle
    // reserve every probed card shows. The 4B's 3,838 misses it by 510, so the E2B is alone here
    // too and the collapse is the same as at 3,072 — this is the form the N8 argument rests on.
    expect(fits(3328)).toEqual(['gemma4-e2b-it-qat-q4'])
    for (const ram of [8, 12, 16, 24, 32, 64]) {
      expect(onCard(chat, 3328, ram), `budget=3328 ram=${ram}`).toBe('gemma4-e2b-it-qat-q4')
    }
    // For the 4B to fit at all, a 4 GB card would have to report a free figure of 3,838 — i.e. a
    // TOTAL of ≥ 4,606 on the same reserve, which a 4 GB card does not have. Pinned as the
    // boundary the #413 argument turns on.
    expect(fits(3837)).toEqual(['gemma4-e2b-it-qat-q4'])
    expect(fits(3838)).toEqual(['gemma4-e2b-it-qat-q4', 'qwen3.5-4b-ud-q4kxl'])
    // The fixture form (~3,900), kept visible: the ONE budget at which the argument would weaken,
    // reachable only by a 4 GB card with no desktop drawn on it. The 4B fits beside the E2B, so
    // such a card would star a real model rather than collapsing to the smallest one.
    expect(fits(3900)).toEqual(['gemma4-e2b-it-qat-q4', 'qwen3.5-4b-ud-q4kxl'])
    // Rule C only ever demotes, never promotes above the RAM pick, so RAM 12 keeps the E2B (its
    // RAM pick already) while every larger RAM size stops at the 4B instead of the E2B.
    expect(onCard(chat, 3900, 12), 'budget=3900 ram=12').toBe('gemma4-e2b-it-qat-q4')
    for (const ram of [8, 16, 24, 32, 64]) {
      expect(onCard(chat, 3900, ram), `budget=3900 ram=${ram}`).toBe('qwen3.5-4b-ud-q4kxl')
    }
    // What the collapse demotes, on the RAM picker the card path would override.
    expect(recommendModelIdByRam(chat, 16, 'chat')).toBe('qwen3.5-9b-ud-q4kxl')
    expect(recommendModelIdByRam(chat, 32, 'chat')).toBe('qwen3.8-27b-ud-q5km')
    // Only RAM 12 is unaffected: the RAM pick is already the E2B, so nothing moves there.
    expect(recommendModelIdByRam(chat, 12, 'chat')).toBe('gemma4-e2b-it-qat-q4')
  })

  // (g) Unified / cpu with a KNOWN budget, and a legacy call without a class: the RAM pick,
  // byte-identical to the RAM picker (T-item 4).
  it('cpu / unified with a known 24 GiB budget, and no class at all, return the RAM pick', async () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    for (const ram of [8, 12, 16, 24, 32, 64]) {
      const ramPick = recommendModelIdByRam(chat, ram, 'chat')
      expect(recommendChatModelId(chat, { memoryClass: 'cpu', ramGb: ram, budgetMb: 24 * 1024 }), `cpu ram=${ram}`).toBe(ramPick)
      expect(recommendChatModelId(chat, { memoryClass: 'unified', ramGb: ram, budgetMb: 24 * 1024 }), `unified ram=${ram}`).toBe(ramPick)
      const slow = { tokensPerSecond: 4, measuredModelId: ramPick }
      expect(recommendChatModelId(chat, { memoryClass: 'cpu', ramGb: ram, budgetMb: 24 * 1024 }, slow), `cpu slow ram=${ram}`).toBe(
        recommendModelIdByRam(chat, ram, 'chat', slow)
      )
    }
    const rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-catalog-rulec-'))
    try {
      const star = async (extra: Partial<Parameters<typeof buildModelList>[0]>) => {
        const { models } = await buildModelList({ manifestsDir: CATALOG_MANIFESTS, rootPath, developerMode: false, machineRamGb: 32, ...extra })
        return models.find((m) => m.role === 'chat' && m.recommended)?.id
      }
      expect(await star({})).toBe('qwen3.8-27b-ud-q5km')
      expect(await star({ memoryClass: 'cpu', graphicsBudgetMb: 24 * 1024 })).toBe('qwen3.8-27b-ud-q5km')
      expect(await star({ memoryClass: 'discrete', graphicsBudgetMb: 7168 })).toBe('qwen3.5-4b-ud-q4kxl')
      expect(await star({ memoryClass: 'discrete', graphicsBudgetMb: 23_332 })).toBe('qwen3.8-27b-ud-q5km')
    } finally {
      rmSync(rootPath, { recursive: true, force: true })
    }
  })

  it('RAM stays a hard gate on the card path: nothing under the lowest floor, and a crawl on a model over the floor is no signal (§6.6 point 5)', () => {
    const chat = committedManifests().filter((m) => m.role === 'chat')
    // RAM 7 is under every floor: the RAM pick is null, and no card however large overrides that.
    expect(onCard(chat, 24_000, 7)).toBeNull()
    // RAM 8, 7,100 MiB: the 4B stands. The 8B fits the card (7,020) but needs RAM 12, so a crawl on it says nothing.
    expect(onCard(chat, 7100, 8)).toBe('qwen3.5-4b-ud-q4kxl')
    expect(onCard(chat, 7100, 8, crawlOn('qwen3-8b-instruct-q4'))).toBe('qwen3.5-4b-ud-q4kxl')
  })
})

describe('committed catalog — Qwen3.8 wave (2026-08-16 promotion, §9.4)', () => {
  // Issue #182 (§9.4 MTP addendum): the draft head costs ~2 GiB VRAM, so exactly the two
  // quants that keep 24 GB headroom opt in. Q6_K peaks at 22.7 GiB on a 24 GB card at ctx
  // 8192 — its VRAM fit IS its reason to exist, and MTP would spend it. The runtime's VRAM
  // guard would refuse it anyway; this pins the DECISION so nobody "fixes" the asymmetry.
  it('exactly the four manifests whose weight carries a draft head opt into MTP, never a Q6 (#182, #196)', () => {
    // The flag is a claim about the WEIGHT (Qwen3.8's in-GGUF `blk.64.nextn.*` tensors), not a
    // tuning knob: copying it onto a model without the head makes llama-server refuse to start,
    // which the ladder then recovers from by falling back — a wasted multi-GB load per session.
    const claiming = committedManifests()
      .filter((m) => m.speculativeDecoding !== undefined)
      .map((m) => m.id)
      .sort()
    // #196 successor wave: the UD successors were re-verified to carry the head IN-GGUF
    // (Dynamic 3.0 ships separate MTP files for its small/legacy quants, so this could not be
    // assumed): draft acceptance logged on the b9849 pin for both, 2026-08-20.
    expect(claiming).toEqual([
      'qwen3.8-27b-q4',
      'qwen3.8-27b-q5',
      'qwen3.8-27b-ud-q4km',
      'qwen3.8-27b-ud-q5km'
    ])
  })

  // Issue #196: upstream deleted all three pinned files. The catalog says so IN THE MANIFEST
  // (`download.withdrawn`) rather than leaving everyone to rediscover an HTTP 404 — the
  // planner, the in-app downloader and both fetch scripts all key off this one field.
  it('all three manifests declare the withdrawn upstream source, block intact', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    const withdrawn = Object.entries(CHAT_FACTS).filter(([, f]) => f.withdrawn).map(([id]) => id)
    expect(withdrawn).toHaveLength(3)
    for (const id of withdrawn) {
      const dl = byId[id].download!
      expect(dl.withdrawn, `${id} withdrawn note`).toMatch(/^2026-08-20: unsloth removed/)
      // The dead URL + hash + size are KEPT: they are the provenance record of the file that
      // existing drives carry, and that copy still verifies against this manifest.
      expect(dl.url, `${id} url kept`).toContain('huggingface.co/unsloth/Qwen3.8-27B-GGUF')
      expect(dl.sizeBytes, `${id} size kept`).toBeGreaterThan(0)
    }
  })

  // The general rule, not just this wave: a model the app cannot obtain or verify must never be the auto-pick. Rank 0 is the
  // established "selectable, never recommended" convention; a legacy profile is the other road to a recommendation.
  it('no committed manifest is both recommended and unobtainable', () => {
    const recommended = committedManifests().filter((m) => m.recommendationRank > 0 || m.recommendedProfiles.length > 0)
    expect(recommended.length, '15 ranked chat models + the embedder, reranker and transcriber').toBeGreaterThanOrEqual(18)
    const offenders = recommended
      .filter(
        (m) =>
          !m.download ||
          m.download.withdrawn !== undefined ||
          m.download.sha256 !== m.sha256 ||
          m.licenseReview.status !== 'approved' ||
          !manifestFiles(tmpdir(), m).every((f) => isRealSha256(f.sha))
      )
      .map((m) => m.id)
    expect(offenders).toEqual([])
  })

  // The RAM bands as ratified (model-policy.md): both ends of each band, plus every point the older rows sampled.
  // #196 successor wave (2026-08-20, measured, owner-ratified): 24 GB goes to the UD-Q4_K_M (the measured 19 percent decode
  // regression vs the withdrawn file is recorded and accepted); >=32 GB to the UD-Q5_K_M, which reproduces its envelope.
  // #153: 12-15 fit the E2B's rec-12 comfortably and nothing else ranked fits below 16. 8-11 stay the runnable-stage 4B
  // (min-8 tie → rank tie → disk-asc, 2.9 GB < 3.3 GB); 16 is the rank-3 9B (capacity-first: the 16 tier outranks the 12).
  it('hands each RAM band to its ratified pick, the big tiers to the measured UD successors (no-signal mapping)', () => {
    const chat = committedManifests()
    const fourB = 'qwen3.5-4b-ud-q4kxl'
    const e2b = 'gemma4-e2b-it-qat-q4'
    const nineB = 'qwen3.5-9b-ud-q4kxl'
    const q4 = 'qwen3.8-27b-ud-q4km'
    const q5 = 'qwen3.8-27b-ud-q5km'
    const bands: Array<[ramGb: number, pick: string | null]> = [
      [7, null], [8, fourB], [11, fourB], [12, e2b], [14, e2b], [15, e2b], [16, nineB], [20, nineB], [23, nineB],
      [24, q4], [31, q4], [32, q5], [48, q5], [64, q5], [128, q5]
    ]
    for (const [ram, pick] of bands) {
      expect(recommendModelIdByRam(chat, ram, 'chat'), `ram=${ram}`).toBe(pick)
    }
  })
})

// §6.5 speed-signal step-down (issue #95) against the REAL committed catalog: a sub-threshold
// crawl measured on the tier's own pick steps the recommendation exactly one capacity band
// down. The no-signal mapping is pinned separately (the RAM bands above + benchmark.test.ts's
// 8/12/16/20/24/32 table) — these rows only pin the stepped picks.
// Since the #153 E2B promotion the 16–20 GB crawl has a landing tier (previously rule 3: keeps).
describe('committed catalog — §6.5 speed-signal stepped picks (issue #95)', () => {
  /** A crawl measured on the tier's own no-signal pick: the predicate always applies. */
  function slowOnOwnPick(chat: ModelManifest[], ram: number) {
    return { tokensPerSecond: 2.0, measuredModelId: recommendModelIdByRam(chat, ram, 'chat') }
  }

  it('steps each tier down one band on a right-sized crawl (stepped mapping)', () => {
    const chat = committedManifests()
    // 8 GB: the pick is the runnable-stage fallback (nothing fits comfortably) — keeps.
    expect(recommendModelIdByRam(chat, 8, 'chat', slowOnOwnPick(chat, 8))).toBe('qwen3.5-4b-ud-q4kxl')
    // 12 GB: the pick is E2B itself (#153) and no ranked band exists below 12 — keeps.
    expect(recommendModelIdByRam(chat, 12, 'chat', slowOnOwnPick(chat, 12))).toBe('gemma4-e2b-it-qat-q4')
    // 16–20 GB: a 9B crawl steps down to the #153 sub-16 band — the landing tier issue #153
    // created for exactly the weak-16 GB-box class (previously: keeps, no ranked band below 16).
    expect(recommendModelIdByRam(chat, 16, 'chat', slowOnOwnPick(chat, 16))).toBe('gemma4-e2b-it-qat-q4')
    expect(recommendModelIdByRam(chat, 20, 'chat', slowOnOwnPick(chat, 20))).toBe('gemma4-e2b-it-qat-q4')
    // 24 GB: 27B Q4 crawling steps to the 16-band winner.
    expect(recommendModelIdByRam(chat, 24, 'chat', slowOnOwnPick(chat, 24))).toBe('qwen3.5-9b-ud-q4kxl')
    // ≥32 GB: 27B Q5 crawling steps to the 24-band winner (the UD successor since the #196
    // successor wave restored the §9.4 handover, owner-ratified 2026-08-20).
    expect(recommendModelIdByRam(chat, 32, 'chat', slowOnOwnPick(chat, 32))).toBe('qwen3.8-27b-ud-q4km')
    expect(recommendModelIdByRam(chat, 48, 'chat', slowOnOwnPick(chat, 48))).toBe('qwen3.8-27b-ud-q4km')
    expect(recommendModelIdByRam(chat, 128, 'chat', slowOnOwnPick(chat, 128))).toBe('qwen3.8-27b-ud-q4km')
  })

  it('an oversized crawl never moves the pick (the #52 lesson, real manifests)', () => {
    const chat = committedManifests()
    // 24 GB box, crawl measured on the manually-started 32 GB-tier Q5: pick unchanged.
    expect(
      recommendModelIdByRam(chat, 24, 'chat', { tokensPerSecond: 2.0, measuredModelId: 'qwen3.6-27b-q5' })
    ).toBe('qwen3.8-27b-ud-q4km')
    // 16 GB box, crawl on the 24 GB-tier Q4: pick unchanged.
    expect(
      recommendModelIdByRam(chat, 16, 'chat', { tokensPerSecond: 2.0, measuredModelId: 'qwen3.6-27b-q4' })
    ).toBe('qwen3.5-9b-ud-q4kxl')
  })

  // A rank-0 model must never be the pick, and a ranked runner-up must lose every tier to a rank-3 holder (§6.3, §9.3; the
  // withdrawn Qwen3.8 quants are rank 0 for the #196 reason). Every RAM size, because a mis-edit hides at the sizes a sample
  // misses: a rank-0 model with a UNIQUE low recommended_ram_gb becomes the only comfortable fit there and slips past the
  // preferRanked guard (exactly what the then-rank-0 E2B did at 12), and one with a min under 8 wins the machines nothing
  // ranked fits. Both arms: the no-signal pick and a crawl on it.
  it('every RAM size from 1 to 128 GB picks a rank-3 model or nothing, with or without a crawl on the pick', () => {
    const chat = committedManifests()
    const rank = new Map(chat.map((m) => [m.id, m.recommendationRank]))
    let picks = 0
    for (let ram = 1; ram <= 128; ram++) {
      const base = recommendModelIdByRam(chat, ram, 'chat')
      if (base === null) {
        expect(ram, 'nothing runs only under the 8 GB floor').toBeLessThan(8)
        continue
      }
      for (const id of [base, recommendModelIdByRam(chat, ram, 'chat', slowOnOwnPick(chat, ram))]) {
        expect(rank.get(id ?? ''), `ram=${ram} picked=${id}`).toBe(3)
        picks++
      }
    }
    expect(picks).toBe(242)
  })
})

describe('committed catalog — the single-manifest roles (TQ-2)', () => {
  // The role manifests churn far less than the chat waves; a presence + real-hash pin over EVERY declared file is the cheap
  // half that catches deletion and hash mis-edits. TranslateGemma's license posture has a row of its own below.
  it('each non-chat role ships exactly its one known manifest with a real hash', () => {
    const manifests = committedManifests()
    const expected: Record<string, { id: string; kinds: string[] }> = {
      embeddings: { id: 'multilingual-e5-small-q8', kinds: ['weight'] },
      reranker: { id: 'bge-reranker-v2-m3-f16', kinds: ['weight'] }, // manifest id ≠ its filename (bge-reranker-v2-m3.yaml)
      transcriber: { id: 'whisper-small-multilingual', kinds: ['weight', 'extra'] },
      translation: { id: 'translategemma-12b-it-q4', kinds: ['weight'] },
      vision: { id: 'qwen2.5-vl-3b-instruct-q4', kinds: ['weight', 'mmproj'] }
    }
    for (const [role, { id, kinds }] of Object.entries(expected)) {
      const ofRole = manifests.filter((m) => m.role === role)
      expect(ofRole.map((m) => m.id), `${role} manifest set`).toEqual([id])
      const files = manifestFiles(tmpdir(), ofRole[0])
      expect(files.map((f) => f.kind), `${id} declared files`).toEqual(kinds)
      for (const f of files) expect(isRealSha256(f.sha), `${f.localPath} real sha256`).toBe(true)
    }
  })

  it('the transcriber declares its Silero VAD file beside the weight (#504)', () => {
    const whisper = committedManifests().find((m) => m.role === 'transcriber')
    expect(whisper, 'one transcriber manifest').toBeDefined()
    expect(manifestFiles(tmpdir(), whisper!).map((f) => [f.localPath, f.kind])).toEqual([
      ['models/transcriber/ggml-small.bin', 'weight'],
      ['models/transcriber/ggml-silero-v5.1.2.bin', 'extra']
    ])
    // Fetched with the weight: dictation needs both, and the wrapper finds this one by its name.
    expect(whisper!.files?.[0].download, 'the VAD file has a source').toBeDefined()
  })

  // #769 (owner call): `license_review.status` is the REDISTRIBUTION review a sold drive needs, and TranslateGemma's
  // stays `pending` until the Gemma flow-down checklist its manifest note lists exists. Freezing it is the point: a flip
  // is an owner decision, never a tidy-up. DRIVE-NOTICES.md prints the status, so its byte gate already shows a flip as
  // a diff; this row carries the intent and says what the flip costs.
  it('TranslateGemma\'s license review stays pending until a redistribution review is recorded (#769)', () => {
    const tg = committedManifests().find((m) => m.id === 'translategemma-12b-it-q4')
    expect(tg, 'translategemma manifest present').toBeDefined()
    expect(
      tg!.licenseReview.status,
      'approving it drops the in-app license confirmation (ModelsScreen needsAck) and the downloaders\' license ' +
        'refusal (services/assets.ts, fetch-models), and lets a Kit preload the weight past the sell gate ' +
        '(services/commercial-drive.ts). Record the redistribution review in docs/model-policy.md first.'
    ).toBe('pending')
  })
})

// #766 (owner call 2026-11-02): a preconfigured Kit preloads its bundled set and lists every other manifest for in-app
// download. The set is an owner decision, so its ids are literals. The builder fetches only these and the sell gate needs
// each one VERIFIED and approved, so a bundled manifest with no source, a withdrawn one, a placeholder hash or an open
// review makes every Kit build fail.
describe('committed catalog — the Kit bundled set (#766)', () => {
  it('bundles chat, embeddings and the transcriber, each one fetchable, verifiable and approved', () => {
    const bundled = committedManifests().filter((m) => m.bundledOnPreconfiguredDrive)
    expect(bundled.map((m) => m.id).sort()).toEqual([
      'multilingual-e5-small-q8',
      'qwen3-4b-instruct-q4',
      'whisper-small-multilingual'
    ])
    for (const m of bundled) {
      expect(m.licenseReview.status, `${m.id} license review`).toBe('approved')
      for (const f of manifestFiles(tmpdir(), m)) expect(isRealSha256(f.sha), `${f.localPath} real sha256`).toBe(true)
      // Every file's own source: fetch-models skips a model whose projector or extra file is withdrawn too.
      const sources = [m.download, ...(m.mmproj ? [m.mmproj.download] : []), ...(m.files ?? []).map((f) => f.download)]
      for (const d of sources) {
        expect(d, `${m.id}: a file with no download`).toBeDefined()
        expect(d?.withdrawn, `${m.id}: a withdrawn source`).toBeUndefined()
      }
    }
  })
})

// PR #30 (portable-build-cleanup): recommended_min_ram_gb is the HARD start gate
// (registerModelIpc §11.4 refuses a model whose min exceeds the machine's RAM). The catalog
// convention — every chat manifest and the vision role model (model-benchmarks.md §4 / §8.4
// PROD-1) — is that this hard min is the MODEL-ALONE floor (peak RSS + ~3 GiB headroom);
// co-residency pressure lives in recommended_ram_gb, NOT the hard gate. TranslateGemma was the
// lone manifest that baked its co-residency floor (13.24 GiB → 17) into the hard min, which
// locked it out of every 16 GB machine. These invariants keep that from regressing.
describe('committed catalog — RAM start-gate invariants (PROD-1)', () => {
  it('no manifest sets its hard min above its own recommended RAM (an incoherent gate)', () => {
    for (const m of committedManifests()) {
      expect(
        m.recommendedMinRamGb,
        `${m.id}: recommended_min_ram_gb (${m.recommendedMinRamGb}) must be > 0`
      ).toBeGreaterThan(0)
      expect(
        m.recommendedMinRamGb,
        `${m.id}: hard min (${m.recommendedMinRamGb}) must not exceed recommended_ram_gb (${m.recommendedRamGb})`
      ).toBeLessThanOrEqual(m.recommendedRamGb)
    }
  })

  it('TranslateGemma clears the §11.4 hard gate on a standard 16 GB machine', () => {
    const tg = committedManifests().find((m) => m.id === 'translategemma-12b-it-q4')
    expect(tg, 'translategemma manifest present').toBeDefined()
    // 9.22 GiB peak RSS + ~3 GiB headroom (§4 rule) → 13. Pinned so a revert to the old 17
    // (co-residency floor baked into the hard gate) fails here instead of on a user's drive.
    expect(tg!.recommendedMinRamGb, 'TranslateGemma model-alone floor').toBe(13)
    // The whole point of the change: a 16 GB box must not be gated out. machineRamGb() reports a
    // hair under the nominal size, so require real headroom below 16, not merely <=16.
    expect(tg!.recommendedMinRamGb, 'fits a 16 GB machine with headroom').toBeLessThan(16)
    // Co-residency stays in recommended_ram_gb (translation + resident chat + E5), not the gate.
    expect(tg!.recommendedRamGb, 'co-residency lives in recommended_ram_gb').toBeGreaterThanOrEqual(
      tg!.recommendedMinRamGb
    )
  })
})

// full-audit 2026-07-16 F-06 + F-16: two catalog-internal coherence invariants. The catalog
// carried defects that no existing test could catch — a chat manifest whose recommended context
// was physically incompatible with the RAM its own hard start-gate declared sufficient (F-06:
// qwen3.5-9b-q8, ctx 98304 @ min 14 GB → a ~12 GB f16 KV cache the 14 GB gate admits but cannot
// hold), and a manifest pair recording size_on_disk_gb in GiB while the whole catalog uses
// decimal GB (F-16: the Qwen3.6 27B pair). Both are cross-field consistency checks that belong in
// CI, not on a user's drive.
describe('committed catalog — internal coherence invariants (F-06, F-16)', () => {
  // F-06 — ctx-vs-hard-min-RAM plausibility. recommended_context_tokens becomes llama-server
  // --ctx-size verbatim when the user leaves context on "Automatic" (models.ts launchContextTokens
  // → sidecar --ctx-size), and recommended_min_ram_gb is the HARD start gate (registerModelIpc
  // §11.4 admits any machine at/above it). The KV cache grows with ctx, so a large context on a
  // small hard-min is an incoherent promise: the gate lets the machine in, then the spawn cannot
  // fit. This is a model-agnostic PLAUSIBILITY bound (not a physical KV model): cap the recommended
  // runtime context at 2048 tokens per GB of hard-min RAM. The whole committed catalog sits at or
  // below 1024 tok/GB (tightest: gemma4-coding-q8 and the E2B, 1024), so 2048 leaves 2x headroom;
  // the F-06 defect (98304 @ 14 → 7022 tok/GB) blows past it by 3.4x. A future manifest that
  // genuinely wants a bigger context must raise its hard-min RAM to stay honest — which is exactly
  // the coherence the start gate is supposed to encode.
  it('no chat manifest promises a context its hard-min RAM gate cannot plausibly hold', () => {
    const MAX_CTX_PER_MIN_RAM_GB = 2048
    for (const m of committedManifests().filter((m) => m.role === 'chat')) {
      const ceiling = m.recommendedMinRamGb * MAX_CTX_PER_MIN_RAM_GB
      expect(
        m.recommendedContextTokens,
        `${m.id}: recommended_context_tokens (${m.recommendedContextTokens}) exceeds the ` +
          `plausibility ceiling (${ceiling} = ${m.recommendedMinRamGb} GB hard-min * ` +
          `${MAX_CTX_PER_MIN_RAM_GB} tok/GB) — the RAM start gate would admit machines the ` +
          `resulting --ctx-size cannot fit`
      ).toBeLessThanOrEqual(ceiling)
    }
  })

  // F-16 — size_on_disk_gb must be decimal GB (size_bytes / 1e9), the catalog-wide convention
  // (ledgered: full-audit DOC-3 at architecture.md fixed this exact GiB-mislabel class once, and
  // BUILD_STATE DOC-2 normalized the Qwen3.5 27B/35B pair). A GiB value is ~6.9% low, which on a
  // multi-GB weight is >1 GB — far outside rounding. Only manifests carrying a real single-file
  // download block with a byte count are checked (the vision manifest's size_on_disk_gb is a
  // composite of two files — GGUF + mmproj — with no single download.size_bytes, so it is
  // excluded by the numeric-sizeBytes guard). Tolerance 0.15 GB clears every honest rounding
  // (largest gap in the catalog: qwen3.5-0.8b, 0.7 vs 0.639 = 0.061) yet reddens on a GiB mislabel
  // of any sizable weight (the F-16 pair was off by 1.12 / 1.31 GB).
  it('size_on_disk_gb matches size_bytes/1e9 (decimal GB) for every real download block', () => {
    const TOLERANCE_GB = 0.15
    const unsized: string[] = []
    for (const m of committedManifests()) {
      const sizeBytes = m.download?.sizeBytes
      if (sizeBytes == null || sizeBytes <= 0) {
        if (m.download) unsized.push(m.id)
        continue
      }
      const decimalGb = sizeBytes / 1e9
      expect(
        Math.abs(m.sizeOnDiskGb - decimalGb),
        `${m.id}: size_on_disk_gb (${m.sizeOnDiskGb}) must be decimal GB = size_bytes/1e9 ` +
          `(${decimalGb.toFixed(3)}); a gap this large means GiB was recorded instead of GB`
      ).toBeLessThan(TOLERANCE_GB)
    }
    // An exact list: a floor would let a later manifest drop its size_bytes once a new one had been added.
    expect(unsized).toEqual(['qwen2.5-vl-3b-instruct-q4'])
  })
})

// ---------------------------------------------------------------------------------------
// #310 — every multi-file weight is fully declared (replaces the PR #302 F1 containment guard).
//
// A weight that ships as several files (llama.cpp's `-00001-of-00004.gguf` shard set) used to
// enter the app as ONE file: the schema knew only the top-level `local_path`/`sha256` plus a
// vision model's `mmproj`, so `computeInstallState` reported a model `installed` with shards
// 2-4 missing or corrupt, and download/prefetch/ETA accounting plus `verifyDriveModels` counted
// a third of the real weight. The F1 block that stood here was a CATALOG regression guard for
// that class — a shard-pattern path was simply banned. The schema now expresses the whole set
// (`files:`) and the validator refuses a partial or inconsistent declaration, so the ban is
// replaced by the real thing: a declared shard set is legal and verified, an undeclared one
// cannot validate at all. Never an id allowlist.
//
// The Flash-Next id/name and family assertions below stay — those are #311's containment
// (catalog membership), not this issue's verification story.
//
// The reviewed head of PR #302 carried a second commit (883f5e40) adding a Flash-Next chat
// manifest with shards 2-4 only in YAML comments. It stays on feat/qwen38-flash-next-manifest and
// lands under #311; its refusal is proved at the owner, unit/manifest "rejects a shard-1
// local_path with no files: list at all".
const SHARDED_GGUF_RE = /-(\d{5})-of-(\d{5})\.gguf$/i

/** The id the split removed from this PR (883f5e40 → `feat/qwen38-flash-next-manifest`). */
const FLASH_NEXT_ID = 'qwen3.8-flash-next-ud-q4kxl'

/**
 * Every weight/projector path a set of manifests declares, drive-relative. Enumeration goes
 * through the PRODUCTION `manifestFiles()` — the same list install state, the checksum gate,
 * `verifyDriveModels` and the startup byte accounting iterate — so a future manifest slot that
 * carries a file (a third kind, say) is covered here the moment the app knows about it, and a
 * slot the app does NOT enumerate is honestly reported as unguarded rather than assumed safe.
 * `manifestFiles()` wants a drive root only to build absolute paths; `tmpdir()` is a real
 * absolute path on every platform and nothing here touches the filesystem.
 */
function declaredFilePaths(manifests: ModelManifest[]): string[] {
  return manifests.flatMap((m) => manifestFiles(tmpdir(), m).map((f) => f.localPath))
}

/** Every sibling a declared shard path implies that the same manifest does not declare. */
function incompleteSeries(manifests: ModelManifest[]): string[] {
  const incomplete: string[] = []
  for (const m of manifests) {
    const declared = declaredFilePaths([m])
    for (const p of declared) {
      const hit = SHARDED_GGUF_RE.exec(p)
      if (!hit) continue
      const stem = p.slice(0, hit.index)
      const total = Number(hit[2])
      for (let n = 1; n <= total; n++) {
        const sibling = `${stem}-${String(n).padStart(5, '0')}-of-${hit[2]}.gguf`
        if (!declared.includes(sibling)) incomplete.push(`${m.id}: ${sibling} is not declared`)
      }
    }
  }
  return incomplete
}

// The `qwen3.8` family as committed at the integration base (bfdb514a): the three static
// K-quants plus the three Dynamic UD quants. Flash-Next declares `family: qwen3.8` too, so
// pinning this ONE family's membership expresses "nothing was added to or removed from the
// family the split touched" without freezing the whole chat catalog (new models in other
// families stay a normal, test-free addition — the facts table at the top pins the current ones).
const QWEN38_FAMILY_IDS = [
  'qwen3.8-27b-q4',
  'qwen3.8-27b-q5',
  'qwen3.8-27b-q6',
  'qwen3.8-27b-ud-q4km',
  'qwen3.8-27b-ud-q5km',
  'qwen3.8-27b-ud-q6k'
]

describe('committed catalog — prompt cache on for every chat model (#512)', () => {
  // Owner decision 1: on b11146 qwen3.5 and gemma4 restore an evicted prompt (measured), and
  // qwen3.6/qwen3.8 are ON by ruling pending the rig check. `disable_prompt_cache: true` is for a
  // model the manual prompt-cache smoke shows cannot restore; setting it here needs that evidence.
  it('no committed manifest sets disable_prompt_cache', () => {
    expect(committedManifests().filter((m) => m.disablePromptCache).map((m) => m.id)).toEqual([])
  })
})

describe('committed catalog — every multi-file weight is fully declared (#310)', () => {
  it('does not carry the Flash-Next manifest split out of PR #302', () => {
    const manifests = committedManifests()
    const ids = manifests.map((m) => m.id)
    expect(ids, 'the split id is absent').not.toContain(FLASH_NEXT_ID)
    // Also catch a re-add under a different id/quant: the family+name pair is the model.
    expect(
      manifests.filter((m) => /flash-next/i.test(m.id) || /flash[- ]?next/i.test(m.displayName)),
      'no Flash-Next manifest under any id'
    ).toEqual([])
  })

  it('keeps the qwen3.8 family at exactly the six committed 27B quants', () => {
    const ids = committedManifests()
      .filter((m) => m.family === 'qwen3.8')
      .map((m) => m.id)
      .sort()
    expect(ids).toEqual([...QWEN38_FAMILY_IDS].sort())
  })

  // The real coverage that replaces the ban. Every committed manifest validates (asserted at
  // `committedManifests()`), and the validator now REFUSES a shard-pattern `local_path` without
  // a complete `files:` list — so an undeclared shard set cannot be in the catalog at all. This
  // states the property directly over the production enumeration, series by series, so it also
  // covers a shard path reached through any other manifest slot.
  // No committed path is sharded today, so this reads nothing until one is: the control below shows it firing.
  it('declares no shard-pattern path whose sibling series is incomplete', () => {
    expect(incompleteSeries(committedManifests())).toEqual([])
  })

  // The validator's shard rule reads `local_path` only, so this check is the one thing watching a sharded projector.
  it('the series check fires on a sharded projector with a missing sibling, and clears once it is declared (control)', () => {
    const mmproj = { local_path: 'models/vision/p-00001-of-00002.gguf', sha256: 'x' }
    const sibling = 'models/vision/p-00002-of-00002.gguf'
    const half = validManifest({ id: 'sharded-projector', role: 'vision', mmproj })
    expect(incompleteSeries([half])).toEqual([`sharded-projector: ${sibling} is not declared`])
    const whole = validManifest({ id: 'sharded-projector', role: 'vision', mmproj, files: [{ local_path: sibling, sha256: 'x' }] })
    expect(incompleteSeries([whole])).toEqual([])
  })

  // Control: the series check can only judge what the enumeration lists. Multi-file entries today: the vision model (mmproj) and the transcriber (its files: list, #504).
  it('enumerates the projector path too, so a sharded mmproj could not slip past', () => {
    const manifests = committedManifests()
    const vision = manifests.filter((m) => m.role === 'vision')
    expect(vision.length, 'one vision manifest').toBe(1)
    expect(declaredFilePaths(vision), 'GGUF + mmproj').toEqual([vision[0].localPath, vision[0].mmproj!.localPath])
    // Every manifest contributes at least its own weight path (no silently empty enumeration).
    expect(declaredFilePaths(manifests).length).toBeGreaterThanOrEqual(manifests.length)
  })
})

// PR #302 P4 — the real-catalog grouping controls the audit ran as probes (O10) and the adapted
// F5 face assertion. These build the ACTUAL list the renderer receives (`buildModelList` over the
// committed manifests) so a catalog change that merged two models into one card, split a family
// apart, or left a group fronting a withdrawn weight fails CI rather than a user's drive.
//
// `rootPath` is a throwaway temp directory: no weights exist under it, so every entry comes back
// `missing` — which is exactly the fresh-drive state these controls describe.
describe('committed catalog — variant grouping as the library renders it (PR #302 O10/F5)', () => {
  const RAM_16_GB = 16

  async function libraryModels(): Promise<ModelInfo[]> {
    const rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-catalog-group-'))
    try {
      const { models } = await buildModelList({
        manifestsDir: CATALOG_MANIFESTS,
        rootPath,
        developerMode: false,
        machineRamGb: RAM_16_GB
      })
      return models
    } finally {
      rmSync(rootPath, { recursive: true, force: true })
    }
  }

  it('collapses into exactly three multi-member variant groups — no false merges (O10)', async () => {
    const models = await libraryModels()
    const all = groupModelVariants(models)
    // Every catalog model lands in exactly one group.
    expect(all.flatMap((g) => g.models.map((m) => m.id)).sort()).toEqual(models.map((m) => m.id).sort())
    const groups = all.filter((g) => g.models.length > 1)
    expect(groups.map((g) => [g.name, g.models.length]).sort()).toEqual([
      ['Qwen3.5 9B', 2],
      ['Qwen3.6 27B', 2],
      ['Qwen3.8 27B', 6]
    ])
  })

  // F5 (#196), ADAPTED from the audit probe `catalog-group-review.probe.ts` test 2. The probe
  // asserted `group.models[0].download?.withdrawn` is undefined; the fix is presentation-only, so
  // `group.models[0]` correctly STAYS the withdrawn catalog-first member and that raw assertion
  // can never pass. The assertion moves to `variantGroupFace(group)` — the member the collapsed
  // group actually shows — and the unchanged raw order is asserted alongside it.
  it('fronts the tied 16 GB Qwen3.8 27B group with an obtainable variant', async () => {
    const models = orderPickerModels(await libraryModels())
    const group = groupModelVariants(models).find((g) => g.name === 'Qwen3.8 27B')
    expect(group, 'the Qwen3.8 27B variant group exists').toBeTruthy()
    expect(group!.models).toHaveLength(6)

    // Preconditions: a six-way tie on all three ordering keys, so only catalog order separates
    // them — the exact situation that let a withdrawn weight front the group.
    expect(
      group!.models.every((m) => m.insufficientRam && !m.recommended && m.state === 'missing')
    ).toBe(true)
    expect(group!.models.some((m) => m.download && !m.download.withdrawn)).toBe(true)

    // The sort itself is untouched: the catalog-first member is still the withdrawn one.
    expect(group!.models[0].download?.withdrawn).toBeTruthy()

    // What the user sees on the collapsed card can actually be downloaded.
    const face = variantGroupFace(group!)
    expect(face.download, `${face.id} offers a download`).toBeTruthy()
    expect(face.download!.withdrawn, `${face.id} is not withdrawn`).toBeUndefined()
    // Presentation exception only — the face is a member of the group, not a new entry.
    expect(group!.models).toContain(face)
  })
})
