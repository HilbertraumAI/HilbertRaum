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
const PHASE = process.env.BR_PHASE ?? 'br3'
const OUT = join(process.cwd(), '..', '..', 'docs', 'design-review', 'brand-refresh', PHASE)
const PW = 'eyeball-pass-123'

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'config'), { recursive: true })
// NOTE: policy.json is NESTED (parsed at policy.workspace.encryption_required) — a FLAT
// { encryption_required } is silently ignored and the dev build falls back to plaintext_dev,
// bypassing the gate. encryption_required:true is an absolute veto on plaintext_dev, so this
// forces the encrypted create/unlock gate even in the unpackaged (isDev) eyeball build.
writeFileSync(
  join(ROOT, 'config', 'policy.json'),
  JSON.stringify(
    { workspace: { encryption_required: true, allow_plaintext_dev_mode: false } },
    null,
    2
  )
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

// ---- Gate (theme-aware, pre-unlock via CSS): the BrandMark + the teal primary button ----
// The build may boot in any locale (the dev machine is German), so drive the gate by CSS /
// input type, NOT by localized button text.
await page.waitForSelector('.gate-brand', { timeout: 8000 }).catch(() => {})
await shotBoth('gate-welcome') // BrandMark above "HilbertRaum Lite", theme-flipped

// Welcome → create: the welcome screen's primary advances to the password step.
const primary = () => page.locator('.gate-card .btn.primary, .gate-actions .btn.primary').first()
await primary().click().catch(() => {})
await sleep(300)
const pwFields = page.locator('.gate-card input[type="password"]')
if (await pwFields.count().catch(() => 0)) {
  await shotBoth('gate-create') // teal primary "Create workspace" + strength meter (semantic, untouched)
  await pwFields.nth(0).fill(PW)
  await pwFields.nth(1).fill(PW)
  await primary().click().catch(() => {}) // Create workspace
  await sleep(500)
  // Optional starter step → advance/skip via any remaining gate button to reach the shell.
  for (let i = 0; i < 2; i++) {
    const btn = page.locator('.gate-card .btn, .gate-actions .btn').first()
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {})
    await sleep(300)
  }
}
await sleep(400)

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
