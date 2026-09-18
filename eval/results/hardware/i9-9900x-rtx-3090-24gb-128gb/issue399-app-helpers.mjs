// Issue #399 leg B - do the per-turn helper calls on the chat runtime evict the conversation's
// own KV prefix? Drives the current-master dev build through Playwright _electron with
// HILBERTRAUM_LLAMA_BIN pointed at a tee wrapper, so every llama-server task shows up in one log.
//
// Usage: DISPLAY=:1 node leg-b.mjs [skills|noskills]
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Point REPO at the checkout and WORK at a scratch dir holding drive/, logs/,
// llama-server-tee.sh and the synthetic document (issue399-app-helpers.document.txt).
const REPO = process.env.HR_REPO ?? '<repo>'
const WORK = process.env.HR_WORK ?? `${REPO}/tmp/399-legb`
const DRIVE = `${WORK}/drive`
const LOGS = `${WORK}/logs`
const WRAPPER = `${WORK}/llama-server-tee.sh`
const PASSWORD = 'issue-399'
const MODEL_ID = 'qwen3.8-27b-ud-q5km'
const DOC = `${WORK}/plant-handbook.txt`
const mode = process.argv[2] ?? 'skills'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const log = (s) => { console.log(s); out.push(s) }

/** Newest tee log whose ARGV names the chat model. */
function chatLogPath() {
  const files = fs.readdirSync(LOGS).filter((f) => f.startsWith('sidecar-')).map((f) => path.join(LOGS, f))
    .filter((f) => (fs.readFileSync(f, 'utf8').split('\n')[0] ?? '').includes(MODEL_ID))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return files[0] ?? null
}
/** Every `task N | prompt eval time = X ms / Y tokens` in the chat log, in order. */
function promptEvals(file) {
  if (!file) return []
  const evals = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/task\s+(\d+)\s*\|\s*prompt eval time\s*=\s*([\d.]+) ms \/\s*(\d+) tokens/)
    if (m) evals.push({ task: +m[1], ms: +m[2], tokens: +m[3] })
  }
  return evals
}
/** `cached n_tokens = N` per task (the last one before each timing is what the task kept). */
function cachedLines(file) {
  if (!file) return []
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => /cached n_tokens|forcing full prompt/.test(l))
    .map((l) => l.trim())
}

async function launch() {
  const app = await electron.launch({
    executablePath: `${REPO}/node_modules/.bin/electron`,
    args: [`${REPO}/apps/desktop/out/main/index.mjs`],
    env: { ...process.env, DISPLAY: ':1', HILBERTRAUM_DRIVE_ROOT: DRIVE, HILBERTRAUM_LLAMA_BIN: WRAPPER },
    timeout: 120000
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await sleep(2500)
  const state = await page.evaluate(() => window.api.getWorkspaceState())
  if (state.state === 'uninitialized') {
    const r = await page.evaluate((pw) => window.api.createWorkspace(pw, 'encrypted'), PASSWORD)
    if (!r.ok) throw new Error('create failed: ' + JSON.stringify(r))
    log('workspace: created')
  } else {
    const r = await page.evaluate((pw) => window.api.unlockWorkspace(pw), PASSWORD)
    if (!r.ok) throw new Error('unlock failed: ' + JSON.stringify(r))
    log('workspace: unlocked')
  }
  await sleep(3000)
  await page.evaluate(() => window.api.updateSettings({ gpuMode: 'auto', autoStartActiveModel: false, uiLanguage: 'en' }))
  return { app, page }
}

const { app, page } = await launch()
try {
  // ---- skills: the leg's independent variable -------------------------------------------
  let skills = await page.evaluate(() => window.api.listSkills())
  log(`skills installed: ${skills.length} (${skills.filter((s) => s.enabled).length} enabled)`)
  if (mode === 'noskills') {
    for (const s of skills.filter((s) => s.enabled)) {
      await page.evaluate((id) => window.api.disableSkill(id), s.installId)
    }
  } else {
    for (const s of skills.filter((s) => !s.enabled && !s.unavailableAt)) {
      await page.evaluate((id) => window.api.enableSkill(id), s.installId).catch(() => {})
    }
  }
  skills = await page.evaluate(() => window.api.listSkills())
  const enabled = skills.filter((s) => s.enabled)
  log(`skills after [${mode}]: ${enabled.length} enabled -> ${enabled.map((s) => s.installId).join(', ') || '(none)'}`)

  // ---- runtime --------------------------------------------------------------------------
  const st = await page.evaluate((id) => window.api.useModel(id), MODEL_ID)
  log(`runtime: backend=${st.backend} healthy=${st.healthy} model=${st.modelId}`)
  const lp = chatLogPath()
  log(`tee log: ${lp}`)
  log(`ARGV: ${lp ? fs.readFileSync(lp, 'utf8').split('\n')[0] : 'NONE'}`)
  const usage0 = await page.evaluate(() => window.api.getSettings())
  log(`settings contextTokens: ${usage0.contextTokens ?? '(unset -> manifest default)'}`)

  // ---- the document ---------------------------------------------------------------------
  let docs = await page.evaluate(() => window.api.listDocuments())
  if (!docs.some((d) => d.title?.includes('plant-handbook') || d.filename?.includes('plant-handbook'))) {
    const job = await page.evaluate((p) => window.api.importDocuments([p]), DOC)
    for (let i = 0; i < 600; i += 1) {
      const s = await page.evaluate((id) => window.api.getImportJob(id), job.id)
      if (s.done === true || s.state === 'done' || s.state === 'error') break
      await sleep(500)
    }
    await sleep(2000)
  }
  docs = await page.evaluate(() => window.api.listDocuments())
  const doc = docs.find((d) => (d.title ?? d.filename ?? '').includes('plant-handbook'))
  log(`document: ${doc?.id} status=${doc?.status} chunks=${doc?.chunkCount} title=${doc?.title}`)
  const active = await page.evaluate(() => window.api.getActiveDocTask())
  log(`active doc task after ingest: ${active ? JSON.stringify({ id: active.id, kind: active.kind, state: active.state }) : 'NONE'}`)
  const treeLines = (await page.evaluate(() => window.api.getLogTail())).filter((l) => /tree|Deep index|deep-index/i.test(l))
  log(`tree/deep-index log lines: ${treeLines.length ? treeLines.slice(-4).join(' | ') : '(none)'}`)

  // ---- the asks -------------------------------------------------------------------------
  const ask = async (convId, label, question) => {
    const before = promptEvals(chatLogPath()).length
    const t0 = Date.now()
    const msg = await page.evaluate(
      ([c, q]) => window.api.askDocuments(c, q),
      [convId, question]
    )
    await sleep(1500)
    const all = promptEvals(chatLogPath())
    const mine = all.slice(before)
    log(`\n[${label}] "${question}"`)
    log(`  ${Math.round((Date.now() - t0) / 1000)} s, ${mine.length} model task(s) on the chat runtime:`)
    for (const e of mine) log(`    task ${e.task}: prompt eval ${e.ms} ms / ${e.tokens} tokens`)
    log(`  answer (first 120 chars): ${String(msg?.content ?? '').slice(0, 120).replace(/\n/g, ' ')}`)
    log(`  skillOffer: ${msg?.skillOffer ? JSON.stringify(msg.skillOffer) : 'none'}`)
    return mine
  }

  const conv1 = await page.evaluate((ids) => window.api.createConversation({ mode: 'documents', title: 'A', scopeDocumentIds: ids }), [doc.id])
  log(`\n=== conversation 1 (ordinary documents ask, twice) ===`)
  await ask(conv1.id, 'C1 turn 1 (ordinary)', 'What is checked with the small gauge above the tool bench?')
  await ask(conv1.id, 'C1 turn 2 (ordinary)', 'And how often is the backup generator exercised?')

  const conv2 = await page.evaluate((ids) => window.api.createConversation({ mode: 'documents', title: 'B', scopeDocumentIds: ids }), [doc.id])
  log(`\n=== conversation 2 (ordinary turn 1, classifier-trigger turn 2) ===`)
  await ask(conv2.id, 'C2 turn 1 (ordinary)', 'What is checked with the small gauge above the tool bench?')
  await ask(conv2.id, 'C2 turn 2 (aggregation-shaped)', 'Group the amounts in these documents by category and sum each category.')

  const conv3 = await page.evaluate((ids) => window.api.createConversation({ mode: 'documents', title: 'C', scopeDocumentIds: ids }), [doc.id])
  log(`\n=== conversation 3 (ordinary turn 1, low-confidence-relevance turn 2) ===`)
  await ask(conv3.id, 'C3 turn 1 (ordinary)', 'What is checked with the small gauge above the tool bench?')
  await ask(conv3.id, 'C3 turn 2 (compare, no second doc)', 'Compare this document with the other contract and list the differences.')

  log('\n=== cached-token / forcing-full lines from the tee log ===')
  for (const l of cachedLines(chatLogPath())) log(`  ${l}`)
} catch (err) {
  log(`ERROR ${err?.stack ?? err}`)
} finally {
  await page.evaluate(() => window.api.stopRuntime()).catch(() => {})
  await sleep(1500)
  await app.close().catch(() => {})
  fs.writeFileSync(`${WORK}/leg-b-${mode}.run.log`, out.join('\n') + '\n')
  console.log(`\nwrote ${WORK}/leg-b-${mode}.run.log`)
  process.exit(0)
}
