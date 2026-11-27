// The import tests' shared inputs (app-update T6.1, T6.2): the case table's host (tests/fixtures/updates/import/cases.json,
// `schema.host`), a key set made from public keys, and the payload check's input as the update service builds it once per
// import (payload.ts's PayloadInput). Inputs only: no expected value lives here. Moved from updates-bundle.test.ts and
// updates-staging.test.ts, which held the same copies (T6.2 part 1's question 5).
import { expect } from 'vitest'
import { rootArtifactOf, type RootApp } from '../../src/main/services/updates/drive-release'
import { parseKeySet, type UpdateKey } from '../../src/main/services/updates/envelope'
import type { PayloadInput } from '../../src/main/services/updates/payload'
import { parseSemver } from '../../src/main/services/updates/version'
import { loadImportCases, type ImportCase } from './update-bundles'

export const MARKER = 'hilbertraum-key-set-1:'
const table = loadImportCases()

export function keySet(spkiBase64: readonly string[]): readonly UpdateKey[] {
  const read = parseKeySet(MARKER + spkiBase64.join(','))
  expect(read.valid).toBe(true)
  return read.valid ? read.keys : []
}

export interface Host {
  os: 'win32' | 'darwin' | 'linux'
  osVersion: string | null
  glibc: string | null
  runningVersion: string
  driveAppVersion: string | null
  rootApps: string[] | null
  now: string
  uiLanguage: string
  keys: string[]
  policy: { install: string; maxVersion: string | null }
  prepared?: boolean
  statfs?: { bsize: number; bavail: number }
  rootLength?: number
}

export function hostOf(c: ImportCase): Host {
  const host = table.hosts[c.host ?? '']
  expect(host, `${c.id}: host ${String(c.host)}`).toBeDefined()
  return { ...host, ...c.hostSet } as unknown as Host
}

export function semver(text: string): NonNullable<ReturnType<typeof parseSemver>> {
  const parsed = parseSemver(text)
  expect(parsed, text).not.toBeNull()
  return parsed!
}

/** What the service reads once per import (payload.ts's PayloadInput); the root apps as rootApps would list the names. */
export function payloadInput(host: Host): PayloadInput {
  const rootApps: RootApp[] | null =
    host.rootApps === null
      ? null
      : host.rootApps.map((name) => {
          const artifact = rootArtifactOf(name, 'file')
          expect(artifact, `${name} should be a root app`).not.toBeNull()
          return { name, kind: 'file', ...artifact! }
        })
  const common = {
    runningVersion: semver(host.runningVersion),
    driveAppVersion: host.driveAppVersion,
    rootApps,
    maxVersion: host.policy.maxVersion === null ? null : semver(host.policy.maxVersion),
    now: Date.parse(host.now),
    uiLanguage: host.uiLanguage
  }
  return host.os === 'linux' ? { ...common, os: 'linux', osVersion: null, glibc: host.glibc } : { ...common, os: host.os, osVersion: host.osVersion!, glibc: null }
}
