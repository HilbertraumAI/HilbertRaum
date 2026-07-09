// Screenshot capture for the screenshot-verify skill. Loads each preview case (built to
// out/preview by vite.preview.config.ts) in an OFFSCREEN Electron window and writes a PNG via
// webContents.capturePage(). Offscreen rendering is fully headless (no visible window / display
// needed) and uses the already-installed Electron — no Playwright/Puppeteer.
//
// Run: npm run screenshot            (default cases)
//      npm run screenshot -- documents chat-byproject
// Output: apps/desktop/screenshots/. On a headless box it still needs GL libs on LD_LIBRARY_PATH
// (the nix dev shell provides them): `nix develop --command npm run screenshot`.
import { app, BrowserWindow } from 'electron'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const previewHtml = resolve(here, '../out/preview/preview/preview.html')
const outDir = resolve(here, '../screenshots')

// The brand asset src is deliberately RELATIVE (`brand/…` — design record §13.3: file:// prod
// load), so from the nested preview.html it resolves to out/preview/preview/brand/, one level
// below where Vite's publicDir copy lands. Mirror it next to the page so the App-shell cases
// (`brand-home*`) show the real mark instead of a broken image.
const brandSrc = resolve(here, '../out/preview/brand')
if (existsSync(brandSrc)) cpSync(brandSrc, resolve(here, '../out/preview/preview/brand'), { recursive: true })

const SIZES = {
  documents: [1180, 760],
  'chat-byproject': [340, 660],
  // The AI Model screen is tall (active card + context card + grouped picker) — capture it all.
  models: [840, 1500],
  'models-de': [840, 1500],
  'chat-runtime': [1180, 740],
  'chat-runtime-compat': [1180, 740]
}
// Electron's argv includes flags + the script path; take everything AFTER the script as case ids.
const sIdx = process.argv.findIndex((a) => a.endsWith('screenshot.mjs'))
let cases = (sIdx >= 0 ? process.argv.slice(sIdx + 1) : []).filter((a) => !a.startsWith('-'))
if (cases.length === 0) cases = ['documents', 'chat-byproject']

// Headless hardening (pass --no-sandbox on the CLI too; the switch alone is too late for the zygote).
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-dev-shm-usage')
// Destroying the only window would fire the default window-all-closed → app.quit(), killing the run
// before the next case. A no-op listener keeps the app alive between captures; we quit explicitly.
app.on('window-all-closed', () => {})

// Never hang the CI/agent: bail out after a generous ceiling.
const hardTimeout = setTimeout(() => {
  console.error('screenshot: hard timeout, exiting')
  process.exit(1)
}, 90_000)

function capture(c) {
  return new Promise((done) => {
    const [w, h] = SIZES[c] ?? [1180, 760]
    const win = new BrowserWindow({
      width: w,
      height: h,
      show: false,
      webPreferences: { backgroundThrottling: false }
    })
    win.webContents.on('console-message', (_e, _l, msg) => console.log(`  [page:${c}]`, msg))
    win.webContents.on('render-process-gone', (_e, d) => console.error(`  [gone:${c}]`, d.reason))
    const url = `${pathToFileURL(previewHtml).href}?case=${encodeURIComponent(c)}`
    win.webContents.once('did-finish-load', async () => {
      // Offscreen needs a tick to paint; give React + the async window.api stubs time too.
      // Full App-shell cases (`brand-home*`) chain workspace → settings → language re-render
      // → brand <img> fetch, and a cold first window adds JIT/IO — they need a longer settle.
      await new Promise((r) => setTimeout(r, c.startsWith('brand-home') ? 4500 : 1800))
      try {
        const img = await win.webContents.capturePage()
        const file = resolve(outDir, `${c}.png`)
        writeFileSync(file, img.toPNG())
        console.log('captured', c, '→', file, `(${img.getSize().width}x${img.getSize().height})`)
      } catch (e) {
        console.error('capture failed', c, e)
      } finally {
        win.destroy()
        done()
      }
    })
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error('load failed', c, code, desc)
      win.destroy()
      done()
    })
    win.loadURL(url)
  })
}

// NB: do NOT top-level `await app.whenReady()` — in Electron's ESM main the entry module must finish
// evaluating before 'ready' fires, so awaiting it here deadlocks. Use the callback form instead.
app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true })
  console.log('preview html:', previewHtml)
  for (const c of cases) await capture(c)
  clearTimeout(hardTimeout)
  app.quit()
})
