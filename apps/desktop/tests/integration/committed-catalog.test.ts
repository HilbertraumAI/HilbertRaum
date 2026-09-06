import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildModelList,
  discoverManifests,
  manifestFiles,
  resolveManifestsDir,
  recommendChatModelId,
  recommendModelIdByRam
} from '../../src/main/services/models'
import { isRealSha256, type ModelManifest } from '../../src/shared/manifest'
import type { ModelInfo } from '../../src/shared/types'
import { groupModelVariants, variantGroupFace } from '../../src/renderer/lib/modelLibrary'
import { orderPickerModels } from '../../src/renderer/lib/modelAvailability'

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
// 9B / 27B / 35B-A3B additions, and the later fast-tier 2B / 0.8B (issue #48 closed the test
// gap — the fast-tier pair shipped without joining these invariants). All are text-only chat
// models, not bundled. Ranks: the 4B and 9B carry rank 3 since the newest-Qwen promotion
// (owner decision 2026-07-12, model-benchmarks.md §6.4); the 35B-A3B carries rank 1 since the
// wave ratification (owner decision 2026-08-03, §9.3 — hallucination-clean §2 eval + the
// confirmed 3B-active speed case); the rest stay rank 0 (selectable, never auto-recommended).
// Pin ALL so neither an accidental demotion nor a silent promotion slips through.
const QWEN35_WAVE_IDS = [
  'qwen3.5-0.8b-q6',
  'qwen3.5-2b-ud-q4kxl',
  'qwen3.5-4b-ud-q4kxl',
  'qwen3.5-9b-ud-q4kxl',
  'qwen3.5-27b-ud-q4kxl',
  'qwen3.5-35b-a3b-ud-q4kxl'
]

// The committed promotion facts: 2026-07-12 newest-Qwen decision + 2026-08-03 ratification.
const QWEN_WAVE_RANKS: Record<string, number> = {
  'qwen3.5-0.8b-q6': 0,
  'qwen3.5-2b-ud-q4kxl': 0,
  'qwen3.5-4b-ud-q4kxl': 3,
  'qwen3.5-9b-ud-q4kxl': 3,
  'qwen3.5-27b-ud-q4kxl': 0,
  'qwen3.5-35b-a3b-ud-q4kxl': 1
}

describe('committed catalog — Qwen3.5 Unsloth wave', () => {
  it('all six Qwen3.5 wave manifests are present and validate', () => {
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
      // Ranks per the 2026-07-12 promotion record; legacy profiles stay empty for the whole
      // wave (promotion is carried by recommendation_rank, never by the legacy profile table).
      expect(m.recommendationRank, `${id} rank`).toBe(QWEN_WAVE_RANKS[id])
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

  it('NEVER auto-recommends a wave model below the rank-3 promoted pair at any realistic RAM level', () => {
    // recommendModelIdByRam is the production picker (RAM-best-fit + rank tiebreak). The
    // 2026-07-12 promotion covers exactly the 4B and 9B (plus the Qwen3.6 27B pair below);
    // every OTHER wave member — rank 0 AND the ratified rank-1 35B-A3B (a ranked alternative,
    // not a tier pick) — must never be the auto-recommendation.
    const chat = committedManifests()
    const unpromoted = new Set(QWEN35_WAVE_IDS.filter((id) => QWEN_WAVE_RANKS[id] < 3))
    // 14 and 20 joined the sample in the PR-#83 hardening: unsampled odd values are where a
    // rank-0 manifest's RAM mis-edit hides from this guard (see the Gemma wave block).
    for (const ram of [8, 12, 14, 16, 20, 24, 32, 48, 64, 128]) {
      const picked = recommendModelIdByRam(chat, ram, 'chat')
      expect(unpromoted.has(picked ?? ''), `ram=${ram} picked=${picked}`).toBe(false)
    }
  })

  // §6.6 (2026-09-05): on a discrete card the pick is by graphics memory. Pinned per card size
  // against the committed catalog (with RAM ample, so only the card decides).
  it('recommends by graphics memory on a discrete card (real manifests, §6.6)', () => {
    const chat = committedManifests()
    const onCard = (vramGb: number, ramGb = 64): string | null =>
      recommendChatModelId(chat, { memoryClass: 'discrete', ramGb, vramMb: vramGb * 1024 })
    expect(onCard(6)).toBe('qwen3.5-4b-ud-q4kxl')
    expect(onCard(8)).toBe('qwen3.5-9b-ud-q4kxl')
    expect(onCard(12)).toBe('gemma4-12b-it-qat-q4')
    expect(onCard(16)).toBe('gemma4-12b-it-qat-q4')
    expect(onCard(24)).toBe('qwen3.8-27b-ud-q5km')
    expect(onCard(32)).toBe('qwen3.8-27b-ud-q5km')
    expect(onCard(48, 128)).toBe('qwen3.8-27b-ud-q5km')
    // The card decides, not the RAM: an 8 GB card in a 32 GB box still gets the 9B, where the
    // RAM picker would send the 27B to a partial offload.
    expect(onCard(8, 32)).toBe('qwen3.5-9b-ud-q4kxl')
    expect(recommendModelIdByRam(chat, 32, 'chat')).toBe('qwen3.8-27b-ud-q5km')
    // RAM stays a hard gate: a 24 GB card in a 16 GB box cannot run the 27B (min RAM 23).
    expect(onCard(24, 16)).not.toBe('qwen3.8-27b-ud-q5km')
  })

  it('the card pick NEVER lands on an opt-in / loser / rank-0 model either (§6.3 carries over)', () => {
    const chat = committedManifests()
    for (const vram of [6, 8, 12, 16, 20, 24, 32, 48, 96]) {
      for (const ram of [16, 32, 64, 128]) {
        const id = recommendChatModelId(chat, { memoryClass: 'discrete', ramGb: ram, vramMb: vram * 1024 })
        expect(id, `card=${vram} ram=${ram}`).not.toBe('qwen3-30b-a3b-q4')
        expect(id, `card=${vram} ram=${ram}`).not.toBe('granite-4.1-8b-q4')
        expect(id, `card=${vram} ram=${ram}`).not.toBe('qwen3.5-35b-a3b-ud-q4kxl')
        expect(id, `card=${vram} ram=${ram}`).not.toBe('qwen3.8-27b-q6')
        expect(id, `card=${vram} ram=${ram}`).not.toBe('qwen3.8-27b-ud-q6k')
      }
    }
  })

  it('keeps the existing incumbents in the catalog (no model removed)', () => {
    const ids = new Set(committedManifests().map((m) => m.id))
    for (const id of [
      'qwen3-4b-instruct-q4',
      'qwen3-4b-instruct-2507-q4',
      'ministral3-8b-instruct-2512-q4',
      'gemma4-12b-it-qat-q4',
      'qwen3-14b-instruct-q4',
      'qwen3-30b-a3b-q4'
    ]) {
      expect(ids.has(id), `${id} still present`).toBe(true)
    }
  })
})

// The Qwen3.6 27B pair: productized from local-test stubs and promoted to rank 3 in the
// newest-Qwen decision (owner, 2026-07-12, model-benchmarks.md §6.4). These are the #48 tester
// eval's top quality scorers, and the only promoted models whose promotion the eval AGREES
// with — pin the full promotion facts so a mis-edit fails CI, not a user's drive. The pair
// carries rank 3 AGAIN since 2026-08-20 (issue #196, §9.5): the Qwen3.8 wave that took the two
// tiers on 2026-08-16 lost its upstream files, and the tiers came back to the best-measured
// models that can still be downloaded.
describe('committed catalog — Qwen3.6 27B pair (2026-07-12 promotion; rank 3 again since #196)', () => {
  it('both Qwen3.6 manifests hold the productization + tier-pick invariants', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    for (const id of ['qwen3.6-27b-q4', 'qwen3.6-27b-q5']) {
      const m = byId[id]
      expect(m, id).toBeDefined()
      expect(m.role, `${id} role`).toBe('chat')
      expect(m.runtime, `${id} runtime`).toBe('llama_cpp')
      expect(m.format, `${id} format`).toBe('gguf')
      expect(m.family, `${id} family`).toBe('qwen3.6')
      // Ranks after the #196 successor wave (2026-08-20, measured, owner-ratified; §9.5):
      // both tiers went back to the Qwen3.8 successors (the full §9.4 generational handover
      // restored), so the pair returns to rank 1. The q4's measured decode advantage over the
      // UD successor (40.1 vs 32.4 t/s) is recorded in its manifest; the owner call weighed
      // the newest generation ahead at quality inside cross-run uncertainty.
      expect(m.recommendationRank, `${id} rank`).toBe(1)
      // …and its own source must still be fetchable — the whole point of taking the tier back.
      expect(m.download!.withdrawn, `${id} source live`).toBeUndefined()
      expect(m.recommendedProfiles, `${id} profiles`).toEqual([])
      expect(m.license, `${id} license`).toBe('apache-2.0')
      expect(m.licenseReview.status, `${id} review`).toBe('approved')
      // Productized: real upstream hash (HF LFS OID) + a download block carrying the same hash.
      expect(isRealSha256(m.sha256), `${id} real sha256`).toBe(true)
      expect(m.download, `${id} download block`).toBeDefined()
      expect(m.download!.sha256, `${id} download hash equals top-level`).toBe(m.sha256)
      expect(m.mmproj, `${id} no mmproj`).toBeUndefined()
      expect(m.recommendedContextTokens, `${id} ctx not native`).toBeLessThanOrEqual(32768)
    }
    // The tier split the original promotion rested on: Q4 in the 24 GB capacity group, Q5 in 32.
    expect(byId['qwen3.6-27b-q4'].recommendedRamGb, 'Q4 comfortable tier').toBe(24)
    expect(byId['qwen3.6-27b-q5'].recommendedRamGb, 'Q5 comfortable tier').toBe(32)
  })
})

// The Qwen3.8 wave (2026-08-16 promotion; model-benchmarks.md §9.4): three unsloth quants of
// Qwen3.8-27B, productized with real HF-LFS hashes on day one. All three carry rank 0 SINCE
// 2026-08-20 (issue #196, §9.5): unsloth deleted the static K-quants in their Dynamic 3.0
// restructure, so the pinned files 404 and a fresh drive cannot obtain them. The MEASUREMENTS
// are unchanged and the manifests stay as installed-base records — rank 0 only stops the picker
// from recommending what can no longer be downloaded (q6 was rank 0 by design anyway: the
// "24 GB GPU quality ceiling" selectable, the gemma4-31b precedent). No UD-Q4_K_XL manifest:
// measured slower than q5 at equal quality (§9.4).
const QWEN38_WAVE_FACTS: Record<
  string,
  { rank: number; minRam: number; recRam: number; displayName: string }
> = {
  'qwen3.8-27b-q4': { rank: 0, minRam: 21, recRam: 24, displayName: 'Qwen3.8 27B Q4_K_M' },
  'qwen3.8-27b-q5': { rank: 0, minRam: 23, recRam: 32, displayName: 'Qwen3.8 27B Q5_K_M' },
  'qwen3.8-27b-q6': { rank: 0, minRam: 26, recRam: 32, displayName: 'Qwen3.8 27B Q6_K' }
}

describe('committed catalog — Qwen3.8 wave (2026-08-16 promotion, §9.4)', () => {
  it('all three Qwen3.8 manifests hold the productization + promotion invariants', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    for (const [id, facts] of Object.entries(QWEN38_WAVE_FACTS)) {
      const m = byId[id]
      expect(m, id).toBeDefined()
      expect(m.role, `${id} role`).toBe('chat')
      expect(m.runtime, `${id} runtime`).toBe('llama_cpp')
      expect(m.format, `${id} format`).toBe('gguf')
      expect(m.family, `${id} family`).toBe('qwen3.8')
      expect(m.recommendationRank, `${id} rank`).toBe(facts.rank)
      expect(m.recommendedMinRamGb, `${id} min RAM`).toBe(facts.minRam)
      expect(m.recommendedRamGb, `${id} rec RAM`).toBe(facts.recRam)
      expect(m.displayName, `${id} display name`).toBe(facts.displayName)
      expect(m.recommendedProfiles, `${id} profiles`).toEqual([])
      expect(m.license, `${id} license`).toBe('apache-2.0')
      expect(m.licenseReview.status, `${id} review`).toBe('approved')
      expect(isRealSha256(m.sha256), `${id} real sha256`).toBe(true)
      expect(m.download, `${id} download block`).toBeDefined()
      expect(m.download!.sha256, `${id} download hash equals top-level`).toBe(m.sha256)
      expect(m.mmproj, `${id} no mmproj`).toBeUndefined()
      expect(m.recommendedContextTokens, `${id} ctx local budget`).toBe(8192)
    }
  })

  // Issue #182 (§9.4 MTP addendum): the draft head costs ~2 GiB VRAM, so exactly the two
  // quants that keep 24 GB headroom opt in. Q6_K peaks at 22.7 GiB on a 24 GB card at ctx
  // 8192 — its VRAM fit IS its reason to exist, and MTP would spend it. The runtime's VRAM
  // guard would refuse it anyway; this pins the DECISION so nobody "fixes" the asymmetry.
  it('opts exactly the Q4 and Q5 quants into MTP speculative decoding — never the Q6_K', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    expect(byId['qwen3.8-27b-q4'].speculativeDecoding).toBe('mtp')
    expect(byId['qwen3.8-27b-q5'].speculativeDecoding).toBe('mtp')
    expect(byId['qwen3.8-27b-q6'].speculativeDecoding).toBeUndefined()
  })

  it('no OTHER committed manifest claims a draft head it does not ship', () => {
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
    for (const id of Object.keys(QWEN38_WAVE_FACTS)) {
      const dl = byId[id].download!
      expect(dl.withdrawn, `${id} withdrawn note`).toMatch(/^2026-08-20: unsloth removed/)
      // The dead URL + hash + size are KEPT: they are the provenance record of the file that
      // existing drives carry, and that copy still verifies against this manifest.
      expect(dl.url, `${id} url kept`).toContain('huggingface.co/unsloth/Qwen3.8-27B-GGUF')
      expect(dl.sizeBytes, `${id} size kept`).toBeGreaterThan(0)
      // The fetch scripts read this value with a flat-YAML parser that strips inline comments
      // at " #" — a note containing one would be silently truncated mid-sentence.
      expect(dl.withdrawn, `${id} no " #" in the note`).not.toContain(' #')
    }
  })

  // The general rule, not just this wave: a model the app cannot obtain must never be the
  // auto-pick. Rank 0 is the established "selectable, never recommended" convention.
  it('no committed manifest is both recommended and unobtainable', () => {
    const offenders = committedManifests()
      .filter((m) => m.download?.withdrawn && m.recommendationRank > 0)
      .map((m) => m.id)
    expect(offenders).toEqual([])
  })

  it('hands both big tiers to the measured UD successors (no-signal mapping)', () => {
    const chat = committedManifests()
    // #196 successor wave (2026-08-20, measured, owner-ratified): the full §9.4 generational
    // handover is restored with the successors. 24 GB goes to qwen3.8-27b-ud-q4km (the
    // measured 19 percent decode regression vs the withdrawn file is recorded and accepted);
    // >=32 GB goes to qwen3.8-27b-ud-q5km, which reproduces the withdrawn file's envelope.
    expect(recommendModelIdByRam(chat, 24, 'chat')).toBe('qwen3.8-27b-ud-q4km')
    for (const ram of [32, 48, 64, 128]) {
      expect(recommendModelIdByRam(chat, ram, 'chat'), `ram=${ram}`).toBe('qwen3.8-27b-ud-q5km')
    }
    // No WITHDRAWN Qwen3.8 manifest may be the auto-pick at ANY realistic RAM level (the UD
    // successors are separate ids with live sources and may hold tiers).
    for (const ram of [8, 12, 14, 16, 20, 24, 26, 32, 48, 64, 128]) {
      expect(
        Object.keys(QWEN38_WAVE_FACTS),
        `ram=${ram}`
      ).not.toContain(recommendModelIdByRam(chat, ram, 'chat'))
    }
    // Below 24 nothing changed (min-21 q4 never leaked into the 16-20 band either).
    expect(recommendModelIdByRam(chat, 16, 'chat')).toBe('qwen3.5-9b-ud-q4kxl')
    expect(recommendModelIdByRam(chat, 20, 'chat')).toBe('qwen3.5-9b-ud-q4kxl')
  })

  it('NEVER auto-recommends the rank-0 Q6_K at any realistic RAM level, with or without a slow signal', () => {
    const chat = committedManifests()
    for (const ram of [8, 12, 14, 16, 20, 24, 26, 32, 48, 64, 128]) {
      expect(recommendModelIdByRam(chat, ram, 'chat'), `ram=${ram}`).not.toBe('qwen3.8-27b-q6')
      const slow = {
        tokensPerSecond: 2.0,
        measuredModelId: recommendModelIdByRam(chat, ram, 'chat')
      }
      expect(recommendModelIdByRam(chat, ram, 'chat', slow), `ram=${ram} slow`).not.toBe(
        'qwen3.8-27b-q6'
      )
    }
  })
})

// The Gemma 4 QAT wave (model-policy.md "Gemma 4 QAT wave", issue #82): the four official
// Google QAT Q4_0 additions around the shipped 12B winner. Text-only chat, not bundled.
// Ranks per the 2026-08-03 wave ratification (model-benchmarks.md §9.3 wave outcome), amended
// 2026-08-09: the 26B-A4B carries rank 2 (ranked runner-up to the rank-3 qwen3.6-27b-q4 — EM
// parity + zero hallucinations at ~4x the speed, F1 under it); E2B carries rank 3 since the
// issue-#153 promotion (the weak-16 GB-box datapoint landed: 17.0 tok/s settled vs the previous
// 12 GB pick qwen3.5-4b's 9.0 on the designated class, F1 .3373 vs .2728 — E2B wins the sub-16
// band it now defines, rec-RAM retuned 16 → 12); E4B stays 0 (missed the 8B bar), 31B stays 0
// (issue-#82 drop condition met — never promote). Only the rank-3 E2B may be the auto-pick
// (asserted below).
const GEMMA4_WAVE_IDS = [
  'gemma4-e2b-it-qat-q4',
  'gemma4-e4b-it-qat-q4',
  'gemma4-26b-a4b-it-qat-q4',
  'gemma4-31b-it-qat-q4'
]

// The committed rank facts: 2026-08-03 ratification + the 2026-08-09 issue-#153 E2B promotion.
const GEMMA4_WAVE_RANKS: Record<string, number> = {
  'gemma4-e2b-it-qat-q4': 3,
  'gemma4-e4b-it-qat-q4': 0,
  'gemma4-26b-a4b-it-qat-q4': 2,
  'gemma4-31b-it-qat-q4': 0
}

// The committed RAM lines and display names. RAM is pinned because a silent mis-edit here is
// exactly how a rank-0 model becomes an auto-pick (a UNIQUE low recommended_ram_gb slips past
// the preferRanked guard at RAM levels the sample misses) or gets locked out of machines it
// fits; display names are pinned per the Qwen3.5 precedent so a copy-paste swap can't mislabel
// the picker UI. E2B's rec-RAM is 12 SINCE the #153 promotion — the same value whose earlier
// accidental appearance on the then-rank-0 manifest this block caught as a hijack; ranked, it
// is the deliberate sub-16 capacity band (and the §6.5 step-down's 16–20 GB landing tier).
const GEMMA4_WAVE_FACTS: Record<string, { minRam: number; recRam: number; displayName: string }> = {
  'gemma4-e2b-it-qat-q4': { minRam: 8, recRam: 12, displayName: 'Gemma 4 E2B Instruct QAT Q4' },
  'gemma4-e4b-it-qat-q4': { minRam: 12, recRam: 16, displayName: 'Gemma 4 E4B Instruct QAT Q4' },
  'gemma4-26b-a4b-it-qat-q4': {
    minRam: 20,
    recRam: 32,
    displayName: 'Gemma 4 26B-A4B Instruct QAT Q4'
  },
  'gemma4-31b-it-qat-q4': { minRam: 24, recRam: 32, displayName: 'Gemma 4 31B Instruct QAT Q4' }
}

describe('committed catalog — Gemma 4 QAT wave (issue #82)', () => {
  it('all four Gemma 4 QAT wave manifests are present and validate', () => {
    const ids = new Set(committedManifests().map((m) => m.id))
    for (const id of GEMMA4_WAVE_IDS) expect(ids.has(id), `${id} present`).toBe(true)
  })

  it('every Gemma 4 QAT wave manifest holds the wave invariants', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    for (const id of GEMMA4_WAVE_IDS) {
      const m = byId[id]
      expect(m, id).toBeDefined()
      // role / runtime — the chat pipeline only.
      expect(m.role, `${id} role`).toBe('chat')
      expect(m.runtime, `${id} runtime`).toBe('llama_cpp')
      expect(m.format, `${id} format`).toBe('gguf')
      expect(m.family, `${id} family`).toBe('gemma4')
      // Ranks per the 2026-08-03 ratification (26B-A4B rank 2, rest 0); legacy profiles stay
      // empty — none of the wave is ever auto-recommended (asserted below too).
      expect(m.recommendationRank, `${id} rank`).toBe(GEMMA4_WAVE_RANKS[id])
      expect(m.recommendedProfiles, `${id} profiles`).toEqual([])
      // Apache-2.0 (Gemma 4 is the Apache generation), review approved (official Google QAT —
      // first-party provenance, drive-shippable). Distinct from the two local-test Gemma stubs
      // (gemma-4-26b-q4 / gemma4-coding-q8: license "gemma", no download block, unverified hash).
      expect(m.license, `${id} license`).toBe('apache-2.0')
      expect(m.licenseReview.status, `${id} review`).toBe('approved')
      // Real hashes: pinned from HF LFS OIDs and confirmed against real downloads for
      // E2B/E4B/26B-A4B by the 2026-07-23 fetch-models run (SHA-256-verified on disk).
      expect(isRealSha256(m.sha256), `${id} real sha256`).toBe(true)
      expect(m.download, `${id} download block`).toBeDefined()
      expect(m.download!.sha256, `${id} download hash equals top-level`).toBe(m.sha256)
      // Text-only: the upstream repos ship mmproj projectors we deliberately do not reference.
      expect(m.mmproj, `${id} no mmproj`).toBeUndefined()
      // The 8192 local runtime budget (the wave convention, matching the 12B).
      expect(m.recommendedContextTokens, `${id} ctx`).toBe(8192)
      // RAM + display-name pins (the Qwen3.6 precedent, extended per the PR-#83 merge review).
      expect(m.recommendedMinRamGb, `${id} min RAM`).toBe(GEMMA4_WAVE_FACTS[id].minRam)
      expect(m.recommendedRamGb, `${id} comfortable RAM`).toBe(GEMMA4_WAVE_FACTS[id].recRam)
      expect(m.displayName, `${id} display name`).toBe(GEMMA4_WAVE_FACTS[id].displayName)
      // Deep-mode gate: the wave ships supports_thinking_mode true (12B-verified template
      // family; per-size suppression smoke pending, model-benchmarks.md §9.3) — a dropped
      // flag would silently remove Deep for the model with no other CI signal.
      expect(m.supportsThinkingMode, `${id} thinking flag`).toBe(true)
    }
  })

  it('NEVER auto-recommends a below-rank-3 Gemma 4 wave model at any realistic RAM level', () => {
    // A rank-0 model with a UNIQUE recommended_ram_gb below every ranked model's would become
    // the only "comfortable fit" at that RAM level and slip past the preferRanked guard —
    // exactly what happened when the then-rank-0 E2B briefly declared 12 (since the #153
    // promotion the rank-3 E2B holds rec-12 deliberately and is EXCLUDED here — its positive
    // pins live in the test below). 14 and 20 are deliberately in the sample: unsampled odd
    // values are where a RAM mis-edit hides (a rec of 13–15 would win ram=14 unseen), and 20
    // is the 26B-A4B's own hard-min boundary introduced by this wave. Since the 2026-08-03
    // ratification this deliberately includes the rank-2 26B-A4B: a ranked runner-up must
    // still lose every tier to the rank-3 holders (qwen3.8-27b-q4 at 24 GB, qwen3.8-27b-q5
    // at ≥32 GB since the 2026-08-16 §9.4 handover).
    const chat = committedManifests()
    const waveSet = new Set(GEMMA4_WAVE_IDS.filter((id) => GEMMA4_WAVE_RANKS[id] < 3))
    for (const ram of [8, 12, 14, 16, 20, 24, 32, 48, 64, 128]) {
      const picked = recommendModelIdByRam(chat, ram, 'chat')
      expect(waveSet.has(picked ?? ''), `ram=${ram} picked=${picked}`).toBe(false)
    }
  })

  it('the promoted E2B owns exactly the sub-16 comfortable band (#153 promotion pins)', () => {
    // The two RAM points the #153 promotion CHANGED (base mapping): 12 and the unsampled-odd
    // guard point 14 both fit E2B's retuned rec-12 comfortably and nothing else ranked fits
    // below 16. The neighbors are pinned unchanged on both sides: 8 stays the runnable-stage
    // qwen3.5-4b (min-8 tie → rank tie → disk-asc, 2.9 GB < 3.3 GB), 16 stays the 16-band
    // rank-3 winner 9B (capacity-first: the 16 tier outranks the 12 tier at ram=16).
    const chat = committedManifests()
    expect(recommendModelIdByRam(chat, 8, 'chat')).toBe('qwen3.5-4b-ud-q4kxl')
    expect(recommendModelIdByRam(chat, 12, 'chat')).toBe('gemma4-e2b-it-qat-q4')
    expect(recommendModelIdByRam(chat, 14, 'chat')).toBe('gemma4-e2b-it-qat-q4')
    expect(recommendModelIdByRam(chat, 16, 'chat')).toBe('qwen3.5-9b-ud-q4kxl')
  })

  it('the shipped 12B winner keeps its Phase-29 rank next to the wave', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    // The wave must not disturb the ranked incumbent it challenges.
    expect(byId['gemma4-12b-it-qat-q4'].recommendationRank, '12B rank').toBe(2)
  })
})

// §6.5 speed-signal step-down (issue #95) against the REAL committed catalog: a sub-threshold
// crawl measured on the tier's own pick steps the recommendation exactly one capacity band
// down. The no-signal mapping is pinned separately ("NEVER auto-recommends…" + the #153 pins
// above + benchmark.test.ts's 8/12/16/20/24/32 table) — these rows only pin the stepped picks.
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

  it('still NEVER lands on a rank-0 or below-rank-3 wave model with a slow signal', () => {
    const chat = committedManifests()
    const neverAutoPick = new Set([
      ...QWEN35_WAVE_IDS.filter((id) => QWEN_WAVE_RANKS[id] < 3),
      ...GEMMA4_WAVE_IDS.filter((id) => GEMMA4_WAVE_RANKS[id] < 3)
    ])
    for (const ram of [8, 12, 14, 16, 20, 24, 32, 48, 64, 128]) {
      const picked = recommendModelIdByRam(chat, ram, 'chat', slowOnOwnPick(chat, ram))
      expect(neverAutoPick.has(picked ?? ''), `ram=${ram} picked=${picked}`).toBe(false)
    }
  })
})

// full-audit 2026-07-12 TQ-2: the 2507 refresh is the one RANKED (auto-recommendable) chat
// manifest that carried no named CI invariant — a rank/license/hash mis-edit or an accidental
// deletion passed the suite (issue #48 closed exactly this gap for the fast-tier pair; this
// closes it one manifest over). Values below are the manifest's COMMITTED promotion facts
// (Phase-29 D18, model-policy.md "Chat (better 4B)" row), not aspirations.
describe('committed catalog — qwen3-4b-instruct-2507-q4 invariants (TQ-2)', () => {
  it('the 2507 refresh holds its Phase-29 promotion values', () => {
    const byId = Object.fromEntries(committedManifests().map((m) => [m.id, m]))
    const m = byId['qwen3-4b-instruct-2507-q4']
    expect(m, 'manifest present').toBeDefined()
    expect(m.role, 'role').toBe('chat')
    expect(m.family, 'family').toBe('qwen3')
    expect(m.runtime, 'runtime').toBe('llama_cpp')
    expect(m.format, 'format').toBe('gguf')
    // Phase-29 user decision: the ORIGINAL 4B (rank 2, hybrid thinking → Deep) stays the
    // catalog default; 2507 is the better-RAG manual pick ranked just BELOW it (rank 1).
    // Pin BOTH ranks so the ordering (not just one number) can't silently invert.
    expect(m.recommendationRank, '2507 rank').toBe(1)
    expect(byId['qwen3-4b-instruct-q4'].recommendationRank, 'original 4B rank').toBe(2)
    expect(m.recommendedProfiles, 'no legacy profiles').toEqual([])
    // Apache-2.0, review approved (drive-shippable provenance), real verified hash.
    expect(m.license, 'license').toBe('apache-2.0')
    expect(m.licenseReview.status, 'license review').toBe('approved')
    expect(isRealSha256(m.sha256), 'real sha256').toBe(true)
    expect(m.download?.sha256, 'download hash equals top-level').toBe(m.sha256)
    expect(m.mmproj, 'text-only chat model').toBeUndefined()
  })

  // The four single-per-role manifests (+ vision) share the thin-coverage gap but churn far
  // less; a presence + real-hash pin is the cheap half that catches deletion/hash mis-edits.
  // License posture is deliberately NOT pinned here: TranslateGemma's `pending` is a standing
  // owner decision (the mechanical sell-gate guard) — pinning statuses would freeze that.
  it('each non-chat role ships exactly its one known manifest with a real hash', () => {
    const manifests = committedManifests()
    const expected: Record<string, string> = {
      embeddings: 'multilingual-e5-small-q8',
      reranker: 'bge-reranker-v2-m3-f16', // manifest id ≠ its filename (bge-reranker-v2-m3.yaml)
      transcriber: 'whisper-small-multilingual',
      translation: 'translategemma-12b-it-q4',
      vision: 'qwen2.5-vl-3b-instruct-q4'
    }
    for (const [role, id] of Object.entries(expected)) {
      const ofRole = manifests.filter((m) => m.role === role)
      expect(ofRole.map((m) => m.id), `${role} manifest set`).toEqual([id])
      expect(isRealSha256(ofRole[0].sha256), `${id} real sha256`).toBe(true)
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
  // below 1024 tok/GB (tightest: gemma4-coding-q8, 16384 @ 16 → 1024), so 2048 leaves 2x headroom;
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
    for (const m of committedManifests()) {
      const sizeBytes = m.download?.sizeBytes
      if (sizeBytes == null || sizeBytes <= 0) continue
      const decimalGb = sizeBytes / 1e9
      expect(
        Math.abs(m.sizeOnDiskGb - decimalGb),
        `${m.id}: size_on_disk_gb (${m.sizeOnDiskGb}) must be decimal GB = size_bytes/1e9 ` +
          `(${decimalGb.toFixed(3)}); a gap this large means GiB was recorded instead of GB`
      ).toBeLessThan(TOLERANCE_GB)
    }
  })
})

// ---------------------------------------------------------------------------------------
// PR #302 (F1) — sharded GGUF entries the catalog cannot honestly verify.
//
// The reviewed head of PR #302 carried a second commit (883f5e40) adding a Flash-Next chat
// manifest whose weight is FOUR GGUF shards. The schema knows the files a manifest DECLARES —
// the top-level `local_path`/`sha256` plus a vision model's `mmproj` — so `manifestFiles()`
// enumerated shard 1 alone: `computeInstallState` reported the model `installed` while shards
// 2-4 were missing or corrupt, the start then failed at load time, and download/prefetch/ETA
// accounting plus `verifyDriveModels` all counted ~1/3 of the real weight. The owner split that
// commit back out of PR #302 (Gate A, 2026-09-05); the manifest stays on its own branch and may
// land only behind real multi-file verification and build containment (follow-up issues I1/I2).
// This block pins the catalog side of that decision.
//
// Deliberately narrow: a CATALOG REGRESSION GUARD over the conventional llama.cpp shard naming
// (`-00001-of-00004.gguf`) that the audited manifest used — not a runtime validator, and not
// proof that arbitrary multi-file weights are safe. It says nothing about a renamed shard set,
// and it does NOT claim one file per manifest (a vision model legitimately declares a GGUF AND
// an mmproj projector). When I1/I2 teach the app to verify every required file, REPLACE this
// guard with that coverage — never just exempt an id.
const SHARDED_GGUF_RE = /-\d{5}-of-\d{5}\.gguf$/i

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

/** The declared paths that name a conventional llama.cpp shard (`…-00001-of-00004.gguf`). */
function shardedGgufPaths(manifests: ModelManifest[]): string[] {
  return declaredFilePaths(manifests).filter((p) => SHARDED_GGUF_RE.test(p))
}

// The `qwen3.8` family as committed at the integration base (bfdb514a): the three static
// K-quants plus the three Dynamic UD quants. Flash-Next declares `family: qwen3.8` too, so
// pinning this ONE family's membership expresses "nothing was added to or removed from the
// family the split touched" without freezing the whole chat catalog (new models in other
// families stay a normal, test-free addition — the per-wave blocks above pin their facts).
const QWEN38_FAMILY_IDS = [
  'qwen3.8-27b-q4',
  'qwen3.8-27b-q5',
  'qwen3.8-27b-q6',
  'qwen3.8-27b-ud-q4km',
  'qwen3.8-27b-ud-q5km',
  'qwen3.8-27b-ud-q6k'
]

// The audited manifest, from `git show 883f5e40:model-manifests/chat/
// qwen3.8-flash-next-ud-q4kxl.yaml` (backticks escaped for the template literal); verbatim YAML
// keys/values; a few private-context comment lines trimmed (P6). It is SCHEMA-VALID — that is
// the point: the guard has to catch a manifest the validator accepts, in an isolated temp
// catalog, never in the real `model-manifests/` tree.
const FLASH_NEXT_MANIFEST_YAML = `
id: qwen3.8-flash-next-ud-q4kxl
display_name: Qwen3.8-Flash-Next 125B-A6B (UD-Q4_K_XL)
family: qwen3.8
role: chat
format: gguf
runtime: llama_cpp
# NOT apache-2.0: Qwen/Qwen3.8-Flash-Next ships under the "Qwen Community License 1.0" (HF card
# tag \`license: other\`, LICENSE blob at the URL in license_review.notes). Permissive for use and
# redistribution, but clause 2 requires a separate Qwen license for any commercial "AI Work
# Assistant" business (a product "primarily designed for AI-assisted coding or office
# productivity"). Whether HilbertRaum's document skills fall under that definition is an open
# legal question, hence \`license_review.status: pending\` and no bundling.
license: qwen-community-1.0
# Four shards, 111,334,654,784 bytes total (HF LFS sizes, matched on disk 2026-09-04).
size_on_disk_gb: 111.3
# MoE: 125B total / ~6B active, plus a ~51 GB N-gram/PLE embedding table (\`ple_ngram_embd\`).
# The weight lives in RAM, not VRAM. With 125 GB the Q4 shards no longer fit the page cache
# completely (light NVMe paging on long sessions); 64 GB machines cannot run it at all.
recommended_min_ram_gb: 120
recommended_ram_gb: 128
# Rank 0 = selectable, never auto-recommended: the RAM tier is out of reach for the target
# machines and the runtime story below is not shippable yet.
recommendation_rank: 0
# Native context is far larger; 8192 is the runtime budget the catalog uses everywhere. The
# 2026-09-03 one-shot series ran it at 32768 without a Vulkan OOM (\`-ncmoe 40\`).
recommended_context_tokens: 8192
# The chat template honours \`enable_thinking\` (smoke 2026-09-03: thinking off is respected, no
# <think> leak), so Deep / Balanced apply.
supports_thinking_mode: true
supports_tools: true
# NO \`speculative_decoding\`: the PR build's MTP path is still work-in-progress and untested.
# RUNTIME PIN: the catalog's pinned llama.cpp release (runtime-sources.yaml) cannot load this
# architecture. It needs llama.cpp PR #27742 (unmerged at the time of writing; measured at
# commit 250b614, Vulkan build). In a dev build point \`HILBERTRAUM_LLAMA_BIN\` at that
# llama-server (and set the LunarG loader \`LD_LIBRARY_PATH\`); a packaged build ignores the
# override by design and will report the model as failing to start until the pin is bumped
# to a release that includes the merge.
# SHARDED WEIGHT: llama.cpp opens the first shard and finds the siblings by the
# \`-0000N-of-00004\` naming convention, so all four files must sit next to each other under
# models/chat/ with this exact prefix. The manifest schema knows one file: \`local_path\` and
# \`sha256\` are shard 1; shards 2 to 4 are listed below for the operator and are NOT checked
# by the app's checksum gate (a known gap, tracked with the multi-file download work).
local_path: models/chat/qwen3.8-flash-next-ud-q4kxl-00001-of-00004.gguf
# Shard 1 hash: HF LFS OID AND on-disk sha256sum on the i9 rig, 2026-09-04.
sha256: 4448186216b3af4cc558bbce2c3213f01608f8f8b2e5267a9767971dd3ec8082
# Shards 2 to 4 (HF LFS OIDs from unsloth/Qwen3.8-Flash-Next-GGUF, folder UD-Q4_K_XL):
#   qwen3.8-flash-next-ud-q4kxl-00002-of-00004.gguf  49,859,583,136 B  3f342f1c1580473f1ee94ddd5b28206e8c07a70fa1a366f59d1d6c922919a6c9
#   qwen3.8-flash-next-ud-q4kxl-00003-of-00004.gguf  49,376,141,504 B  56758f40269cad5cd9b0d3d6fbae0f40f6d5be6de49e4ab392dbe83157d9cbd3
#   qwen3.8-flash-next-ud-q4kxl-00004-of-00004.gguf  12,087,983,520 B  753bda48b98ba4f1636134a90a967de1b2d3908a236c026e464777342e53510a
# Upstream files: https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF/tree/main/UD-Q4_K_XL
# NO \`download\` block on purpose: the in-app downloader fetches exactly one file per manifest,
# and a shard-1-only download would leave a model that can never start. Until the downloader
# understands multi-file weights this stays a manually placed model (curl -C - against the
# resolve URLs with a HF token was the only reliable route on the rig; hf/xet stalled).
bundled_on_preconfigured_drive: false
recommended_profiles: []
license_review:
  status: pending
  reviewed_by: null
  reviewed_at: null
  notes: "PENDING 2026-09-04: base model Qwen/Qwen3.8-Flash-Next is NOT apache-2.0 but 'Qwen Community License 1.0' (https://huggingface.co/Qwen/Qwen3.8-Flash-Next/blob/main/LICENSE; HF card tag license:other). Grants use, copy, modify, distribute, sell; conditions: (1) keep the copyright + permission notice, model-name attribution only above 100M MAU / US$20M monthly revenue; (2) a licensee running a 'Model as a Service' or an 'AI Work Assistant' business (a product primarily designed for AI-assisted coding or office productivity) needs a separate Qwen license for commercial use. Whether a prepared HilbertRaum drive with document/office skills is an 'AI Work Assistant' under clause 2 is unresolved; do not bundle or sell until legal has reviewed. Quantization provenance: unsloth Dynamic UD-Q4_K_XL GGUF (unsloth/Qwen3.8-Flash-Next-GGUF, card license:other, base_model Qwen/Qwen3.8-Flash-Next). Runtime: unmerged llama.cpp PR #27742 required; dev-only until the runtime pin catches up."
`

describe('committed catalog — no unsupported sharded GGUF entries (PR #302 F1)', () => {
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

  it('declares no sharded GGUF weight or projector path anywhere in the catalog', () => {
    expect(shardedGgufPaths(committedManifests())).toEqual([])
  })

  // Control: without this the previous assertion could pass vacuously for a projector, because
  // the guard would never look at one. The vision model is the catalog's only two-file entry.
  it('enumerates the projector path too, so a sharded mmproj could not slip past the guard', () => {
    const manifests = committedManifests()
    const vision = manifests.filter((m) => m.role === 'vision')
    expect(vision.length, 'one vision manifest').toBe(1)
    const paths = declaredFilePaths(vision)
    expect(paths, 'GGUF + mmproj').toEqual([vision[0].localPath, vision[0].mmproj!.localPath])
    expect(paths.length, 'two declared files').toBe(2)
    // Every manifest contributes at least its own weight path (no silently empty enumeration).
    expect(declaredFilePaths(manifests).length).toBeGreaterThanOrEqual(manifests.length)
  })

  // The red proof, committed: run the guard against the ACTUAL audited manifest in a throwaway
  // catalog laid out like `model-manifests/chat/`. `discoverManifests()` takes any directory, so
  // no test ever has to write into the real tree to prove the assertion above can fail.
  it('flags the audited Flash-Next manifest in an isolated temporary catalog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-shard-guard-'))
    try {
      mkdirSync(join(dir, 'chat'), { recursive: true })
      writeFileSync(join(dir, 'chat', `${FLASH_NEXT_ID}.yaml`), FLASH_NEXT_MANIFEST_YAML, 'utf8')
      const { manifests, errors } = discoverManifests(dir)
      // Schema-valid and discovered: the guard's subject is a manifest the app would accept.
      expect(errors, 'the audited manifest still validates').toEqual([])
      expect(manifests.map((m) => m.manifest.id)).toEqual([FLASH_NEXT_ID])
      expect(shardedGgufPaths(manifests.map((m) => m.manifest))).toEqual([
        'models/chat/qwen3.8-flash-next-ud-q4kxl-00001-of-00004.gguf'
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    const manifestsDir = resolveManifestsDir(process.cwd())
    if (!manifestsDir) throw new Error('could not locate model-manifests from the repo')
    const rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-catalog-group-'))
    try {
      const { models } = await buildModelList({
        manifestsDir,
        rootPath,
        profile: 'BALANCED',
        developerMode: false,
        machineRamGb: RAM_16_GB
      })
      return models
    } finally {
      rmSync(rootPath, { recursive: true, force: true })
    }
  }

  it('collapses into exactly three multi-member variant groups — no false merges (O10)', async () => {
    const groups = groupModelVariants(await libraryModels()).filter((g) => g.models.length > 1)
    expect(groups.map((g) => [g.name, g.models.length]).sort()).toEqual([
      ['Qwen3.5 9B', 2],
      ['Qwen3.6 27B', 2],
      ['Qwen3.8 27B', 6]
    ])
  })

  it('keeps every catalog model in exactly one group, and every group role/family-pure', async () => {
    const models = await libraryModels()
    const groups = groupModelVariants(models)
    expect(groups.flatMap((g) => g.models.map((m) => m.id)).sort()).toEqual(
      models.map((m) => m.id).sort()
    )
    for (const g of groups) {
      expect(new Set(g.models.map((m) => `${m.role}/${m.family}/${m.runtime}`)).size).toBe(1)
    }
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
