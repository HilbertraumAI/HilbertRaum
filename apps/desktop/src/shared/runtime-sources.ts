// Runtime-sources schema + validator (see docs/packaging.md).
//
// The `llama-server` sidecar binaries are NOT models, so they get their own committed
// manifest (`model-manifests/runtime-sources.yaml`) describing one prebuilt build per
// OS/arch/backend. `fetch-runtime` (and the canonical `services/assets.ts`) read this to
// know which release zip to download, what to verify it against, and where to extract it.
//
// Parsed with the pure-JS `yaml` package (like the model manifests). The validator is
// hand-written + pure (no I/O) so it is shared + unit-tested without the filesystem.

import { isRealSha256 } from './manifest'

/** Sidecar OS keys — must match `services/runtime/sidecar.ts` `llamaOsDir`. */
export type RuntimeOs = 'win' | 'mac' | 'linux'

const OS_KEYS: RuntimeOs[] = ['win', 'mac', 'linux']

/** One prebuilt `llama-server` build for a specific OS/arch/backend. */
export interface RuntimeBuild {
  os: RuntimeOs
  arch: string
  backend: string
  /** GitHub release zip URL. */
  url: string
  /** Expected SHA-256 (lower-case hex) of the zip; may be a placeholder. */
  sha256: string
  /** Drive-relative dir to extract into, e.g. `runtime/llama.cpp/win`. */
  extractTo: string
}

export interface RuntimeSources {
  /** Pinned upstream release tag (`ggml-org/llama.cpp` b-tag or `ggml-org/whisper.cpp` v-tag). */
  version: string
  builds: RuntimeBuild[]
}

/**
 * One vendored OCR language file (its own asset class on this yaml, not a third
 * build family): a plain verified file, no extraction, no per-OS variance.
 * `dest` is the drive-relative target (e.g. `ocr/deu.traineddata.gz`).
 */
export interface OcrFile {
  lang: string
  url: string
  /** Expected SHA-256 (lower-case hex) of the file AS DOWNLOADED; may be a placeholder. */
  sha256: string
  dest: string
}

export interface OcrSources {
  /** Pinned upstream data version (e.g. `@tesseract.js-data 4.0.0_best_int`). */
  version: string
  files: OcrFile[]
}

export interface RuntimeSourcesResult {
  ok: boolean
  sources?: RuntimeSources
  /**
   * The optional `whisper_cpp:` sibling block (the second sidecar family).
   * Absent when the file does not declare one; an older app simply never read
   * this key, so adding the block to a drive's yaml is forward-compatible.
   */
  whisper?: RuntimeSources
  /**
   * The optional `ocr:` sibling block (vendored traineddata).
   * Same forward-compatibility contract as `whisper_cpp:`.
   */
  ocr?: OcrSources
  errors: string[]
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * A drive-relative extract/dest target must not escape the drive root: no `..`
 * traversal, no leading slash (absolute POSIX), no Windows drive-letter (`C:`) or
 * UNC form. `model-manifests/` is user-writable on the removable drive, so an
 * attacker-supplied `extract_to`/`dest` is rejected at PARSE time here (SEC-4),
 * keeping these two sibling path-fields consistent — `resolveWithinRoot`
 * (`services/assets.ts`) is still the load-bearing downstream containment, this is
 * defense-in-depth so the footgun never reaches it. Pure (no I/O).
 */
function isUnsafeDrivePath(p: string): boolean {
  return p.includes('..') || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)
}

/** Validate one `{ version, builds[] }` family block, appending errors under `prefix.…`. */
function validateFamily(block: Record<string, unknown>, prefix: string, errors: string[]): RuntimeSources | null {
  const version = block['version']
  if (typeof version !== 'string' || version.trim() === '') {
    errors.push(`"${prefix}.version" is required and must be a non-empty string`)
  }

  const buildsRaw = block['builds']
  const builds: RuntimeBuild[] = []
  if (!Array.isArray(buildsRaw) || buildsRaw.length === 0) {
    errors.push(`"${prefix}.builds" is required and must be a non-empty list`)
  } else {
    buildsRaw.forEach((b, i) => {
      const where = `${prefix}.builds[${i}]`
      if (!isObject(b)) {
        errors.push(`${where} must be a mapping`)
        return
      }
      const osRaw = b['os']
      if (typeof osRaw !== 'string' || !OS_KEYS.includes(osRaw as RuntimeOs)) {
        errors.push(`${where}.os must be one of: ${OS_KEYS.join(', ')}`)
      }
      const arch = b['arch']
      if (typeof arch !== 'string' || arch.trim() === '') {
        errors.push(`${where}.arch is required and must be a non-empty string`)
      }
      const backend = b['backend']
      if (typeof backend !== 'string' || backend.trim() === '') {
        errors.push(`${where}.backend is required and must be a non-empty string`)
      }
      const url = b['url']
      if (typeof url !== 'string' || url.trim() === '') {
        errors.push(`${where}.url is required and must be a non-empty string`)
      }
      const shaRaw = b['sha256']
      if (typeof shaRaw !== 'string' || shaRaw.trim() === '') {
        errors.push(`${where}.sha256 is required and must be a string (hash or placeholder)`)
      }
      const extractTo = b['extract_to']
      if (typeof extractTo !== 'string' || extractTo.trim() === '') {
        errors.push(`${where}.extract_to is required and must be a non-empty string`)
      } else if (isUnsafeDrivePath(extractTo.trim())) {
        errors.push(`${where}.extract_to must be a drive-relative path with no "..", leading slash, or drive letter`)
      }
      if (
        typeof osRaw === 'string' &&
        OS_KEYS.includes(osRaw as RuntimeOs) &&
        typeof arch === 'string' &&
        typeof backend === 'string' &&
        typeof url === 'string' &&
        typeof shaRaw === 'string' &&
        typeof extractTo === 'string' &&
        !isUnsafeDrivePath(extractTo.trim())
      ) {
        builds.push({
          os: osRaw as RuntimeOs,
          arch: arch.trim(),
          backend: backend.trim(),
          url: url.trim(),
          sha256: shaRaw.trim().toLowerCase(),
          extractTo: extractTo.trim()
        })
      }
    })
  }

  // A duplicate (os, arch, backend) triple would make "first match wins" ambiguous and
  // could silently shadow a deliberate pin — reject it (architecture.md GPU record §6).
  // Per family: the llama and whisper builds live in different extract trees.
  const seen = new Set<string>()
  for (const b of builds) {
    const key = `${b.os}/${b.arch}/${b.backend}`
    if (seen.has(key)) {
      errors.push(`duplicate ${prefix} build for (${key}) — (os, arch, backend) must be unique`)
    }
    seen.add(key)
  }

  if (typeof version !== 'string' || version.trim() === '' || builds.length === 0) return null
  return { version: version.trim(), builds }
}

/** Validate the `ocr:` block (`{ version, files: [{lang,url,sha256,dest}] }`). */
function validateOcrFamily(
  block: Record<string, unknown>,
  errors: string[]
): OcrSources | null {
  const version = block['version']
  if (typeof version !== 'string' || version.trim() === '') {
    errors.push('"ocr.version" is required and must be a non-empty string')
  }
  const filesRaw = block['files']
  const files: OcrFile[] = []
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
    errors.push('"ocr.files" is required and must be a non-empty list')
  } else {
    filesRaw.forEach((f, i) => {
      const where = `ocr.files[${i}]`
      if (!isObject(f)) {
        errors.push(`${where} must be a mapping`)
        return
      }
      const lang = f['lang']
      if (typeof lang !== 'string' || !/^[a-z_]{3,}$/i.test(lang.trim())) {
        errors.push(`${where}.lang must be a traineddata language code (e.g. deu)`)
      }
      const url = f['url']
      if (typeof url !== 'string' || url.trim() === '') {
        errors.push(`${where}.url is required and must be a non-empty string`)
      }
      const sha = f['sha256']
      if (typeof sha !== 'string' || sha.trim() === '') {
        errors.push(`${where}.sha256 is required and must be a string (hash or placeholder)`)
      }
      const dest = f['dest']
      if (typeof dest !== 'string' || dest.trim() === '' || isUnsafeDrivePath(dest.trim())) {
        errors.push(`${where}.dest must be a drive-relative path with no "..", leading slash, or drive letter`)
      }
      if (
        typeof lang === 'string' &&
        typeof url === 'string' &&
        typeof sha === 'string' &&
        typeof dest === 'string' &&
        !isUnsafeDrivePath(dest.trim())
      ) {
        files.push({
          lang: lang.trim().toLowerCase(),
          url: url.trim(),
          sha256: sha.trim().toLowerCase(),
          dest: dest.trim()
        })
      }
    })
  }
  const seen = new Set<string>()
  for (const f of files) {
    if (seen.has(f.lang)) errors.push(`duplicate ocr file for language "${f.lang}"`)
    seen.add(f.lang)
  }
  if (typeof version !== 'string' || version.trim() === '' || files.length === 0) return null
  return { version: version.trim(), files }
}

/**
 * Validate a parsed `runtime-sources.yaml` object, collecting all errors. Pure (no I/O).
 * The file shape is:
 *   llama_cpp:
 *     version: b9196
 *     builds:
 *       - { os, arch, backend, url, sha256, extract_to }
 *   whisper_cpp:        # OPTIONAL second sidecar family, same shape
 *     version: v1.8.6
 *     builds: [ … ]
 *   ocr:                # OPTIONAL vendored OCR language data
 *     version: 4.0.0_best_int
 *     files:
 *       - { lang, url, sha256, dest }
 *
 * Unknown sibling keys are ignored (forward compatibility: an older app on a
 * newer drive parses the file unchanged).
 */
export function validateRuntimeSources(raw: unknown): RuntimeSourcesResult {
  const errors: string[] = []
  if (!isObject(raw)) {
    return { ok: false, errors: ['runtime-sources must be a YAML mapping'] }
  }

  const llama = raw['llama_cpp']
  if (!isObject(llama)) {
    return { ok: false, errors: ['"llama_cpp" block is required (version + builds)'] }
  }
  const sources = validateFamily(llama, 'llama_cpp', errors)

  // The whisper block is OPTIONAL (an older yaml has none) — but when present it
  // must be fully valid: a malformed pin must fail loudly, never fetch the wrong thing.
  let whisper: RuntimeSources | null = null
  const whisperRaw = raw['whisper_cpp']
  if (whisperRaw !== undefined) {
    if (!isObject(whisperRaw)) {
      errors.push('"whisper_cpp" must be a mapping (version + builds) when present')
    } else {
      whisper = validateFamily(whisperRaw, 'whisper_cpp', errors)
    }
  }

  // The ocr block is OPTIONAL too — same contract: absent is fine,
  // malformed fails loudly.
  let ocr: OcrSources | null = null
  const ocrRaw = raw['ocr']
  if (ocrRaw !== undefined) {
    if (!isObject(ocrRaw)) {
      errors.push('"ocr" must be a mapping (version + files) when present')
    } else {
      ocr = validateOcrFamily(ocrRaw, errors)
    }
  }

  if (errors.length > 0 || !sources) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    errors: [],
    sources,
    ...(whisper ? { whisper } : {}),
    ...(ocr ? { ocr } : {})
  }
}

/** Re-exported so callers can warn on placeholder zip hashes (mirrors models.ts use). */
export { isRealSha256 }
