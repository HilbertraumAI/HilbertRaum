import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

// One real-Electron smoke child: a test spawns a runner bundled from tests/helpers/*SmokeRunner.ts under the local
// Electron binary, and the runner writes one result JSON (tests/integration/app-menu-electron-smoke.test.ts,
// close-guard-electron-smoke.test.ts). Both halves live here: the runner imports `writeSmokeResult` (Node built-ins
// only, no vitest, no electron), and the test imports `runSmokeChild`.
//
// The bounds, from the outside in, so that a hang always reports itself by name inside its row:
//   row budget (the `it` timeout, testBudgetMs)
//     > child deadline = row budget - ROW_MARGIN_MS: the test kills a child that wrote nothing and names it
//       > runner self-timeout = child deadline - START_ALLOWANCE_MS: the runner writes its own `timeout` result,
//         naming what it was waiting for
// `smokeBounds` derives both from the row budget. The test passes the self-timeout to the runner, so one number sets
// all three.
//
// Measured on this desk (follow-ups wave 3 W8): a child takes 2-7 s alone. Under a 12-thread CPU load the spawn took
// up to 5 s before the runner's code ran (START_ALLOWANCE_MS covers that twice). Electron's teardown after the result
// took up to 36 s (the print-PDF smoke, which once waited for `exit` itself, saw 10-14 s under that load and a 66-122 s
// row: #934); no row asserts anything after the result, so once it appears the child gets EXIT_GRACE_MS to exit
// by itself (alone it takes about 65 ms) and is then killed. ROW_MARGIN_MS covers that grace, reading the result and
// the row's assertions.

const START_ALLOWANCE_MS = 10_000
const ROW_MARGIN_MS = 10_000
const EXIT_GRACE_MS = 2_000

/** The child deadline and the runner's self-timeout for a row budget (see the bounds above). */
export function smokeBounds(rowBudgetMs: number): { childDeadlineMs: number; runnerTimeoutMs: number } {
  const childDeadlineMs = rowBudgetMs - ROW_MARGIN_MS
  return { childDeadlineMs, runnerTimeoutMs: childDeadlineMs - START_ALLOWANCE_MS }
}

/** Runner side: write the result beside its path and rename it into place, so the test never reads half a file. */
export function writeSmokeResult(resultPath: string, result: unknown): void {
  writeFileSync(`${resultPath}.part`, JSON.stringify(result), 'utf8')
  renameSync(`${resultPath}.part`, resultPath)
}

export interface SmokeChildRun {
  /** The label a failure names; unless `args` is set it is also where the runner's argv ends: `<resultPath> <runnerTimeoutMs> <what>`. */
  what: string
  /** A runner with its own argv (the print-PDF smoke takes a job file that names its result path): replaces those three. */
  args?: string[]
  bin: string
  runnerPath: string
  resultPath: string
  /** An isolated profile per child (the pdf smoke's lesson: a shared one's singleton lock crashes startup). */
  profileDir: string
  rowBudgetMs: number
}

/**
 * Test side: run one child and return its result, or throw a named error when it wrote none (`label: no result
 * (<how it ended>)`, with the child's stderr). It never outlives `childDeadlineMs`. `exitCode` is the child's own exit
 * code, or null when this helper had to kill it (it did not exit within the grace).
 */
export async function runSmokeChild<T>(
  run: SmokeChildRun
): Promise<{ result: T; stderr: string; exitCode: number | null }> {
  const { childDeadlineMs, runnerTimeoutMs } = smokeBounds(run.rowBudgetMs)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // must launch as Electron, never as plain node
  const args = [
    `--user-data-dir=${run.profileDir}`,
    run.runnerPath,
    ...(run.args ?? [run.resultPath, String(runnerTimeoutMs), run.what])
  ]
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const stderr: string[] = []
  let exitCode: number | null = null
  const end = await new Promise<string>((resolve, reject) => {
    const child = spawn(run.bin, args, { env, windowsHide: true })
    let grace: ReturnType<typeof setTimeout> | undefined
    let killedHere = false
    const settle = (): void => {
      clearInterval(poll)
      clearTimeout(deadline)
      clearTimeout(grace)
      if (child.exitCode === null && child.signalCode === null) {
        killedHere = true
        child.kill()
      }
    }
    const poll = setInterval(() => {
      if (!existsSync(run.resultPath)) return
      clearInterval(poll)
      clearTimeout(deadline)
      grace = setTimeout(() => {
        settle()
        resolve(`result written, killed ${EXIT_GRACE_MS} ms later`)
      }, EXIT_GRACE_MS)
    }, 50)
    const deadline = setTimeout(() => {
      settle()
      resolve(`killed at the ${childDeadlineMs} ms deadline`)
    }, childDeadlineMs)
    child.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    child.on('error', (err) => {
      settle()
      reject(err)
    })
    child.on('exit', (code) => {
      if (!killedHere) exitCode = code ?? -1
      settle()
      resolve(`exit ${code ?? -1}`)
    })
  })
  if (!existsSync(run.resultPath)) throw new Error(`${run.what}: no result (${end})\n${stderr.join('')}`)
  return { result: JSON.parse(readFileSync(run.resultPath, 'utf8')) as T, stderr: stderr.join(''), exitCode }
}
