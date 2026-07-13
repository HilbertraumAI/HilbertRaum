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
  'chat-runtime-compat': [1180, 740],
  // #44/#46: short composer-strip components — no full-screen canvas needed.
  'skill-info-card': [820, 320],
  'skill-info-card-de': [820, 320],
  'skill-run-result-offer': [820, 220]
}
// Per-case readiness selector: an element that only exists once the case's async chain
// (mock window.api fetch → React state → re-render) has completed, so the poll below can
// capture as soon as the UI is real instead of sleeping a fixed worst-case interval.
// Unlisted cases fall back to the generic "harness root has rendered children" check.
const READY = {
  documents: '.doc-row',
  'chat-byproject': '.chat-conv-group',
  models: '.model-card',
  'models-de': '.model-card',
  'chat-runtime': '.chat-runtime-hint',
  'chat-runtime-compat': '.chat-runtime-hint',
  'chat-warmup': '.chat-warmup-hint',
  'skill-info-card': '.skill-info-card',
  'skill-info-card-de': '.skill-info-card',
  'skill-run-result-offer': '.skill-run-bar'
}

// Marketing captures (preview.tsx marketing block): every shot renders as
// marketing-<shot>[-de][-light]; pair with SHOT_SCALE=2 for hi-dpi output. The staged shells
// self-report readiness via body[data-marketing-ready]; the indicator close-up is a plain
// component case.
const MKT_SHOTS = {
  'marketing-salary': [1220, 856],
  'marketing-spending': [1220, 856],
  'marketing-contract': [1220, 1226],
  'marketing-documents': [1220, 856],
  'marketing-privacy': [1220, 1136],
  'marketing-indicator': [640, 280]
}
for (const [base, size] of Object.entries(MKT_SHOTS)) {
  for (const suffix of ['', '-de', '-light', '-de-light']) {
    SIZES[base + suffix] = size
    READY[base + suffix] = base === 'marketing-indicator' ? '.local-indicator' : 'body[data-marketing-ready]'
  }
}

// Poll the ready condition, then let two frames paint. The previous fixed settles
// (1.8 s, 4.5 s for the full App-shell cases) stay as timeout CEILINGS: on timeout we
// warn and capture anyway — same worst-case behavior, but the common case is much faster.
async function waitReady(win, c) {
  const isAppShell = c.startsWith('brand-home')
  const ceiling = isAppShell || c.startsWith('marketing-') ? 4500 : 1800
  const selector = READY[c] ?? null
  // Full App-shell cases chain workspace → settings → language re-render → brand <img>
  // fetch; the brand images completing marks the end of that chain.
  const expr = `(() => {
    if (document.fonts.status !== 'loaded') return false
    const root = document.querySelector('[data-preview-case]')
    if (!root || root.childElementCount === 0) return false
    ${selector ? `if (!document.querySelector(${JSON.stringify(selector)})) return false` : ''}
    ${
      isAppShell
        ? `const imgs = [...document.querySelectorAll('.brand img')]
    if (imgs.length === 0 || !imgs.every((i) => i.complete && i.naturalWidth > 0)) return false`
        : ''
    }
    return true
  })()`
  const deadline = Date.now() + ceiling
  for (;;) {
    let ok = false
    try {
      ok = await win.webContents.executeJavaScript(expr, true)
    } catch {
      /* page still navigating — keep polling until the ceiling */
    }
    if (ok) break
    if (Date.now() >= deadline) {
      console.warn(`  [wait:${c}] ready condition not met within ${ceiling}ms — capturing anyway`)
      break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  // Offscreen still needs the ready DOM to actually paint: wait two animation frames.
  try {
    await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      true
    )
  } catch {
    /* capture regardless */
  }
}

// Electron's argv includes flags + the script path; take everything AFTER the script as case ids.
const sIdx = process.argv.findIndex((a) => a.endsWith('screenshot.mjs'))
let cases = (sIdx >= 0 ? process.argv.slice(sIdx + 1) : []).filter((a) => !a.startsWith('-'))
if (cases.length === 0) cases = ['documents', 'chat-byproject']

// Headless hardening (pass --no-sandbox on the CLI too; the switch alone is too late for the zygote).
app.commandLine.appendSwitch('no-sandbox')
// SHOT_SCALE=2 renders every capture at 2x device pixels (crisp marketing/hero images).
if (process.env.SHOT_SCALE) app.commandLine.appendSwitch('force-device-scale-factor', process.env.SHOT_SCALE)
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
      await waitReady(win, c)
      try {
        if (c.startsWith('marketing-')) {
          // Park the pointer in the harness padding (bottom-left corner): the hidden window maps
          // the REAL OS cursor position, so a stray :hover fill (a rail item, a document row)
          // lands in captures. The 16px harness padding is guaranteed interaction-free.
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: h - 8 })
          await win.webContents.executeJavaScript(
            'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
            true
          )
        }
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
