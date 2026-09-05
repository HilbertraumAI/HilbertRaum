import { describe, expect, it } from 'vitest'
import {
  groupModelVariants,
  modelVariantName,
  variantGroupFace,
  variantGroupOrder,
  type ModelVariantGroup
} from '../../src/renderer/lib/modelLibrary'
import { isModelOnDrive } from '../../src/renderer/lib/modelAvailability'
import type { ModelDownloadInfo, ModelInfo, ModelState } from '../../src/shared/types'

/** A complete, typed `ModelInfo` — no payload cast, so a shared-type change fails here first. */
const BASE: ModelInfo = {
  id: 'base',
  displayName: 'Base',
  family: 'qwen3.8',
  role: 'chat',
  format: 'gguf',
  runtime: 'llama_cpp',
  license: 'apache-2.0',
  sizeOnDiskGb: 16,
  recommendedMinRamGb: 24,
  recommendedRamGb: 32,
  recommendedContextTokens: 8192,
  localPath: 'models/chat/base.gguf',
  state: 'missing',
  recommended: false
}

function model(displayName: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { ...BASE, id: displayName, displayName, ...extra }
}

const OBTAINABLE: ModelDownloadInfo = {
  url: 'https://example.test/weights.gguf',
  sizeBytes: 1000,
  licenseUrl: null,
  licenseApproved: true
}

/** #196: the pinned upstream file is gone — the row explains instead of offering a button. */
const WITHDRAWN: ModelDownloadInfo = { ...OBTAINABLE, withdrawn: 'the publisher removed it' }

/** Groups here are hand-built so the "already ordered" precondition is explicit in each case. */
function group(models: ModelInfo[]): ModelVariantGroup {
  return { key: 'test-group', name: 'Test group', models }
}

describe('variant identity', () => {
  it('groups static and dynamic quantizations, including parenthesized variants', () => {
    const variants = ['Qwen3.8 27B Q4_K_M', 'Qwen3.8 27B UD-Q6_K', 'Qwen3.8 27B (UD-Q4_K_XL)']
    const groups = groupModelVariants(variants.map((name) => model(name)))
    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBe('Qwen3.8 27B')
    expect(groups[0].models.map((m) => m.displayName)).toEqual(variants)
  })

  it('keeps sizes, instruction revisions, generations, roles, families and runtimes separate', () => {
    const models = [
      model('Qwen3 4B Instruct Q4'),
      model('Qwen3 4B Instruct 2507 Q4'),
      model('Qwen3 8B Instruct Q4'),
      model('Qwen3.8 4B Instruct Q4'),
      model('Qwen3 4B Instruct Q4', { role: 'vision' }),
      model('Qwen3 4B Instruct Q4', { family: 'custom' }),
      model('Qwen3 4B Instruct Q4', { runtime: 'other' }),
      model('Qwen3 4B Instruct custom')
    ]
    expect(groupModelVariants(models)).toHaveLength(models.length)
  })
})

// CG-ID — the grouping boundaries the audit found unpinned. These pin the CURRENT regex
// (`modelVariantName`), which strips only a recognized TERMINAL quantization label. They exist so
// nobody widens it to satisfy an invented naming policy: broadening it silently merges two
// different weights into one card, which is exactly the failure grouping must never have.
describe('variant identity — quantization suffix boundaries (CG-ID)', () => {
  const NORMALIZED: [string, string][] = [
    ['Qwen3.8 27B Q4_K_M', 'Qwen3.8 27B'],
    ['Qwen3.8 27B q4_k_m', 'Qwen3.8 27B'],
    ['Qwen3.8 27B UD-Q4_K_XL', 'Qwen3.8 27B'],
    ['Qwen3.8 27B (UD-Q4_K_XL)', 'Qwen3.8 27B'],
    ['Qwen3.8 27B IQ4_XS', 'Qwen3.8 27B'],
    ['Qwen3.8 27B UD-IQ2_XXS', 'Qwen3.8 27B'],
    ['Qwen3.8 27B BF16', 'Qwen3.8 27B'],
    ['Qwen3.8 27B F16', 'Qwen3.8 27B'],
    ['Qwen3.8 27B f16', 'Qwen3.8 27B'],
    ['Qwen3.8 27B F32', 'Qwen3.8 27B']
  ]
  it.each(NORMALIZED)('normalizes the recognized terminal label in %s', (name, stripped) => {
    expect(modelVariantName(model(name))).toBe(stripped)
  })

  // Everything that is NOT a terminal quantization label stays part of the identity.
  const PRESERVED: [string, string][] = [
    // QAT is a training property, not a quantization label — it must not merge with the plain
    // weight of the same size (issue #82's Gemma 4 QAT wave ships both).
    ['Gemma 4 12B QAT Q4_0', 'Gemma 4 12B QAT'],
    ['Gemma 4 12B Q4_0', 'Gemma 4 12B'],
    // Instruction revisions / architecture notes / date stamps are identity.
    ['Qwen3 4B Instruct 2507 Q4_K_M', 'Qwen3 4B Instruct 2507'],
    ['Qwen3.8 27B (MoE)', 'Qwen3.8 27B (MoE)'],
    ['Qwen3.8 27B (2512)', 'Qwen3.8 27B (2512)'],
    ['Qwen3.8 27B Q4_K_M (MoE)', 'Qwen3.8 27B Q4_K_M (MoE)'],
    // Not a label the regex recognizes ⇒ left alone; the entry keeps its own card.
    ['Qwen3.8 27B Q', 'Qwen3.8 27B Q'],
    ['Qwen3.8 27B v2', 'Qwen3.8 27B v2']
  ]
  it.each(PRESERVED)('keeps %s distinct', (name, kept) => {
    expect(modelVariantName(model(name))).toBe(kept)
  })

  it('keeps QAT, revision and MoE names in separate groups', () => {
    const names = [
      'Gemma 4 12B QAT Q4_0',
      'Gemma 4 12B Q4_0',
      'Qwen3 4B Instruct 2507 Q4_K_M',
      'Qwen3 4B Instruct Q4_K_M',
      'Qwen3.8 27B (MoE)',
      'Qwen3.8 27B Q4_K_M',
      'Qwen3.8 27B Q',
      'Qwen3.8 27B v2'
    ]
    expect(groupModelVariants(names.map((n) => model(n)))).toHaveLength(names.length)
  })

  // Recorded, not endorsed: `Q4KM-beta` is not a real quantization, but it reads as one to the
  // regex (Q + digit + word characters), so it merges with the family's other quants. Pinned so a
  // future change to that behaviour is a deliberate decision with a failing test, not a surprise.
  it('treats an unknown suffix that still LOOKS like a quantization as one', () => {
    expect(modelVariantName(model('Qwen3.8 27B Q4KM-beta'))).toBe('Qwen3.8 27B')
    expect(
      groupModelVariants([model('Qwen3.8 27B Q4KM-beta'), model('Qwen3.8 27B Q4_K_M')])
    ).toHaveLength(1)
  })
})

describe('isModelOnDrive — known usable OR repair states (F3, Gate C1)', () => {
  const EXPECTED: Record<ModelState, boolean> = {
    installed: true,
    running: true,
    ready: true,
    checksum_failed: true,
    missing: false,
    unsupported: false,
    not_recommended: false
  }

  it.each(Object.entries(EXPECTED) as [ModelState, boolean][])(
    'state %s → %s',
    (state, onDrive) => {
      expect(isModelOnDrive(model('Any model', { state }))).toBe(onDrive)
    }
  )

  it('covers every ModelState the shared contract declares', () => {
    // A new state added to the shared contract must be a deliberate decision about this view;
    // `Record<ModelState, boolean>` above makes omitting one a type error, this pins the reverse.
    expect(Object.keys(EXPECTED).sort()).toEqual([
      'checksum_failed',
      'installed',
      'missing',
      'not_recommended',
      'ready',
      'running',
      'unsupported'
    ])
  })

  it('never infers file presence for unsupported / not_recommended entries', () => {
    // Those states describe the MACHINE or the policy, not what is on the drive; the renderer has
    // no presence contract to read, so the view must not guess (Gate C1).
    expect(isModelOnDrive(model('Unsupported', { state: 'unsupported' }))).toBe(false)
    expect(isModelOnDrive(model('Not recommended', { state: 'not_recommended' }))).toBe(false)
  })
})

describe('variantGroupFace — an obtainable face within the leader priority cohort (F5, #196)', () => {
  const TIE: Partial<ModelInfo> = { state: 'missing', recommended: false, insufficientRam: true }

  /** Six quants that tie on all three ordering keys, exactly like the real 16 GB catalog group. */
  function tiedSix(): ModelInfo[] {
    return [
      model('Qwen3.8 27B Q4_K_M', { ...TIE, download: WITHDRAWN }),
      model('Qwen3.8 27B UD-Q4_K_XL', { ...TIE, download: OBTAINABLE }),
      model('Qwen3.8 27B Q4_K_S', { ...TIE, download: WITHDRAWN }),
      model('Qwen3.8 27B Q6_K', { ...TIE, download: OBTAINABLE }),
      model('Qwen3.8 27B Q8_0', { ...TIE, download: OBTAINABLE }),
      model('Qwen3.8 27B UD-Q6_K_XL', { ...TIE, download: OBTAINABLE })
    ]
  }

  it('fronts the first obtainable variant when a withdrawn one leads a tie', () => {
    const g = group(tiedSix())
    expect(variantGroupFace(g).displayName).toBe('Qwen3.8 27B UD-Q4_K_XL')
  })

  it('skips a manual entry with no download block and takes the next obtainable variant', () => {
    const g = group([
      model('Local build Q4_K_M', { ...TIE, download: undefined }),
      model('Local build Q6_K', { ...TIE, download: WITHDRAWN }),
      model('Local build Q8_0', { ...TIE, download: OBTAINABLE })
    ])
    expect(variantGroupFace(g).displayName).toBe('Local build Q8_0')
  })

  it('keeps the original leader when no member of the cohort is obtainable', () => {
    const g = group([
      model('Gone Q4_K_M', { ...TIE, download: WITHDRAWN }),
      model('Gone Q6_K', { ...TIE, download: undefined }),
      model('Gone Q8_0', { ...TIE, download: WITHDRAWN })
    ])
    expect(variantGroupFace(g)).toBe(g.models[0])
  })

  it('an INSTALLED but withdrawn leader keeps the face — being on the drive is obtainable', () => {
    const g = group([
      model('Priority Q4_K_M', { state: 'installed', download: WITHDRAWN }),
      model('Priority Q6_K', { state: 'missing', download: OBTAINABLE })
    ])
    expect(variantGroupFace(g).displayName).toBe('Priority Q4_K_M')
  })

  it('never displaces a RECOMMENDED leader with a lower-priority obtainable sibling', () => {
    const g = group([
      model('Starred Q4_K_M', { recommended: true, download: WITHDRAWN }),
      model('Starred Q6_K', { recommended: false, download: OBTAINABLE })
    ])
    expect(variantGroupFace(g).displayName).toBe('Starred Q4_K_M')
  })

  it('never displaces a RUNNABLE leader with an obtainable variant this machine cannot run', () => {
    const g = group([
      model('Fits Q4_K_M', { insufficientRam: false, download: WITHDRAWN }),
      model('Too big Q6_K', { insufficientRam: true, download: OBTAINABLE })
    ])
    expect(variantGroupFace(g).displayName).toBe('Fits Q4_K_M')
  })

  it('stops at the first member that leaves the cohort, even mid-group', () => {
    const g = group([
      model('Cohort Q4_K_M', { insufficientRam: false, download: WITHDRAWN }),
      model('Cohort Q4_K_S', { insufficientRam: false, download: WITHDRAWN }),
      model('Cohort Q6_K', { insufficientRam: true, download: OBTAINABLE })
    ])
    expect(variantGroupFace(g)).toBe(g.models[0])
  })

  it('leaves group.models — the sort order itself — untouched', () => {
    const models = tiedSix()
    const g = group(models)
    const before = models.map((m) => m.displayName)
    variantGroupFace(g)
    variantGroupOrder(g)
    expect(g.models).toBe(models)
    expect(g.models.map((m) => m.displayName)).toEqual(before)
    expect(g.models[0].displayName).toBe('Qwen3.8 27B Q4_K_M')
  })
})

describe('variantGroupOrder — face first, then every other variant exactly once', () => {
  const TIE: Partial<ModelInfo> = { state: 'missing', recommended: false, insufficientRam: true }

  it('promotes the face and keeps the rest in their original relative order', () => {
    const g = group([
      model('Qwen3.8 27B Q4_K_M', { ...TIE, download: WITHDRAWN }),
      model('Qwen3.8 27B UD-Q4_K_XL', { ...TIE, download: OBTAINABLE }),
      model('Qwen3.8 27B Q4_K_S', { ...TIE, download: WITHDRAWN }),
      model('Qwen3.8 27B Q6_K', { ...TIE, download: OBTAINABLE })
    ])
    expect(variantGroupOrder(g).map((m) => m.displayName)).toEqual([
      'Qwen3.8 27B UD-Q4_K_XL',
      'Qwen3.8 27B Q4_K_M',
      'Qwen3.8 27B Q4_K_S',
      'Qwen3.8 27B Q6_K'
    ])
  })

  it('is the identity order when the face is already the leader', () => {
    const g = group([
      model('Lead Q4_K_M', { download: OBTAINABLE }),
      model('Lead Q6_K', { download: OBTAINABLE })
    ])
    expect(variantGroupOrder(g).map((m) => m.displayName)).toEqual(['Lead Q4_K_M', 'Lead Q6_K'])
  })

  it('lists every variant exactly once — nothing duplicated, nothing dropped', () => {
    const models = [
      model('Six Q4_K_M', { ...TIE, download: WITHDRAWN }),
      model('Six UD-Q4_K_XL', { ...TIE, download: OBTAINABLE }),
      model('Six Q4_K_S', { ...TIE, download: WITHDRAWN }),
      model('Six Q6_K', { ...TIE, download: OBTAINABLE }),
      model('Six Q8_0', { ...TIE, download: OBTAINABLE }),
      model('Six UD-Q6_K_XL', { ...TIE, download: OBTAINABLE })
    ]
    const ordered = variantGroupOrder(group(models))
    expect(ordered).toHaveLength(models.length)
    expect(new Set(ordered).size).toBe(models.length)
    expect(ordered.map((m) => m.displayName).sort()).toEqual(
      models.map((m) => m.displayName).sort()
    )
  })
})
