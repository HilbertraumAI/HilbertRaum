import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { LAZY_WRAPPER_ALIAS } from '../helpers/lazy-wrapper-alias'

// #832 (guard for #815): vitest resolves `AssistantMarkdownLazy` to the synchronous renderer only for the
// specifiers LAZY_WRAPPER_ALIAS matches. A new importer that spells the path another way (`./chat/…`,
// `../../chat/…`, `@renderer/chat/…`, a dynamic `import()`) would get the real React.lazy wrapper in every
// render suite, and its tests would see the Suspense fallback and a chunk load nobody awaits. This row
// finds every such specifier under `src/`.

const SRC = resolve(__dirname, '../../src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Every `import … from 'x'`, `export … from 'x'`, bare `import 'x'` and `import('x')` specifier that names the wrapper. */
function wrapperSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)(['"])([^'"\n]*AssistantMarkdownLazy)\1/g)].map((m) => m[2])
}

describe('AssistantMarkdownLazy specifiers (#832)', () => {
  it('every import of the wrapper under src/ is one the test alias rewrites', () => {
    const found = sourceFiles(SRC).flatMap((file) =>
      wrapperSpecifiers(readFileSync(file, 'utf8')).map((specifier) => ({
        file: relative(SRC, file).split(sep).join('/'),
        specifier
      }))
    )
    // The scan itself must not rot to zero (a moved wrapper, a changed import style).
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter(({ specifier }) => !LAZY_WRAPPER_ALIAS.test(specifier))).toEqual([])
  })

  it('the scan reports the spellings the alias does not cover', () => {
    for (const specifier of ['./chat/AssistantMarkdownLazy', '../../chat/AssistantMarkdownLazy', '@renderer/chat/AssistantMarkdownLazy']) {
      expect(wrapperSpecifiers(`import { A } from '${specifier}'`)).toEqual([specifier])
      expect(LAZY_WRAPPER_ALIAS.test(specifier)).toBe(false)
    }
    expect(wrapperSpecifiers(`const m = await import('./x/AssistantMarkdownLazy')`)).toEqual(['./x/AssistantMarkdownLazy'])
    expect(wrapperSpecifiers(`export { A } from "../chat/AssistantMarkdownLazy"`)).toEqual(['../chat/AssistantMarkdownLazy'])
  })
})
