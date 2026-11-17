import { describe, it, expect, vi, onTestFinished } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { RuntimeManager } from '../../src/main/services/runtime'
import { LocalApiServer, PortInUseError } from '../../src/main/services/local-api/server'
import { RuntimeUnresponsiveError } from '../../src/main/services/runtime/llama'
import { until, within } from '../helpers/hang-budget'
import { authed, freePort, localApiDeps, localApiHarness, rawHttp, type LocalApiHarness } from '../helpers/local-api-harness'

// LocalApiServer integration pins (local-api wave P3): a REAL listener on an ephemeral
// port, driven over real HTTP, against a real RuntimeManager (gated fake runtimes; the shared
// harness, tests/helpers/local-api-harness.ts). The pin set is the plan's §4 P3 rows: bind
// posture, the Host/Origin/content-type/auth matrix and its order, the OpenAI response +
// error contract, distinct model states, pre-emption semantics, body-cap/backpressure
// bounds, the shipped limits of docs/local-api.md §6.7, and teardown.

async function post(h: LocalApiHarness, body: unknown, headers?: Record<string, string>): Promise<Response> {
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

/** The `(port, host)` of every `listen` an http.Server made since the spy was installed. */
function httpBinds(listen: { mock: { calls: unknown[][]; contexts: unknown[] } }): unknown[][] {
  return listen.mock.calls.filter((_, i) => listen.mock.contexts[i] instanceof http.Server).map((args) => args.slice(0, 2))
}

/**
 * Whether the `setTimeout` call whose stack this is came from local-api/server.ts itself. Called from a spy
 * implementation: frame 0 is that implementation, the spy's own frames (node_modules) follow, then the caller.
 */
function armedByServer(stack: string | undefined): boolean {
  const frames = (stack ?? '').split('\n').filter((line) => line.trimStart().startsWith('at '))
  const caller = frames.slice(1).find((frame) => !/[\\/]node_modules[\\/]/.test(frame))
  return caller !== undefined && /[\\/]services[\\/]local-api[\\/]server\.ts:\d/.test(caller)
}

describe('LocalApiServer — bind posture (D2/O5)', () => {
  it('listens on 127.0.0.1 AND ::1, never 0.0.0.0; the two listeners share the port', async () => {
    // The bind targets are literals in server.ts: read them off the listen calls themselves.
    const listen = vi.spyOn(net.Server.prototype, 'listen')
    onTestFinished(() => listen.mockRestore())
    const h = await localApiHarness()
    // The setting asks for port 0 (ephemeral); the ::1 twin binds the port the v4 listener got.
    expect(httpBinds(listen)).toEqual([
      [0, '127.0.0.1'],
      [h.port, '::1']
    ])
    const v4 = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    expect(v4.status).toBe(200)
    // A machine without IPv6 loopback degrades to v4-only and says so in the log; anywhere else the ::1 listener
    // must answer (Windows resolves `localhost` to ::1 first).
    if (!h.logged.some((line) => line.includes('IPv6 loopback bind failed'))) {
      const v6 = await fetch(`http://[::1]:${h.port}/v1/models`, { headers: authed(h.token) })
      expect(v6.status).toBe(200)
    }
  })

  it('a taken port surfaces PortInUseError + lastError (never a crash), and a deliberate stop clears it — "off" is off, not broken', async () => {
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    onTestFinished(() => new Promise<void>((r) => blocker.close(() => r())))
    const takenPort = (blocker.address() as net.AddressInfo).port
    const mgr = new RuntimeManager(() => {
      throw new Error('unused')
    })
    const server = new LocalApiServer(
      localApiDeps(mgr, { getSettings: () => ({ localApiPort: takenPort, localApiTokenRequired: true }) })
    )
    await expect(server.start()).rejects.toThrow(PortInUseError)
    expect(server.status().running).toBe(false)
    // The P4 card's error surface: the failed bind is queryable, not just logged.
    expect(server.status().lastError).toBe('port_in_use')
    // Without this the Diagnostics row (and the copy report) would keep telling a user who
    // simply switched the feature back off that the port is still in use (review 2026-08-18).
    await server.applySettings({ shouldRun: false })
    expect(server.status().lastError).toBeNull()
    expect(server.status().running).toBe(false)
  })

  it('stop() closes the listener — connections are refused afterwards', async () => {
    const h = await localApiHarness()
    await h.server.stop()
    await expect(fetch(`${h.base}/v1/models`, { headers: authed(h.token) })).rejects.toThrow()
  })
})

describe('LocalApiServer — Host / Origin / content-type / auth matrix', () => {
  it('rejects a foreign, ABSENT, wrong-port or look-alike Host with 403 (DNS-rebinding backstop)', async () => {
    const h = await localApiHarness()
    // fetch refuses to override Host — drive every leg over a raw socket, each with a valid key, so only the Host
    // check can answer 403. The control: a loopback name for OUR port is served.
    const get = (host: string): Promise<string> =>
      rawHttp(h.port, `GET /v1/models HTTP/1.1\r\nhost: ${host}\r\nauthorization: Bearer ${h.token}\r\nconnection: close\r\n\r\n`)
    expect(await get(`localhost:${h.port}`)).toMatch(/^HTTP\/1\.1 200 /)
    for (const host of ['evil.example', `127.0.0.1:${h.port + 1}`, `127.0.0.1.evil.example:${h.port}`]) {
      const answer = await get(host)
      expect(answer, host).toMatch(/^HTTP\/1\.1 403 /)
      expect(answer, host).toContain('"code":"forbidden_host"')
    }
    // Absent Host (HTTP/1.0): no Origin and no key, so only the Host check can answer 403 (otherwise 401).
    const absent = await rawHttp(h.port, 'GET /v1/models HTTP/1.0\r\n\r\n')
    expect(absent).toMatch(/^HTTP\/1\.[01] 403 /)
    expect(absent).toContain('"code":"forbidden_host"')
  })

  // The ORDER of the checks is part of the security contract (handlers.ts): Host → OPTIONS → Origin →
  // content-type → auth → route, so nothing is readable before auth. Each request below fails two or more
  // checks and carries no key; the answer names the check that runs first.
  it.each<[string, string, (port: number) => string[], number, string]>([
    ['a foreign Host first', 'OPTIONS /v1/chat/completions', () => ['host: evil.example', 'origin: https://evil.example'], 403, 'forbidden_host'],
    ['OPTIONS before Origin', 'OPTIONS /v1/chat/completions', (p) => [`host: 127.0.0.1:${p}`, 'origin: https://evil.example'], 403, 'no_cors'],
    ['Origin before content-type', 'POST /v1/chat/completions', (p) => [`host: 127.0.0.1:${p}`, 'origin: https://evil.example', 'content-type: text/plain', 'content-length: 2'], 403, 'forbidden_origin'],
    ['content-type before auth', 'POST /v1/chat/completions', (p) => [`host: 127.0.0.1:${p}`, 'content-type: text/plain', 'content-length: 2'], 415, 'unsupported_content_type'],
    ['auth before the route', 'GET /v1/embeddings', (p) => [`host: 127.0.0.1:${p}`], 401, 'invalid_api_key']
  ])('check order: %s', async (_order, line, headers, status, code) => {
    const h = await localApiHarness()
    const body = line.startsWith('POST') ? '{}' : ''
    const answer = await rawHttp(h.port, [`${line} HTTP/1.1`, ...headers(h.port), 'connection: close', '', body].join('\r\n'))
    expect(answer).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `))
    expect(answer).toContain(`"code":"${code}"`)
  })

  it("rejects web origins, Origin: null and the app's own scheme; allows absent + other custom app schemes", async () => {
    const h = await localApiHarness()
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
    // #560: this app's OWN renderer origin is refused even with a valid key — it talks to main
    // over IPC; only its CSP stood in the way before this second layer.
    for (const own of ['hilbertraum://app', 'HILBERTRAUM://app', 'hilbertraum://other']) {
      const res = await fetch(`${h.base}/v1/models`, { headers: { ...authed(h.token), origin: own } })
      expect(res.status, own).toBe(403)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden_origin')
    }
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
    const h = await localApiHarness()
    const preflight = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { origin: 'app://x', 'access-control-request-method': 'POST' }
    })
    const ok = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    // A completion writes its own head, once as the JSON answer and once as the SSE prologue.
    const completion = await post(h, { messages: [{ role: 'user', content: 'x' }] })
    const stream = await post(h, { messages: [{ role: 'user', content: 'x' }], stream: true })
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const responses = [preflight, ok, completion, stream]
    expect(responses.map((res) => res.status)).toEqual([403, 200, 200, 200])
    for (const res of responses) {
      for (const name of res.headers.keys()) {
        expect(name.toLowerCase().startsWith('access-control-'), name).toBe(false)
      }
      await res.text()
    }
    expect(ok.headers.get('server')).toMatch(/^HilbertRaum\//)
  })

  it('POST requires application/json but tolerates a charset parameter', async () => {
    const h = await localApiHarness()
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
    const h = await localApiHarness()
    for (const headers of [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', authorization: 'Bearer wrong' }
    ] as Array<Record<string, string>>) {
      expect((await fetch(`${h.base}/v1/models`, { headers })).status).toBe(401)
      expect((await post(h, { messages: [{ role: 'user', content: 'x' }] }, headers)).status).toBe(401)
    }
    const h2 = await localApiHarness({ tokenRequired: false })
    // SDKs always send SOME key — token-off must ignore it, not validate it.
    const dummy = await fetch(`${h2.base}/v1/models`, {
      headers: { authorization: 'Bearer dummy' }
    })
    expect(dummy.status).toBe(200)
  })

  it('unknown routes are 404 with an OpenAI-shaped error body', async () => {
    const h = await localApiHarness()
    const res = await fetch(`${h.base}/v1/embeddings`, {
      method: 'POST',
      headers: authed(h.token),
      body: '{}'
    })
    expect(res.status).toBe(404)
    // docs/local-api.md §6.6 publishes the code clients branch on.
    expect(await res.json()).toEqual({ error: { message: 'Not found', type: 'invalid_request_error', code: 'unknown_route' } })
  })
})

describe('LocalApiServer — key rotation mid-request (SEC-F6)', () => {
  it('a request that authenticated with the OLD key is refused once the body arrives', async () => {
    // Auth runs before the (up to 30 s) body phase, so a rotation landing in that window
    // would otherwise let a request admitted under the dead key occupy the model — the same
    // hole abortExternalRequests closes for streams already running.
    const h = await localApiHarness()
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    const socket = net.connect(h.port, '127.0.0.1')
    await new Promise<void>((r) => socket.once('connect', r))
    const chunks: Buffer[] = []
    socket.on('data', (c) => chunks.push(c))
    // Headers (with the still-valid key) first, body withheld.
    socket.write(
      [
        'POST /v1/chat/completions HTTP/1.1',
        `host: 127.0.0.1:${h.port}`,
        `authorization: Bearer ${h.token}`,
        'content-type: application/json',
        `content-length: ${Buffer.byteLength(body)}`,
        'connection: close',
        '',
        ''
      ].join('\r\n')
    )
    // The headers passed the key check (it reads the key once per check), so the rotation lands in the body window.
    await until(() => h.tokenCalls() === 1, 'the server checking the key on the headers')
    h.setToken('hr-' + 'b'.repeat(43)) // the user pressed "Create a new key"
    socket.write(body)
    await until(() => Buffer.concat(chunks).toString('utf8').includes('\r\n\r\n'), 'the answer to the stale-key request')
    const answer = Buffer.concat(chunks).toString('utf8')
    socket.destroy()
    expect(answer).toMatch(/^HTTP\/1\.1 401 /)
    expect(answer).toContain('invalid_api_key')
    expect(h.tokenCalls()).toBe(2) // the second check is the one after the body
    // …and nothing was generated for it (the echo runtime records every chatStream call's options): it was refused
    // before it even asked for admission, so it never held the one external slot.
    expect(h.lastOptions()).toBeUndefined()
    expect(h.admitChecks()).toBe(0)
  })
})

describe('LocalApiServer — model states (perf M6)', () => {
  it('GET /v1/models: 200 with id + context window when running', async () => {
    const h = await localApiHarness()
    const res = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    const body = (await res.json()) as { object: string; data: Array<{ id: string; context_window: number | null }> }
    expect(body.object).toBe('list')
    expect(body.data[0].id).toBe('test-model')
    expect(body.data[0].context_window).toBe(4096)
  })

  it('model_not_loaded vs model_starting are DISTINCT 503s; starting carries Retry-After', async () => {
    const h = await localApiHarness({ startModel: false })
    const absent = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    expect(absent.status).toBe(503)
    expect(((await absent.json()) as { error: { code: string } }).error.code).toBe('model_not_loaded')

    // #599: a start requested and still checking the weights (minutes on a freshly copied drive) —
    // `startingModelId` is not set yet, but a client must still hear "retry", not "start one".
    const releaseRequest = h.mgr.beginStartRequest()
    const checking = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    releaseRequest()
    expect(checking.status).toBe(503)
    expect(((await checking.json()) as { error: { code: string } }).error.code).toBe('model_starting')

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
    const server2 = new LocalApiServer(
      localApiDeps(slowMgr, {
        getSettings: () => ({ localApiPort: 0, localApiTokenRequired: false }),
        estimateBusySeconds: () => 17
      })
    )
    await server2.start()
    onTestFinished(async () => {
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
    const h = await localApiHarness()
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
    const h = await localApiHarness()
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
    const h = await localApiHarness()
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
    const h = await localApiHarness()
    // docs/local-api.md §6.4/§6.6: 400 `unsupported_field`, the message naming the field.
    const message = [{ role: 'user', content: 'x' }]
    const capabilities: Array<[string, Record<string, unknown>]> = [
      ['tools', { messages: message, tools: [{}] }],
      ['n>1', { messages: message, n: 2 }],
      ["response_format.type='json_object'", { messages: message, response_format: { type: 'json_object' } }],
      ['messages[].content parts', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }],
      ['audio', { messages: message, audio: { voice: 'alloy' } }],
      ['audio', { messages: message, modalities: ['text', 'audio'] }]
    ]
    for (const [field, body] of capabilities) {
      const res = await post(h, body)
      expect(res.status, field).toBe(400)
      const { error } = (await res.json()) as { error: { message: string; code: string } }
      expect(error.code, field).toBe('unsupported_field')
      expect(error.message, field).toContain(`'${field}'`)
    }
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
    const h = await localApiHarness({ runtime: 'manual' })
    // A direct active().chatStream, the way the benchmark or a skill run drives the model: registered nowhere,
    // but the gate counts it.
    const inApp = h.mgr.active()!.chatStream([{ role: 'user', content: 'q' }])
    const pull = inApp.next()
    await until(() => h.sources.length === 1, 'the in-app generation reaching the model')
    h.sources[0].push('tok')
    await pull
    // The admission side's own read: the generation gate answers the same 429 through
    // ExternalGenerationBusyError, so the status alone cannot show that the fail-closed busy predicate
    // counts an in-flight generation.
    expect(h.mgr.isExternallyBusy()).toBe(true)
    const res = await post(h, { messages: [{ role: 'user', content: 'x' }] })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('busy')
    h.sources[0].end()
    await inApp.return()
    expect(h.mgr.isExternallyBusy()).toBe(false)
    // The lane is idle again: the next request is admitted and served, not refused.
    const next = post(h, { messages: [{ role: 'user', content: 'again' }] })
    await until(() => h.sources.length === 2, 'the next request reaching the model')
    h.sources[1].push('ok')
    h.sources[1].end()
    expect((await next).status).toBe(200)
  })

  it('a doc task refuses admission too', async () => {
    const h = await localApiHarness()
    h.setDocTask(true)
    const res = await post(h, { messages: [{ role: 'user', content: 'x' }] })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('busy')
  })

  it('locked workspace → 503 workspace_locked', async () => {
    const h = await localApiHarness()
    h.setAdmitsWork(false)
    const res = await post(h, { messages: [{ role: 'user', content: 'x' }] })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_locked')
  })

  // #594/#598: a sidecar that never answers now ends in CB-5's error (headers 180 s, then 120 s of silence or 7 min without
  // prompt progress — it used to hold the one external slot until undici gave up at 300 s, or forever behind pings). Before
  // the first token both modes owe the documented 502, and the slot must free.
  it.each([false, true])('the runtime stops responding before its first token → 502 runtime_unresponsive, slot freed (stream: %s)', async (stream) => {
    const h = await localApiHarness({ runtime: 'manual' })
    const resPromise = post(h, { messages: [{ role: 'user', content: 'x' }], stream })
    await until(() => h.sources.length === 1, 'the generation starting')
    h.sources[0].fail(new RuntimeUnresponsiveError(120_000))
    const res = await resPromise
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('runtime_unresponsive')
    const next = post(h, { messages: [{ role: 'user', content: 'again' }] })
    await until(() => h.sources.length === 2, 'the next request being admitted') // admitted, not 429
    h.sources[1].push('ok')
    h.sources[1].end()
    expect((await next).status).toBe(200)
  })

  it('pre-emption mid-stream: preempted_by_user error frame, close WITHOUT [DONE]', async () => {
    const h = await localApiHarness({ runtime: 'manual' })
    const resPromise = post(h, { messages: [{ role: 'user', content: 'x' }], stream: true })
    await until(() => h.sources.length === 1, 'the external generation starting')
    h.sources[0].push('partial ')
    const res = await resPromise // the headers ride the first delta: the stream has started
    // An in-app turn enters (D8): the manager's pre-emption hook aborts the external stream.
    const inApp = h.mgr.active()!.chatStream([{ role: 'user', content: 'in-app' }])
    const inAppPull = inApp.next()
    const payloads = ssePayloads(await within(res.text(), 'the pre-empted stream ending'))
    expect(payloads).not.toContain('[DONE]')
    const last = JSON.parse(payloads[payloads.length - 1]) as { error?: { code: string } }
    expect(last.error?.code).toBe('preempted_by_user')
    // The in-app turn proceeds once the external stream tore down, and gets its first token.
    await until(() => h.sources.length === 2, 'the in-app turn reaching the model')
    h.sources[1].push('a')
    expect((await inAppPull).value).toBe('a')
    await inApp.return()
  })

  // #600: the user stopped or switched the chat model while a request ran (the runtime's model-stop hook
  // calls endForModelChange BEFORE the kill). The client gets the model gate's own code — `model_starting`
  // (a switch, with Retry-After) or `model_not_loaded` (a stop) — not the 502 runtime_unresponsive a
  // killed sidecar used to produce (measured on master 2026-10-06: 502 / in-band runtime_error).
  it.each([
    ['model_not_loaded' as const, false],
    ['model_starting' as const, true]
  ])('a model change before any bytes → 503 %s for the running request and the one queued behind it (Retry-After: %s)', async (code, retryAfter) => {
    const h = await localApiHarness({ runtime: 'manual' })
    const running = post(h, { messages: [{ role: 'user', content: 'x' }] })
    await until(() => h.sources.length === 1, 'the generation starting') // generating, nothing sent yet
    const queued = post(h, { messages: [{ role: 'user', content: 'y' }] })
    await until(() => h.admitChecks() === 2, 'the second request parking in the queue') // the one-deep queue
    h.server.endForModelChange(code)
    for (const res of [await running, await queued]) {
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code)
      expect(res.headers.has('retry-after')).toBe(retryAfter)
    }
  })

  it('a model change mid-stream → in-band model_starting frame, closed WITHOUT [DONE] (#600)', async () => {
    const h = await localApiHarness({ runtime: 'manual' })
    const resPromise = post(h, { messages: [{ role: 'user', content: 'x' }], stream: true })
    await until(() => h.sources.length === 1, 'the generation starting')
    h.sources[0].push('partial ')
    const res = await resPromise // the headers ride the first delta
    h.server.endForModelChange('model_starting')
    const payloads = ssePayloads(await res.text())
    expect(payloads).not.toContain('[DONE]')
    const last = JSON.parse(payloads[payloads.length - 1]) as { error?: { code: string } }
    expect(last.error?.code).toBe('model_starting')
  })

  it('server stop mid-stream (the lock teardown): error frame, no [DONE], listener gone', async () => {
    const h = await localApiHarness({ runtime: 'manual' })
    const resPromise = post(h, { messages: [{ role: 'user', content: 'x' }], stream: true })
    await until(() => h.sources.length === 1, 'the generation starting')
    h.sources[0].push('some ')
    const res = await resPromise // the headers ride the first delta: the stream has started
    await h.server.stop()
    const payloads = ssePayloads(await res.text())
    expect(payloads).not.toContain('[DONE]')
    const last = JSON.parse(payloads[payloads.length - 1]) as { error?: { code: string } }
    expect(last.error?.code).toBe('server_stopped')
    await expect(fetch(`${h.base}/v1/models`, { headers: authed(h.token) })).rejects.toThrow()
  })

  it('a stop queued behind a same-port settings re-apply still ends the running stream with server_stopped (#859)', async () => {
    const h = await localApiHarness({ runtime: 'manual' })
    h.setSettingsPort(h.port) // the re-apply below takes the same-port path, which used to clear `stopping`
    const resPromise = post(h, { messages: [{ role: 'user', content: 'x' }], stream: true })
    await until(() => h.sources.length === 1, 'the generation starting')
    h.sources[0].push('some ')
    const res = await resPromise
    // A Settings save just before Lock now: the re-apply is queued first, then the lock's stop.
    void h.server.applySettings({ shouldRun: true })
    await h.server.stop()
    const payloads = ssePayloads(await res.text())
    const last = JSON.parse(payloads[payloads.length - 1]) as { error?: { code: string } }
    expect(last.error?.code).toBe('server_stopped')
    expect(h.server.status().running).toBe(false)
  })

  it('a request queued behind a running one is refused with 503 server_stopped when the endpoint stops, not 429 busy (#859)', async () => {
    const h = await localApiHarness({ runtime: 'manual' })
    const running = post(h, { messages: [{ role: 'user', content: 'x' }] })
    await until(() => h.sources.length === 1, 'the generation starting')
    const queued = post(h, { messages: [{ role: 'user', content: 'y' }] })
    await until(() => h.admitChecks() === 2, 'the second request parking in the queue')
    await h.server.stop()
    for (const res of [await running, await queued]) {
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('server_stopped')
      expect(res.headers.has('retry-after')).toBe(false)
    }
  })

  // #859: the admission gate. The request's headers are in (its key was checked) but its body is still
  // uploading when the stop lands, so it reaches admission DURING the teardown: the gate must answer it
  // 503 server_stopped. Before, a plain stop answered workspace_locked (the gate fed the lock check), and
  // a same-port re-apply queued first, or a re-port, let it in for the close to cut off.
  it.each([
    ['a stop', async (h: LocalApiHarness) => void h.server.stop()],
    [
      'a same-port settings re-apply, then a stop',
      async (h: LocalApiHarness) => {
        h.setSettingsPort(h.port)
        void h.server.applySettings({ shouldRun: true })
        void h.server.stop()
      }
    ],
    [
      'a re-port',
      async (h: LocalApiHarness) => {
        h.setSettingsPort(await freePort())
        return h.server.applySettings({ shouldRun: true })
      }
    ]
  ])('a request that reaches admission during %s gets 503 server_stopped (#859)', async (_label, trigger) => {
    const h = await localApiHarness()
    let finishBody!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"messages":[{"role":"user",'))
        finishBody = () => {
          controller.enqueue(new TextEncoder().encode('"content":"x"}]}'))
          controller.close()
        }
      }
    })
    const resPromise = fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body,
      duplex: 'half'
    } as RequestInit)
    await until(() => h.tokenCalls() === 1, 'the server checking the key on the headers')
    const settled = trigger(h)
    finishBody()
    const res = await resPromise
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('server_stopped')
    await settled // a re-port's applySettings must not reject (a lost port would)
  })

  // #859: the other half of the gate. A bookkeeping slip in the stop-request count would leave a live
  // listener answering every request 503 server_stopped: after each way the gate closes, it must open again.
  it('the gate opens again: a start after a stop, a start after a stop queued behind a re-apply, and a re-port all serve (#859)', async () => {
    const h = await localApiHarness()
    const complete = async (): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${h.server.status().port}/v1/chat/completions`, {
        method: 'POST',
        headers: authed(h.token),
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] })
      })
      await res.text()
      return res.status
    }
    await h.server.stop()
    await h.server.start()
    expect(await complete()).toBe(200)
    h.setSettingsPort(h.server.status().port!)
    void h.server.applySettings({ shouldRun: true })
    await h.server.stop()
    await h.server.start()
    h.setSettingsPort(0)
    expect(await complete()).toBe(200)
    h.setSettingsPort(await freePort())
    await h.server.applySettings({ shouldRun: true })
    expect(await complete()).toBe(200)
  })

  it('a re-port ends the streams on the old port with server_stopped, not a "retry shortly" preemption (#859)', async () => {
    const h = await localApiHarness({ runtime: 'manual' })
    const nextPort = await freePort() // free on both loopbacks the server binds
    const resPromise = post(h, { messages: [{ role: 'user', content: 'x' }], stream: true })
    await until(() => h.sources.length === 1, 'the generation starting')
    h.sources[0].push('some ')
    const res = await resPromise
    h.setSettingsPort(nextPort)
    await h.server.applySettings({ shouldRun: true })
    const payloads = ssePayloads(await res.text())
    const last = JSON.parse(payloads[payloads.length - 1]) as { error?: { code: string } }
    expect(last.error?.code).toBe('server_stopped')
    expect(h.server.status()).toMatchObject({ running: true, port: nextPort })
  })

  it('413 via COUNTED bytes on a chunked body (no Content-Length to trust)', async () => {
    const h = await localApiHarness()
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
    const h = await localApiHarness({ runtime: 'manual', deps: { drainTimeoutMs: 120 } })
    // Raw socket client that sends the request then never reads the response.
    const socket = net.connect(h.port, '127.0.0.1')
    await new Promise<void>((r) => socket.once('connect', r))
    socket.pause() // stop reading → server-side backpressure once buffers fill
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true })
    socket.write(
      `POST /v1/chat/completions HTTP/1.1\r\nhost: 127.0.0.1:${h.port}\r\nauthorization: Bearer ${h.token}\r\n` +
        `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    )
    await until(() => h.sources.length === 1, 'the generation starting')
    // Feed deltas until the drain timeout reclaims the slot. The source never ends, so the stream cannot finish
    // normally: however much the loopback buffers absorb (a fixed 4 MiB flood fit them under load, and the stream
    // then ended as served), the writer stays ahead of the reader until a write waits on 'drain' and times out.
    const big = 'y'.repeat(64 * 1024)
    await until(() => {
      if (!h.mgr.isGenerating()) return true
      h.sources[0].push(big)
      return false
    }, 'the drain timeout reclaiming the stalled stream')
    socket.destroy()
    // The slot is free: a fresh request is admitted and served.
    const next = post(h, { messages: [{ role: 'user', content: 'ok' }] })
    await until(() => h.sources.length === 2, 'the next request being admitted')
    h.sources[1].push('fine')
    h.sources[1].end()
    expect((await next).status).toBe(200)
    // The stalled stream was RECLAIMED (counted as refused), not finished: had the loopback buffers taken the whole
    // flood, it would have ended normally and counted as served, and only the follow-up would be.
    expect(h.server.status()).toMatchObject({ rejectedCount: 1, requestsServed: 1 })
  })

  it('client disconnect aborts the generation (no orphan burn)', async () => {
    const h = await localApiHarness({ runtime: 'manual' })
    const controller = new AbortController()
    const resPromise = fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true }),
      signal: controller.signal
    })
    await until(() => h.sources.length === 1, 'the generation starting')
    h.sources[0].push('a')
    await resPromise // the headers ride the first delta: the client leaves mid-stream
    controller.abort()
    await until(() => !h.mgr.isGenerating(), 'the generation ending after the client left')
  })
})

// docs/local-api.md §6.7 publishes these bounds to third-party clients; every expected value is a literal, so a
// changed constant turns this row red instead of moving the test along with it. (The queue wait, ~30 s, is
// local-api-admission.test.ts's "caps the queued wait" row.)
describe('LocalApiServer — the shipped limits and timeouts (docs/local-api.md §6.7)', () => {
  it('serves with the published bounds', async () => {
    const listen = vi.spyOn(net.Server.prototype, 'listen')
    // The delay of every setTimeout server.ts arms ITSELF (the spy's caller frame is server.ts), so a timer of the
    // same length armed anywhere else cannot stand in for a bound: the two decoys below are armed by this row.
    const realSetTimeout = globalThis.setTimeout
    const serverDelays: unknown[] = []
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      if (armedByServer(new Error().stack)) serverDelays.push(args[1])
      return realSetTimeout(...args)
    }) as typeof setTimeout)
    const bodyIdle = vi.spyOn(http.IncomingMessage.prototype, 'setTimeout')
    const decoys = [120_000, 15_000].map((ms) => setTimeout(() => {}, ms))
    onTestFinished(() => {
      for (const decoy of decoys) clearTimeout(decoy)
      listen.mockRestore()
      timers.mockRestore()
      bodyIdle.mockRestore()
    })
    const h = await localApiHarness({ runtime: 'manual' })
    const servers = listen.mock.contexts.filter((s): s is http.Server => s instanceof http.Server)
    expect(servers.length).toBeGreaterThan(0)
    // One streaming completion whose delta overflows the response buffer: the write waits for 'drain', under the
    // SSE reader-stall bound.
    const resPromise = post(h, { messages: [{ role: 'user', content: 'x' }], stream: true })
    await until(() => h.sources.length === 1, 'the generation starting')
    h.sources[0].push('y'.repeat(256 * 1024))
    h.sources[0].end()
    const res = await resPromise
    expect(res.status).toBe(200)
    await res.text()
    const bounds: Array<[string, unknown, unknown]> = [
      ['header phase 10 s', servers.map((s) => s.headersTimeout), servers.map(() => 10_000)],
      ['generation: no timeout', servers.map((s) => s.requestTimeout), servers.map(() => 0)],
      ['concurrent connections 16', servers.map((s) => s.maxConnections), servers.map(() => 16)],
      ['body idle 30 s', bodyIdle.mock.calls[0]?.[0], 30_000],
      ['body total 120 s', serverDelays.includes(120_000), true],
      ['SSE reader stall 15 s', serverDelays.includes(15_000), true]
    ]
    for (const [bound, actual, expected] of bounds) expect(actual, bound).toEqual(expected)
    // Request body 1 MB, counted as bytes arrive: exactly the cap is read (and is not JSON), one byte more is refused.
    const atCap = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body: 'x'.repeat(1024 * 1024)
    })
    expect(((await atCap.json()) as { error: { code: string } }).error.code).toBe('invalid_json')
    const pastCap = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body: 'x'.repeat(1024 * 1024 + 1)
    })
    expect(pastCap.status).toBe(413)
    expect(((await pastCap.json()) as { error: { code: string } }).error.code).toBe('body_too_large')
  })
})
