// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  isModelInstalled,
  isModelRunnableHere,
  orderPickerModels
} from '../../src/renderer/screens/ModelsScreen'
import type { ModelInfo } from '../../src/shared/types'

// DV-2 — display order of the chat model picker.
//
// The picker rendered in catalog (alphabetical) order once the installed/not-installed key
// tied, so a machine with modest RAM opened on a run of cards it cannot run at all ("Needs at
// least 20 GB RAM") while the models it CAN run sat far below the fold. Runnability is now the
// second sort key, applied unconditionally: "can this computer run it" outranks alphabetical,
// always. Installed-first stays PRIMARY because the installed/needs-download boundary is
// rendered as a labelled subheading, so runnability may only reorder cards within a group.
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

  it('applies WITH a recommendation present, exactly as it does without one', () => {
    // The recommendation is not a reason to leave un-runnable cards at the top: the ★ badge
    // sits on ONE card, while the first screenful is what a user actually scans.
    const catalog = [
      model({ id: 'gemma-26b', insufficientRam: true }),
      model({ id: 'gemma-12b' }),
      model({ id: 'qwen-27b', insufficientRam: true }),
      model({ id: 'qwen-9b', recommended: true })
    ]
    const withRec = names(orderPickerModels(catalog))
    const withoutRec = names(
      orderPickerModels(catalog.map((m) => ({ ...m, recommended: false })))
    )
    expect(withRec).toEqual(['gemma-12b', 'qwen-9b', 'gemma-26b', 'qwen-27b'])
    expect(withRec).toEqual(withoutRec)
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
    // `groupedCards` renders the installed/needs-download split as two labelled subheadings, so
    // runnability may only order cards WITHIN a group — never lift one across the boundary.
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

describe('orderPickerModels — the recommended card is never demoted', () => {
  it('keeps the ★ card in the leading (runnable) block', () => {
    // The recommender only ever picks a model that fits this machine's RAM, so the ★ card is
    // runnable by construction and the runnability key can only move it UP, never down.
    const catalog = [
      model({ id: 'gemma-26b', insufficientRam: true }),
      model({ id: 'gemma-31b', insufficientRam: true }),
      model({ id: 'qwen-9b', recommended: true }),
      model({ id: 'qwen-4b' })
    ]
    const ordered = orderPickerModels(catalog)
    const recIndex = ordered.findIndex((m) => m.recommended)
    const firstUnrunnable = ordered.findIndex((m) => !isModelRunnableHere(m))
    expect(recIndex).toBeLessThan(firstUnrunnable)
    // It also cannot end up further down than where it started.
    expect(recIndex).toBeLessThanOrEqual(catalog.findIndex((m) => m.recommended))
    expect(names(ordered)).toEqual(['qwen-9b', 'qwen-4b', 'gemma-26b', 'gemma-31b'])
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
