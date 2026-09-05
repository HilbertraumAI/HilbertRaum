import type { ModelInfo } from '@shared/types'
import { isModelInstalled, isModelRunnableHere } from './modelAvailability'

export type ModelTask = 'chat' | 'documents' | 'translation' | 'vision' | 'transcriber'

export function modelTask(model: ModelInfo): ModelTask {
  return model.role === 'embeddings' || model.role === 'reranker' ? 'documents' : model.role
}

/** Only remove a recognized terminal quantization label. Keep size, generation,
 * instruction revision and QAT identity intact; unknown naming stays separate.
 * This is presentation grouping, never a new runtime/model identifier. */
export function modelVariantName(model: ModelInfo): string {
  return model.displayName.replace(/\s+\(?(?:UD-)?(?:I?Q\d[\w-]*|BF16|F16|F32)\)?$/i, '').trim()
}

export interface ModelVariantGroup {
  key: string
  name: string
  models: ModelInfo[]
}

/** Input is already ordered by availability/recommendation; retain that order in
 * both groups and their variants (the collapsed FACE is a presentation exception —
 * `variantGroupFace`). Never combine different roles or runtimes. */
export function groupModelVariants(models: ModelInfo[]): ModelVariantGroup[] {
  const groups = new Map<string, ModelVariantGroup>()
  for (const model of models) {
    const name = modelVariantName(model)
    const key = JSON.stringify([model.role, model.family, model.runtime, name])
    const group = groups.get(key)
    if (group) group.models.push(model)
    else groups.set(key, { key, name, models: [model] })
  }
  return [...groups.values()]
}

/**
 * The three ordering keys of `orderPickerModels`, as a comparable tuple. Members that tie on
 * all three are interchangeable to the sort — only their catalog order separates them.
 */
function priorityKeys(m: ModelInfo): [boolean, boolean, boolean] {
  return [isModelInstalled(m), m.recommended === true, isModelRunnableHere(m)]
}

/**
 * Can the user act on this variant right now — either it is already on the drive, or its
 * manifest still offers a download that has not been withdrawn (#196)? A manual/local entry with
 * no `download` block is NOT obtainable from inside the app, so it never wins the face.
 */
function isObtainable(m: ModelInfo): boolean {
  return isModelInstalled(m) || (m.download != null && m.download.withdrawn == null)
}

/**
 * F5 (#196) — which variant a COLLAPSED group shows. The catalog's six Qwen3.8 27B quants tie on
 * all three ordering keys on a 16 GB machine (none installed, none recommended, none runnable),
 * so stable sort left alphabetical catalog order in charge and the group fronted a variant whose
 * upstream file was withdrawn: the one card the user sees offered nothing to do.
 *
 * The rule is deliberately narrow. Only the LEADING COHORT is considered — the run of members
 * from the front whose `priorityKeys` equal the first member's — so obtainability can never lift
 * a variant across an installed / recommended / runnable boundary (an installed-but-withdrawn
 * weight keeps the face; a lower-priority downloadable sibling does not steal it). Within that
 * cohort the first obtainable member wins; if none is obtainable the original leader stays, so a
 * group of purely withdrawn or manual variants is unchanged.
 *
 * Presentation only: group membership, the global sort and `group.models` itself are untouched.
 * Expects a nonempty group (`groupModelVariants` never produces an empty one).
 */
export function variantGroupFace(group: ModelVariantGroup): ModelInfo {
  const first = group.models[0]
  const lead = priorityKeys(first)
  for (const m of group.models) {
    const keys = priorityKeys(m)
    if (keys[0] !== lead[0] || keys[1] !== lead[1] || keys[2] !== lead[2]) break
    if (isObtainable(m)) return m
  }
  return first
}

/**
 * Render order for a group: the face first, then every OTHER member exactly once in its original
 * relative order. Never mutates `group.models` (the face is removed by index, so a group that
 * happens to hold the same object twice still renders both).
 */
export function variantGroupOrder(group: ModelVariantGroup): ModelInfo[] {
  if (group.models.length === 0) return []
  const face = variantGroupFace(group)
  const faceIndex = group.models.indexOf(face)
  return [face, ...group.models.filter((_, i) => i !== faceIndex)]
}

export function matchesModelSearch(model: ModelInfo, query: string): boolean {
  const haystack = `${model.displayName} ${model.id} ${model.family}`.toLowerCase()
  return query.toLowerCase().trim().split(/\s+/).every((word) => haystack.includes(word))
}
