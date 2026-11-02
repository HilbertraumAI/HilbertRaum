// The committed catalog through the app's own parsers. Both throw instead of returning an empty or partial answer, so a
// rule row over the catalog cannot pass on nothing. Imports main services: `repo-files.ts` is the one with no such import.
import { join } from 'node:path'
import { parse } from 'yaml'
import { discoverManifests } from '../../src/main/services/models'
import type { ModelManifest } from '../../src/shared/manifest'
import { validateRuntimeSources, type RuntimeSourcesResult } from '../../src/shared/runtime-sources'
import { REPO_ROOT, repoText } from './repo-files'

export function committedManifests(): ModelManifest[] {
  const { manifests, errors } = discoverManifests(join(REPO_ROOT, 'model-manifests'))
  if (errors.length > 0) throw new Error(`invalid committed manifests:\n${errors.join('\n')}`)
  if (manifests.length === 0) throw new Error('no committed manifest found under model-manifests/')
  return manifests.map((m) => m.manifest)
}

export function committedRuntimeSources(): RuntimeSourcesResult {
  const result = validateRuntimeSources(parse(repoText('model-manifests', 'runtime-sources.yaml')))
  if (!result.ok) throw new Error(`invalid runtime-sources.yaml:\n${result.errors.join('\n')}`)
  return result
}
