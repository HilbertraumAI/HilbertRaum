// Playwright _electron eyeball walk for the Home/privacy/AI-Model refinement wave:
//   A) Home readiness-hub adaptive CTA (§11.3 D-UI3): needs-a-model → loud "Choose a
//      model"; ready → loud "Start chatting".
//   B) One app-wide privacy indicator at the foot of the rail (§12.1 #2), on every
//      screen, honest about the EFFECTIVE state: internet OFF → 🔒 "Offline"; internet
//      ON → 🔓 "Downloads on".
//   C) AI Model de-jargon (§3/§7): "Try in demo mode" (not "Start mock runtime"); no
//      disabled "Select" on a not-downloaded card (Download is the one clear action).
//
// BOTH themes AND both locales (EN/DE). A few states the fresh encrypted workspace can't
// reach on its own (a running model; downloads-allowed; a demo-capable card) are forced
// by overriding the relevant window.api reads in the page — visual capture only.
//
// Run from apps/desktop AFTER `npm run build` (Playwright is an ad-hoc dev tool per §11.4):
//   node scripts/walk-home-privacy-aimodel.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const ROOT = join(os.tmpdir(), 'hilbertraum-eyeball')
const OUT = join(process.cwd(), '..', '..', 'docs', 'design-review', 'home-privacy-aimodel')
const PW = 'eyeball-pass-123'

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'config'), { recursive: true })
// Same policy.json the repo's other eyeball walks use (exercises the gate). The policy
// ceiling leaves model downloads allowed, so flipping the allowNetwork SETTING drives the
// effective offline state — we toggle it to show both the 🔒 "Offline" and 🔓 "Downloads
// on" rail states.
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
const railLabel = () =>
  page.evaluate(() => document.querySelector('.local-indicator-sidebar')?.textContent?.trim())
const heroPrimary = () =>
  page.evaluate(() => document.querySelector('.actions button.btn.primary')?.textContent?.trim())

// ---- Drive the create gate (encryption required) ----
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

// setNetwork/startMock/stopRuntime use CALLABLE window.api methods (the contextBridge
// object is frozen, so its functions can be invoked but not reassigned).
const setNetwork = (on) =>
  page.evaluate(async (v) => await window.api.updateSettings?.({ allowNetwork: v }), on)

for (const locale of ['en', 'de']) {
  await page.evaluate(async (l) => {
    await window.api.updateSettings?.({ uiLanguage: l })
    localStorage.setItem('hilbertraum.uiLanguage', l)
  }, locale)
  await setNetwork(false) // start each locale OFF (honest default)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await sleep(500)

  // ---- A) Home — needs-a-model (fresh, no model running) → loud "Choose a model" ----
  await goto('home')
  await sleep(400)
  console.log(`[${locale}] needs-model hero primary:`, await heroPrimary())
  await shotBoth(`home-needsmodel-${locale}`)

  // ---- B) Rail indicator OFF ("Offline") on every screen ----
  for (const s of ['home', 'chat', 'documents', 'models', 'settings']) {
    await goto(s)
    if (s === 'home') console.log(`[${locale}] rail (OFF):`, await railLabel())
    await shotBoth(`rail-off-${locale}-${s}`)
  }

  // ---- C) AI Model — missing card: no disabled Select, Download + "Try in demo mode" ----
  await goto('models')
  await sleep(300)
  const cardBtns = await page.evaluate(() =>
    [...document.querySelectorAll('.model-card')].map((c) => ({
      title: c.querySelector('.model-title')?.textContent,
      buttons: [...c.querySelectorAll('button')].map((b) => b.textContent?.trim()).filter(Boolean)
    }))
  )
  console.log(`[${locale}] AI Model cards:`, JSON.stringify(cardBtns))
  await shotBoth(`models-${locale}`)

  // ---- B') Rail indicator ON ("Downloads on") — flip the allowNetwork setting ----
  await setNetwork(true)
  await goto('chat') // navigate so App re-fetches the policy/effective state
  await goto('home')
  await sleep(300)
  console.log(`[${locale}] rail (ON):`, await railLabel())
  await shotBoth(`rail-on-${locale}-home`)
  await goto('settings')
  await shotBoth(`rail-on-${locale}-settings`)

  // ---- A') Home — ready: actually start the dev mock so runtime.running is real ----
  const startedId = await page.evaluate(async () => {
    const ms = await window.api.listModels()
    const m = ms.find((x) => x.role === 'chat' && x.startableAsMock)
    if (!m) return null
    await window.api.startRuntime(m.id)
    return m.id
  })
  if (startedId) {
    await page
      .waitForFunction(async () => (await window.api.getRuntimeStatus())?.running === true, null, {
        timeout: 30000
      })
      .catch(() => console.log(`[${locale}] WARN: mock runtime did not report running`))
    await goto('chat')
    await goto('home')
    await sleep(600)
    console.log(`[${locale}] ready hero primary:`, await heroPrimary())
    await shotBoth(`home-ready-${locale}`)
    await page.evaluate(async () => await window.api.stopRuntime?.()) // reset for next locale
    await sleep(300)
  } else {
    console.log(`[${locale}] WARN: no demo-capable chat model to start (skipping ready capture)`)
  }
}

await app.close()
console.log('DONE — screenshots in', OUT)
