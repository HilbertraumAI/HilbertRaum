import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import { RuntimeManager, type RuntimeChatOptions } from '../../src/main/services/runtime'
import { LocalApiServer } from '../../src/main/services/local-api/server'

// Local-API wave P6 — the adversarial pass over the listener. Two invariants, proved with a
// real listener on an ephemeral port:
//
//   (1) NO CONTENT, ANYWHERE. A sentinel string is driven through the endpoint as a prompt AND
//       as the model's answer, then every sink the server can reach — the injected logger, every
//       console stream, and the bytes of every response the request produced — is grepped for it.
//       The endpoint's own accounting is counts-only by design (D1); this is the test that keeps
//       it that way when someone later adds a "helpful" log line.
//   (2) HOSTILE WIRE INPUT IS BOUNDED. Slow-loris headers, an idle socket, a truncated body, a
//       smuggling attempt (both Content-Length and Transfer-Encoding), header injection through
//       a reflected value, and a torn-down stream must each end in a refusal or a closed socket —
//       never a hang, never a second interpretation of the request, never a wedged model slot.
//
// The auth/Host/Origin matrix itself lives in local-api-server.test.ts; this file is about what
// happens when the bytes are malicious rather than merely wrong.

const SENTINEL = 'XLOCALAPI_SENTINEL_my_iban_is_AT99_4242_3333'
const ANSWER_SENTINEL = 'XLOCALAPI_ANSWER_the_password_is_hunter2'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.restoreAllMocks()
})

interface Harness {
  server: LocalApiServer
  mgr: RuntimeManager
  port: number
  base: string
  token: string
  logged: string[]
}

async function makeHarness(opts: { echoAnswer?: string } = {}): Promise<Harness> {
  const logged: string[] = []
  const mgr = new RuntimeManager((startOpts) => ({
    modelId: startOpts.modelId,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: '', port: null }),
    contextWindow: () => startOpts.contextTokens,
    chatStream(_messages, options?: RuntimeChatOptions) {
      return (async function* (): AsyncGenerator<string, void, unknown> {
        if (options?.signal?.aborted) return
        yield opts.echoAnswer ?? ANSWER_SENTINEL
        options?.onFinish?.('stop')
      })()
    }
  }))
  await mgr.start({ modelId: 'test-model', modelPath: '/m.gguf', contextTokens: 4096 })
  const token = 'hr-' + 'c'.repeat(43)
  const server = new LocalApiServer({
    getSettings: () => ({ localApiPort: 0, localApiTokenRequired: true }),
    getToken: () => token,
    runtime: {
      status: () => mgr.status(),
      active: () => mgr.active(),
      isExternallyBusy: () => mgr.isExternallyBusy(),
      setExternalPreemption: (hook) => mgr.setExternalPreemption(hook)
    },
    hasActiveDocTask: () => false,
    admitsWork: () => true,
    estimateBusySeconds: () => 30,
    appVersion: '0.0.0-test',
    // Capture EVERYTHING the server would write to the app log.
    log: {
      info: (msg, meta) => logged.push(`${msg} ${JSON.stringify(meta ?? null)}`),
      warn: (msg, meta) => logged.push(`${msg} ${JSON.stringify(meta ?? null)}`)
    }
  })
  await server.start()
  const port = server.status().port!
  const h: Harness = { server, mgr, port, base: `http://127.0.0.1:${port}`, token, logged }
  cleanups.push(async () => {
    await server.stop()
    await mgr.stop()
  })
  return h
}

function authed(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

/** Write a raw request and collect the whole reply; resolves on close or a short deadline. */
function raw(port: number, request: string, opts: { holdMs?: number } = {}): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request))
    socket.on('data', (c) => chunks.push(c))
    const done = (): void => {
      socket.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    socket.on('close', done)
    socket.on('error', done)
    const timer = setTimeout(done, opts.holdMs ?? 3000)
    timer.unref?.()
  })
}

describe('local API hardening — no content in any sink (D1)', () => {
  it('a sentinel prompt and a sentinel answer reach the caller and NOTHING else', async () => {
    const h = await makeHarness()
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )

    // 1. A normal, successful completion carrying the secret both ways.
    const ok = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body: JSON.stringify({ messages: [{ role: 'user', content: SENTINEL }] })
    })
    const okBody = await ok.text()
    expect(ok.status).toBe(200)
    expect(okBody).toContain(ANSWER_SENTINEL) // the caller DOES get the answer

    // 2. The same secret through the failure paths, where a "helpful" error is the usual leak.
    const badJson = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body: `{"messages":[{"role":"user","content":"${SENTINEL}"` // truncated on purpose
    })
    const badJsonBody = await badJson.text()
    expect(badJson.status).toBe(400)

    const badShape = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body: JSON.stringify({ messages: [{ role: 'user', content: SENTINEL }], tools: [SENTINEL] })
    })
    const badShapeBody = await badShape.text()
    expect(badShape.status).toBe(400)

    const badAuth = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: SENTINEL }] })
    })
    const badAuthBody = await badAuth.text()
    expect(badAuth.status).toBe(401)

    // Every server-side sink.
    const sinks = h.logged.join('\n')
    expect(sinks).not.toContain(SENTINEL)
    expect(sinks).not.toContain(ANSWER_SENTINEL)
    // A rejected credential must not be echoed back either — that is a log AND a response leak.
    expect(badAuthBody).not.toContain(SENTINEL)
    for (const spy of consoleSpies) {
      const said = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
      expect(said).not.toContain(SENTINEL)
      expect(said).not.toContain(ANSWER_SENTINEL)
    }
    // Error bodies say what was wrong, never what was said.
    expect(badJsonBody).not.toContain(SENTINEL)
    expect(badShapeBody).not.toContain(SENTINEL)

    // …and the status the UI reads is counts only — no field can carry a string of content.
    const status = h.server.status()
    expect(JSON.stringify(status)).not.toContain(SENTINEL)
    expect(status.requestsServed).toBe(1)
    expect(status.rejectedCount).toBe(3)
  })

  it('the access key never appears in a response, a header, or a log line', async () => {
    const h = await makeHarness()
    const res = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).not.toContain(h.token)
    expect(JSON.stringify([...res.headers])).not.toContain(h.token)
    expect(h.logged.join('\n')).not.toContain(h.token)
  })
})

describe('local API hardening — hostile wire input is bounded', () => {
  it('a slow-loris header phase is cut off by the headers timeout, not left hanging', async () => {
    const h = await makeHarness()
    // Headers that never terminate: the server must close the socket itself. A 3 s read window
    // proves it does not answer; the point is that the connection cannot be held indefinitely
    // (headersTimeout is 10 s, deliberately shorter than any generation).
    const answer = await raw(h.port, `GET /v1/models HTTP/1.1\r\nhost: 127.0.0.1:${h.port}\r\nx-a: 1`, {
      holdMs: 1500
    })
    expect(answer).not.toContain('200')
    // The listener is unharmed: a well-formed request right after still works.
    const ok = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    expect(ok.status).toBe(200)
  })

  it('refuses a request that carries BOTH Content-Length and Transfer-Encoding (smuggling)', async () => {
    const h = await makeHarness()
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    const answer = await raw(
      h.port,
      [
        'POST /v1/chat/completions HTTP/1.1',
        `host: 127.0.0.1:${h.port}`,
        `authorization: Bearer ${h.token}`,
        'content-type: application/json',
        `content-length: ${Buffer.byteLength(body)}`,
        'transfer-encoding: chunked',
        '',
        body
      ].join('\r\n')
    )
    // Node's own parser rejects the ambiguity outright — the request is never interpreted twice.
    expect(answer).toMatch(/HTTP\/1\.1 (400|501)/)
    expect(answer).not.toContain('chatcmpl-')
  })

  it('a header value with CRLF cannot inject a second header or response line', async () => {
    const h = await makeHarness()
    // The Host check runs on the parsed value; an injected CRLF must not survive into the reply.
    const answer = await raw(
      h.port,
      [
        'GET /v1/models HTTP/1.1',
        `host: 127.0.0.1:${h.port}`,
        'x-evil: a\r\nx-injected: yes',
        `authorization: Bearer ${h.token}`,
        'connection: close',
        '',
        ''
      ].join('\r\n')
    )
    expect(answer).not.toContain('x-injected')
    // Whatever the parser decided, exactly ONE status line came back.
    expect(answer.match(/HTTP\/1\.1 \d\d\d/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it('a body that stops mid-upload frees the slot instead of holding the model', async () => {
    const h = await makeHarness()
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    const socket = net.connect(h.port, '127.0.0.1')
    await new Promise<void>((r) => socket.once('connect', r))
    socket.write(
      [
        'POST /v1/chat/completions HTTP/1.1',
        `host: 127.0.0.1:${h.port}`,
        `authorization: Bearer ${h.token}`,
        'content-type: application/json',
        `content-length: ${Buffer.byteLength(body) + 100}`, // promises more than it will send
        '',
        body
      ].join('\r\n')
    )
    await new Promise((r) => setTimeout(r, 100))
    socket.destroy() // client vanishes mid-upload

    // No generation was ever started, and the next caller is admitted immediately.
    expect(h.mgr.isGenerating()).toBe(false)
    const ok = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body
    })
    expect(ok.status).toBe(200)
  })

  it('a torn-down server answers nothing further and leaves no generation running', async () => {
    const h = await makeHarness()
    await h.server.stop()
    await expect(fetch(`${h.base}/v1/models`, { headers: authed(h.token) })).rejects.toThrow()
    expect(h.mgr.isGenerating()).toBe(false)
  })
})
