// Runtime-sources schema + validator (see docs/packaging.md).
//
// The `llama-server` sidecar binaries are NOT models, so they get their own committed
// manifest (`model-manifests/runtime-sources.yaml`) describing one prebuilt build per
// OS/arch/backend. `fetch-runtime` (and the canonical `services/assets.ts`) read this to
// know which release zip to download, what to verify it against, and where to extract it.
//
// Parsed with the pure-JS `yaml` package (like the model manifests). The validator is
// hand-written + pure (no I/O) so it is shared + unit-tested without the filesystem.

import { isHttpsUrl, isRealSha256 } from './manifest'

/** Sidecar OS keys — must match `services/runtime/sidecar.ts` `llamaOsDir`. */
export type RuntimeOs = 'win' | 'mac' | 'linux'

const OS_KEYS: RuntimeOs[] = ['win', 'mac', 'linux']

/**
 * The `{ version, builds }` sidecar families this yaml can declare (#339 P8-1). `ocr` is NOT
 * one of them — it is a different asset class (`files`, not `builds`) with its own field.
 * `kiwix_tools` (kiwix-serve + kiwix-manage, the knowledge-pack tools) is the third; it is
 * the first family that ships MORE THAN ONE executable and, on Windows, required non-executable
 * runtime files (the ICU DLLs) — hence the `executables` / `runtime_files` keys below.
 */
export type RuntimeFamily = 'llama_cpp' | 'whisper_cpp' | 'kiwix_tools'

/** A plain filename: one path segment, no separators, no drive/UNC syntax — the same rule the
 *  downloader applies to archive basenames (`services/assets.ts` `ARCHIVE_NAME_RULE`). */
const PLAIN_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/

/**
 * The platforms a kit can be sold for — one release artifact + launcher each (#233).
 * The sell gate takes the platforms a kit is DECLARED for and requires the app for each;
 * the builder scripts re-spell this list (script-drift.test.ts keeps them in sync).
 */
export type KitPlatform = 'win-x64' | 'mac-arm64' | 'linux-x64'

export const KIT_PLATFORMS: readonly KitPlatform[] = ['win-x64', 'mac-arm64', 'linux-x64']

export function isKitPlatform(value: unknown): value is KitPlatform {
  return typeof value === 'string' && (KIT_PLATFORMS as readonly string[]).includes(value)
}

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
  /**
   * Non-executable files the family's executables cannot start without, relative to
   * `extract_to`, plain filenames only (#339 P8-1): the five ICU DLLs of the kiwix-tools
   * Windows bundle. Every entry must exist after extraction and is hashed into the install
   * marker. Absent (every llama / whisper build) = nothing beyond the executables.
   */
  runtimeFiles?: string[]
  /**
   * The archive's size in bytes as pinned with its SHA-256 (#339 P8-2) — what the consent
   * dialog shows BEFORE any request is made (the engine job's `totalBytes` only exists once
   * the download started). Declarative; a positive integer when present. Absent = unknown.
   */
  sizeBytes?: number
}

export interface RuntimeSources {
  /** Pinned upstream release tag (`ggml-org/llama.cpp` b-tag or `ggml-org/whisper.cpp` v-tag). */
  version: string
  builds: RuntimeBuild[]
  /**
   * Declarative (#339 P8-1): the family is never part of the default engine install and never
   * counted in readiness — only an explicit per-family request installs it. The LOAD-BEARING
   * copy of this flag is the code-side family spec (`services/assets.ts`
   * `SIDECAR_FAMILY_SPECS`): a drive's yaml is user-writable and must not be able to promote a
   * family into the argument-less "Install the AI engine" path. The yaml key is validated and
   * asserted to agree with the code.
   */
  optional?: boolean
  /**
   * Executable base names (no OS suffix — `sidecarBinaryName` adds `.exe` on win) the family
   * ships when it ships MORE THAN ONE (#339 P8-1): `[kiwix-serve, kiwix-manage, kiwix-search]`.
   * Every entry must exist after extraction and is hashed into the install marker. Absent =
   * the family ships exactly the one binary its code-side spec names (the llama / whisper shape).
   */
  executables?: string[]
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
  /**
   * Every `{ version, builds }` family the file declares, keyed by its yaml name (#339 P8-1).
   * `llama_cpp` and `whisper_cpp` are the SAME objects as `sources` / `whisper` (aliases, kept
   * so no existing reader moves); `kiwix_tools` is reachable only here. Consumers that must
   * never go blind to a new family (the installer's family lookup, the drift nets) iterate this.
   */
  families?: Partial<Record<RuntimeFamily, RuntimeSources>>
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

  // #339 P8-1: the family-level keys. `optional` is declarative (see `RuntimeSources.optional`);
  // `executables` are base names — no separator, no `.exe`/`.dll` (the OS suffix is added by
  // `sidecarBinaryName`; a `.exe` here would spell `kiwix-serve.exe.exe` on win and a wrong
  // name on mac), unique, non-empty when present.
  const optionalRaw = block['optional']
  let optional: boolean | undefined
  let familyKeysOk = true
  if (optionalRaw !== undefined) {
    if (typeof optionalRaw !== 'boolean') {
      errors.push(`"${prefix}.optional" must be true or false when present`)
      familyKeysOk = false
    } else optional = optionalRaw
  }
  const executablesRaw = block['executables']
  const executables: string[] = []
  if (executablesRaw !== undefined) {
    if (!Array.isArray(executablesRaw) || executablesRaw.length === 0) {
      errors.push(`"${prefix}.executables" must be a non-empty list of unique names when present`)
      familyKeysOk = false
    } else {
      executablesRaw.forEach((e, i) => {
        if (
          typeof e !== 'string' ||
          !PLAIN_FILE_NAME.test(e) ||
          e === '.' ||
          e === '..' ||
          /\.(exe|dll)$/i.test(e)
        ) {
          errors.push(
            `"${prefix}.executables[${i}]" must be a plain executable base name with no path separator or extension`
          )
          familyKeysOk = false
          return
        }
        if (executables.includes(e)) {
          errors.push(`"${prefix}.executables" must be a non-empty list of unique names when present`)
          familyKeysOk = false
          return
        }
        executables.push(e)
      })
    }
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
      if (typeof url !== 'string' || !isHttpsUrl(url)) {
        // https-only at PARSE time (#245): the downloader refuses cleartext again at fetch time.
        errors.push(`${where}.url is required and must be an https:// URL`)
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
      // #339 P8-1: per-build required non-executable files — plain filenames, unique, and never
      // one of the family's executables (in either spelling), which are declared separately.
      const runtimeFilesRaw = b['runtime_files']
      let runtimeFiles: string[] | undefined
      let runtimeFilesOk = true
      if (runtimeFilesRaw !== undefined) {
        if (!Array.isArray(runtimeFilesRaw)) {
          errors.push(`${where}.runtime_files must be a list of plain filenames when present`)
          runtimeFilesOk = false
        } else {
          const seenFiles = new Set<string>()
          runtimeFiles = []
          runtimeFilesRaw.forEach((f, j) => {
            if (typeof f !== 'string' || !PLAIN_FILE_NAME.test(f) || f === '.' || f === '..') {
              errors.push(`${where}.runtime_files[${j}] must be a plain filename`)
              runtimeFilesOk = false
              return
            }
            if (seenFiles.has(f) || executables.includes(f) || executables.some((e) => `${e}.exe` === f)) {
              errors.push(`${where}.runtime_files[${j}] duplicates another required file`)
              runtimeFilesOk = false
              return
            }
            seenFiles.add(f)
            runtimeFiles!.push(f)
          })
        }
      }
      // #339 P8-2: the pinned archive size the consent dialog shows. Optional; when present it
      // must be a positive integer (a wrong size is a pin error, not a runtime concern).
      const sizeRaw = b['size_bytes']
      let sizeBytes: number | undefined
      let sizeOk = true
      if (sizeRaw !== undefined) {
        if (typeof sizeRaw !== 'number' || !Number.isInteger(sizeRaw) || sizeRaw <= 0) {
          errors.push(`${where}.size_bytes must be a positive integer when present`)
          sizeOk = false
        } else sizeBytes = sizeRaw
      }
      if (
        typeof osRaw === 'string' &&
        OS_KEYS.includes(osRaw as RuntimeOs) &&
        typeof arch === 'string' &&
        typeof backend === 'string' &&
        typeof url === 'string' &&
        typeof shaRaw === 'string' &&
        typeof extractTo === 'string' &&
        !isUnsafeDrivePath(extractTo.trim()) &&
        runtimeFilesOk &&
        sizeOk
      ) {
        builds.push({
          os: osRaw as RuntimeOs,
          arch: arch.trim(),
          backend: backend.trim(),
          url: url.trim(),
          sha256: shaRaw.trim().toLowerCase(),
          extractTo: extractTo.trim(),
          ...(runtimeFiles && runtimeFiles.length > 0 ? { runtimeFiles } : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {})
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

  if (typeof version !== 'string' || version.trim() === '' || builds.length === 0 || !familyKeysOk) return null
  return {
    version: version.trim(),
    builds,
    ...(optional !== undefined ? { optional } : {}),
    ...(executables.length > 0 ? { executables } : {})
  }
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
      if (typeof url !== 'string' || !isHttpsUrl(url)) {
        errors.push(`${where}.url is required and must be an https:// URL`)
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
 *   kiwix_tools:        # OPTIONAL third sidecar family (#339): optional + multi-file
 *     version: '3.8.1'
 *     optional: true
 *     executables: [kiwix-serve, kiwix-manage, kiwix-search]
 *     builds:
 *       - { os, arch, backend, url, sha256, extract_to, runtime_files? }
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

  // The kiwix_tools block (#339 P8-1) is OPTIONAL like whisper_cpp, and fully validated when
  // present — before this family existed a raw `kiwix_tools:` block was silently ignored by
  // the forward-compatibility rule while the notices generator threw on it; now both guards
  // point the same way.
  let kiwix: RuntimeSources | null = null
  const kiwixRaw = raw['kiwix_tools']
  if (kiwixRaw !== undefined) {
    if (!isObject(kiwixRaw)) {
      errors.push('"kiwix_tools" must be a mapping (version + builds) when present')
    } else {
      kiwix = validateFamily(kiwixRaw, 'kiwix_tools', errors)
    }
  }

  if (errors.length > 0 || !sources) {
    return { ok: false, errors }
  }

  const families: Partial<Record<RuntimeFamily, RuntimeSources>> = { llama_cpp: sources }
  if (whisper) families.whisper_cpp = whisper
  if (kiwix) families.kiwix_tools = kiwix
  return {
    ok: true,
    errors: [],
    sources,
    families,
    ...(whisper ? { whisper } : {}),
    ...(ocr ? { ocr } : {})
  }
}

/** Re-exported so callers can warn on placeholder zip hashes (mirrors models.ts use). */
export { isRealSha256 }
