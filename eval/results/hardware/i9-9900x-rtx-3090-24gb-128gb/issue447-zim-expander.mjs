// Issue #447 - does the ZIM query expander (the once-per-pack-scoped-ask search-plan call,
// `makeQueryExpander(runtime)` -> `ctx.zim.makeArm`, D-Z20 "always") evict the conversation's own
// KV prefix on every turn? Extends issue #399 leg B (issue399-app-helpers.mjs): the current-master
// dev build driven through Playwright _electron with HILBERTRAUM_LLAMA_BIN pointed at a tee
// wrapper, so every llama-server task shows up in one log. All skills are disabled, so the
// classifier can never fire and the expander is the only helper call on the chat runtime.
//
// Usage: DISPLAY=:1 node issue447-zim-expander.mjs [modelId]
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Point REPO at the checkout and WORK at a scratch dir holding drive/ (models/chat/<id>.gguf,
// zim/<one pack>.zim, runtime/kiwix-tools/<os>/), logs/, llama-server-tee.sh and the synthetic
// document (issue399-app-helpers.document.txt, saved as plant-handbook.txt).
const REPO = process.env.HR_REPO ?? '<repo>'
const WORK = process.env.HR_WORK ?? `${REPO}/tmp/447`
const DRIVE = `${WORK}/drive`
const LOGS = `${WORK}/logs`
const WRAPPER = `${WORK}/llama-server-tee.sh`
const PASSWORD = 'issue-447'
const MODEL_ID = process.argv[2] ?? 'qwen3.8-27b-ud-q5km'
const DOC = `${WORK}/plant-handbook.txt`
const Q1 = 'What is the Doppler effect?'
const Q2 = 'And what does the Heisenberg uncertainty principle state?'
const Q_PREFLIGHT = 'What is a neutron star?'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const log = (s) => { console.log(s); out.push(s) }

/** Newest tee log whose ARGV names the chat model. */
function chatLogPath() {
  const files = fs.readdirSync(LOGS).filter((f) => f.startsWith('sidecar-')).map((f) => path.join(LOGS, f))
    .filter((f) => (fs.readFileSync(f, 'utf8').split('\n')[0] ?? '').includes(`${MODEL_ID}.gguf`))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return files[0] ?? null
}
/** One record per finished task: total (task.n_tokens), prefilled, kept, prompt-eval ms, decode. */
function tasks(file) {
  if (!file) return []
  const totals = new Map()
  const evals = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let m = line.match(/task\s+(\d+)\s*\|\s*new prompt.*task\.n_tokens = (\d+)/)
    if (m) { totals.set(+m[1], +m[2]); continue }
    m = line.match(/task\s+(\d+)\s*\|\s*prompt eval time\s*=\s*([\d.]+) ms \/\s*(\d+) tokens/)
    if (m) { evals.push({ task: +m[1], ms: +m[2], prefilled: +m[3], total: totals.get(+m[1]) ?? NaN }); continue }
    m = line.match(/task\s+(\d+)\s*\|\s+eval time\s*=\s*([\d.]+) ms \/\s*(\d+) tokens/)
    if (m) { const e = evals.find((x) => x.task === +m[1]); if (e) { e.genMs = +m[2]; e.genTokens = +m[3] } }
  }
  return evals
}
/** The launched argv as the OS reports it (/proc/<pid>/cmdline), not as our code builds it. */
function osArgv() {
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      if (argv[0]?.endsWith('llama-server') && argv.some((a) => a.includes(`${MODEL_ID}.gguf`))) return { pid, argv }
    } catch { /* raced a dying process */ }
  }
  return null
}
const scrub = (s) => s.replaceAll(DRIVE, '<drive>').replaceAll(WORK, '<work>').replace(/\/[^\s]*\/llama-server/g, '<runtime>/llama-server')

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
  // ---- skills: all off, so the classifier has no candidates (leg B's `noskills` mode) ----
  let skills = await page.evaluate(() => window.api.listSkills())
  log(`skills installed: ${skills.length} (${skills.filter((s) => s.enabled).length} enabled)`)
  for (const s of skills.filter((s) => s.enabled)) {
    await page.evaluate((id) => window.api.disableSkill(id), s.installId)
  }
  skills = await page.evaluate(() => window.api.listSkills())
  log(`skills after [noskills]: ${skills.filter((s) => s.enabled).length} enabled`)

  // ---- runtime --------------------------------------------------------------------------
  const st = await page.evaluate((id) => window.api.useModel(id), MODEL_ID)
  log(`runtime: backend=${st.backend} healthy=${st.healthy} model=${st.modelId}`)
  const lp = chatLogPath()
  log(`tee log: ${lp ? scrub(lp) : 'NONE'}`)
  log(`ARGV (wrapper): ${lp ? scrub(fs.readFileSync(lp, 'utf8').split('\n')[0]) : 'NONE'}`)
  const os = osArgv()
  log(`ARGV (OS process list, /proc/${os?.pid}/cmdline): ${os ? scrub(os.argv.join(' ')) : 'NOT FOUND'}`)
  const cr = os ? os.argv.indexOf('--cache-ram') : -1
  log(`--cache-ram in the OS argv: ${cr >= 0 ? `present, value ${os.argv[cr + 1]}` : 'ABSENT'}`)
  const settings = await page.evaluate(() => window.api.getSettings())
  log(`settings contextTokens: ${settings.contextTokens ?? '(unset -> manifest default)'}`)

  // ---- the document (the control's corpus, leg B's handbook) ------------------------------
  let docs = await page.evaluate(() => window.api.listDocuments())
  if (!docs.some((d) => (d.title ?? d.filename ?? '').includes('plant-handbook'))) {
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
  log(`document: status=${doc?.status} chunks=${doc?.chunkCount} title=${doc?.title}`)
  const active = await page.evaluate(() => window.api.getActiveDocTask())
  log(`active doc task after ingest: ${active ? JSON.stringify({ kind: active.kind, state: active.state }) : 'NONE'}`)

  // ---- the knowledge pack -----------------------------------------------------------------
  const status0 = await page.evaluate(() => window.api.getKnowledgePackStatus())
  log(`pack tools: toolsInstalled=${status0.toolsInstalled}`)
  if (!status0.toolsInstalled) throw new Error('kiwix-tools not found on the drive - makeArm would return null')
  await page.evaluate(() => window.api.refreshKnowledgePacks())
  let packs = []
  for (let i = 0; i < 120; i += 1) {
    const s = await page.evaluate(() => window.api.getKnowledgePackStatus())
    packs = await page.evaluate(() => window.api.listKnowledgePacks())
    if (!s.refreshing && packs.length > 0) break
    await sleep(500)
  }
  const pack = packs[0]
  if (!pack) throw new Error('no knowledge pack registered from <drive>/zim/')
  if (!pack.enabled) await page.evaluate((id) => window.api.setKnowledgePackEnabled(id, true), pack.id)
  await sleep(4000) // the /suggest searchability probe runs from the end of the reconciliation
  packs = await page.evaluate(() => window.api.listKnowledgePacks())
  for (const p of packs) {
    log(`pack: "${p.title}" leaf=${p.leaf} lang=${p.language} articles=${p.articleCount} sizeBytes=${p.sizeBytes} enabled=${p.enabled} available=${p.available} searchable=${p.searchable} hint=${p.searchableHint}`)
  }

  // ---- the asks -------------------------------------------------------------------------
  const rows = []
  const ask = async (convId, run, turn, question) => {
    const before = tasks(chatLogPath()).length
    const t0 = Date.now()
    const msg = await page.evaluate(([c, q]) => window.api.askDocuments(c, q), [convId, question])
    const wall = (Date.now() - t0) / 1000
    await sleep(1500)
    const mine = tasks(chatLogPath()).slice(before)
    log(`\n[${run} turn ${turn}] "${question}"`)
    log(`  ${wall.toFixed(1)} s wall, ${mine.length} model task(s) on the chat runtime:`)
    for (const e of mine) {
      log(`    task ${e.task}: total ${e.total}, prefilled ${e.prefilled}, kept ${e.total - e.prefilled}, prompt eval ${e.ms} ms, decode ${e.genTokens ?? '?'} tokens / ${e.genMs ?? '?'} ms`)
    }
    log(`  answer (first 140 chars): ${String(msg?.content ?? '').slice(0, 140).replace(/\n/g, ' ')}`)
    const cites = (msg?.citations ?? msg?.sources ?? [])
    log(`  citations: ${cites.length}${cites.length ? ' -> ' + cites.slice(0, 4).map((c) => `${c.sourceKind ?? 'document'}:${c.sourceTitle}`).join(' | ') : ''}`)
    log(`  packOutcomes: ${msg?.packOutcomes ? JSON.stringify(msg.packOutcomes.map((o) => ({ status: o.status, reason: o.reason, found: o.found, admitted: o.admitted }))) : 'none'}`)
    log(`  skillOffer: ${msg?.skillOffer ? JSON.stringify(msg.skillOffer) : 'none'}`)
    rows.push({ run, turn, wall, tasks: mine, packOutcomes: msg?.packOutcomes ?? null })
    return { mine, msg }
  }
  const conversation = (title, scope) =>
    page.evaluate(([t, s]) => window.api.createConversation({ mode: 'documents', title: t, scope: s }), [title, scope])
  const SCOPE_PACK = { collectionIds: [], documentIds: [], packIds: [pack.id] } // all documents AND the pack
  const SCOPE_PACK_ONLY = { collectionIds: [], documentIds: [], packIds: [pack.id], documentsOff: true } // "Ask this pack"
  const SCOPE_CONTROL = { collectionIds: [], documentIds: [] } // all documents, packs OFF

  // Preflight: the pack is retrievable in the app BEFORE anything is measured. It also absorbs
  // the first-ever task on the slot, which is always a cold 0 (leg B, C1 turn 1).
  log(`\n=== preflight (pack-only, not measured): is the pack retrievable? ===`)
  const pre = await conversation('preflight', SCOPE_PACK_ONLY)
  const { mine: preTasks, msg: preMsg } = await ask(pre.id, 'preflight', 1, Q_PREFLIGHT)
  const searched = (preMsg?.packOutcomes ?? []).some((o) => o.status === 'searched' && o.admitted > 0)
  if (!searched) throw new Error('preflight: the pack contributed nothing - not retrievable, nothing measured')
  if (preTasks.length < 2) log('  NOTE: fewer than 2 model tasks on a pack-scoped ask - no expander call seen')

  const plan = [
    ['P1', 'pack + documents', SCOPE_PACK],
    ['C1', 'control, pack scope off', SCOPE_CONTROL],
    ['P2', 'pack + documents', SCOPE_PACK],
    ['C2', 'control, pack scope off', SCOPE_CONTROL],
    ['PO1', 'pack only (documentsOff)', SCOPE_PACK_ONLY],
    ['PO2', 'pack only (documentsOff)', SCOPE_PACK_ONLY]
  ]
  for (const [run, label, scope] of plan) {
    const conv = await conversation(run, scope)
    log(`\n=== ${run} (${label}) - fresh conversation, two ordinary questions ===`)
    await ask(conv.id, run, 1, Q1)
    await ask(conv.id, run, 2, Q2)
  }

  log('\n=== table (leg-B columns; the LAST task of a turn is the answer) ===')
  log('| conversation | turn | model tasks | task | total | prefilled | kept | prompt eval ms | decode tok / ms | turn wall s |')
  log('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    r.tasks.forEach((e, i) => {
      const role = r.tasks.length > 1 ? (i === r.tasks.length - 1 ? ' (answer)' : ' (expand)') : ''
      log(`| ${i === 0 ? r.run : ''} | ${i === 0 ? r.turn : ''} | ${i === 0 ? `**${r.tasks.length}**` : ''} | ${e.task}${role} | ${e.total} | ${e.prefilled} | ${i === r.tasks.length - 1 ? `**${e.total - e.prefilled}**` : e.total - e.prefilled} | ${e.ms} | ${e.genTokens ?? '?'} / ${e.genMs ?? '?'} | ${i === 0 ? r.wall.toFixed(1) : ''} |`)
    })
  }
} catch (err) {
  log(`ERROR ${err?.stack ?? err}`)
} finally {
  await page.evaluate(() => window.api.stopRuntime()).catch(() => {})
  await sleep(1500)
  await app.close().catch(() => {})
  fs.writeFileSync(`${WORK}/issue447-${MODEL_ID}.run.log`, out.join('\n') + '\n')
  console.log(`\nwrote ${WORK}/issue447-${MODEL_ID}.run.log`)
  process.exit(0)
}
