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

export interface EngineProblemCopyOptions {
  /**
   * #532: the surface offers "Install … again" and this drive's policy allows the download (the
   * button may still wait for the Settings toggle). The damaged-files sentence then names that
   * action instead of pointing to the troubleshooting guide.
   */
  reinstall?: boolean
}

/** The sentence that says what is wrong and what to do — after the "can't run" title. */
export function engineProblemCopy(
  problem: EngineProblem,
  opts: EngineProblemCopyOptions = {}
): {
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
      // #532: a fresh, verified copy that still does not load — its files are not the likely
      // cause, so no second reinstall is suggested. On Windows the known other cause is an
      // outdated Visual C++ Redistributable whose DLLs are present (the presence-only check).
      if (problem.afterInstall) {
        return {
          key:
            problem.os === 'win'
              ? 'models.engineProblem.filesDamagedAfterInstallWin'
              : 'models.engineProblem.filesDamagedAfterInstall'
        }
      }
      return {
        key: opts.reinstall ? 'models.engineProblem.filesDamagedReinstall' : 'models.engineProblem.filesDamaged'
      }
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

/** Diagnostics' reason phrase for one verdict — a damaged-files verdict about a fresh install says so (#532). */
export function engineProblemDiagKey(problem: EngineProblem): MessageKey {
  return problem.reason === 'files-damaged' && problem.afterInstall
    ? 'diag.engine.reason.filesDamagedAfterInstall'
    : ENGINE_PROBLEM_DIAG_KEY[problem.reason]
}

/** May a surface offer "Install … again" for this verdict (#532)? Damaged files, not yet after a fresh install. */
export function engineProblemOffersReinstall(problem: EngineProblem): boolean {
  return problem.reason === 'files-damaged' && !problem.afterInstall
}

/** The technical detail Diagnostics shows after the reason: `libgomp.so.1, exit code 127`. */
export function engineProblemTechnicalDetail(problem: EngineProblem): string {
  return [problem.name, problem.exit].filter((part): part is string => !!part).join(', ')
}
