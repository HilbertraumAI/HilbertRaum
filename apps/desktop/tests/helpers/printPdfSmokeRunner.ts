import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { app, session, BrowserWindow } from 'electron'
import { printEvidencePackHtmlToPdf } from '../../src/main/services/evidence-pack/print-pdf'
import { installOfflineNetworkGuard } from '../../src/main/services/offlineGuard'

// REAL-Electron smoke runner (EP-1 plan §11 tests) — NOT a test file. The pdf-smoke suite
// bundles this entry with esbuild and spawns it under the locally installed Electron
// binary; it drives the REAL `printEvidencePackHtmlToPdf` (the same module the app ships,
// bundled from source — no reimplementation that could drift) against real Chromium and
// reports machine-checkable facts back through a result JSON:
//   per job — the PDF bytes written (normal jobs) or the rejection (kill job), plus
//   whether the transient print source was cleaned up;
//   globally — EVERY url Chromium requested during the run (the network tripwire at the
//   layer node's connect-guard cannot see) and the node-side offline-guard violations.
//
// Job file (argv[argv.length - 1]):
//   { resultPath, jobs: [{ name, htmlPath, packId, outPdfPath, sourceHtmlPath, kill? }] }
//
// The kill job pins the app-quit teardown: `BrowserWindow.prototype.loadFile` is wrapped
// to emit `before-quit` the moment the load finishes — the harness's quit hook must
// destroy the hidden window mid-flight (after load, before print bytes exist), the
// promise must REJECT, and no output may be written. Deterministic: the emit is
// sequenced by the load itself, not by a timer.

interface SmokeJob {
  name: string
  htmlPath: string
  packId: string
  outPdfPath: string
  sourceHtmlPath: string
  kill?: boolean
}

interface SmokeJobResult {
  name: string
  ok: boolean
  error: string | null
  sourceHtmlRemoved: boolean
  outExists: boolean
}

async function runJob(job: SmokeJob): Promise<SmokeJobResult> {
  const html = readFileSync(job.htmlPath, 'utf8')
  const origLoadFile = BrowserWindow.prototype.loadFile
  if (job.kill) {
    BrowserWindow.prototype.loadFile = async function (this: BrowserWindow, ...args) {
      await origLoadFile.apply(this, args as [string])
      // Load finished — the print step is next. Quit NOW: the harness's before-quit
      // hook must tear the hidden window down and fail the print.
      app.emit('before-quit')
    }
  }
  let ok = false
  let error: string | null = null
  try {
    const bytes = await printEvidencePackHtmlToPdf(html, {
      packId: job.packId,
      sourceHtmlPath: job.sourceHtmlPath
    })
    // Plain write: the atomic tail has its own suite; this smoke targets the harness +
    // Chromium fidelity. The parent inspects these bytes with pdfjs.
    writeFileSync(job.outPdfPath, bytes)
    ok = true
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    BrowserWindow.prototype.loadFile = origLoadFile
  }
  return {
    name: job.name,
    ok,
    error,
    sourceHtmlRemoved: !existsSync(job.sourceHtmlPath),
    outExists: existsSync(job.outPdfPath)
  }
}

async function main(): Promise<void> {
  const jobFilePath = process.argv[process.argv.length - 1]!
  const { resultPath, jobs } = JSON.parse(readFileSync(jobFilePath, 'utf8')) as {
    resultPath: string
    jobs: SmokeJob[]
  }
  const requestedUrls: string[] = []
  const offlineViolations: string[] = []
  const results: SmokeJobResult[] = []
  let fatal: string | null = null
  // Electron's DEFAULT with no 'window-all-closed' listener is to QUIT the app the
  // moment all windows are gone — which is exactly what the harness's teardown produces
  // after every job. Subscribe a keep-alive no-op or the runner dies racing its own
  // result write (observed: exit 0xFFFF7003 mid-run).
  app.on('window-all-closed', () => {
    /* keep the runner alive between jobs; app.exit below ends it */
  })
  try {
    await app.whenReady()
    // Chromium-level tripwire: record EVERY request the session makes across all prints.
    // The parent asserts nothing but file:// ever appears (the pack is self-contained).
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      requestedUrls.push(details.url)
      callback({})
    })
    // Node-level tripwire: the app's REAL offline connect-guard, silent end to end.
    installOfflineNetworkGuard({
      offline: true,
      onViolation: (host) => offlineViolations.push(host)
    })
    for (const job of jobs) {
      results.push(await runJob(job))
    }
  } catch (e) {
    fatal = e instanceof Error ? (e.stack ?? e.message) : String(e)
  }
  writeFileSync(
    resultPath,
    JSON.stringify({ fatal, results, requestedUrls, offlineViolations }, null, 2),
    'utf8'
  )
  app.exit(fatal ? 1 : 0)
}

void main()
