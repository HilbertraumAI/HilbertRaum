#!/usr/bin/env node
// Issue #399 leg A - architecture sweep driver.
//
// Starts the pinned llama-server build with the app's argv shape (held identical across
// models), sends three chat completions in sequence, and captures the whole stderr so the
// prompt-cache lines can be read back:
//
//   R1  conversation A: the shared system message + a long deterministic user message
//   R2  conversation B: the SAME system message + a short unrelated user message
//   R3  back to A:      R1's messages + R1's assistant reply + one new short user turn
//
// Verdict comes from R3's `prompt eval time = ... / N tokens`: only the delta (tens of
// tokens) means the host prompt cache restored A's prefix; hundreds of tokens means the
// prefix was re-prefilled down to the system prompt that never left the slot.
//
// Usage:
//   node issue399-arch-sweep.mjs --bin <llama-server> --model <file.gguf> --stem <out/prefix>
//                                [--port 8399] [--ctx 8192] [--np 1] [--extra "-a -b"]
//                                [--ready-timeout 900]
//
// Everything it writes: <stem>.stderr.log, <stem>.cache-lines.txt, <stem>.json, <stem>.run.log

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { writeFileSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const BIN = arg('bin')
const MODEL = arg('model')
const STEM = arg('stem')
const PORT = Number(arg('port', '8399'))
const CTX = arg('ctx', '8192')
const NP = arg('np', '1')
const THREADS = arg('threads', '10')
const EXTRA = arg('extra', '').split(' ').filter(Boolean)
const READY_TIMEOUT_S = Number(arg('ready-timeout', '900'))

// ------------------------------------------------------- the fixed prompts
// Synthetic, deterministic, byte-stable across models (this repo is public: no real user
// text, no document content). The long message is built from a fixed sentence table so the
// same bytes go to every model.
const SYSTEM = [
  'You are a careful assistant inside an offline workspace.',
  'Answer briefly and factually. Do not invent sources.',
  'If a question cannot be answered from the given text, say so plainly.',
].join(' ')

const SENTENCES = [
  'The maintenance crew records every valve reading in the shift ledger before the handover.',
  'Pump seven runs at a steady pressure of four bar and is inspected on the first Monday of each month.',
  'The east corridor lamps are replaced in pairs so that the illumination stays even along the walkway.',
  'A spare gasket set is kept in the grey cabinet beside the workshop door and is counted every quarter.',
  'The calibration weights live in a padded case and must never be handled without cotton gloves.',
  'Storage tank four is drained slowly to avoid a pressure drop in the connected return line.',
  'The night shift logs ambient temperature at midnight, at three, and again at six in the morning.',
  'Filter cartridges are rinsed in clean water, dried on the rack, and only then returned to service.',
  'The intake grille is brushed clear of leaves whenever the differential reading exceeds twelve units.',
  'A second operator confirms every manual override and signs the corresponding line in the ledger.',
  'The compressor room door stays closed while the machine is running to keep the noise contained.',
  'Belt tension is checked with the small gauge that hangs on the hook above the tool bench.',
  'Any reading outside the printed range is repeated once before it is written into the record.',
  'The spill kit is stored at the corridor junction and its seal is inspected during every walkaround.',
  'Cooling water is sampled weekly and the sample bottles are labelled with the date and the point of draw.',
  'The backup generator is exercised for twenty minutes on the last working day of the month.',
]

const longUserMessage = () => {
  const lines = []
  lines.push('Here is an excerpt from a plant handbook. Read it and keep it in mind.')
  lines.push('')
  // 4 passes over 16 sentences = 64 numbered lines; comfortably above 600 tokens on every
  // tokenizer in the sweep, and identical bytes for every model.
  let n = 1
  for (let pass = 0; pass < 4; pass += 1) {
    for (const s of SENTENCES) {
      lines.push(`${String(n).padStart(2, '0')}. ${s}`)
      n += 1
    }
  }
  lines.push('')
  lines.push('Name the item that is counted every quarter. Answer in one short sentence.')
  return lines.join('\n')
}

const R1_USER = longUserMessage()
const R2_USER = 'In one short sentence: what is a barometer used for?'
const R3_USER = 'And which room door stays closed while the machine runs?'

// `--print-prompts <dir>` writes the three prompts to disk without starting a server, so the
// exact bytes can be tokenised or diffed later.
const printTo = arg('print-prompts')
if (printTo) {
  writeFileSync(`${printTo}/r1.system.txt`, SYSTEM)
  writeFileSync(`${printTo}/r1.user.txt`, R1_USER)
  writeFileSync(`${printTo}/r2.user.txt`, R2_USER)
  writeFileSync(`${printTo}/r3.user.txt`, R3_USER)
  console.log(`wrote prompts to ${printTo}`)
  process.exit(0)
}

if (!BIN || !MODEL || !STEM) {
  console.error('usage: --bin <llama-server> --model <file.gguf> --stem <out/prefix>')
  process.exit(2)
}

// ------------------------------------------------------------------ runner
const runLog = []
const trace = (line) => {
  const stamped = `${new Date().toISOString()} ${line}`
  runLog.push(stamped)
  console.log(stamped)
}

const stderrPath = `${STEM}.stderr.log`
const stderrFile = createWriteStream(stderrPath)

trace(`bin      ${BIN}`)
trace(`model    ${MODEL}`)
trace(`ctx      ${CTX}  np ${NP}  threads ${THREADS}  extra [${EXTRA.join(' ')}]`)

const args = [
  '--host', '127.0.0.1',
  '--port', String(PORT),
  '--model', MODEL,
  '--ctx-size', CTX,
  '--threads', THREADS,
  '--batch-size', '2048',
  '--ubatch-size', '2048',
  '--jinja',
  '--reasoning-format', 'deepseek',
  '-lv', '4',
  '-np', NP,
  ...EXTRA,
]
trace(`argv     ${BIN} ${args.join(' ')}`)

const server = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.pipe(stderrFile, { end: false })
server.stderr.pipe(stderrFile, { end: false })
let serverExited = false
server.on('exit', (code, signal) => {
  serverExited = true
  trace(`server exited code=${code} signal=${signal}`)
})

const base = `http://127.0.0.1:${PORT}`

const waitReady = async () => {
  const deadline = Date.now() + READY_TIMEOUT_S * 1000
  while (Date.now() < deadline) {
    if (serverExited) throw new Error('server exited before it became ready')
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(1000)
  }
  throw new Error(`server not ready within ${READY_TIMEOUT_S}s`)
}

const ask = async (label, messages) => {
  const started = Date.now()
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages,
      temperature: 0,
      max_tokens: 16,
      stream: false,
    }),
  })
  const body = await res.json()
  const elapsed = Date.now() - started
  const content = body?.choices?.[0]?.message?.content ?? ''
  const usage = body?.usage ?? {}
  const timings = body?.timings ?? {}
  trace(
    `${label}  http=${res.status}  ${elapsed} ms  prompt_tokens=${usage.prompt_tokens}  ` +
      `completion_tokens=${usage.completion_tokens}  ` +
      `prompt_ms=${timings.prompt_ms}  prompt_n=${timings.prompt_n}  cache_n=${timings.cache_n}`,
  )
  return { label, http: res.status, elapsedMs: elapsed, usage, timings, content }
}

const results = { model: MODEL, bin: BIN, argv: [BIN, ...args], requests: [] }

try {
  trace('waiting for /health ...')
  await waitReady()
  trace('server ready')
  // Let the load log settle in the capture before the first request.
  await sleep(1000)

  const convA = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: R1_USER },
  ]
  const r1 = await ask('R1 (conversation A, long)', convA)
  results.requests.push(r1)
  await sleep(2000)

  const convB = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: R2_USER },
  ]
  const r2 = await ask('R2 (conversation B, short)', convB)
  results.requests.push(r2)
  await sleep(2000)

  const convA2 = [
    ...convA,
    { role: 'assistant', content: r1.content },
    { role: 'user', content: R3_USER },
  ]
  const r3 = await ask('R3 (back to conversation A)', convA2)
  results.requests.push(r3)

  // The prompt-cache bookkeeping for the last task is written when the next task starts or
  // the slot goes idle; give the server a moment so the capture holds it.
  await sleep(4000)
} catch (err) {
  trace(`ERROR ${err?.stack ?? err}`)
  results.error = String(err?.message ?? err)
} finally {
  trace('stopping server')
  server.kill('SIGINT')
  const deadline = Date.now() + 30_000
  while (!serverExited && Date.now() < deadline) await sleep(200)
  if (!serverExited) server.kill('SIGKILL')
  await sleep(500)
  stderrFile.end()
  await sleep(300)

  // Filtered log, same shape as the leg-7 captures.
  const log = readFileSync(stderrPath, 'utf8').split('\n')
  const keep = /prompt cache|prompt_save|load:|cache state|forcing full|cached n_tokens|print_timing|llama_memory|swa|n_ctx_slot|kv_unified|n_seq_max|n_parallel/i
  writeFileSync(`${STEM}.cache-lines.txt`, log.filter((l) => keep.test(l)).join('\n') + '\n')

  // Prefilled token counts per task, straight out of the capture.
  const evals = []
  for (const line of log) {
    const m = line.match(/task\s+(\d+)\s*\|\s*prompt eval time\s*=\s*([\d.]+) ms \/\s*(\d+) tokens/)
    if (m) evals.push({ task: Number(m[1]), ms: Number(m[2]), tokens: Number(m[3]) })
  }
  results.promptEvals = evals
  results.stderrLines = log.length
  writeFileSync(`${STEM}.json`, JSON.stringify(results, null, 2) + '\n')
  writeFileSync(`${STEM}.run.log`, runLog.join('\n') + '\n')
  trace(`wrote ${STEM}.{stderr.log,cache-lines.txt,json,run.log}`)
  process.exit(results.error ? 1 : 0)
}
