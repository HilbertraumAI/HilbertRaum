import type { ModelInfo } from '@shared/types'

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
 * both groups and their variants. Never combine different roles or runtimes. */
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

export function matchesModelSearch(model: ModelInfo, query: string): boolean {
  const haystack = `${model.displayName} ${model.id} ${model.family}`.toLowerCase()
  return query.toLowerCase().trim().split(/\s+/).every((word) => haystack.includes(word))
}
