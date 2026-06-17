// Playwright _electron eyeball walk for the S6 chat-composer SkillPicker (skills plan §10/§15;
// design-guidelines §11.4 verification pattern). This closes the one carry-forward from the Skills
// wave: every UI phase since S6 forwarded the composer-picker "live eyeball" as uncaptured, because
// the walk harness never brought up a running model, so the chat composer never rendered for the
// camera. The picker sits behind TWO gates in ChatScreen: (A) a RUNNING runtime (else the whole
// screen is the "no model" EmptyState) and (B) ≥1 enabled skill. We satisfy (A) by starting a chat
// runtime with no real binary/weights present — the factory falls back to the built-in mock runtime
// (registerModelIpc developerLeniency + services/runtime/mock.ts) — and (B) for free, since the
// bundled app skill `app-skills/bank-statement/` is discovered + installed-enabled in dev.
//
// Captures into docs/design-review/skills-s6/, in BOTH themes (light/dark) × BOTH locales (EN/DE):
//   1. composer-<loc>-skill-none    — composer footer, picker CLOSED ("Skill: No skill ▾")
//   2. picker-<loc>-open            — picker OPEN: None + the enabled skill(s) with description hints
//   3. picker-<loc>-suggest         — the S8 "Suggested: …" one-tap offer pinned on top
//   4. composer-<loc>-skill-active  — picker closed after picking a skill (trigger shows its title)
//   5. message-<loc>-skill-glyph    — the per-message .msg-skill glyph on a mock-runtime answer
//
// Run from apps/desktop AFTER `npm run build` (Playwright is an ad-hoc dev tool per §11.4 — NOT a
// committed dependency; install without saving:  npm i playwright --no-save -w apps/desktop):
//   node scripts/walk-skills-composer.mjs
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const ROOT = join(os.tmpdir(), 'hilbertraum-skills-eyeball')
const OUT = join(process.cwd(), '..', '..', 'docs', 'design-review', 'skills-s6')
// Any chat manifest id resolves in dev (model-manifests/ is found by walking up from the app path);
// with no weights on this fresh root the start gate falls back to the mock runtime.
const MODEL_ID = 'qwen3-4b-instruct-2507-q4'

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'config'), { recursive: true })
// Plaintext dev workspace (no unlock gate) + offline. Models policy is left at the dev default
// (allow_unverified_models true / require_sha256_match false) so a MISSING weight starts the mock.
writeFileSync(
  join(ROOT, 'config', 'policy.json'),
  JSON.stringify(
    {
      workspace: { encryption_required: false, allow_plaintext_dev_mode: true },
      network: { allow_model_downloads: false, allow_update_checks: false, allow_telemetry: false }
    },
    null,
    2
  )
)
mkdirSync(OUT, { recursive: true })

const env = { ...process.env, HILBERTRAUM_DRIVE_ROOT: ROOT }
delete env.ELECTRON_RUN_AS_NODE // the VSCode host exports it → Electron would boot as plain Node

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({ args: [join(process.cwd(), 'out', 'main', 'index.js')], env })
const page = await app.firstWindow()
// Default window (1100px) sits below the chat list's 1150px auto-collapse threshold; widen it so
// the conversation list (and its "New chat" control) is visible — the full review layout.
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setSize(1360, 900)
  w.center()
})
await page.waitForLoadState('domcontentloaded')
await page.evaluate(() => localStorage.clear()) // userData localStorage persists across runs
await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })

async function setTheme(theme) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
  await sleep(120)
}

// A closed-surface shot in both themes.
async function shotBoth(name) {
  await setTheme('light')
  await page.screenshot({ path: join(OUT, `${name}-light.png`), fullPage: true })
  await setTheme('dark')
  await page.screenshot({ path: join(OUT, `${name}-dark.png`), fullPage: true })
  await setTheme('light')
  console.log('captured', name)
}

// The SkillPicker trigger is the composer-footer menu button whose label starts with the localized
// "Skill:" prefix (the DepthMenu shares .footer-menu-btn). The prefix is "Skill:" in both EN + DE.
const skillTrigger = () => page.locator('.composer-footer .footer-menu-btn', { hasText: 'Skill:' })

async function openPicker() {
  if (await page.locator('.menu').isVisible().catch(() => false)) return
  await skillTrigger().click()
  await page.locator('.menu').waitFor({ timeout: 5000 })
  await sleep(150)
}
async function closePicker() {
  await page.keyboard.press('Escape').catch(() => {})
  await page.locator('.menu').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
  await sleep(80)
}

// An OPEN-menu shot in both themes: the menu is opened once and kept open across the theme toggle
// (openPicker is a no-op when already open), so React state driving the menu (e.g. the suggestion)
// is computed a single time. `expectSel` asserts the surface actually rendered before the shot.
async function shotBothWhileOpen(name, expectSel) {
  for (const theme of ['light', 'dark']) {
    await setTheme(theme)
    await openPicker()
    if (expectSel) await page.locator(expectSel).first().waitFor({ timeout: 8000 })
    await page.screenshot({ path: join(OUT, `${name}-${theme}.png`), fullPage: true })
  }
  await setTheme('light')
  console.log('captured', name)
}

// In plaintext dev the workspace opens without a gate; drive it only if one appears.
const start = page.getByRole('button', { name: 'Get started' })
if (await start.isVisible().catch(() => false)) {
  await start.click()
  const PW = 'eyeball-pass-123'
  await page.getByPlaceholder('Password', { exact: true }).first().fill(PW)
  await page.getByPlaceholder('Confirm password').fill(PW)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  for (const label of ['Skip — take me to the app', 'Skip for now']) {
    const b = page.getByRole('button', { name: label })
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {})
  }
}

// Wait for the workspace to be usable before touching settings/model IPC.
await page.waitForFunction(async () => (await window.api.getWorkspaceState()).state === 'unlocked', null, {
  timeout: 30000
})

// ---- Gate (A): bring up a runtime. No binary/weights here → the factory uses the mock runtime,
// which is enough to render the composer AND stream a (simulated) assistant reply. ----------------
await page.evaluate(async (id) => {
  await window.api.selectModel(id)
  await window.api.startRuntime(id)
}, MODEL_ID)
await page.waitForFunction(async () => (await window.api.getRuntimeStatus()).running === true, null, {
  timeout: 30000
})

// ---- Per-locale walk (EN, DE): force the language at the source of truth + the pre-unlock mirror,
// then reload. The main-process runtime survives a renderer reload, so we start it once above. -----
for (const locale of ['en', 'de']) {
  await page.evaluate(async (l) => {
    await window.api.updateSettings?.({ uiLanguage: l })
    localStorage.setItem('hilbertraum.uiLanguage', l)
  }, locale)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(async () => (await window.api.getRuntimeStatus()).running === true, null, {
    timeout: 30000
  })

  // Open Chat (nav order is home · chat · documents · models — the label is "Chat" in EN+DE),
  // then start a CLEAN conversation so the picker begins at "No skill" (a prior locale's sticky
  // default never leaks in).
  await page.locator('.nav-item', { hasText: 'Chat' }).first().click()
  await page.locator('.composer').waitFor({ timeout: 10000 })
  await page.locator('.chat-new').click()
  await page.locator('.composer').waitFor({ timeout: 10000 })
  // The picker renders only once enabledSkills loaded (gate B) — its presence is our sync point.
  await skillTrigger().waitFor({ timeout: 10000 })
  await sleep(300)

  // (1) Composer footer, picker CLOSED — "Skill: No skill ▾".
  await shotBoth(`composer-${locale}-skill-none`)

  // (2) Picker OPEN — None + the enabled skill(s) with their description hints.
  await shotBothWhileOpen(`picker-${locale}-open`, '.menu-item.menu-radio')
  await closePicker()

  // (3) The S8 deterministic one-tap offer: a triggering draft makes selector.ts score the
  // bank-statement skill; the offer pins on top of the picker (recomputed on open with the draft).
  await page.locator('.chat-input').fill('reconcile this bank statement')
  await sleep(150)
  await shotBothWhileOpen(`picker-${locale}-suggest`, '.menu-item.skill-suggest')
  await closePicker()
  await page.locator('.chat-input').fill('')

  // (4) Active state: pick the skill; the closed trigger now shows its title.
  await openPicker()
  await page.getByRole('menuitemradio', { name: /Bank Statement Analysis/ }).click()
  await page.locator('.menu').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  await sleep(150)
  await shotBoth(`composer-${locale}-skill-active`)

  // (5) Per-message glyph: send a turn through the mock runtime with the skill active → the
  // assistant row is stamped + the .msg-skill glyph shows.
  await page.locator('.chat-input').fill('Walk me through the totals on this statement.')
  await page.keyboard.press('Enter')
  await page.locator('.msg-skill').first().waitFor({ timeout: 30000 })
  await sleep(400)
  await shotBoth(`message-${locale}-skill-glyph`)
}

await app.close()
console.log('DONE — screenshots in', OUT)
