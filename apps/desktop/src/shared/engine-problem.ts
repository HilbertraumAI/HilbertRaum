import type { MessageKey } from './i18n'
import type { EngineProblem, EngineProblemReason } from './types'

// Renderer-side copy for an engine the OS refused to start (#530; design-guidelines §11.17).
// Pure: picks the message key + params for a verdict. The everyday surfaces name the library and
// the package to install; shell commands stay in the docs (troubleshooting.md), never in the UI.

/**
 * Linux packages that provide a library the engines link and that a supported desktop could lack.
 * Only `libgomp.so.1` today: OpenSSL 3, libstdc++ and glibc are part of every supported base
 * system, so their absence means a system that is too old (`system-too-old`), not a package to
 * add. Package names: Debian/Ubuntu/Mint (`deb`) and Fedora (`rpm`).
 */
export const LINUX_LIBRARY_PACKAGES: Readonly<Record<string, { deb: string; rpm: string }>> = {
  'libgomp.so.1': { deb: 'libgomp1', rpm: 'libgomp' }
}

/** The sentence that says what is wrong and what to do — after the "can't run" title. */
export function engineProblemCopy(problem: EngineProblem): {
  key: MessageKey
  params?: Record<string, string>
} {
  switch (problem.reason) {
    case 'library-missing': {
      const library = problem.name ?? ''
      const pkg = problem.os === 'linux' ? LINUX_LIBRARY_PACKAGES[library] : undefined
      return pkg
        ? {
            key: 'models.engineProblem.libraryMissingPackage',
            params: { library, debPackage: pkg.deb, rpmPackage: pkg.rpm }
          }
        : { key: 'models.engineProblem.libraryMissing', params: { library } }
    }
    case 'system-too-old':
      return {
        key:
          problem.os === 'linux'
            ? 'models.engineProblem.systemTooOldLinux'
            : problem.os === 'mac'
              ? 'models.engineProblem.systemTooOldMac'
              : 'models.engineProblem.systemTooOld'
      }
    case 'vc-runtime-missing':
      return { key: 'models.engineProblem.vcRuntimeMissing' }
    case 'files-damaged':
      return { key: 'models.engineProblem.filesDamaged' }
    case 'blocked':
      return { key: 'models.engineProblem.blocked' }
  }
}

/** Diagnostics' short reason phrase (the technical name + exit code follow it, untranslated). */
export const ENGINE_PROBLEM_DIAG_KEY: Readonly<Record<EngineProblemReason, MessageKey>> = {
  'library-missing': 'diag.engine.reason.libraryMissing',
  'system-too-old': 'diag.engine.reason.systemTooOld',
  'files-damaged': 'diag.engine.reason.filesDamaged',
  'vc-runtime-missing': 'diag.engine.reason.vcRuntimeMissing',
  blocked: 'diag.engine.reason.blocked'
}

/** The technical detail Diagnostics shows after the reason: `libgomp.so.1, exit code 127`. */
export function engineProblemTechnicalDetail(problem: EngineProblem): string {
  return [problem.name, problem.exit].filter((part): part is string => !!part).join(', ')
}
