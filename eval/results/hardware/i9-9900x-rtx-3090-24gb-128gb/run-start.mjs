// Hardware-session runner for issue #318 (Linux port of the 1070 Ti session's run-start.mjs):
// one llama-server start, measured and logged.
// Usage: node run-start.mjs --leg 7 --variant baseline-q4km --model <gguf> --id <manifest id>
//        --ctx 8192 --out <dir> --slug <hw slug> --bin <llama-server> --desktop "<note>"
//        [--mtp on|off] [--ubatch 512] [--extra "--fit-target 512"] [--rung "<label>"]
// Paths come from flags / env only — nothing developer-specific is hardcoded (CLAUDE.md).
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus, hostname, userInfo, homedir } from 'node:os'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && (a === '--extra' || !arr[i + 1].startsWith('--')) ? arr[i + 1] : 'true'])
    return acc
  }, [])
)
const EXE = String(args.bin ?? process.env.HILBERTRAUM_LLAMA_BIN ?? '')
if (!EXE || !existsSync(EXE)) throw new Error('pass --bin <llama-server> or set HILBERTRAUM_LLAMA_BIN')
const VULKANINFO = args.vulkaninfo ?? process.env.VULKANINFO ?? 'vulkaninfo'
const leg = args.leg, variant = args.variant, modelPath = path.resolve(args.model), modelId = args.id
const ctx = Number(args.ctx ?? 8192)
const outDir = args.out
const extra = args.extra ? args.extra.split(' ').filter(Boolean) : []
const mtp = (args.mtp ?? 'on') === 'on'
const ubatch = Number(args.ubatch ?? 0) || null
const desktopNote = args.desktop ?? 'unspecified'
const rungLabel = args.rung ?? (mtp ? 'rung 1a (GPU auto-offload + MTP speculative decoding)' : 'rung 1 (default args, GPU auto-offload)')
const stem = `leg${leg}-${variant}`
const logPath = path.join(outDir, `${stem}.stderr.log`)
const jsonPath = path.join(outDir, `${stem}.json`)
const heapsPath = path.join(outDir, `${stem}.heaps.csv`)

// --- app argv reconstruction (sidecar.ts buildArgs + llama.ts LlamaRuntime ctor + factory.ts rung 1/1a)
const threads = Math.max(1, Math.floor(cpus().length / 2) || 1) // sidecar.ts:90-98 defaultThreadCount
const physicalBatch = Math.min(ctx, 2048) // llama.ts:460 min(contextTokens, CHAT_MAX_PHYSICAL_BATCH=2048)
const MTP_SERVER_ARGS = ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2'] // factory.ts:95

const sh = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8' })
const smi = () => {
  const r = sh('nvidia-smi', ['--query-gpu=memory.used,memory.total,memory.free', '--format=csv,noheader,nounits'])
  const [used, total, free] = (r.stdout || '').trim().split(',').map((s) => Number(s.trim()))
  return { used, total, free }
}
const listDevices = () => ((sh(EXE, ['--list-devices']).stdout || '') + '').trim()
// vulkaninfo heaps of physical device 0 (VK_EXT_memory_budget): size/budget/usage per heap, MiB.
const heaps = () => {
  const out = sh(VULKANINFO, []).stdout || ''
  const dev0 = out.split(/\nGPU1:|\nGPU1 /)[0]
  const res = []
  const re = /memoryHeaps\[(\d+)\]:\s*\n\s*size\s*=\s*(\d+)[^\n]*\n\s*budget\s*=\s*(\d+)[^\n]*\n\s*usage\s*=\s*(\d+)[^\n]*\n(?:[^\n]*flags[^\n]*\n)?(\s*MEMORY_HEAP_DEVICE_LOCAL_BIT)?/g
  let m
  while ((m = re.exec(dev0))) res.push({ heap: Number(m[1]), size_mib: +(m[2] / 2 ** 20).toFixed(1), budget_mib: +(m[3] / 2 ** 20).toFixed(1), usage_mib: +(m[4] / 2 ** 20).toFixed(1), device_local: !!m[5] })
  return res
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
    '--ubatch-size', String(ubatch ?? physicalBatch), // variant: ubatch 2048 -> 512
    '--jinja', '--reasoning-format', 'deepseek', '-lv', '4', // llama.ts:39 CHAT_SERVER_ARGS (llama.ts:461 puts them before the rung's extraArgs)
    ...(mtp ? MTP_SERVER_ARGS : []), // factory.ts:754-760 rung 1a extraArgs; rung 1 (factory.ts:764) adds nothing
    ...extra // protocol variants only (-np 1, --fit-target 512); never -ngl / --device
  ]
  const heapSamples = []
  const sampleHeaps = (phase) => { const h = heaps(); heapSamples.push({ t: Date.now(), phase, heaps: h }); return h }
  const before = { list_devices: listDevices(), nvidia_smi: smi(), heaps: sampleHeaps('before'), desktop: desktopNote, at: new Date().toISOString() }
  console.log('[pre] nvidia-smi', JSON.stringify(before.nvidia_smi))
  console.log('[pre] heaps', JSON.stringify(before.heaps))
  console.log('[pre] list-devices\n' + before.list_devices)
  console.log('[argv] ' + argv.join(' '))

  const log = createWriteStream(logPath)
  log.write(`# ${stem} : argv: llama-server ${argv.join(' ')}\n`)
  const t0 = Date.now()
  child = spawn(EXE, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => log.write(d))
  child.stderr.on('data', (d) => log.write(d))
  let exited = null
  child.on('exit', (code, sig) => { exited = { code, sig } })

  // wait for /health, polling nvidia-smi during the load too
  const base = `http://127.0.0.1:${port}`
  let healthy = false
  const loadSamples = []
  for (let i = 0; i < 1200 && !exited; i++) {
    try {
      const r = await fetch(base + '/health')
      if (r.status === 200) { healthy = true; break }
    } catch {}
    if (i % 2 === 0) loadSamples.push({ t: Date.now(), ...smi() })
    await sleep(500)
  }
  const loadMs = Date.now() - t0
  if (!healthy) {
    log.end()
    throw new Error(`server never became healthy (exit=${JSON.stringify(exited)}) — see ${logPath}`)
  }
  await sleep(1500)
  const afterLoad = { nvidia_smi: smi(), list_devices: listDevices(), heaps: sampleHeaps('after_load'), at: new Date().toISOString() }
  console.log('[loaded] ' + loadMs + ' ms; nvidia-smi', JSON.stringify(afterLoad.nvidia_smi))
  console.log('[loaded] heaps', JSON.stringify(afterLoad.heaps))
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

  // poll GPU memory every 1 s during the request (+ vulkaninfo heaps every ~3 s)
  const samples = []
  const poll = setInterval(() => samples.push({ t: Date.now(), ...smi() }), 1000)
  let heapTick = 0
  const heapPoll = setInterval(() => { heapTick++; sampleHeaps('request') }, 3000)
  samples.push({ t: Date.now(), ...smi() })
  const t1 = Date.now()
  const resp = await fetchClose(base + '/completion', {
    method: 'POST',
    body: JSON.stringify({ prompt, n_predict: 512, ignore_eos: true, temperature: 0, cache_prompt: false, stream: false })
  })
  const body = await resp.json()
  clearInterval(poll); clearInterval(heapPoll)
  samples.push({ t: Date.now(), ...smi() })
  sampleHeaps('after_request')
  const reqMs = Date.now() - t1
  const peak = samples.reduce((m, s) => (s.used > m.used ? s : m), samples[0])
  const loadPeak = loadSamples.reduce((m, s) => (s.used > m.used ? s : m), loadSamples[0] ?? peak)
  const timings = body.timings ?? null
  console.log('[timings]', JSON.stringify(timings))
  console.log('[peak] used ' + peak.used + ' MiB; tokens_predicted=' + body.tokens_predicted + ' prompt_n=' + timings?.prompt_n)

  // stop the server (SIGTERM, as the sidecar does); wait for memory to return
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
  const afterHeaps = sampleHeaps('after_stop')
  console.log('[after] nvidia-smi', JSON.stringify(after), 'exit', JSON.stringify(exited))

  // redact the log + parse the fit outcome
  let raw = readFileSync(logPath, 'utf8')
  const host = hostname(), user = userInfo().username, home = homedir(), modelsDir = path.dirname(modelPath)
  const redact = (s) =>
    s.split(modelsDir).join('<drive>/models/chat').split(home).join('/home/<user>').split(host).join('<host>').split(user).join('<user>')
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
    device: pick(/^ggml_vulkan|device|Vulkan\d/i).slice(0, 40),
    spec: pick(/spec|draft|mtp/i).slice(0, 40)
  }
  const excerpt = lines.filter((l) => /load_tensors|buffer|_Host|offload|device|SWA|recurrent|fit|ctx|slots|kv_unified|n_parallel|draft|spec/i.test(l)).slice(0, 300)
  writeFileSync(heapsPath, 'phase,t,heap,size_mib,budget_mib,usage_mib,device_local\n' + heapSamples.flatMap((s) => s.heaps.map((h) => `${s.phase},${s.t},${h.heap},${h.size_mib},${h.budget_mib},${h.usage_mib},${h.device_local}`)).join('\n') + '\n')
  const result = {
    hw_slug: args.slug, leg, variant, rung: rungLabel, model_id: modelId, model_file: path.basename(modelPath),
    model_bytes: statSync(modelPath).size,
    runtime: '9849 (799fcc04a)', argv: redact(argv.join(' ')), mtp, extra_args: extra, ctx, threads, physical_batch: physicalBatch, ubatch: ubatch ?? physicalBatch,
    before, load_ms: loadMs, load_peak_nvidia_smi: loadPeak, after_load: afterLoad, prompt_tokens: n, request_ms: reqMs,
    tokens_predicted: body.tokens_predicted, timings, peak_nvidia_smi: peak, samples,
    after_stop: { nvidia_smi: after, list_devices: afterDevices, heaps: afterHeaps, exit: exited },
    heap_samples: heapSamples,
    prompt_text_in_log: promptLeak, request_errors: requestErrors, fit, excerpt, app_report: null
  }
  writeFileSync(jsonPath, JSON.stringify(result, null, 2))
  console.log('[done] ' + jsonPath)
}
main().catch((e) => { console.error(e); killChild(); setTimeout(() => process.exit(1), 1500) })
