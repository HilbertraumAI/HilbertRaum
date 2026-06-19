// Playwright _electron eyeball walk for the brand refresh (docs/brand-refresh-plan).
// Confirms the refresh end to end: the sealed-room BrandMark (rail + gate, theme-flipped),
// the teal token swap (accent/link/focus, teal-fill + dark-ink primary, switch-on track,
// selected-row teal bar), with no teal-on-light text and semantics still green/amber/red —
// across ALL six screens in BOTH themes AND both locales (EN/DE).
//
// Run from apps/desktop AFTER `npm run build` (Playwright is an ad-hoc dev tool per §11.4):
//   node scripts/walk-brand-refresh.mjs   (BR_PHASE overrides the output subfolder)
//
// Gate note: policy.json is parsed NESTED (policy.workspace.encryption_required) — a flat key
// is ignored and the isDev build falls back to plaintext_dev, skipping the gate. We drive the
// gate by CSS/input type because the dev machine boots German, not English.
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

const NAV = { home: 0, chat: 1, documents: 2, models: 3, skills: 4 }
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

// ---- All six screens, both themes, both locales ----
async function setLocale(locale) {
  await page.evaluate(async (l) => {
    await window.api.updateSettings?.({ uiLanguage: l })
    localStorage.setItem('hilbertraum.uiLanguage', l)
  }, locale)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await sleep(500)
}

for (const locale of ['en', 'de']) {
  await setLocale(locale)
  // Home — adaptive hero (teal primary), teal nav icons, rail-foot indicator.
  await goto('home')
  await shotBoth(`home-${locale}`)
  // Chat — focus ring / send accent teal; NO brand mark in the transcript.
  await goto('chat')
  await shotBoth(`chat-${locale}`)
  // Documents — selected-row teal bar; green readiness badge stays green; neutral chips.
  await goto('documents')
  await shotBoth(`documents-${locale}`)
  // AI Model — cards + "Technical details"; download progress uses theme-aware --accent
  // (light dark-teal on a light track, dark bright-teal on a dark track — both ≥3:1).
  await goto('models')
  await shotBoth(`models-${locale}`)
  // Skills — capability library, teal-accented affordances.
  await goto('skills')
  await shotBoth(`skills-${locale}`)
  // Settings — Appearance segmented control, switches (teal-on track), links.
  await goto('settings')
  await shotBoth(`settings-${locale}`)
  // Settings → Privacy & data (reassuring, not theatrical).
  await page.locator('[role="tab"]').nth(1).click().catch(() => {})
  await sleep(200)
  await shotBoth(`settings-privacy-${locale}`)
}

await app.close()
console.log('DONE — screenshots in', OUT)
