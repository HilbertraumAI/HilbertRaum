import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// The host Chromium profile (Electron `userData`) is the one place the app keeps state OUTSIDE
// the drive, and lock does not clear it (owner decision #231). `docs/security-model.md`
// "What lives or passes outside the drive" lists every `localStorage` key the renderer touches
// (#249); this pin keeps that list honest. A new key means: add it here AND in the doc.
const PRODUCT_KEYS: Record<string, string> = {
  'hilbertraum.uiLanguage': 'i18n.tsx',
  'hilbertraum.chat.listCollapsed': 'screens/ChatScreen.tsx',
  'hilbertraum.docs.railCollapsed': 'screens/documents/types.ts',
  'hilbertraum.docs.viewsMoreOpen': 'screens/documents/types.ts'
}
// Written only by the dev preview harness (never read by the app).
const DEV_HARNESS_KEYS = ['hilbertraum.chat.listView']
const DEV_HARNESS_FILE = 'preview/preview.tsx'

const RENDERER = join(__dirname, '../../src/renderer')
const MAIN = join(__dirname, '../../src/main')

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p)
  }
  return out
}

const rel = (p: string): string => relative(RENDERER, p).replace(/\\/g, '/')

describe('renderer localStorage keys are the documented set (#249)', () => {
  const files = walk(RENDERER)
  const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))

  // `const NAME = 'literal'` anywhere under src/renderer resolves an identifier argument.
  const constants = new Map<string, string>()
  for (const src of sources.values()) {
    for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)) constants.set(m[1], m[2])
  }

  // Every read/write/remove call: `localStorage.getItem(X)` with X a literal or an identifier.
  const uses: Array<{ file: string; key: string }> = []
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(\s*(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      const key = m[1] ?? constants.get(m[2])
      expect(key, `${rel(file)}: unresolvable localStorage key argument \`${m[2]}\``).toBeDefined()
      uses.push({ file: rel(file), key: key as string })
    }
  }

  it('finds the calls at all (the scan is not vacuous)', () => {
    expect(uses.length).toBeGreaterThanOrEqual(Object.keys(PRODUCT_KEYS).length + DEV_HARNESS_KEYS.length)
  })

  it('touches exactly the documented product keys plus the dev-harness key', () => {
    const seen = new Set(uses.map((u) => u.key))
    expect([...seen].sort()).toEqual([...Object.keys(PRODUCT_KEYS), ...DEV_HARNESS_KEYS].sort())
  })

  it('each product key is defined where the doc says', () => {
    for (const [key, file] of Object.entries(PRODUCT_KEYS)) {
      const definers = [...sources].filter(([, src]) => src.includes(`'${key}'`)).map(([f]) => rel(f))
      expect(definers, key).toEqual([file])
    }
  })

  it('the dev-harness key is written only by the preview harness', () => {
    for (const key of DEV_HARNESS_KEYS) {
      const where = uses.filter((u) => u.key === key).map((u) => u.file)
      expect(where, key).toEqual([DEV_HARNESS_FILE])
    }
  })

  it('no other web storage is used, and no key argument is computed', () => {
    for (const [file, src] of sources) {
      expect(src, rel(file)).not.toMatch(/\bsessionStorage\b|\bindexedDB\b|\bopenDatabase\(/)
      expect(src, rel(file)).not.toMatch(/localStorage\.(?:getItem|setItem|removeItem)\(\s*[`(]/)
    }
  })
})

describe('the host profile is the default session and is never cleared (#249, #231)', () => {
  const src = walk(MAIN).map((f) => readFileSync(f, 'utf8')).join('\n')

  it('no window uses a `partition`', () => {
    expect(src).not.toMatch(/\bpartition\s*:/)
  })

  it('nothing calls clearStorageData / clearCache (owner decision #231: document only)', () => {
    expect(src).not.toMatch(/clearStorageData\(|clearCache\(/)
  })
})
