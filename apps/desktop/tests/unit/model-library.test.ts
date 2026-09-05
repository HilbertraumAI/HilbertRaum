import { describe, expect, it } from 'vitest'
import { groupModelVariants } from '../../src/renderer/lib/modelLibrary'
import type { ModelInfo } from '../../src/shared/types'

function model(displayName: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { displayName, role: 'chat', family: 'qwen3.8', runtime: 'llama_cpp', ...extra } as ModelInfo
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
