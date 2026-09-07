// Hardware-session runner for issue #318: one llama-server start, measured and logged.
// Usage: node run-start.mjs --leg 3 --variant baseline --model <gguf> --id <manifest id>
//        --ctx 8192 --out <dir> --slug <hw slug> --drive <drive root> --desktop "<note>" [--extra "--fit-target 512"]
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus, hostname, userInfo } from 'node:os'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && (a === '--extra' || !arr[i + 1].startsWith('--')) ? arr[i + 1] : 'true'])
    return acc
  }, [])
)
// Drive root from --drive <root> or HILBERTRAUM_DRIVE_ROOT — never hardcoded (CLAUDE.md).
const DRIVE_ROOT = String(args.drive ?? process.env.HILBERTRAUM_DRIVE_ROOT ?? '').replace(/[\\/]*$/, '') + '\\'
if (DRIVE_ROOT.length < 3) throw new Error('pass --drive <root> or set HILBERTRAUM_DRIVE_ROOT')
const EXE = path.join(DRIVE_ROOT, 'runtime', 'llama.cpp', 'win', 'llama-server.exe')
const leg = args.leg, variant = args.variant, modelPath = args.model, modelId = args.id
const ctx = Number(args.ctx ?? 8192)
const outDir = args.out
const extra = args.extra ? args.extra.split(' ').filter(Boolean) : []
const desktopNote = args.desktop ?? 'unspecified'
const ignoreEos = args['ignore-eos'] === 'true'
const stem = `leg${leg}-${variant}`
const logPath = path.join(outDir, `${stem}.stderr.log`)
const jsonPath = path.join(outDir, `${stem}.json`)

// --- app argv reconstruction (sidecar.ts buildArgs + llama.ts LlamaRuntime ctor + factory.ts rung 1)
const threads = Math.max(1, Math.floor(cpus().length / 2) || 1) // sidecar.ts:90-98 defaultThreadCount
const physicalBatch = Math.min(ctx, 2048) // llama.ts:460 min(contextTokens, CHAT_MAX_PHYSICAL_BATCH=2048)

const sh = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', windowsHide: true })
const smi = () => {
  const r = sh('nvidia-smi', ['--query-gpu=memory.used,memory.total,memory.free', '--format=csv,noheader,nounits'])
  const [used, total, free] = (r.stdout || '').trim().split(',').map((s) => Number(s.trim()))
  return { used, total, free }
}
const listDevices = () => (sh(EXE, ['--list-devices']).stdout || '').trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Every request on its own connection (no keep-alive reuse) and up to 3 tries on a reset: the first
// attempt on the GTX 1070 Ti machine got ECONNRESET on the first POST after a 200 /health.
const requestErrors = []
const fetchClose = async (url, init = {}, tries = 3) => {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, { ...init, headers: { ...(init.headers ?? {}), connection: 'close' } })
    } catch (e) {
      const code = e?.cause?.code ?? e?.code ?? String(e)
      requestErrors.push({ at: new Date().toISOString(), url: '/' + url.split('/').slice(3).join('/'), try: i, code })
      console.log('[request-error] ' + url + ' try ' + i + ': ' + code)
      if (i >= tries) throw e
      await sleep(1500)
    }
  }
}
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
    s.on('error', rej)
  })

// --- synthetic prompt: neutral repeated English paragraph, sized via /tokenize to ~2048 tokens
const PARAGRAPH =
  'The river runs past the old mill and under the stone bridge before it widens into the lake. ' +
  'Every spring the water rises with the snowmelt from the hills, and every autumn it settles back into its quiet channel. ' +
  'The town keeps a small museum near the bridge with maps of the valley, a model of the mill wheel, and a shelf of ' +
  'weather records that go back more than a century. Visitors usually walk the footpath along the bank, stop at the ' +
  'bench by the willow, and return the same way. '

let child = null
const killChild = () => { try { if (child && child.exitCode === null) child.kill() } catch {} }
process.on('exit', killChild)
async function main() {
  if (!existsSync(outDir)) throw new Error('out dir missing: ' + outDir)
  const port = await freePort()
  const argv = [
    '--host', '127.0.0.1', // sidecar.ts:526-527
    '--port', String(port), // sidecar.ts:528-529
    '--model', modelPath, // sidecar.ts:530-531
    '--ctx-size', String(ctx), // sidecar.ts:532-533 (launchContextTokens, models.ts:176-181)
    '--threads', String(threads), // sidecar.ts:534-535 (defaultThreadCount, sidecar.ts:90-98)
    '--batch-size', String(physicalBatch), // sidecar.ts:516-524 (llama.ts:460)
    '--ubatch-size', String(physicalBatch),
    '--jinja', '--reasoning-format', 'deepseek', '-lv', '4', // llama.ts:39 CHAT_SERVER_ARGS
    ...extra // factory.ts:763 rung 1 extraArgs = [] (no -ngl, no --device); variants add here
  ]
  const before = { list_devices: listDevices(), nvidia_smi: smi(), desktop: desktopNote, at: new Date().toISOString() }
  console.log('[pre] nvidia-smi', JSON.stringify(before.nvidia_smi))
  console.log('[pre] list-devices\n' + before.list_devices)
  console.log('[argv] ' + argv.join(' '))

  const log = createWriteStream(logPath)
  log.write(`# ${stem} — argv: ${EXE} ${argv.join(' ')}\n`)
  const t0 = Date.now()
  child = spawn(EXE, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => log.write(d))
  child.stderr.on('data', (d) => log.write(d))
  let exited = null
  child.on('exit', (code, sig) => { exited = { code, sig } })

  // wait for /health
  const base = `http://127.0.0.1:${port}`
  let healthy = false
  for (let i = 0; i < 1200 && !exited; i++) {
    try {
      const r = await fetch(base + '/health')
      if (r.status === 200) { healthy = true; break }
    } catch {}
    await sleep(500)
  }
  const loadMs = Date.now() - t0
  if (!healthy) {
    log.end()
    throw new Error(`server never became healthy (exit=${JSON.stringify(exited)}) — see ${logPath}`)
  }
  await sleep(1500)
  const afterLoad = { nvidia_smi: smi(), list_devices: listDevices(), at: new Date().toISOString() }
  console.log('[loaded] ' + loadMs + ' ms; nvidia-smi', JSON.stringify(afterLoad.nvidia_smi))
  console.log('[loaded] list-devices while loaded\n' + afterLoad.list_devices)

  // size the prompt to ~2048 tokens
  const tok = async (text) => {
    const r = await fetchClose(base + '/tokenize', { method: 'POST', body: JSON.stringify({ content: text }) })
    return (await r.json()).tokens.length
  }
  const perPara = await tok(PARAGRAPH)
  let reps = Math.floor(2048 / perPara)
  let prompt = PARAGRAPH.repeat(reps)
  let n = await tok(prompt)
  while (n < 2000) { prompt += PARAGRAPH.slice(0, 200); n = await tok(prompt) }
  console.log(`[prompt] ${perPara} tok/paragraph × ${reps} → ${n} tokens`)

  // poll GPU memory every 1 s during the request
  const samples = []
  const poll = setInterval(() => samples.push({ t: Date.now(), ...smi() }), 1000)
  samples.push({ t: Date.now(), ...smi() })
  const t1 = Date.now()
  const resp = await fetchClose(base + '/completion', {
    method: 'POST',
    // `--ignore-eos` (added on this machine): Gemma 4 E2B ends its turn after ONE token on this
    // neutral continuation prompt, so the decode leg measured nothing (`predicted_n: 1`,
    // `predicted_per_second: 1000000`). The GTX-1070-Ti session never hit it because the 9B keeps
    // generating. `ignore_eos` forces the full 512 tokens so the decode figure exists and is
    // comparable; it changes nothing about placement or memory. Recorded per start in the JSON.
    body: JSON.stringify({ prompt, n_predict: 512, temperature: 0, cache_prompt: false, stream: false, ignore_eos: ignoreEos })
  })
  const body = await resp.json()
  clearInterval(poll)
  samples.push({ t: Date.now(), ...smi() })
  const reqMs = Date.now() - t1
  const peak = samples.reduce((m, s) => (s.used > m.used ? s : m), samples[0])
  const timings = body.timings ?? null
  console.log('[timings]', JSON.stringify(timings))
  console.log('[peak] used ' + peak.used + ' MiB; tokens_predicted=' + body.tokens_predicted + ' prompt_n=' + timings?.prompt_n)

  // stop the server; wait for memory to return
  child.kill()
  for (let i = 0; i < 60 && !exited; i++) await sleep(250)
  let after = null
  for (let i = 0; i < 30; i++) {
    after = smi()
    if (after.used <= before.nvidia_smi.used + 150) break
    await sleep(1000)
  }
  await sleep(500)
  log.end()
  await sleep(300)
  const afterDevices = listDevices()
  console.log('[after] nvidia-smi', JSON.stringify(after), 'exit', JSON.stringify(exited))

  // redact the log + parse the fit outcome
  let raw = readFileSync(logPath, 'utf8')
  const host = hostname(), user = userInfo().username
  // ORDER MATTERS ON THIS MACHINE (changed from the GTX-1070-Ti copy, which replaced host → user →
  // drive): its drive root was a real volume, so the user replacement could not touch it. Here the
  // drive root lives UNDER the user profile, so replacing the user first rewrites the prefix and the
  // later DRIVE_ROOT split then matches nothing — leaving the absolute path in the artefacts. Drive
  // root first, then host, then user.
  const redact = (s) =>
    s.split(DRIVE_ROOT).join('<drive>\\').split(host).join('<host>').split('C:\\Users\\' + user).join('C:\\Users\\<user>')
  const promptLeak = raw.includes('old mill and under the stone bridge')
  raw = redact(raw)
  if (promptLeak) raw = raw.split(PARAGRAPH.trim()).join('<PROMPT TEXT STRIPPED>')
  writeFileSync(logPath, raw)
  const lines = raw.split(/\r?\n/)
  const pick = (re) => lines.filter((l) => re.test(l))
  const fit = {
    offloaded: pick(/load_tensors: offloaded/),
    buffers: pick(/buffer size|_Host|CPU_Mapped|model buffer/),
    kv: pick(/KV self size|kv_unified|n_parallel|swa|SWA|recurrent|RS|memory_seq|KV size|n_ctx|llama_context:|n_batch|n_ubatch/),
    fit: pick(/fit|ctx-size|slots|n_slots/i).slice(0, 40),
    device: pick(/^ggml_vulkan|device|Vulkan\d/i).slice(0, 40)
  }
  const excerpt = lines.filter((l) => /load_tensors|buffer|_Host|offload|device|SWA|recurrent|fit|ctx|slots|kv_unified|n_parallel/i.test(l)).slice(0, 300)
  const result = {
    hw_slug: args.slug, leg, variant, model_id: modelId, model_file: path.basename(modelPath),
    model_bytes: (await import('node:fs')).statSync(modelPath).size,
    runtime: '9849 (799fcc04a)', argv: redact(argv.join(' ')), extra_args: extra, ctx, threads, physical_batch: physicalBatch,
    before, load_ms: loadMs, after_load: afterLoad, prompt_tokens: n, request_ms: reqMs,
    tokens_predicted: body.tokens_predicted, timings, peak_nvidia_smi: peak, samples, after_stop: { nvidia_smi: after, list_devices: afterDevices, exit: exited },
    ignore_eos: ignoreEos,
    prompt_text_in_log: promptLeak, request_errors: requestErrors, fit, excerpt, app_report: null
  }
  writeFileSync(jsonPath, JSON.stringify(result, null, 2))
  console.log('[done] ' + jsonPath)
}
main().catch((e) => { console.error(e); killChild(); setTimeout(() => process.exit(1), 1500) })
