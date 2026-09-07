import { spawn, spawnSync } from 'node:child_process'
const B = String.fromCharCode(92)
const bin = ['H:', 'runtime', 'llama.cpp', 'win', 'llama-server.exe'].join(B)
const model = ['H:', 'models', 'chat', 'qwen3.5-9b-ud-q4kxl.gguf'].join(B)
const t0 = Date.now()
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's'

const probe = (label) => {
  const s = Date.now()
  const r = spawnSync(bin, ['--list-devices'], { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const devices = (r.stdout || '').split('\n').filter((l) => /Vulkan\d/.test(l)).map((l) => l.trim())
  console.log(`[${stamp()}] probe ${label}: ${Date.now() - s} ms, status=${r.status}, err=${r.error?.code ?? null}, devices=${devices.length}`)
}

probe('idle-before')

const server = spawn(bin, ['-m', model, '--host', '127.0.0.1', '--port', '18999', '-c', '8192', '--jinja'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let ready = false
server.stderr.on('data', (c) => {
  const s = String(c)
  if (/server is listening|HTTP server listening|starting the main loop/i.test(s) && !ready) {
    ready = true
    console.log(`[${stamp()}] server ready`)
  }
})
server.on('exit', (code, sig) => console.log(`[${stamp()}] server exit code=${code} sig=${sig}`))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(300)
probe('t+0.3s (load starting)')
probe('next (still loading?)')
probe('next')
probe('next')
await sleep(20000)
probe(`t+~20s (ready=${ready})`)
server.kill('SIGKILL')
await sleep(1500)
probe('after kill')
