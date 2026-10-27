import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { readZimHeader } from '../../src/main/services/zim/identity'
import { kiwixManageBinaryName, kiwixServeBinaryName } from '../../src/main/services/zim/tools'

// The FAIL-CLOSED smoke-env contract for the real-tools manual harness (#301 P5, finding L8,
// plan §9.19 (d)). `tests/manual/zim-real.test.ts` used to derive its `enabled` flag from input
// EXISTENCE (`!!toolsDir && !!zimFile && existsSync(...)`), which cannot express "requested but
// invalid" — a wrong path, a missing binary, or an unset query all silently SKIPPED the smoke
// instead of failing it. `zimSmokeEnv` is a pure function: the gate is
// `HILBERTRAUM_ZIM_SMOKE` (set and not `''`/`'0'`/`'false'`); once requested, every input is
// REQUIRED and every failure is a named problem, never a value — a wrong path or a missing
// binary must fail the run, not quietly skip it.

export interface ZimSmokeInputs {
  toolsDir: string
  zimFile: string
  query: string
  /** `HILBERTRAUM_ZIM_EXPECT_ARTICLE` — optional; null when unset or blank. */
  expectArticle: string | null
}

export type ZimSmokeGate =
  | { requested: false }
  | ({
      requested: true
      /** Each entry names the VARIABLE and the failed check — never the configured value. */
      problems: string[]
    } & ZimSmokeInputs)

const UNSET_OR_FALSY = new Set(['', '0', 'false'])

/**
 * Read the `HILBERTRAUM_ZIM_*` smoke-env contract (#301 P5, finding L8). Unrequested
 * (`HILBERTRAUM_ZIM_SMOKE` unset/`''`/`'0'`/`'false'`) ⇒ `{ requested: false }`, a genuine skip.
 * Requested ⇒ `{ requested: true, problems, ... }`; `problems` is empty only when every input is
 * valid: `HILBERTRAUM_ZIM_TOOLS_DIR` is a directory holding both platform binaries,
 * `HILBERTRAUM_ZIM_FILE` is a file `readZimHeader` accepts, and `HILBERTRAUM_ZIM_QUERY` is a
 * non-blank string (deliberately NO default — the old hardcoded `'Treibhausgas'` fallback let an
 * unset query pass silently).
 */
export function zimSmokeEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): ZimSmokeGate {
  const smoke = env.HILBERTRAUM_ZIM_SMOKE
  const requested = smoke !== undefined && !UNSET_OR_FALSY.has(smoke)
  if (!requested) return { requested: false }

  const problems: string[] = []

  const toolsDir = env.HILBERTRAUM_ZIM_TOOLS_DIR ?? ''
  if (toolsDir === '') {
    problems.push('HILBERTRAUM_ZIM_TOOLS_DIR is not set')
  } else if (!isDirectory(toolsDir)) {
    problems.push('HILBERTRAUM_ZIM_TOOLS_DIR is not a directory')
  } else {
    if (!nodeFs.existsSync(join(toolsDir, kiwixServeBinaryName(platform)))) {
      problems.push(`HILBERTRAUM_ZIM_TOOLS_DIR is missing ${kiwixServeBinaryName(platform)}`)
    }
    if (!nodeFs.existsSync(join(toolsDir, kiwixManageBinaryName(platform)))) {
      problems.push(`HILBERTRAUM_ZIM_TOOLS_DIR is missing ${kiwixManageBinaryName(platform)}`)
    }
  }

  const zimFile = env.HILBERTRAUM_ZIM_FILE ?? ''
  if (zimFile === '') {
    problems.push('HILBERTRAUM_ZIM_FILE is not set')
  } else if (!isFile(zimFile)) {
    problems.push('HILBERTRAUM_ZIM_FILE is not a file')
  } else {
    try {
      readZimHeader(zimFile)
    } catch {
      problems.push('HILBERTRAUM_ZIM_FILE failed the ZIM header check (readZimHeader rejected it)')
    }
  }

  const query = env.HILBERTRAUM_ZIM_QUERY ?? ''
  if (query.trim() === '') {
    problems.push('HILBERTRAUM_ZIM_QUERY is not set or blank')
  }

  const expectArticleRaw = env.HILBERTRAUM_ZIM_EXPECT_ARTICLE
  const expectArticle = expectArticleRaw !== undefined && expectArticleRaw.trim() !== '' ? expectArticleRaw : null

  return { requested: true, problems, toolsDir, zimFile, query, expectArticle }
}

function isDirectory(path: string): boolean {
  try {
    return nodeFs.existsSync(path) && nodeFs.statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return nodeFs.existsSync(path) && nodeFs.statSync(path).isFile()
  } catch {
    return false
  }
}
