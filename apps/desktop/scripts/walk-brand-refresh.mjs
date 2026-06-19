// Playwright _electron eyeball walk for the brand refresh (docs/brand-refresh-plan).
// BR2 scope: confirm the teal token swap reads calm and AA-safe — accent/link/focus teal,
// the teal-fill + dark-ink primary button, the switch-on track, the selected-row teal bar —
// across a few representative screens in BOTH themes. The full six-screen / both-locale walk
// is BR4/BR6. (The in-app brand MARK is still the ◈ placeholder until BR3.)
//
// Run from apps/desktop AFTER `npm run build` (Playwright is an ad-hoc dev tool per §11.4):
//   node scripts/walk-brand-refresh.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const ROOT = join(os.tmpdir(), 'hilbertraum-eyeball')
const OUT = join(process.cwd(), '..', '..', 'docs', 'design-review', 'brand-refresh', 'br2')
const PW = 'eyeball-pass-123'

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'config'), { recursive: true })
writeFileSync(
  join(ROOT, 'config', 'policy.json'),
  JSON.stringify({ encryption_required: true, allow_network: false }, null, 2)
)
mkdirSync(OUT, { recursive: true })

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

const NAV = { home: 0, chat: 1, documents: 2, models: 3 }
async function goto(screen) {
  if (screen === 'settings') await page.locator('.nav-bottom .nav-item').first().click()
  else await page.locator('.nav-list .nav-item').nth(NAV[screen]).click()
  await sleep(250)
}

// ---- Gate (theme-aware, pre-unlock): the ◈ mark colour + the teal primary button ----
await shotBoth('gate-welcome')

const start = page.getByRole('button', { name: 'Get started' })
if (await start.isVisible().catch(() => false)) {
  await start.click()
  await sleep(200)
  await shotBoth('gate-create') // teal primary "Create workspace" + strength meter (semantic, untouched)
  await page.getByPlaceholder('Password', { exact: true }).first().fill(PW)
  await page.getByPlaceholder('Confirm password').fill(PW)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  for (const label of ['Skip — take me to the app', 'Skip for now']) {
    const b = page.getByRole('button', { name: label })
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {})
  }
  await sleep(400)
}

// ---- Home: adaptive hero (teal primary), nav icons teal, rail-foot indicator ----
await goto('home')
await shotBoth('home')

// ---- Chat empty state: focus ring/send accent teal; no mark in transcript ----
await goto('chat')
await shotBoth('chat-empty')

// ---- Settings: Appearance segmented control, switches (teal-on track), links ----
await goto('settings')
await sleep(200)
await shotBoth('settings')

await app.close()
console.log('DONE — screenshots in', OUT)
