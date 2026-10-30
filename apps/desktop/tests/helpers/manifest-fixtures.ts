// Model-manifest factories and drive-file writers for the models, drive, manifest and downloader suites. Everything
// goes through the REAL `validateManifest`, so a factory that drifts from the schema fails loudly at the call. Constraint:
// no value import from a main service beyond what `tempRoot` itself brings (db-fixtures -> services/db), so it is safe
// beside a suite's `vi.mock` of a service and beside a passthrough `vi.mock('node:fs')`.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import type { DiscoveredManifest } from '../../src/main/services/models'
import { validateManifest, type ModelManifest } from '../../src/shared/manifest'
import { tempRoot } from './db-fixtures'

/** The hex SHA-256 of a string's UTF-8 bytes. Replaces the suites' local `sha256`. */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * A minimal valid raw manifest (snake_case, as parsed from YAML). Replaces `manifestObj` (models, drive) and `rawManifest`
 * (manifest). Its license review is `pending` and its hash a placeholder; it has no `download` block (`downloadManifest`).
 */
export function rawManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'qwen3-4b-instruct-q4',
    display_name: 'Qwen3 4B Instruct Q4',
    family: 'qwen3',
    role: 'chat',
    format: 'gguf',
    runtime: 'llama_cpp',
    license: 'apache-2.0',
    size_on_disk_gb: 2.7,
    recommended_min_ram_gb: 8,
    recommended_ram_gb: 16,
    recommended_context_tokens: 4096,
    local_path: 'models/chat/qwen3-4b-instruct-q4.gguf',
    sha256: 'REPLACE_WITH_REAL_HASH',
    recommended_profiles: ['LITE'],
    license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' },
    ...overrides
  }
}

function validated(raw: Record<string, unknown>): ModelManifest {
  const res = validateManifest(raw)
  if (!res.manifest) throw new Error('fixture invalid: ' + res.errors.join(', '))
  return res.manifest
}

/** `rawManifest` validated, or throws `fixture invalid: ...`. Replaces `asManifest` (models, drive). */
export function validManifest(overrides: Record<string, unknown> = {}): ModelManifest {
  return validated(rawManifest(overrides))
}

/**
 * One discovery result for a resolver or a caller that threads `discovered` through. `sourceFile` defaults to
 * `<id>.yaml`. Does not touch the disk: `manifestsDirWith` + the real `discoverManifests` is the walk.
 */
export function discovered(m: ModelManifest, sourceFile?: string): DiscoveredManifest {
  return { manifest: m, sourceFile: sourceFile ?? `${m.id}.yaml` }
}

/**
 * Writes `obj` as YAML at `<dir>/<name>`, for a discovery row whose file name or extension is the point, or whose content
 * is deliberately invalid. Replaces models.test's `writeManifest`; `manifestsDirWith` cannot name a file.
 */
export function writeManifest(dir: string, name: string, obj: unknown): void {
  writeFileSync(join(dir, name), stringify(obj))
}

/**
 * A fresh temp dir holding `m0.yaml`, `m1.yaml`, ... one per raw manifest. Replaces models.test's four `manifestsDirWith`.
 * It does not validate: an invalid object lands on disk for discovery to report.
 */
export function manifestsDirWith(...objs: Array<Record<string, unknown>>): string {
  const dir = tempRoot('manifests')
  for (const [i, o] of objs.entries()) writeManifest(dir, `m${i}.yaml`, o)
  return dir
}

/**
 * Writes `content` at `<root>/<rel>` (`rel` is manifest-style, `/`-separated; parents are created) and returns its real
 * SHA-256. Replaces models.test's `writeWeight`/`writeFile` and drive.test's `writeWeight` (pass `m.localPath`).
 */
export function writeDriveFile(root: string, rel: string, content: string): string {
  const dest = join(root, ...rel.split('/'))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, content)
  return sha256(content)
}

/**
 * A chat manifest the downloader accepts: license review `approved` (so no acknowledgement is needed), placeholder hashes
 * and a `download` block of 1000 bytes. Replaces downloads.test's `manifest`. Overrides are shallow: passing `download`
 * replaces the whole block.
 */
export function downloadManifest(overrides: Record<string, unknown> = {}): ModelManifest {
  return validated(
    rawManifest({
      license_review: {
        status: 'approved',
        reviewed_by: 'test',
        reviewed_at: '2026-06-10',
        notes: ''
      },
      download: {
        url: 'https://example.test/qwen3-4b.gguf',
        sha256: 'REPLACE_WITH_REAL_HASH',
        size_bytes: 1000,
        license_url: 'https://example.test/license'
      },
      ...overrides
    })
  )
}

/**
 * `downloadManifest` whose top-level AND download hashes are the real hash of `body`, and whose `size_bytes` is
 * `body.length` (so an ASCII body, as the fake fetches count). Replaces `verifiedManifest` (downloads, fsync durability).
 */
export function verifiedManifest(body: string, overrides: Record<string, unknown> = {}): ModelManifest {
  return downloadManifest({
    sha256: sha256(body),
    download: {
      url: 'https://example.test/qwen3-4b.gguf',
      sha256: sha256(body),
      size_bytes: body.length,
      license_url: 'https://example.test/license'
    },
    ...overrides
  })
}

/**
 * A vision manifest: language GGUF + mmproj projector, each hashed to the real hash of its body, each with a `download`
 * block. Replaces downloads.test's `visionManifest`, not models.test's placeholder-hash one, which has no `download`.
 */
export function visionManifest(gguf: string, mmproj: string): ModelManifest {
  return downloadManifest({
    role: 'vision',
    input_modalities: ['text', 'image'],
    local_path: 'models/vision/vl.gguf',
    sha256: sha256(gguf),
    download: {
      url: 'https://example.test/vl.gguf',
      sha256: sha256(gguf),
      size_bytes: gguf.length,
      license_url: 'https://example.test/license'
    },
    mmproj: {
      local_path: 'models/vision/vl-mmproj.gguf',
      sha256: sha256(mmproj),
      download: {
        url: 'https://example.test/vl-mmproj.gguf',
        sha256: sha256(mmproj),
        size_bytes: mmproj.length,
        license_url: 'https://example.test/license'
      }
    }
  })
}
