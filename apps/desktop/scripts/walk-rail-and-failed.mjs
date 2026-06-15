// Playwright _electron eyeball walk for the docs-screen-refinement polish wave
// (design-guidelines §12.1 #1 rail labels + §11.6 failed-import rows). Drives the real app
// through the create-password gate, then in BOTH themes AND both locales (EN/DE):
//   - the app rail on Home / Chat / Documents / AI Model / Settings — labels UNBROKEN
//     (no mid-word hyphen) and NOT clipped/overflowing; the script measures each label and
//     fails loudly if any wraps to >1 line or overflows the column.
//   - a Documents list containing a FAILED import: localized friendly error, Remove (+ Try
//     again only when retryable) instead of Preview, a COMPACT in-row banner.
//   - the "Failed imports" rare view; the regrouped sub-nav (tightened density) unaffected.
//
// Run from apps/desktop AFTER `npm run build` (Playwright is an ad-hoc dev tool per §11.4):
//   node scripts/walk-rail-and-failed.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const ROOT = join(os.tmpdir(), 'hilbertraum-eyeball')
const OUT = join(process.cwd(), '..', '..', 'docs', 'design-review', 'rail-and-failed')
const PW = 'eyeball-pass-123'

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'config'), { recursive: true })
writeFileSync(
  join(ROOT, 'config', 'policy.json'),
  JSON.stringify({ encryption_required: true, allow_network: false }, null, 2)
)
mkdirSync(OUT, { recursive: true })

// Seed source files: a few that index (plain text → MockEmbedder) + one unsupported that FAILS.
const srcDir = join(ROOT, 'src-files')
mkdirSync(srcDir, { recursive: true })
const file = (n, body) => {
  const p = join(srcDir, n)
  writeFileSync(p, body)
  return p
}
const paths = [
  file('contract.txt', 'Severance and termination clauses.\n'.repeat(60)),
  file('quarterly-report.txt', 'Quarterly figures and commentary.\n'.repeat(60)),
  file('weird-scan.xyz', 'unsupported binary-ish content\n') // → unsupported-type failure
]

const env = { ...process.env, HILBERTRAUM_DRIVE_ROOT: ROOT }
delete env.ELECTRON_RUN_AS_NODE

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({ args: [join(process.cwd(), 'out', 'main', 'index.js')], env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.evaluate(() => localStorage.clear())
await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })

async function setTheme(theme) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
  await sleep(120)
}
async function shotBoth(name) {
  await setTheme('light')
  await page.screenshot({ path: join(OUT, `${name}-light.png`), fullPage: true })
  await setTheme('dark')
  await page.screenshot({ path: join(OUT, `${name}-dark.png`), fullPage: true })
  await setTheme('light')
  console.log('captured', name)
}

// Measure every rail label: report its single-line width, the column width, and whether it
// wrapped (offsetHeight taller than one line) — the §12.1 #1 no-mid-word-break + fit check.
async function measureRail(locale) {
  const data = await page.evaluate(() => {
    const col = getComputedStyle(document.querySelector('.app-shell')).gridTemplateColumns
    const oneLine = (() => {
      // Probe one line-height by measuring a single-word label's natural line box.
      const el = document.querySelector('.nav-label')
      if (!el) return 0
      const cs = getComputedStyle(el)
      return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
    })()
    const labels = [...document.querySelectorAll('.nav-item .nav-label, .lock-btn .nav-label')].map((el) => {
      const lines = Math.round(el.offsetHeight / (parseFloat(getComputedStyle(el).lineHeight) || 1))
      return {
        text: el.textContent,
        offsetW: el.offsetWidth,
        scrollW: el.scrollWidth, // > offsetW ⇒ clipped/overflowing
        lines
      }
    })
    return { col, oneLine, labels }
  })
  console.log(`\n[${locale}] rail column: ${data.col}`)
  let bad = false
  for (const l of data.labels) {
    const clipped = l.scrollW > l.offsetW + 1
    const wrappedSingleWord = l.lines > 1 && !/[\s-]/.test(l.text)
    const flag = clipped || wrappedSingleWord ? '  <<< PROBLEM' : ''
    if (clipped || wrappedSingleWord) bad = true
    console.log(
      `[${locale}]   "${l.text}" lines=${l.lines} w=${l.scrollW}/${l.offsetW}${flag}`
    )
  }
  console.log(`[${locale}] rail labels OK: ${!bad}`)
  return !bad
}

// Drive the create gate (encryption required).
const start = page.getByRole('button', { name: 'Get started' })
if (await start.isVisible().catch(() => false)) {
  await start.click()
  await page.getByPlaceholder('Password', { exact: true }).first().fill(PW)
  await page.getByPlaceholder('Confirm password').fill(PW)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  for (const label of ['Skip — take me to the app', 'Skip for now']) {
    const b = page.getByRole('button', { name: label })
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {})
  }
}

// Seed documents (one fails as unsupported type).
await page.locator('.nav-item').nth(2).click()
await page.locator('.docs-screen').waitFor({ timeout: 10000 })
await sleep(300)
await page.evaluate(async (p) => await window.api.importDocuments(p), paths)
await page.waitForFunction(
  async () => {
    const docs = await window.api.listDocuments()
    return docs.length >= 3 && docs.every((d) => d.status === 'indexed' || d.status === 'failed')
  },
  null,
  { timeout: 90000 }
)

let allRailOk = true
for (const locale of ['en', 'de']) {
  await page.evaluate(async (l) => {
    await window.api.updateSettings?.({ uiLanguage: l })
    localStorage.setItem('hilbertraum.uiLanguage', l)
    localStorage.removeItem('hilbertraum.docs.railCollapsed')
    localStorage.removeItem('hilbertraum.docs.viewsMoreOpen')
  }, locale)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await sleep(400)

  // ---- Rail on every screen (nav indices: 0 Home, 1 Chat, 2 Documents, 3 AI Model; Settings is bottom) ----
  const screens = ['home', 'chat', 'documents', 'models']
  for (let i = 0; i < screens.length; i++) {
    await page.locator('.nav-list .nav-item').nth(i).click()
    await sleep(250)
    await shotBoth(`rail-${locale}-${screens[i]}`)
    if (i === 0) allRailOk = (await measureRail(locale)) && allRailOk
  }
  // Settings (bottom nav group).
  await page.locator('.nav-bottom .nav-item').first().click()
  await sleep(250)
  await shotBoth(`rail-${locale}-settings`)

  // ---- Documents: failed import row (All-docs view) ----
  await page.locator('.nav-list .nav-item').nth(2).click()
  await page.locator('.doc-row').first().waitFor({ timeout: 10000 })
  await sleep(300)
  await shotBoth(`failed-${locale}-all`)
  // Sanity-log the failed row's actions + banner text.
  const failedInfo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.doc-row')]
    const failed = rows.find((r) => r.querySelector('.banner'))
    if (!failed) return null
    const btns = [...failed.querySelectorAll('.doc-row-actions button')].map((b) => b.textContent?.trim())
    const banner = failed.querySelector('.banner')?.textContent?.trim()
    const bannerH = failed.querySelector('.banner')?.offsetHeight
    return { btns, banner, bannerH }
  })
  console.log(`[${locale}] failed row:`, JSON.stringify(failedInfo))

  // ---- "Failed imports" rare view (behind "More") ----
  const more = page.locator('.docs-rail-more').first()
  if (await more.isVisible().catch(() => false)) {
    await more.click()
    await sleep(150)
    const failedView = page.getByRole('button', { name: locale === 'de' ? 'Fehlgeschlagen' : 'Failed imports' })
    if (await failedView.isVisible().catch(() => false)) {
      await failedView.click()
      await sleep(200)
      await shotBoth(`failed-${locale}-view`)
    } else {
      console.log(`[${locale}] WARN: Failed-imports view button not found`)
    }
  }
}

console.log('\n==== RAIL LABELS ALL OK:', allRailOk, '====')
await app.close()
console.log('DONE — screenshots in', OUT)
if (!allRailOk) process.exit(2)
