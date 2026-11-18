// The committed catalog through the app's own parsers. Both throw instead of returning an empty or partial answer, so a
// rule row over the catalog cannot pass on nothing. Imports main services: `repo-files.ts` is the one with no such import.
import { join } from 'node:path'
import { parse } from 'yaml'
import { discoverManifests, setManifestAppVersion } from '../../src/main/services/models'
import type { ModelManifest } from '../../src/shared/manifest'
import { validateRuntimeSources, type RuntimeSourcesResult } from '../../src/shared/runtime-sources'
import { REPO_ROOT, repoText } from './repo-files'

export function committedManifests(): ModelManifest[] {
  // A committed manifest's `min_app_version` is judged against the app this checkout builds, as the shipped app does.
  setManifestAppVersion((JSON.parse(repoText('apps', 'desktop', 'package.json')) as { version: string }).version)
  let found: ReturnType<typeof discoverManifests>
  try {
    found = discoverManifests(join(REPO_ROOT, 'model-manifests'))
  } finally {
    setManifestAppVersion('') // the module default again, even when the walk throws
  }
  const { manifests, unsupported, errors } = found
  if (errors.length > 0) throw new Error(`invalid committed manifests:\n${errors.join('\n')}`)
  // #847: discovery LISTS a manifest with an unknown role (or a `min_app_version` this app does not meet) rather than
  // reporting it invalid, so a role typo in a committed manifest would otherwise drop out of every catalog row silently.
  if (unsupported.length > 0) {
    throw new Error(`committed manifests this app cannot use:\n${unsupported.map((u) => u.sourceFile).join('\n')}`)
  }
  if (manifests.length === 0) throw new Error('no committed manifest found under model-manifests/')
  return manifests.map((m) => m.manifest)
}

export function committedRuntimeSources(): RuntimeSourcesResult {
  const result = validateRuntimeSources(parse(repoText('model-manifests', 'runtime-sources.yaml')))
  if (!result.ok) throw new Error(`invalid runtime-sources.yaml:\n${result.errors.join('\n')}`)
  return result
}
