import { describe, expect, it } from 'vitest'
import {
  availableFamilies,
  groupModelVariants,
  modelVariantName,
  variantGroupFace,
  variantGroupOrder,
  type ModelVariantGroup
} from '../../src/renderer/lib/modelLibrary'
import {
  isModelInstalled,
  isModelOnDrive,
  isModelRunnableHere,
  orderPickerModels
} from '../../src/renderer/lib/modelAvailability'
import type { ModelInfo, ModelState } from '../../src/shared/types'
import {
  OBTAINABLE_DOWNLOAD as OBTAINABLE,
  WITHDRAWN_DOWNLOAD as WITHDRAWN,
  modelInfo
} from '../helpers/model-fixtures'

function model(displayName: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return modelInfo({ id: displayName, displayName, ...extra })
}

/** Groups here are hand-built so the "already ordered" precondition is explicit in each case. */
function group(models: ModelInfo[]): ModelVariantGroup {
  return { key: 'test-group', name: 'Test group', models }
}

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
      model('Qwen3 4B Instruct custom'),
      // QAT is identity (#82 ships both); so are architecture notes and unrecognized suffixes.
      model('Gemma 4 12B QAT Q4_0'),
      model('Gemma 4 12B Q4_0'),
      model('Qwen3.8 27B (MoE)'),
      model('Qwen3.8 27B Q4_K_M'),
      model('Qwen3.8 27B Q'),
      model('Qwen3.8 27B v2')
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

describe('isModelOnDrive and isModelInstalled — the state table (F3, Gate C1)', () => {
  // On the drive = usable OR repairable. Installed = usable right now, the picker's first key and the
  // main side's start gate. `unsupported` and `not_recommended` describe the MACHINE or the policy, not
  // what is on the drive; the renderer has no presence contract to read, so neither may guess (Gate C1).
  // `Record<ModelState, …>` makes a new state, or an unknown key, a type error here: that decision
  // must be taken deliberately (tsconfig.web.json type-checks tests).
  const STATES: Record<ModelState, { onDrive: boolean; installed: boolean }> = {
    installed: { onDrive: true, installed: true },
    running: { onDrive: true, installed: true },
    ready: { onDrive: true, installed: true },
    checksum_failed: { onDrive: true, installed: false },
    missing: { onDrive: false, installed: false },
    unsupported: { onDrive: false, installed: false },
    not_recommended: { onDrive: false, installed: false }
  }
  const ROWS = Object.entries(STATES).map(
    ([state, e]): [ModelState, boolean, boolean] => [state as ModelState, e.onDrive, e.installed]
  )

  it.each(ROWS)('state %s → on drive %s, installed %s', (state, onDrive, installed) => {
    const m = model('Any model', { state })
    expect(isModelOnDrive(m)).toBe(onDrive)
    expect(isModelInstalled(m)).toBe(installed)
  })
})

describe('variantGroupFace — an obtainable face within the leader priority cohort (F5, #196)', () => {
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
    // Both installed, so they tie on every key: only `isObtainable`'s installed half keeps the leader.
    const tied = group([
      model('Priority Q4_K_M', { state: 'installed', download: WITHDRAWN }),
      model('Priority Q6_K', { state: 'installed', download: OBTAINABLE })
    ])
    expect(variantGroupFace(tied).displayName).toBe('Priority Q4_K_M')
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
    // A tied, obtainable member sits AFTER the leaver: only stopping the scan keeps the leader.
    const g = group([
      model('Cohort Q4_K_M', { insufficientRam: false, download: WITHDRAWN }),
      model('Too big Q6_K', { insufficientRam: true, download: OBTAINABLE }),
      model('Cohort Q8_0', { insufficientRam: false, download: OBTAINABLE })
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
  it('promotes the face and keeps the rest in their original relative order', () => {
    const g = group(tiedSix())
    expect(variantGroupOrder(g).map((m) => m.displayName)).toEqual([
      'Qwen3.8 27B UD-Q4_K_XL',
      'Qwen3.8 27B Q4_K_M',
      'Qwen3.8 27B Q4_K_S',
      'Qwen3.8 27B Q6_K',
      'Qwen3.8 27B Q8_0',
      'Qwen3.8 27B UD-Q6_K_XL'
    ])
  })

  it('is the identity order when the face is already the leader', () => {
    const g = group([
      model('Lead Q4_K_M', { download: OBTAINABLE }),
      model('Lead Q6_K', { download: OBTAINABLE })
    ])
    expect(variantGroupOrder(g).map((m) => m.displayName)).toEqual(['Lead Q4_K_M', 'Lead Q6_K'])
  })
})

describe('availableFamilies (#313)', () => {
  // Zeta/beta are on the drive; alpha/gamma are download-only. Beta and gamma share the
  // "documents" task (embeddings + reranker); zeta and alpha are chat.
  const zeta = model('Zeta chat', { family: 'zeta', role: 'chat', state: 'installed' })
  const alpha = model('Alpha chat', { family: 'alpha', role: 'chat', state: 'missing' })
  const beta = model('Beta embedder', { family: 'beta', role: 'embeddings', state: 'installed' })
  const gamma = model('Gamma reranker', { family: 'gamma', role: 'reranker', state: 'missing' })
  const catalog: ModelInfo[] = [zeta, alpha, beta, gamma]

  it('offers only on-drive families for the installed view, every family for browse', () => {
    expect(
      availableFamilies(catalog, { activeChat: null, view: 'installed', task: 'all' })
    ).toEqual(['beta', 'zeta'])
    expect(
      availableFamilies(catalog, { activeChat: null, view: 'browse', task: 'all' })
    ).toEqual(['alpha', 'beta', 'gamma', 'zeta'])
  })

  it('narrows by the selected task, combined with the view', () => {
    expect(
      availableFamilies(catalog, { activeChat: null, view: 'browse', task: 'documents' })
    ).toEqual(['beta', 'gamma'])
    expect(
      availableFamilies(catalog, { activeChat: null, view: 'installed', task: 'documents' })
    ).toEqual(['beta'])
  })

  it('excludes the pinned active chat model, dropping a family that has no other member', () => {
    // zeta's only member is the active model — it must disappear from both views once excluded.
    expect(
      availableFamilies(catalog, { activeChat: zeta, view: 'installed', task: 'all' })
    ).toEqual(['beta'])
    expect(
      availableFamilies(catalog, { activeChat: zeta, view: 'browse', task: 'all' })
    ).toEqual(['alpha', 'beta', 'gamma'])
    // A family with another member stays: the exclusion is the pinned model, not its family.
    const zeta2 = model('Zeta two', { family: 'zeta', role: 'chat', state: 'installed' })
    expect(
      availableFamilies([zeta, zeta2, alpha], { activeChat: zeta, view: 'installed', task: 'all' })
    ).toEqual(['zeta'])
  })

  it('lists a family once, however many members it has', () => {
    const zeta2 = model('Zeta two', { family: 'zeta', role: 'chat', state: 'installed' })
    expect(
      availableFamilies([zeta, zeta2, alpha], { activeChat: null, view: 'browse', task: 'all' })
    ).toEqual(['alpha', 'zeta'])
  })
})

// DV-2 + issue #93 item 3 — display order of the chat model picker. Keys, in order: installed first
// (primary), then recommended, then runnable-on-this-machine, then stable catalog order. Runnability is
// read from `insufficientRam`, the SAME flag the card's RAM warning badge and banner render from, so the
// order can never contradict the warning printed on a moved card. Display order only: nothing here
// computes the recommendation. Once variants are grouped there is no global installed-first boundary in
// the rendered rows (`modelAvailability.ts` O8; design-guidelines §15 "Ordering after grouping").
const names = (list: ModelInfo[]): string[] => list.map((m) => m.id)

describe('orderPickerModels — runnable-first is unconditional', () => {
  it('pins the ★ card first in its group; without a recommendation runnable-first alone orders (#93 item 3)', () => {
    // The un-runnable cards still sink regardless (that DV-2 property is unchanged); the ★
    // card now additionally leads the runnable block instead of sitting in catalog order.
    // The recommender only picks a model that fits this machine's RAM, so the ★ is runnable by construction.
    const catalog = [
      modelInfo({ id: 'gemma-26b', insufficientRam: true }),
      modelInfo({ id: 'gemma-12b' }),
      modelInfo({ id: 'qwen-27b', insufficientRam: true }),
      modelInfo({ id: 'qwen-9b', recommended: true })
    ]
    expect(names(orderPickerModels(catalog))).toEqual([
      'qwen-9b',
      'gemma-12b',
      'gemma-26b',
      'qwen-27b'
    ])
    // Control: with no ★ anywhere, runnable-first + stable catalog order alone decide.
    expect(names(orderPickerModels(catalog.map((m) => ({ ...m, recommended: false }))))).toEqual([
      'gemma-12b',
      'qwen-9b',
      'gemma-26b',
      'qwen-27b'
    ])
  })

  it('lifts every runnable card above every un-runnable one, catalog order kept inside each group', () => {
    const catalog = [
      modelInfo({ id: 'gemma-26b', insufficientRam: true }),
      modelInfo({ id: 'gemma-12b' }),
      modelInfo({ id: 'gemma-31b', insufficientRam: true }),
      modelInfo({ id: 'qwen-4b' }),
      modelInfo({ id: 'qwen-27b', insufficientRam: true }),
      modelInfo({ id: 'qwen-9b' })
    ]
    expect(names(orderPickerModels(catalog))).toEqual([
      'gemma-12b',
      'qwen-4b',
      'qwen-9b',
      'gemma-26b',
      'gemma-31b',
      'qwen-27b'
    ])
  })

  it('treats an absent insufficientRam flag as runnable (older/partial payloads)', () => {
    expect(isModelRunnableHere(modelInfo())).toBe(true)
    expect(isModelRunnableHere(modelInfo({ insufficientRam: false }))).toBe(true)
    expect(isModelRunnableHere(modelInfo({ insufficientRam: true }))).toBe(false)
  })
})

describe('orderPickerModels — installed-first stays the primary key', () => {
  it('an installed but un-runnable model still outranks a runnable one that needs downloading', () => {
    // Runnability may only reorder cards WITHIN a group, never lift one across the installed-first key.
    const installedTooBig = modelInfo({ id: 'on-drive', state: 'installed', insufficientRam: true })
    const missingRunnable = modelInfo({ id: 'to-download' })
    expect(names(orderPickerModels([missingRunnable, installedTooBig]))).toEqual([
      'on-drive',
      'to-download'
    ])
  })

  it('orders runnable-first inside EACH group, not just the first one', () => {
    const catalog = [
      modelInfo({ id: 'drive-big', state: 'running', insufficientRam: true }),
      modelInfo({ id: 'dl-big', insufficientRam: true }),
      modelInfo({ id: 'drive-small', state: 'ready' }),
      modelInfo({ id: 'dl-small' })
    ]
    expect(names(orderPickerModels(catalog))).toEqual([
      'drive-small',
      'drive-big',
      'dl-small',
      'dl-big'
    ])
  })
})

describe('orderPickerModels — the recommended card leads its group (#93 item 3)', () => {
  it('never lifts a ★ needs-download card across the installed boundary', () => {
    // Installed-first stays primary: a recommendation is not a reason to reorder across it.
    const installed = modelInfo({ id: 'on-drive', state: 'installed' })
    const recMissing = modelInfo({ id: 'star-to-download', recommended: true })
    expect(names(orderPickerModels([recMissing, installed]))).toEqual([
      'on-drive',
      'star-to-download'
    ])
  })

  it('an installed ★ card leads the installed group', () => {
    const catalog = [
      modelInfo({ id: 'drive-a', state: 'ready' }),
      modelInfo({ id: 'drive-star', state: 'installed', recommended: true }),
      modelInfo({ id: 'dl-a' })
    ]
    expect(names(orderPickerModels(catalog))).toEqual(['drive-star', 'drive-a', 'dl-a'])
  })
})

describe('orderPickerModels — purity', () => {
  it('returns a new array and never mutates the input', () => {
    const input = [modelInfo({ id: 'big', insufficientRam: true }), modelInfo({ id: 'small' })]
    const out = orderPickerModels(input)
    expect(out).not.toBe(input)
    expect(names(input)).toEqual(['big', 'small'])
  })
})
