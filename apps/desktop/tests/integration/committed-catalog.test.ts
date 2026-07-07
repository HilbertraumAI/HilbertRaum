import { describe, it, expect } from 'vitest'
import {
  discoverManifests,
  resolveManifestsDir,
  recommendModelIdByRam
} from '../../src/main/services/models'
import { isRealSha256, type ModelManifest } from '../../src/shared/manifest'

// The COMMITTED model-manifests/ tree is what a real drive is provisioned from. These tests
// assert invariants directly against the on-disk catalog (mirrors the committed
// runtime-sources.yaml tests in assets.test.ts) — so a malformed or mis-promoted manifest
// fails CI, not a user's drive.
function committedManifests(): ModelManifest[] {
  const dir = resolveManifestsDir(process.cwd())
  if (!dir) throw new Error('could not locate model-manifests from the repo')
  const { manifests, errors } = discoverManifests(dir)
  // Every committed manifest must validate cleanly (no skipped/erroring files).
  expect(errors).toEqual([])
  return manifests.map((m) => m.manifest)
}

// The Qwen3.5 Unsloth wave (model-policy.md "Qwen3.5 Unsloth wave"): the 4B incumbent plus the
// 9B / 27B / 35B-A3B additions. All are text-only chat models, rank 0, not bundled, not
// auto-recommended until the offline benchmark + b9849 runtime smoke promote them.
const QWEN35_WAVE_IDS = [
  'qwen3.5-4b-ud-q4kxl',
  'qwen3.5-9b-ud-q4kxl',
  'qwen3.5-27b-ud-q4kxl',
  'qwen3.5-35b-a3b-ud-q4kxl'
]

describe('committed catalog — Qwen3.5 Unsloth wave', () => {
  it('all four Qwen3.5 wave manifests are present and validate', () => {
    const ids = new Set(committedManifests().map((m) => m.id))
    for (const id of QWEN35_WAVE_IDS) expect(ids.has(id), `${id} present`).toBe(true)
  })

  it('every Qwen3.5 wave manifest holds the wave invariants', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    for (const id of QWEN35_WAVE_IDS) {
      const m = byId[id]
      expect(m, id).toBeDefined()
      // role / runtime — the chat pipeline only.
      expect(m.role, `${id} role`).toBe('chat')
      expect(m.runtime, `${id} runtime`).toBe('llama_cpp')
      expect(m.format, `${id} format`).toBe('gguf')
      expect(m.family, `${id} family`).toBe('qwen3.5')
      // Not promoted: rank 0 + no legacy profiles → never auto-recommended (asserted below too).
      expect(m.recommendationRank, `${id} rank`).toBe(0)
      expect(m.recommendedProfiles, `${id} profiles`).toEqual([])
      // Apache-2.0, license reviewed + approved (drive-shippable provenance).
      expect(m.license, `${id} license`).toBe('apache-2.0')
      expect(m.licenseReview.status, `${id} review`).toBe('approved')
      // Real top-level hash that matches the download hash (same file). All four carry a hash captured
      // from the actual upstream file: the 4B by download+sha256sum (2026-06-18), the 9B/27B/35B from HF
      // LFS metadata (2026-07-03) after the 27B/35B wave values were found WRONG (BUG dl-size-cap-2026-07-03).
      expect(isRealSha256(m.sha256), `${id} real sha256`).toBe(true)
      expect(m.download, `${id} download block`).toBeDefined()
      expect(m.download!.sha256, `${id} download hash equals top-level`).toBe(m.sha256)
      // Text-only: a chat model never carries an mmproj projector (no vision in chat).
      expect(m.mmproj, `${id} no mmproj`).toBeUndefined()
      // Runtime context is the safe LOCAL budget, NOT the 262,144-token native window — the
      // manifest field is the recommended runtime context, not the theoretical model maximum.
      expect(m.recommendedContextTokens, `${id} ctx not native`).toBeLessThanOrEqual(32768)
    }
  })

  it('the three NEW additions pin recommended_context_tokens to the 8192 local budget', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    for (const id of ['qwen3.5-9b-ud-q4kxl', 'qwen3.5-27b-ud-q4kxl', 'qwen3.5-35b-a3b-ud-q4kxl']) {
      expect(byId[id].recommendedContextTokens, `${id} ctx`).toBe(8192)
    }
  })

  it('the three NEW additions are the 9B, 27B, and 35B-A3B manifests', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    expect(byId['qwen3.5-9b-ud-q4kxl'].displayName).toBe('Qwen3.5 9B (UD-Q4_K_XL)')
    expect(byId['qwen3.5-27b-ud-q4kxl'].displayName).toBe('Qwen3.5 27B (UD-Q4_K_XL)')
    expect(byId['qwen3.5-35b-a3b-ud-q4kxl'].displayName).toBe('Qwen3.5 35B-A3B (UD-Q4_K_XL)')
    // supports_tools is a display/capability flag only — it must NOT change the role/runtime
    // routing (tool execution stays owned by the Skills/Tier-2 gate, not the model manifest).
    expect(byId['qwen3.5-9b-ud-q4kxl'].role).toBe('chat')
  })

  it('NEVER auto-recommends a rank-0 Qwen3.5 model at any realistic RAM level', () => {
    // recommendModelIdByRam is the production picker (RAM-best-fit + rank tiebreak). With rank 0
    // the new models always lose the tiebreak to a ranked incumbent that also fits — so a
    // Qwen3.5 wave model is never the auto-recommendation until a benchmark gives it a rank.
    const chat = committedManifests()
    const waveSet = new Set(QWEN35_WAVE_IDS)
    for (const ram of [8, 12, 16, 24, 32, 48, 64, 128]) {
      const picked = recommendModelIdByRam(chat, ram, 'chat')
      expect(waveSet.has(picked ?? ''), `ram=${ram} picked=${picked}`).toBe(false)
    }
  })

  it('keeps the existing incumbents in the catalog (no model removed)', () => {
    const ids = new Set(committedManifests().map((m) => m.id))
    for (const id of [
      'qwen3-4b-instruct-q4',
      'ministral3-8b-instruct-2512-q4',
      'gemma4-12b-it-qat-q4',
      'qwen3-14b-instruct-q4',
      'qwen3-30b-a3b-q4'
    ]) {
      expect(ids.has(id), `${id} still present`).toBe(true)
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
