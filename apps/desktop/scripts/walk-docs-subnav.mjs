// Playwright _electron eyeball walk for the Documents sub-nav regroup + suggested-project
// REMOVAL (design-guidelines §11.6 / §11.4 verification pattern). Drives the real app through
// the create-password gate, seeds documents via window.api (mock embedder — no model needed),
// then screenshots the Documents screen in BOTH themes AND both locales (EN/DE):
//   - populated list with NO suggestion banner anywhere
//   - the regrouped sub-nav (All documents · Projects · Locations · Views) with "More" collapsed
//   - the sub-nav with "More" expanded (the rare diagnostic views revealed)
//   - the sub-nav collapsed (list full-width) and expanded
//   - the active-item highlight (fill, not a ring)
//
// Run from apps/desktop AFTER `npm run build` (Playwright is an ad-hoc dev tool per §11.4 —
// NOT a committed dependency; install with `npm i -D playwright -w apps/desktop` if missing):
//   node scripts/walk-docs-subnav.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const ROOT = join(os.tmpdir(), 'hilbertraum-eyeball')
const OUT = join(process.cwd(), '..', '..', 'docs', 'design-review', 'docs-subnav')
const PW = 'eyeball-pass-123'

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'config'), { recursive: true })
// Exercise the gate: encryption required (§11.4).
writeFileSync(
  join(ROOT, 'config', 'policy.json'),
  JSON.stringify({ encryption_required: true, allow_network: false }, null, 2)
)
mkdirSync(OUT, { recursive: true })

// Seed source files (plain text → indexes under the MockEmbedder, no model required).
const srcDir = join(ROOT, 'src-files')
mkdirSync(srcDir, { recursive: true })
const file = (n, body) => {
  const p = join(srcDir, n)
  writeFileSync(p, body)
  return p
}
const paths = [
  file('contract.txt', 'Severance and termination clauses.\n'.repeat(60)),
  file('terms.txt', 'Payment terms net 30 days.\n'.repeat(60)),
  file('quarterly-report.txt', 'Quarterly figures and commentary.\n'.repeat(60)),
  file('invoice.txt', 'Invoice total and due date.\n'.repeat(60)),
  // An unsupported file fails import → the "Failed imports" rare VIEW is non-empty, so the
  // "More" disclosure is offered (and can be expanded for the capture).
  file('scan-notes.xyz', 'unsupported\n')
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

// In dev the workspace opens plaintext (no gate); if a gate appears, drive it.
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

// ---- Seed documents + a project + lifecycle so the sub-nav has Projects/Locations content --
await page.locator('.nav-item').nth(2).click()
await page.locator('.docs-screen').waitFor({ timeout: 10000 })
await sleep(300)
await page.evaluate(async (p) => await window.api.importDocuments(p), paths)
await page.waitForFunction(
  async () => {
    const docs = await window.api.listDocuments()
    return docs.length >= 5 && docs.every((d) => d.status === 'indexed' || d.status === 'failed')
  },
  null,
  { timeout: 90000 }
)
await page.evaluate(async () => {
  const docs = await window.api.listDocuments()
  const byTitle = (t) => docs.find((d) => d.title.startsWith(t))
  const proj = await window.api.createCollection('Tax 2025')
  if (byTitle('terms')) await window.api.addToCollection([byTitle('terms').id], proj.id)
  if (byTitle('quarterly')) await window.api.setDocumentLifecycle([byTitle('quarterly').id], 'temporary')
  if (byTitle('invoice')) await window.api.setDocumentLifecycle([byTitle('invoice').id], 'archived')
})

// ---- Per-locale walk (EN, DE): force the language via the pre-unlock mirror + reload --------
for (const locale of ['en', 'de']) {
  // Force the language at the SOURCE OF TRUTH: after unlock the app re-applies the
  // AppSettings.uiLanguage (overriding the pre-unlock mirror), so set the setting too.
  await page.evaluate(async (l) => {
    await window.api.updateSettings?.({ uiLanguage: l })
    localStorage.setItem('hilbertraum.uiLanguage', l)
    // Clear remembered sub-nav collapse / More state so each locale starts from the default.
    localStorage.removeItem('hilbertraum.docs.railCollapsed')
    localStorage.removeItem('hilbertraum.docs.viewsMoreOpen')
  }, locale)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.nav-item').nth(2).click()
  await page.locator('.doc-row').first().waitFor({ timeout: 10000 })
  await sleep(500)

  // (1) Populated list + regrouped sub-nav, "More" collapsed. No suggestion banner anywhere.
  await shotBoth(`subnav-${locale}-populated`)
  const suggestCount = await page.locator('.doc-suggest').count()
  console.log(`[${locale}] .doc-suggest elements (must be 0):`, suggestCount)

  // (2) "More" expanded — the rare diagnostic views revealed.
  const more = page.locator('.docs-rail-more').first()
  if (await more.isVisible().catch(() => false)) {
    await more.click()
    await sleep(150)
    await shotBoth(`subnav-${locale}-more-open`)
    await more.click() // collapse again
    await sleep(120)
  } else {
    console.log(`[${locale}] WARN: "More" disclosure not visible`)
  }

  // (3) Active-item highlight: select Library (a Locations row) to show the fill treatment.
  const railItems = page.locator('.docs-rail-item')
  await railItems.nth(1).click() // first row after "All documents" is in a group; pick a stable one
  await sleep(150)
  await shotBoth(`subnav-${locale}-active`)

  // (4) Sub-nav collapsed → the list takes the full width.
  await page.locator('.docs-rail-collapse').click()
  await page.locator('.docs-layout.rail-collapsed').waitFor({ timeout: 5000 }).catch(() => {})
  await sleep(200)
  await shotBoth(`subnav-${locale}-collapsed`)
  // Re-open via the "»" handle.
  await page.locator('.docs-rail-show').click()
  await sleep(200)
}

await app.close()
console.log('DONE — screenshots in', OUT)
