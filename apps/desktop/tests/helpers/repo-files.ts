// The committed files the catalog, script and packaging suites read: one root, one reader, and readers that refuse to
// come back empty. Constraint: no src/main imports, so it stays safe beside a `vi.mock` of anything.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { LockPackages } from './asar-layout'

export const REPO_ROOT: string = join(__dirname, '..', '..', '..', '..')
export const DESKTOP_ROOT: string = join(REPO_ROOT, 'apps', 'desktop')

export function repoText(...rel: string[]): string {
  return readFileSync(join(REPO_ROOT, ...rel), 'utf8')
}

/** The electron-builder.yml fields the packaging gates read. The index signature keeps a row free to read one more. */
export interface BuilderConfig {
  files?: string[]
  asarUnpack?: string[]
  includeSubNodeModules?: boolean
  productName?: string
  executableName?: string
  win?: { executableName?: string; [key: string]: unknown }
  mac?: { executableName?: string; [key: string]: unknown }
  linux?: { executableName?: string; [key: string]: unknown }
  portable?: { executableName?: string; artifactName?: string; [key: string]: unknown }
  // Deliberately loose: a YAML scalar like `43.0` parses as a NUMBER, and the DEP-4 parity
  // row must be able to CATCH that mistake rather than be typed out of it.
  electronVersion?: string | number
  electronFuses?: Record<string, unknown>
  asar?: unknown
  disableAsarIntegrity?: unknown
  [key: string]: unknown
}

export function builderConfig(): BuilderConfig {
  return parse(repoText('apps', 'desktop', 'electron-builder.yml')) as BuilderConfig
}

/** `package-lock.json`'s `.packages`, keyed by lockfile path. */
export function lockPackages(): LockPackages {
  return (JSON.parse(repoText('package-lock.json')) as { packages: LockPackages }).packages
}

function yamlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return yamlFiles(path)
    return /\.ya?ml$/i.test(entry.name) ? [path] : []
  })
}

/**
 * Every committed model manifest as written: its path, its text, and the parsed document (a manifest is the yaml with a
 * `local_path`, which leaves `runtime-sources.yaml` out). Throws on zero, so a rule row over the list cannot pass on nothing.
 */
export function modelManifestDocs(): Array<{ path: string; text: string; doc: Record<string, unknown> }> {
  const docs = yamlFiles(join(REPO_ROOT, 'model-manifests'))
    .sort()
    .map((path) => {
      const text = readFileSync(path, 'utf8')
      return { path, text, doc: parse(text) as Record<string, unknown> }
    })
    .filter(({ doc }) => doc?.local_path !== undefined)
  if (docs.length === 0) throw new Error('no model manifest found under model-manifests/')
  return docs
}
