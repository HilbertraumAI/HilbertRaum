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
      // Rank 3 again since 2026-08-20 (issue #196, §9.5): the 2026-08-16 handover to the
      // Qwen3.8 pair is reverted because those files are gone from upstream. This pair's own
      // source is live (URL + LFS OID re-verified 2026-08-20), so it holds the two big tiers.
      expect(m.recommendationRank, `${id} rank`).toBe(3)
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
    expect(claiming).toEqual(['qwen3.8-27b-q4', 'qwen3.8-27b-q5'])
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

  it('hands the 24 GB and ≥32 GB tiers back to the Qwen3.6 pair (no-signal mapping)', () => {
    const chat = committedManifests()
    // #196: with the Qwen3.8 pair at rank 0, the tiers return to their pre-§9.4 holders — the
    // best-measured models whose upstream source is still live.
    expect(recommendModelIdByRam(chat, 24, 'chat')).toBe('qwen3.6-27b-q4')
    for (const ram of [32, 48, 64, 128]) {
      expect(recommendModelIdByRam(chat, ram, 'chat'), `ram=${ram}`).toBe('qwen3.6-27b-q5')
    }
    // No Qwen3.8 manifest may be the auto-pick at ANY realistic RAM level any more.
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
    // ≥32 GB: 27B Q5 crawling steps to the 24-band winner (qwen3.6 again since issue #196 —
    // the §9.4 handover to qwen3.8 was reverted when upstream deleted those files).
    expect(recommendModelIdByRam(chat, 32, 'chat', slowOnOwnPick(chat, 32))).toBe('qwen3.6-27b-q4')
    expect(recommendModelIdByRam(chat, 48, 'chat', slowOnOwnPick(chat, 48))).toBe('qwen3.6-27b-q4')
    expect(recommendModelIdByRam(chat, 128, 'chat', slowOnOwnPick(chat, 128))).toBe('qwen3.6-27b-q4')
  })

  it('an oversized crawl never moves the pick (the #52 lesson, real manifests)', () => {
    const chat = committedManifests()
    // 24 GB box, crawl measured on the manually-started 32 GB-tier Q5: pick unchanged.
    expect(
      recommendModelIdByRam(chat, 24, 'chat', { tokensPerSecond: 2.0, measuredModelId: 'qwen3.6-27b-q5' })
    ).toBe('qwen3.6-27b-q4')
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
