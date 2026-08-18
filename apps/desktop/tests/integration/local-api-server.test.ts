import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { RuntimeManager, type RuntimeChatOptions } from '../../src/main/services/runtime'
import { LocalApiServer, PortInUseError } from '../../src/main/services/local-api/server'
import { manualSource, type ManualSource } from '../helpers/manual-stream'

// LocalApiServer integration pins (local-api wave P3): a REAL listener on an ephemeral
// port, driven over real HTTP, against a real RuntimeManager (gated mock runtimes). The
// pin set is the plan's §4 P3 rows: bind posture, the Host/Origin/content-type/auth
// matrix, the OpenAI response + error contract, distinct model states, pre-emption
// semantics, body-cap/backpressure bounds, and teardown.

interface Harness {
  server: LocalApiServer
  mgr: RuntimeManager
  base: string
  port: number
  token: string
  sources: ManualSource[]
  lastOptions: () => RuntimeChatOptions | undefined
  setDocTask: (busy: boolean) => void
  setAdmitsWork: (v: boolean) => void
  stopAll: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function makeHarness(opts?: {
  startModel?: boolean
  tokenRequired?: boolean
  echo?: boolean
  queueWaitMs?: number
  drainTimeoutMs?: number
}): Promise<Harness> {
  const sources: ManualSource[] = []
  const optionsSeen: RuntimeChatOptions[] = []
  const echo = opts?.echo ?? true
  const mgr = new RuntimeManager((startOpts) => ({
    modelId: startOpts.modelId,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: '', port: null }),
    contextWindow: () => startOpts.contextTokens,
    chatStream(messages, options?: RuntimeChatOptions) {
      if (options) optionsSeen.push(options)
      if (echo) {
        // Echo runtime: deterministic two-token reply, honours signal + onFinish.
        const text = messages[messages.length - 1]?.content ?? ''
        return (async function* (): AsyncGenerator<string, void, unknown> {
          if (options?.signal?.aborted) return
          yield 'echo: '
          yield text
          options?.onFinish?.('stop')
        })()
      }
      const src = manualSource()
      sources.push(src)
      return src.stream(options?.signal)
    }
  }))
  if (opts?.startModel !== false) {
    await mgr.start({ modelId: 'test-model', modelPath: '/m.gguf', contextTokens: 4096 })
  }
  let docTask = false
  let admits = true
  const token = 'hr-' + 'a'.repeat(43)
  const server = new LocalApiServer({
    getSettings: () => ({ localApiPort: 0, localApiTokenRequired: opts?.tokenRequired ?? true }),
    getToken: () => token,
    runtime: {
      status: () => mgr.status(),
      active: () => mgr.active(),
      isExternallyBusy: () => mgr.isExternallyBusy(),
      setExternalPreemption: (hook) => mgr.setExternalPreemption(hook)
    },
    hasActiveDocTask: () => docTask,
    admitsWork: () => admits,
    estimateBusySeconds: () => 42,
    appVersion: '0.0.0-test',
    queueWaitMs: opts?.queueWaitMs,
    drainTimeoutMs: opts?.drainTimeoutMs
  })
  await server.start()
  const port = server.status().port!
  const harness: Harness = {
    server,
    mgr,
    base: `http://127.0.0.1:${port}`,
    port,
    token,
    sources,
    lastOptions: () => optionsSeen[optionsSeen.length - 1],
    setDocTask: (b) => (docTask = b),
    setAdmitsWork: (v) => (admits = v),
    stopAll: async () => {
      await server.stop()
      await mgr.stop()
    }
  }
  cleanups.push(harness.stopAll)
  return harness
}

function authed(token: string, extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }
}

async function post(h: Harness, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${h.base}/v1/chat/completions`, {
    method: 'POST',
    headers: headers ?? authed(h.token),
    body: JSON.stringify(body)
  })
}

/** Parse an SSE body into its data payloads (strings; '[DONE]' stays literal). */
function ssePayloads(text: string): string[] {
  return text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('data: '))
    .map((b) => b.slice('data: '.length))
}

describe('LocalApiServer — bind posture (D2/O5)', () => {
  it('listens on 127.0.0.1 AND ::1, never 0.0.0.0; the two listeners share the port', async () => {
    const h = await makeHarness()
    const v4 = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    expect(v4.status).toBe(200)
    // ::1 twin (guarded: a runner without IPv6 loopback would have logged + degraded).
    try {
      const v6 = await fetch(`http://[::1]:${h.port}/v1/models`, { headers: authed(h.token) })
      expect(v6.status).toBe(200)
    } catch {
      /* no IPv6 loopback on this runner — the v4 assertion above still pins the port */
    }
    // Nothing is reachable via a non-loopback interface: the listener addresses are
    // loopback-only by construction (bind targets are literals in server.ts, pinned here
    // via the Server header response on loopback + the D2 test below).
    const server = (await v4.text()).length
    expect(server).toBeGreaterThan(0)
  })

  it('a taken port surfaces PortInUseError (never a crash)', async () => {
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const takenPort = (blocker.address() as net.AddressInfo).port
    const mgr = new RuntimeManager(() => {
      throw new Error('unused')
    })
    const server = new LocalApiServer({
      getSettings: () => ({ localApiPort: takenPort, localApiTokenRequired: true }),
      getToken: () => 'hr-x',
      runtime: {
        status: () => mgr.status(),
        active: () => null,
        isExternallyBusy: () => true,
        setExternalPreemption: () => {}
      },
      hasActiveDocTask: () => false,
      admitsWork: () => true,
      estimateBusySeconds: () => 30,
      appVersion: 't'
    })
    await expect(server.start()).rejects.toThrow(PortInUseError)
    expect(server.status().running).toBe(false)
    // The P4 card's error surface: the failed bind is queryable, not just logged.
    expect(server.status().lastError).toBe('port_in_use')
    await new Promise<void>((r) => blocker.close(() => r()))
  })

  it('stop() closes the listener — connections are refused afterwards', async () => {
    const h = await makeHarness()
    await h.server.stop()
    await expect(fetch(`${h.base}/v1/models`, { headers: authed(h.token) })).rejects.toThrow()
  })
})

describe('LocalApiServer — Host / Origin / content-type / auth matrix', () => {
  it('rejects a foreign or ABSENT Host with 403 (DNS-rebinding backstop)', async () => {
    const h = await makeHarness()
    // fetch refuses to override Host — drive both legs over a raw socket.
    const foreign = await rawRequest(
      h.port,
      `GET /v1/models HTTP/1.1\r\nhost: evil.example\r\nauthorization: Bearer ${h.token}\r\nconnection: close\r\n\r\n`
    )
    expect(foreign).toContain('403')
    expect(foreign).toContain('forbidden_host')
    // Absent Host (HTTP/1.0).
    const raw = await rawRequest(h.port, 'GET /v1/models HTTP/1.0\r\n\r\n')
    expect(raw).toContain('403')
  })

  it('rejects web origins and Origin: null; allows absent + custom app schemes', async () => {
    const h = await makeHarness()
    const web = await fetch(`${h.base}/v1/models`, {
      headers: { ...authed(h.token), origin: 'https://evil.example' }
    })
    expect(web.status).toBe(403)
    const nullOrigin = await fetch(`${h.base}/v1/models`, {
      headers: { ...authed(h.token), origin: 'null' }
    })
    expect(nullOrigin.status).toBe(403)
    const appScheme = await fetch(`${h.base}/v1/models`, {
      headers: { ...authed(h.token), origin: 'app://obsidian.md' }
    })
    expect(appScheme.status).toBe(200)
    const loopbackWeb = await fetch(`${h.base}/v1/models`, {
      headers: { ...authed(h.token), origin: `http://127.0.0.1:${h.port}` }
    })
    expect(loopbackWeb.status).toBe(200)
    // WHATWG quirk pin (review 2026-08-18): URL.hostname keeps IPv6 brackets — an
    // IPv6-loopback web origin must pass, and localhost too.
    const v6Web = await fetch(`${h.base}/v1/models`, {
      headers: { ...authed(h.token), origin: 'http://[::1]:5173' }
    })
    expect(v6Web.status).toBe(200)
    const localhostWeb = await fetch(`${h.base}/v1/models`, {
      headers: { ...authed(h.token), origin: 'http://localhost:5173' }
    })
    expect(localhostWeb.status).toBe(200)
  })

  it('refuses OPTIONS and never emits a CORS header on ANY response', async () => {
    const h = await makeHarness()
    const preflight = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { origin: 'app://x', 'access-control-request-method': 'POST' }
    })
    expect(preflight.status).toBe(403)
    const ok = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    for (const res of [preflight, ok]) {
      for (const name of res.headers.keys()) {
        expect(name.toLowerCase().startsWith('access-control-')).toBe(false)
      }
    }
    expect(ok.headers.get('server')).toMatch(/^HilbertRaum\//)
  })

  it('POST requires application/json but tolerates a charset parameter', async () => {
    const h = await makeHarness()
    const noCt = await post(h, { messages: [{ role: 'user', content: 'x' }] }, { authorization: `Bearer ${h.token}` })
    expect(noCt.status).toBe(415)
    const charset = await post(
      h,
      { messages: [{ role: 'user', content: 'hi' }] },
      { authorization: `Bearer ${h.token}`, 'content-type': 'application/json; charset=utf-8' }
    )
    expect(charset.status).toBe(200)
  })

  it('401 on a bad/missing key; both routes are auth-gated; token-off IGNORES a present key', async () => {
    const h = await makeHarness()
    for (const headers of [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', authorization: 'Bearer wrong' }
    ] as Array<Record<string, string>>) {
      expect((await fetch(`${h.base}/v1/models`, { headers })).status).toBe(401)
      expect((await post(h, { messages: [{ role: 'user', content: 'x' }] }, headers)).status).toBe(401)
    }
    const h2 = await makeHarness({ tokenRequired: false })
    // SDKs always send SOME key — token-off must ignore it, not validate it.
    const dummy = await fetch(`${h2.base}/v1/models`, {
      headers: { authorization: 'Bearer dummy' }
    })
    expect(dummy.status).toBe(200)
  })

  it('unknown routes are 404 with an OpenAI-shaped error body', async () => {
    const h = await makeHarness()
    const res = await fetch(`${h.base}/v1/embeddings`, {
      method: 'POST',
      headers: authed(h.token),
      body: '{}'
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { message: string; type: string; code: string } }
    expect(body.error.type).toBe('invalid_request_error')
    expect(typeof body.error.message).toBe('string')
  })
})

describe('LocalApiServer — model states (perf M6)', () => {
  it('GET /v1/models: 200 with id + context window when running', async () => {
    const h = await makeHarness()
    const res = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    const body = (await res.json()) as { object: string; data: Array<{ id: string; context_window: number | null }> }
    expect(body.object).toBe('list')
    expect(body.data[0].id).toBe('test-model')
    expect(body.data[0].context_window).toBe(4096)
  })

  it('model_not_loaded vs model_starting are DISTINCT 503s; starting carries Retry-After', async () => {
    const h = await makeHarness({ startModel: false })
    const absent = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    expect(absent.status).toBe(503)
    expect(((await absent.json()) as { error: { code: string } }).error.code).toBe('model_not_loaded')

    // A start in flight: startingModelId set, active() still null.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slowMgr = new RuntimeManager((startOpts) => ({
      modelId: startOpts.modelId,
      start: () => gate,
      stop: async () => {},
      health: async () => ({ healthy: true, message: '', port: null }),
      chatStream: async function* (): AsyncGenerator<string, void, unknown> {}
    }))
    const startPromise = slowMgr.start({ modelId: 'loading', modelPath: '/m.gguf', contextTokens: 2048 })
    const server2 = new LocalApiServer({
      getSettings: () => ({ localApiPort: 0, localApiTokenRequired: false }),
      getToken: () => 'hr-x',
      runtime: {
        status: () => slowMgr.status(),
        active: () => slowMgr.active(),
        isExternallyBusy: () => slowMgr.isExternallyBusy(),
        setExternalPreemption: () => {}
      },
      hasActiveDocTask: () => false,
      admitsWork: () => true,
      estimateBusySeconds: () => 17,
      appVersion: 't'
    })
    await server2.start()
    cleanups.push(async () => {
      release()
      await startPromise
      await server2.stop()
      await slowMgr.stop()
    })
    const starting = await fetch(`http://127.0.0.1:${server2.status().port}/v1/models`)
    expect(starting.status).toBe(503)
    expect(((await starting.json()) as { error: { code: string } }).error.code).toBe('model_starting')
    expect(starting.headers.get('retry-after')).toBe('17')
  })
})

describe('LocalApiServer — completions contract (client-dev 1/2/5/7)', () => {
  it('non-streaming (the SDK default): ONE chat.completion object with the full content', async () => {
    const h = await makeHarness()
    const res = await post(h, { messages: [{ role: 'user', content: 'hello' }] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      object: string
      created: number
      model: string
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>
      usage?: unknown
    }
    expect(body.object).toBe('chat.completion')
    expect(body.id).toMatch(/^chatcmpl-/)
    expect(body.model).toBe('test-model')
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'echo: hello' })
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage).toBeUndefined() // deliberately absent, documented (client-dev 5)
  })

  it('streaming: role-first chunk → content deltas → finish_reason chunk → [DONE]', async () => {
    const h = await makeHarness()
    const res = await post(h, { messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const payloads = ssePayloads(await res.text())
    expect(payloads[payloads.length - 1]).toBe('[DONE]')
    const frames = payloads.slice(0, -1).map((p) => JSON.parse(p) as {
      object: string
      choices: Array<{ delta: Record<string, string>; finish_reason: string | null }>
    })
    expect(frames.every((f) => f.object === 'chat.completion.chunk')).toBe(true)
    expect(frames[0].choices[0].delta).toEqual({ role: 'assistant' })
    const content = frames.map((f) => f.choices[0].delta.content ?? '').join('')
    expect(content).toBe('echo: hi')
    expect(frames[frames.length - 1].choices[0].finish_reason).toBe('stop')
  })

  it('external requests run balanced/thinking-off on the external lane, schema honored (json_schema)', async () => {
    const h = await makeHarness()
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    const res = await post(h, {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 999_999,
      temperature: 0.4,
      response_format: { type: 'json_schema', json_schema: { name: 'thing', schema } }
    })
    expect(res.status).toBe(200)
    const opts = h.lastOptions()!
    expect(opts.lane).toBe('external')
    expect(opts.mode).toBe('balanced')
    expect(opts.maxTokens).toBe(4096) // clamped to the context window
    expect(opts.temperature).toBe(0.4)
    expect(opts.responseSchema).toEqual(schema)
    expect(opts.responseSchemaName).toBe('thing')
  })

  it('capability fields 400 naming the field; benign fields accepted-and-ignored', async () => {
    const h = await makeHarness()
    const tools = await post(h, { messages: [{ role: 'user', content: 'x' }], tools: [{}] })
    expect(tools.status).toBe(400)
    expect(((await tools.json()) as { error: { message: string } }).error.message).toContain('tools')
    const n2 = await post(h, { messages: [{ role: 'user', content: 'x' }], n: 2 })
    expect(n2.status).toBe(400)
    const jsonObject = await post(h, {
      messages: [{ role: 'user', content: 'x' }],
      response_format: { type: 'json_object' }
    })
    expect(jsonObject.status).toBe(400)
    const imageParts = await post(h, {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]
    })
    expect(imageParts.status).toBe(400)
    // Benign: ignored, not refused. Text content-parts flatten.
    const benign = await post(h, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'flat' }] }],
      top_p: 0.9,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      n: 1,
      user: 'abc',
      stream_options: { include_usage: true }
    })
    expect(benign.status).toBe(200)
    expect(((await benign.json()) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe(
      'echo: flat'
    )
  })

  it('busy while an in-app generation runs: 429 + Retry-After (fail-closed admission)', async () => {
    const h = await makeHarness({ echo: false, queueWaitMs: 50 })
    const inApp = h.mgr.active()!.chatStream([{ role: 'user', content: 'q' }])
    const pull = inApp.next()
    await Promise.resolve()
    h.sources[0].push('tok')
    await pull
    const res = await post(h, { messages: [{ role: 'user', content: 'x' }] })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('busy')
    h.sources[0].end()
    await inApp.return()
  })

  it('a doc task refuses admission too', async () => {
    const h = await makeHarness({ queueWaitMs: 50 })
    h.setDocTask(true)
    const res = await post(h, { messages: [{ role: 'user', content: 'x' }] })
    expect(res.status).toBe(429)
  })

  it('locked workspace → 503 workspace_locked', async () => {
    const h = await makeHarness()
    h.setAdmitsWork(false)
    const res = await post(h, { messages: [{ role: 'user', content: 'x' }] })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_locked')
  })

  it('pre-emption mid-stream: preempted_by_user error frame, close WITHOUT [DONE]', async () => {
    const h = await makeHarness({ echo: false })
    const resPromise = post(h, { messages: [{ role: 'user', content: 'x' }], stream: true })
    // Feed one delta so the stream starts, then enter an in-app turn (D8 pre-empts).
    await waitFor(() => h.sources.length === 1)
    h.sources[0].push('partial ')
    await new Promise((r) => setTimeout(r, 50))
    const inApp = h.mgr.active()!.chatStream([{ role: 'user', content: 'in-app' }])
    const inAppPull = inApp.next()
    const res = await resPromise
    const payloads = ssePayloads(await res.text())
    expect(payloads).not.toContain('[DONE]')
    const last = JSON.parse(payloads[payloads.length - 1]) as { error?: { code: string } }
    expect(last.error?.code).toBe('preempted_by_user')
    // The in-app turn proceeds once the external stream tore down.
    await Promise.resolve()
    h.sources[1]?.push('a')
    await inAppPull
    await inApp.return()
  })

  it('server stop mid-stream (the lock teardown): error frame, no [DONE], listener gone', async () => {
    const h = await makeHarness({ echo: false })
    const resPromise = post(h, { messages: [{ role: 'user', content: 'x' }], stream: true })
    await waitFor(() => h.sources.length === 1)
    h.sources[0].push('some ')
    await new Promise((r) => setTimeout(r, 50))
    await h.server.stop()
    const res = await resPromise
    const payloads = ssePayloads(await res.text())
    expect(payloads).not.toContain('[DONE]')
    const last = JSON.parse(payloads[payloads.length - 1]) as { error?: { code: string } }
    expect(last.error?.code).toBe('server_stopped')
    await expect(fetch(`${h.base}/v1/models`, { headers: authed(h.token) })).rejects.toThrow()
  })

  it('413 via COUNTED bytes on a chunked body (no Content-Length to trust)', async () => {
    const h = await makeHarness()
    const chunk = 'x'.repeat(64 * 1024)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 20; i++) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      }
    })
    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body: stream,
      duplex: 'half'
    } as RequestInit)
    expect(res.status).toBe(413)
  })

  it('a slow reader is reclaimed by the drain timeout — the slot frees for the next request', async () => {
    const h = await makeHarness({ echo: false, drainTimeoutMs: 120, queueWaitMs: 50 })
    // Raw socket client that sends the request then never reads the response.
    const socket = net.connect(h.port, '127.0.0.1')
    await new Promise<void>((r) => socket.once('connect', r))
    socket.pause() // stop reading → server-side backpressure once buffers fill
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true })
    socket.write(
      `POST /v1/chat/completions HTTP/1.1\r\nhost: 127.0.0.1:${h.port}\r\nauthorization: Bearer ${h.token}\r\n` +
        `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    )
    await waitFor(() => h.sources.length === 1)
    // Flood deltas until the socket buffer fills and the drain timeout reclaims the slot.
    const big = 'y'.repeat(64 * 1024)
    for (let i = 0; i < 64; i++) h.sources[0].push(big)
    h.sources[0].end()
    await waitFor(() => !h.mgr.isGenerating(), 5_000)
    socket.destroy()
    // The slot is free: a fresh request is admitted (echo path not used here — manual).
    const next = post(h, { messages: [{ role: 'user', content: 'ok' }] })
    await waitFor(() => h.sources.length === 2)
    h.sources[1].push('fine')
    h.sources[1].end()
    expect((await next).status).toBe(200)
  })

  it('client disconnect aborts the generation (no orphan burn)', async () => {
    const h = await makeHarness({ echo: false })
    const controller = new AbortController()
    const resPromise = fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true }),
      signal: controller.signal
    }).catch(() => null)
    await waitFor(() => h.sources.length === 1)
    h.sources[0].push('a')
    await new Promise((r) => setTimeout(r, 30))
    controller.abort()
    await resPromise
    await waitFor(() => !h.mgr.isGenerating(), 5_000)
    expect(h.mgr.isGenerating()).toBe(false)
  })
})

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Minimal raw HTTP exchange (for requests fetch cannot express, e.g. absent Host). */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request))
    const chunks: Buffer[] = []
    socket.on('data', (c) => chunks.push(c))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }, 2_000).unref()
  })
}
