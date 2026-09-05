// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  isModelInstalled,
  isModelRunnableHere,
  orderPickerModels
} from '../../src/renderer/screens/ModelsScreen'
import type { ModelInfo } from '../../src/shared/types'

// DV-2 + issue #93 item 3 — display order of the chat model picker.
//
// The picker rendered in catalog (alphabetical) order once the installed/not-installed key
// tied, so a machine with modest RAM opened on a run of cards it cannot run at all ("Needs at
// least 20 GB RAM") while the models it CAN run sat far below the fold (DV-2). Since issue #93
// item 3 the ★ recommended card additionally LEADS its group: on a fresh install the
// recommendation is the one actionable answer to "which of these should I download?", so it
// must be the first card scanned. Keys, in order: installed first (PRIMARY — the
// installed/needs-download boundary is a labelled subheading, lower keys only reorder within a
// group), then recommended, then runnable-on-this-machine, then stable catalog order.
//
// Runnability is read from `insufficientRam`, the SAME flag the card's RAM warning badge and
// banner render from, so the order can never contradict the warning printed on a moved card.
// Display order only: nothing here computes or influences the recommendation itself.

function model(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'm',
    displayName: 'M',
    family: 'f',
    role: 'chat',
    format: 'gguf',
    runtime: 'llama_cpp',
    license: 'apache-2.0',
    sizeOnDiskGb: 2,
    recommendedMinRamGb: 8,
    recommendedRamGb: 16,
    recommendedContextTokens: 8192,
    localPath: 'models/chat/m.gguf',
    state: 'missing',
    recommended: false,
    ...over
  }
}

const names = (list: ModelInfo[]): string[] => list.map((m) => m.id)

describe('orderPickerModels — runnable-first is unconditional', () => {
  it('puts a runnable model ahead of one this machine cannot run', () => {
    const tooBig = model({ id: 'big', insufficientRam: true })
    const runnable = model({ id: 'small', insufficientRam: false })
    expect(names(orderPickerModels([tooBig, runnable]))).toEqual(['small', 'big'])
  })

  it('pins the ★ card first in its group; without a recommendation runnable-first alone orders (#93 item 3)', () => {
    // The un-runnable cards still sink regardless (that DV-2 property is unchanged); the ★
    // card now additionally leads the runnable block instead of sitting in catalog order.
    const catalog = [
      model({ id: 'gemma-26b', insufficientRam: true }),
      model({ id: 'gemma-12b' }),
      model({ id: 'qwen-27b', insufficientRam: true }),
      model({ id: 'qwen-9b', recommended: true })
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
      model({ id: 'gemma-26b', insufficientRam: true }),
      model({ id: 'gemma-12b' }),
      model({ id: 'gemma-31b', insufficientRam: true }),
      model({ id: 'qwen-4b' }),
      model({ id: 'qwen-27b', insufficientRam: true }),
      model({ id: 'qwen-9b' })
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
    expect(isModelRunnableHere(model())).toBe(true)
    expect(isModelRunnableHere(model({ insufficientRam: false }))).toBe(true)
    expect(isModelRunnableHere(model({ insufficientRam: true }))).toBe(false)
  })
})

describe('orderPickerModels — installed-first stays the primary key', () => {
  it('an installed but un-runnable model still outranks a runnable one that needs downloading', () => {
    // `orderPickerModels` (now in `lib/modelAvailability.ts`, re-exported from ModelsScreen —
    // PR #302 P4) still orders the flat picker list installed-first/recommended-first/
    // runnable-first; the model library renders that ordered list as variant GROUPS, each
    // taking its leader's rank (`variantGroupOrder`, design-guidelines §15 "Ordering after
    // grouping"), so runnability may only reorder cards WITHIN a group — never lift one across
    // the installed-first boundary.
    const installedTooBig = model({ id: 'on-drive', state: 'installed', insufficientRam: true })
    const missingRunnable = model({ id: 'to-download' })
    expect(names(orderPickerModels([missingRunnable, installedTooBig]))).toEqual([
      'on-drive',
      'to-download'
    ])
  })

  it('orders runnable-first inside EACH group, not just the first one', () => {
    const catalog = [
      model({ id: 'drive-big', state: 'running', insufficientRam: true }),
      model({ id: 'dl-big', insufficientRam: true }),
      model({ id: 'drive-small', state: 'ready' }),
      model({ id: 'dl-small' })
    ]
    expect(names(orderPickerModels(catalog))).toEqual([
      'drive-small',
      'drive-big',
      'dl-small',
      'dl-big'
    ])
  })

  it('counts installed / running / ready as on-drive, and nothing else', () => {
    for (const state of ['installed', 'running', 'ready'] as const) {
      expect(isModelInstalled(model({ state }))).toBe(true)
    }
    for (const state of ['missing', 'checksum_failed'] as const) {
      expect(isModelInstalled(model({ state }))).toBe(false)
    }
  })
})

describe('orderPickerModels — the recommended card leads its group (#93 item 3)', () => {
  it('puts the ★ card first in the runnable block', () => {
    // The recommender only ever picks a model that fits this machine's RAM, so the ★ card is
    // runnable by construction — pinning it first can never surface an un-runnable card.
    const catalog = [
      model({ id: 'gemma-26b', insufficientRam: true }),
      model({ id: 'gemma-31b', insufficientRam: true }),
      model({ id: 'qwen-9b', recommended: true }),
      model({ id: 'qwen-4b' })
    ]
    expect(names(orderPickerModels(catalog))).toEqual([
      'qwen-9b',
      'qwen-4b',
      'gemma-26b',
      'gemma-31b'
    ])
  })

  it('never lifts a ★ needs-download card across the installed boundary', () => {
    // Installed-first stays PRIMARY: the boundary is a labelled subheading, and a
    // recommendation is not a reason to reorder across it.
    const installed = model({ id: 'on-drive', state: 'installed' })
    const recMissing = model({ id: 'star-to-download', recommended: true })
    expect(names(orderPickerModels([recMissing, installed]))).toEqual([
      'on-drive',
      'star-to-download'
    ])
  })

  it('an installed ★ card leads the installed group', () => {
    const catalog = [
      model({ id: 'drive-a', state: 'ready' }),
      model({ id: 'drive-star', state: 'installed', recommended: true }),
      model({ id: 'dl-a' })
    ]
    expect(names(orderPickerModels(catalog))).toEqual(['drive-star', 'drive-a', 'dl-a'])
  })
})

describe('orderPickerModels — purity', () => {
  it('returns a new array and never mutates the input', () => {
    const input = [model({ id: 'big', insufficientRam: true }), model({ id: 'small' })]
    const out = orderPickerModels(input)
    expect(out).not.toBe(input)
    expect(names(input)).toEqual(['big', 'small'])
  })
})
