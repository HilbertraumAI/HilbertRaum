// Playwright _electron eyeball walk for the Documents-screen refinement (design-guidelines
// §11.6 / §11.4 verification pattern). Drives the real app through the create-password gate,
// seeds documents via window.api (mock embedder — no model needed), and screenshots the
// Documents screen in BOTH themes: empty, populated (chips + status badges), the "⋯" overflow
// open, and the selection toolbar active (two selected → Compare enabled).
//
// Run from apps/desktop AFTER `npm run build` (Playwright is an ad-hoc dev tool per §11.4 —
// it is NOT a committed dependency; install it first with `npm i -D playwright -w apps/desktop`):
//   node scripts/walk-docs-refinement.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const ROOT = join(os.tmpdir(), 'hilbertraum-eyeball')
// Screenshots live at the REPO ROOT docs/design-review (alongside the chat-UI captures), not
// under apps/desktop. The script runs from apps/desktop, so go up two levels.
const OUT = join(process.cwd(), '..', '..', 'docs', 'design-review', 'docs-refinement', 'after')
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
  // A deliberately long filename (§11.6 refinement / FIX 1): confirms the name uses the
  // available width and ellipsizes cleanly — not a premature one-word truncation.
  file('Oracle metrics summary and quarterly variance analysis 2025 H2 final.txt',
    'Long-name coverage check.\n'.repeat(60))
]

const env = { ...process.env, HILBERTRAUM_DRIVE_ROOT: ROOT }
delete env.ELECTRON_RUN_AS_NODE

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({ args: [join(process.cwd(), 'out', 'main', 'index.js')], env })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.evaluate(() => localStorage.clear())
await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
// NB: in dev the workspace opens plaintext (no gate) and the UI language follows the OS
// locale (resolved from settings, not localStorage), so captures may be German — fine for an
// eyeball of layout/contrast/both themes. All selectors below are class-based (language-agnostic).

// Force the design token theme for a deterministic capture (data-theme is the real switch in
// tokens.css), alongside emulateMedia so reduced-motion + color-scheme agree.
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

// In dev the workspace opens plaintext (no gate); if a gate ever appears, drive it.
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

// ---- Navigate to Documents (home=0, chat=1, documents=2, model=3) --------------------------
await page.locator('.nav-item').nth(2).click()
await page.locator('.docs-screen').waitFor({ timeout: 10000 })
await page.locator('.docs-main').waitFor({ timeout: 10000 })
await sleep(400)
await shotBoth('documents-empty')

// ---- Seed documents (mock embedder) -------------------------------------------------------
await page.evaluate(async (p) => await window.api.importDocuments(p), paths)
await page.waitForFunction(
  async () => {
    const docs = await window.api.listDocuments()
    return docs.length >= 5 && docs.every((d) => d.status === 'indexed' || d.status === 'failed')
  },
  null,
  { timeout: 90000 }
)

// Organize so the row chips show Library / project / Temporary / Archived.
await page.evaluate(async () => {
  const docs = await window.api.listDocuments()
  const byTitle = (t) => docs.find((d) => d.title.startsWith(t))
  const proj = await window.api.createCollection('Tax 2025')
  if (byTitle('terms')) await window.api.addToCollection([byTitle('terms').id], proj.id)
  if (byTitle('quarterly')) await window.api.setDocumentLifecycle([byTitle('quarterly').id], 'temporary')
  if (byTitle('invoice')) await window.api.setDocumentLifecycle([byTitle('invoice').id], 'archived')
})

// Best-effort: a Summary + Deeply-indexed badge on contract.txt via the mock runtime. Wrapped
// so a missing/slow mock runtime never fails the walk.
try {
  await page.evaluate(async () => {
    const models = await window.api.listModels()
    const m = models.find((x) => x.startableAsMock) ?? models[0]
    if (m) await window.api.startRuntime(m.id)
  })
  const contractId = await page.evaluate(async () => {
    const docs = await window.api.listDocuments()
    return (docs.find((d) => d.title.startsWith('contract')) ?? {}).id ?? null
  })
  if (contractId) {
    for (const kind of ['summary', 'tree']) {
      const { jobId } = await page.evaluate(
        async (req) => await window.api.startDocTask(req),
        { kind, documentIds: [contractId] }
      )
      // Poll the task to completion (mock is fast), bounded.
      for (let i = 0; i < 40; i++) {
        const st = await page.evaluate(async (id) => await window.api.getDocTask(id), jobId)
        if (st && (st.state === 'done' || st.state === 'failed')) break
        await sleep(500)
      }
    }
  }
} catch (e) {
  console.log('badge seeding skipped:', String(e).slice(0, 120))
}

// The React list state is still empty (we seeded via window.api, bypassing the screen), and the
// empty state hides the toolbar's Refresh — so remount the screen by leaving and returning;
// DocumentsScreen reloads on mount.
await page.locator('.nav-item').nth(0).click()
await sleep(300)
await page.locator('.nav-item').nth(2).click()
await page.locator('.doc-row').first().waitFor({ timeout: 10000 })
await sleep(600)
await shotBoth('documents-populated')

// ---- The "⋯" overflow open ----------------------------------------------------------------
const firstMenuBtn = page.locator('.doc-row-menu-btn').first()
await firstMenuBtn.click({ force: true })
await page.locator('.menu [role="menuitem"]').first().waitFor({ timeout: 5000 }).catch(() => {})
await shotBoth('documents-overflow-open')
await page.keyboard.press('Escape').catch(() => {})

// ---- Selection toolbar active (two selected → Compare enabled) -----------------------------
const boxes = page.locator('.doc-select')
const n = await boxes.count()
if (n >= 2) {
  await boxes.nth(0).check({ force: true })
  await boxes.nth(1).check({ force: true })
  await page.locator('.docs-selbar').waitFor({ timeout: 5000 }).catch(() => {})
  await shotBoth('documents-selection-two')
}

await app.close()
console.log('DONE — screenshots in', OUT)
