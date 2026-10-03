// Probe a RUNNING packaged HilbertRaum over the Chrome DevTools Protocol (#560, #562).
//
// Not part of the build or the test suite: a manual verification tool for a packaged build on any
// platform, used by scripts/verify-mac-build.sh and runnable by hand on Windows and Linux. The app
// must already be running with `--remote-debugging-port=<port>` and `HILBERTRAUM_DRIVE_ROOT=<root>`
// pointing at a SCRATCH drive root (never a real one — the probe creates an encrypted workspace).
//
//   node scripts/lib/packaged-app-probe.mjs --port 9333 --drive-root /tmp/hr-probe/root [options]
//     --renderer-dir <apps/desktop/out/renderer>   checks the KaTeX stylesheet + fonts (needs the
//                                                  build's asset names)
//     --clipboard-read "<command>"                 reads the OS clipboard back after a Copy through
//                                                  the bridge (pbpaste / xclip -o -selection clipboard /
//                                                  powershell -NoProfile -Command Get-Clipboard)
//     --mic                                        calls getUserMedia (a real OS prompt may appear:
//                                                  allow it; 90 s)
//     --scan <pdf> --scan-words "A,B"              also OCRs a real scan (e.g. a black-and-white
//                                                  CCITT office scan) and expects those words
//     --export-pdf <path>                          exports an evidence pack as PDF: a save dialog
//                                                  opens, save it EXACTLY as <path> (5 min); needs
//                                                  the sqlite3 CLI to insert one answer
//
// OCR runs when <drive-root>/ocr holds deu/eng.traineddata.gz BEFORE the app started: a JPEG "scan"
// drawn on a canvas in the app's own page must be read back (and --scan, when given). Each check
// prints PASS / FAIL / SKIP; the exit code is the number of FAILs. Node >= 22.12 (global fetch +
// WebSocket); the fixture PDFs come from apps/desktop/tests/helpers/fixtures.ts via a child
// `node --experimental-strip-types`.
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const port = Number(opt('--port') ?? 9333)
const driveRoot = opt('--drive-root')
if (!driveRoot) {
  console.error('usage: packaged-app-probe.mjs --port <n> --drive-root <scratch root> [options]')
  process.exit(2)
}
const rendererDir = opt('--renderer-dir')
const clipboardRead = opt('--clipboard-read')
const exportPdf = opt('--export-pdf')
const wantMic = args.includes('--mic')
const userScan = opt('--scan')
const userScanWords = (opt('--scan-words') ?? '').split(',').map((w) => w.trim().toUpperCase()).filter(Boolean)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok === null) console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`)
  else {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  }
}

// Fixtures: a text PDF from the repo's own test helpers (the scan is drawn in the app, below).
const files = join(resolve(driveRoot), '..', 'probe-files')
mkdirSync(files, { recursive: true })
execFileSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--no-warnings',
    '--input-type=module',
    '-e',
    `const f = await import(${JSON.stringify(pathToFileURL(join(REPO, 'apps/desktop/tests/helpers/fixtures.ts')).href)});
     const { writeFileSync } = await import('node:fs');
     writeFileSync(${JSON.stringify(join(files, 'probe.pdf'))}, f.makePdf('HilbertRaum packaged probe Kontoauszug 4711'));`
  ],
  { stdio: 'inherit' }
)
const secret = join(files, 'secret.txt')
const planted = join(files, 'planted-page.js')
writeFileSync(secret, 'SECRET-PROBE')
writeFileSync(planted, 'self.__plantedProbe = 1')
const fileUrl = (p) => pathToFileURL(p).href

/** A one-page PDF whose only content is a JPEG image: a true scan, no text layer. */
function makeImagePdf(jpeg, w, h) {
  const parts = []
  const offsets = []
  let len = 0
  const push = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')
    parts.push(buf)
    len += buf.length
  }
  const obj = (n, body) => {
    offsets[n] = len
    push(`${n} 0 obj\n`)
    for (const b of [].concat(body)) push(b)
    push('\nendobj\n')
  }
  push('%PDF-1.4\n')
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)
  obj(4, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream'])
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  const xref = len
  push(`xref\n0 6\n0000000000 65535 f \n`)
  for (let i = 1; i <= 5; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(parts)
}

// ---- CDP ------------------------------------------------------------------------------------
let target
for (let i = 0; i < 120 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
      (t) => t.type === 'page' && t.url.includes('index.html')
    )
  } catch {}
  if (!target) await sleep(1000)
}
if (!target) {
  console.log(`FAIL  no app page on DevTools port ${port}`)
  process.exit(1)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, no) => ((ws.onopen = ok), (ws.onerror = no)))
let id = 1
const pending = new Map()
const errors = []
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text)
}
const send = (method, params = {}) =>
  new Promise((ok) => {
    const mid = id++
    pending.set(mid, ok)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
const evaluate = async (expr) => {
  const res = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.result?.exceptionDetails) {
    throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text)
  }
  return res.result?.result?.value
}
await send('Runtime.enable')
for (let i = 0; i < 60; i++) {
  if (await evaluate('return typeof window.api === "object"').catch(() => false)) break
  await sleep(500)
}

// ---- the scheme and its refusals (#560) ------------------------------------------------------
const where = await evaluate('return { origin: location.origin, secure: isSecureContext, ua: navigator.userAgent }')
check('the main window loads from hilbertraum://app (a secure context)', where.origin === 'hilbertraum://app' && where.secure, JSON.stringify(where).slice(0, 200))
const status = await evaluate('return window.api.getAppStatus()')
const PW = 'packaged-probe-pw!'
const created = await evaluate(`return window.api.createWorkspace(${JSON.stringify(PW)}, 'encrypted')`)
check(
  'packaged build (encryption required): an encrypted workspace is created',
  created?.ok !== false && created?.state?.mode === 'encrypted' && created?.state?.encryptionRequired === true,
  `v${status?.appVersion} ${JSON.stringify(created?.state ?? created).slice(0, 140)}`
)
await evaluate("return window.api.updateSettings({ uiLanguage: 'en' })")
const reads = await evaluate(`const r = {}
  for (const u of ${JSON.stringify([fileUrl(secret), process.platform === 'win32' ? 'file:///C:/Windows/win.ini' : 'file:///etc/hosts'])}) {
    try { const res = await fetch(u); r['fetch ' + u] = 'read: ' + (await res.text()).trim().slice(0, 20) } catch { r['fetch ' + u] = 'failed' }
    r['xhr ' + u] = await new Promise((ok) => { try { const x = new XMLHttpRequest(); x.open('GET', u); x.onload = () => ok('read: ' + x.responseText.trim().slice(0, 20)); x.onerror = () => ok('failed'); x.send() } catch (e) { ok('threw') } })
  }
  r.script = await new Promise((ok) => { const s = document.createElement('script'); s.src = ${JSON.stringify(fileUrl(planted))}; s.onload = () => ok(self.__plantedProbe ? 'RAN' : 'loaded'); s.onerror = () => ok('refused'); document.head.appendChild(s) })
  return r`)
check('fetch/XHR of local files fail and a planted local script is refused', Object.values(reads).every((v) => v === 'failed' || v === 'refused'), JSON.stringify(reads))
const trav = await evaluate(`const out = {}
  for (const p of ['index.html', '', 'assets/', '%2e%2e/%2e%2e/main/index.mjs', '..%2f..%2fmain%2findex.mjs', '..%5c..%5cmain%5cindex.mjs', '%2fetc%2fpasswd', '/etc/passwd', 'etc/passwd', '%252e%252e/package.json', 'index.html%00.txt', 'ind%65x.html', '../../../../../../etc/passwd']) {
    out[p] = await new Promise((ok) => { const x = new XMLHttpRequest(); x.open('GET', 'hilbertraum://app/' + p); x.onload = () => ok(x.status); x.onerror = () => ok('failed'); x.send() })
  }
  return out`)
check('13 traversal vectors are 404s; only index.html is served', Object.entries(trav).every(([p, s]) => (p === 'index.html' ? s === 200 : s === 404)), JSON.stringify(trav))
if (rendererDir && existsSync(join(rendererDir, 'assets'))) {
  const css = readdirSync(join(rendererDir, 'assets')).find(
    (f) => f.endsWith('.css') && readFileSync(join(rendererDir, 'assets', f), 'utf8').includes('KaTeX_Main')
  )
  const katex = await evaluate(`
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = './assets/${css}'
    await new Promise((ok) => { l.onload = () => ok(); l.onerror = () => ok(); document.head.appendChild(l) })
    await document.fonts.load('16px KaTeX_Main'); await document.fonts.load('16px KaTeX_Math')
    const faces = [...document.fonts].filter((f) => /KaTeX_(Main|Math)/.test(f.family))
    return { css: l.sheet ? 'applied' : 'not applied', loaded: faces.filter((f) => f.status === 'loaded').length }`)
  check('the KaTeX stylesheet and fonts load through the scheme', katex.css === 'applied' && katex.loaded >= 2, JSON.stringify(katex))
} else check('the KaTeX stylesheet and fonts load through the scheme', null, 'pass --renderer-dir <apps/desktop/out/renderer>')

if (wantMic) {
  console.log('      … microphone: allow the system prompt if one appears (90 s)')
  const mic = await evaluate(`try { const s = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }), new Promise((_, no) => setTimeout(() => no(new Error('no answer in 90 s')), 90000))]); const n = s.getAudioTracks().length; s.getTracks().forEach((t) => t.stop()); return 'tracks=' + n } catch (e) { return 'failed: ' + (e.name || '') + ' ' + e.message }`)
  check('getUserMedia (dictation) gets an audio track', mic === 'tracks=1', mic)
} else check('getUserMedia (dictation) gets an audio track', null, 'pass --mic')

if (clipboardRead) {
  const token = `probe-clipboard-${Date.now()}`
  const copied = await evaluate(`return window.api.copyToClipboard(${JSON.stringify(token)})`)
  await sleep(300)
  let clip = ''
  try {
    clip = execSync(clipboardRead, { encoding: 'utf8' }).trim()
  } catch (e) {
    clip = `read failed: ${e.message}`
  }
  check('Copy through the bridge reaches the OS clipboard', copied === true && clip === token, `copied=${copied} clipboard=${JSON.stringify(clip.slice(0, 40))}`)
} else check('Copy through the bridge reaches the OS clipboard', null, 'pass --clipboard-read "<command>"')

// ---- documents, OCR, lock ------------------------------------------------------------------
const jpeg = await evaluate(`
  const c = document.createElement('canvas'); c.width = 1600; c.height = 400
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#000'; g.font = 'bold 72px Arial, Helvetica, sans-serif'
  g.fillText('SCANNED INVOICE 8842', 60, 160); g.fillText('OCR PROBE OCTOBER', 60, 300)
  return c.toDataURL('image/jpeg', 0.95)`)
writeFileSync(join(files, 'scan.pdf'), makeImagePdf(Buffer.from(jpeg.split(',')[1], 'base64'), 1600, 400))
const toImport = [join(files, 'probe.pdf'), join(files, 'scan.pdf'), ...(userScan ? [resolve(userScan)] : [])]
const job = await evaluate(`return window.api.importDocuments(${JSON.stringify(toImport)})`)
for (let i = 0; i < 120; i++) {
  if ((await evaluate(`return window.api.getImportJob(${JSON.stringify(job.jobId)})`))?.done) break
  await sleep(500)
}
const docs = await evaluate('return window.api.listDocuments()')
const textOf = async (doc) =>
  doc
    ? ((await evaluate(`return window.api.previewDocument(${JSON.stringify(doc.id)})`).catch(() => null))?.segments ?? []).map((s) => s.text).join(' ')
    : ''
const pdfText = await textOf(docs.find((d) => d.title === 'probe.pdf'))
check('a PDF imports and its text is extracted', pdfText.includes('Kontoauszug 4711'), JSON.stringify(pdfText.slice(0, 60)))
const ocrReady = ['deu', 'eng'].every((l) => existsSync(join(driveRoot, 'ocr', `${l}.traineddata.gz`)))
const runOcr = async (title, words, label) => {
  const doc = docs.find((d) => d.title === title)
  const task = await evaluate(`return window.api.startDocTask({ kind: 'ocr', documentIds: [${JSON.stringify(doc?.id)}] })`)
  let st
  for (let i = 0; i < 900; i++) {
    st = await evaluate(`return window.api.getDocTask(${JSON.stringify(task.jobId)})`)
    if (['done', 'failed', 'cancelled'].includes(st?.state)) break
    await sleep(200)
  }
  await sleep(1000)
  const text = (await textOf(doc)).toUpperCase()
  check(label, st?.state === 'done' && words.every((w) => text.includes(w)), `state=${st?.state} error=${st?.error ?? ''} text=${JSON.stringify(text.slice(0, 60))}`)
}
if (ocrReady) {
  await runOcr('scan.pdf', ['SCANNED', '8842'], 'OCR reads a scanned page (the OCR page on the scheme; the worker from app.asar.unpacked)')
  if (userScan) await runOcr(basename(userScan), userScanWords, `OCR reads the supplied scan (${basename(userScan)})`)
  else check('OCR reads a supplied scan', null, 'pass --scan <pdf> --scan-words "A,B" (e.g. a CCITT office scan)')
} else check('OCR', null, `put deu/eng.traineddata.gz into ${join(driveRoot, 'ocr')} before starting the app`)

if (exportPdf) {
  const conv = await evaluate("return window.api.createConversation({ title: 'Packaged probe review' })")
  const answer = 'PROBE sentinel answer: the notice period is thirty days.'
  const ws_ = join(driveRoot, 'workspace')
  const dbFile = readdirSync(ws_).find((f) => f.endsWith('.sqlite'))
  const now = new Date().toISOString()
  // No model on a scratch drive: one answer goes straight into the unlocked working DB.
  execFileSync('sqlite3', [
    '-cmd',
    '.timeout 5000',
    join(ws_, dbFile),
    `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('probe-q', '${conv.id}', 'user', 'Notice period?', '${now}'); INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('probe-a', '${conv.id}', 'assistant', '${answer}', '${now}');`
  ])
  const review = await evaluate("return window.api.createEvidenceReview('probe-a')")
  console.log(`      … a save dialog opens: save the pack EXACTLY as ${exportPdf} (5 min)`)
  const res = await evaluate(
    `return Promise.race([window.api.exportEvidencePack(${JSON.stringify(review.id)}, { format: 'pdf', language: 'en' }).then((r) => ({ ok: true, format: r && r.format }), (e) => ({ ok: false, e: e.message })), new Promise((ok) => setTimeout(() => ok({ ok: false, e: 'no save in 5 min' }), 300000))])`
  )
  const magic = existsSync(exportPdf) ? readFileSync(exportPdf).subarray(0, 5).toString('latin1') : '(no file)'
  const siblings = existsSync(dirname(exportPdf)) ? readdirSync(dirname(exportPdf)).filter((f) => f.includes('.print.tmp')) : []
  check('an evidence pack exports as PDF', res.ok && res.format === 'pdf' && magic === '%PDF-', `${JSON.stringify(res)} magic=${magic} print-source residue=${JSON.stringify(siblings)}`)
} else check('an evidence pack exports as PDF', null, 'pass --export-pdf <path>')

const before = (await evaluate('return window.api.listDocuments()')).length
await evaluate('return window.api.lockWorkspace()')
const locked = (await evaluate('return window.api.getWorkspaceState()'))?.state
await evaluate(`return window.api.unlockWorkspace(${JSON.stringify(PW)})`)
const after = (await evaluate('return window.api.listDocuments()')).length
check('lock + unlock keeps every document', locked === 'locked' && before === after && after >= 2, `locked=${locked} before=${before} after=${after}`)
const tail = (await evaluate('return window.api.getLogTail()')) ?? []
check('no ERROR lines in the log tail', !tail.some((l) => /\[ERROR\]/.test(l)), tail.filter((l) => /\[ERROR\]/.test(l)).slice(0, 2).join(' | '))
check('no renderer exceptions', errors.length === 0, errors.slice(0, 3).join(' | '))
ws.close()
console.log(`\n${failed} check(s) failed`)
process.exit(failed)
