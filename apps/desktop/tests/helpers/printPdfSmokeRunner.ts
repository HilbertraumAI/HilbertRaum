import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, session, BrowserWindow } from 'electron'
import { printEvidencePackHtmlToPdf } from '../../src/main/services/evidence-pack/print-pdf'
import { installOfflineNetworkGuard } from '../../src/main/services/offlineGuard'
import { installAppProtocol, registerAppSchemePrivileges } from '../../src/main/install-app-protocol'
import { printPages } from '../../src/main/app-protocol'

// REAL-Electron smoke runner (EP-1 plan §11 tests) — NOT a test file. The pdf-smoke suite
// bundles this entry with esbuild and spawns it under the locally installed Electron
// binary; it drives the REAL `printEvidencePackHtmlToPdf` (the same module the app ships,
// bundled from source — no reimplementation that could drift) against real Chromium and
// reports machine-checkable facts back through a result JSON:
//   per job — the PDF bytes written (normal jobs) or the rejection (kill job), the print
//   pages still held afterwards (#563: none), the requests Chromium made during the job, the
//   time it took and the peak memory of the app's processes while it ran;
//   globally — EVERY url Chromium requested during the run (the network tripwire at the
//   layer node's connect-guard cannot see) and the node-side offline-guard violations.
//
// #563: the print page is served from memory on the app's own scheme, so this runner sets the
// scheme up exactly as the app does: `registerAppSchemePrivileges()` before `ready`, then
// `installAppProtocol(...)` (its renderer root does not exist here: the app host serves nothing,
// the print host serves the pending pages).
//
// Job file (argv[argv.length - 1]):
//   { resultPath, jobs: [{ name, htmlPath, packId, outPdfPath, kill? }] }
//
// The kill job pins the app-quit teardown: `BrowserWindow.prototype.loadURL` is wrapped
// to emit `before-quit` the moment the load finishes — the harness's quit hook must
// destroy the hidden window mid-flight (after load, before print bytes exist), the
// promise must REJECT, and no output may be written. Deterministic: the emit is
// sequenced by the load itself, not by a timer.
//
// Honest scope of that leg (FIX-4): `app.emit('before-quit')` fires the HOOK — it does
// NOT run Electron's real quit sequence (window teardown ordering, will-quit handlers).
// What it proves: the registered hook destroys the window, the in-flight step rejects,
// and no output file appears. What it cannot prove: the harness `finally` racing a real
// quit's own window destruction — but the export invariant holds regardless, because the
// destination write sits AFTER the awaited print, which has already rejected by then.

interface SmokeJob {
  name: string
  htmlPath: string
  packId: string
  outPdfPath: string
  kill?: boolean
}

interface SmokeJobResult {
  name: string
  ok: boolean
  error: string | null
  outExists: boolean
  /** Print pages still holding a slot after the job (#563: always 0). */
  pendingAfter: number
  /** The URLs Chromium requested while this job ran. */
  requests: string[]
  ms: number
  htmlBytes: number
  /** Peak working set (KiB) of the browser process / of any renderer while the job ran. */
  peakBrowserKiB: number
  peakRendererKiB: number
}

// Electron accepts scheme privileges only before `ready` — at module load, like index.ts.
registerAppSchemePrivileges()

const requestedUrls: string[] = []

async function runJob(job: SmokeJob): Promise<SmokeJobResult> {
  const html = readFileSync(job.htmlPath, 'utf8')
  const origLoadURL = BrowserWindow.prototype.loadURL
  if (job.kill) {
    BrowserWindow.prototype.loadURL = async function (this: BrowserWindow, ...args) {
      await origLoadURL.apply(this, args as [string])
      // Load finished — the print step is next. Quit NOW: the harness's before-quit
      // hook must tear the hidden window down and fail the print.
      app.emit('before-quit')
    }
  }
  const firstRequest = requestedUrls.length
  let peakBrowserKiB = 0
  let peakRendererKiB = 0
  const sample = (): void => {
    for (const m of app.getAppMetrics()) {
      const kib = m.memory.workingSetSize
      if (m.type === 'Browser') peakBrowserKiB = Math.max(peakBrowserKiB, kib)
      if (m.type === 'Tab') peakRendererKiB = Math.max(peakRendererKiB, kib)
    }
  }
  const sampler = setInterval(sample, 50)
  const t0 = performance.now()
  let ok = false
  let error: string | null = null
  try {
    const bytes = await printEvidencePackHtmlToPdf(html, { packId: job.packId })
    // Plain write: the atomic tail has its own suite; this smoke targets the harness +
    // Chromium fidelity. The parent inspects these bytes with pdfjs.
    writeFileSync(job.outPdfPath, bytes)
    ok = true
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    BrowserWindow.prototype.loadURL = origLoadURL
    clearInterval(sampler)
    sample()
  }
  return {
    name: job.name,
    ok,
    error,
    outExists: existsSync(job.outPdfPath),
    pendingAfter: printPages.pending,
    requests: requestedUrls.slice(firstRequest),
    ms: Math.round(performance.now() - t0),
    htmlBytes: Buffer.byteLength(html, 'utf8'),
    peakBrowserKiB,
    peakRendererKiB
  }
}

async function main(): Promise<void> {
  const jobFilePath = process.argv[process.argv.length - 1]!
  const { resultPath, jobs } = JSON.parse(readFileSync(jobFilePath, 'utf8')) as {
    resultPath: string
    jobs: SmokeJob[]
  }
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
    // The app's own scheme, as index.ts installs it (no renderer build here: an empty app host).
    installAppProtocol(join(resultPath, '..', 'no-renderer-build'))
    // Chromium-level tripwire: record EVERY request the session makes across all prints.
    // The parent asserts nothing but the print pages ever appears (the pack is self-contained).
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
