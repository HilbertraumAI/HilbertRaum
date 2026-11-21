import { describe, it, expect, afterEach, vi } from 'vitest'
import net from 'node:net'
import { hangBudgetMs, until } from '../helpers/hang-budget'
import { authed, localApiHarness, rawHttp } from '../helpers/local-api-harness'

// Local-API wave P6 — the adversarial pass over the listener. Two invariants, proved with a
// real listener on an ephemeral port (the shared harness, tests/helpers/local-api-harness.ts):
//
//   (1) NO CONTENT, ANYWHERE. A sentinel string is driven through the endpoint as a prompt AND
//       as the model's answer, then every sink the server can reach — the injected logger, every
//       console stream, and the bytes and headers of every response the request produced — is
//       grepped for it, and for the access key. The endpoint's own accounting is counts-only by
//       design (D1); this is the test that keeps it that way when someone later adds a
//       "helpful" log line or status field.
//   (2) HOSTILE WIRE INPUT IS BOUNDED. Slow-loris headers, a truncated body, a body that trickles
//       forever and a smuggling attempt (both Content-Length and Transfer-Encoding, or a bare LF
//       in the header block) must each end in a refusal or a closed socket — never a hang, never
//       a second interpretation of the request, never a counted refusal nobody received.
//
// The auth/Host/Origin matrix itself lives in local-api-server.test.ts; this file is about what
// happens when the bytes are malicious rather than merely wrong.

const SENTINEL = 'XLOCALAPI_SENTINEL_my_iban_is_AT99_4242_3333'
const ANSWER_SENTINEL = 'XLOCALAPI_ANSWER_the_password_is_hunter2'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('local API hardening — no content in any sink (D1)', () => {
  it('a sentinel prompt and a sentinel answer reach the caller and NOTHING else', async () => {
    const h = await localApiHarness({ runtime: { answer: ANSWER_SENTINEL } })
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )
    const responses: Array<{ body: string; headers: string }> = []
    const send = async (path: string, init: RequestInit): Promise<{ status: number; body: string }> => {
      const res = await fetch(`${h.base}${path}`, init)
      const body = await res.text()
      responses.push({ body, headers: JSON.stringify([...res.headers]) })
      return { status: res.status, body }
    }

    // 1. A normal, successful completion carrying the secret both ways.
    const ok = await send('/v1/chat/completions', {
      method: 'POST',
      headers: authed(h.token),
      body: JSON.stringify({ messages: [{ role: 'user', content: SENTINEL }] })
    })
    expect(ok.status).toBe(200)
    expect(ok.body).toContain(ANSWER_SENTINEL) // the caller DOES get the answer

    // 2. The same secret through the failure paths, where a "helpful" error is the usual leak.
    const badJson = await send('/v1/chat/completions', {
      method: 'POST',
      headers: authed(h.token),
      body: `{"messages":[{"role":"user","content":"${SENTINEL}"` // truncated on purpose
    })
    expect(badJson.status).toBe(400)

    const badShape = await send('/v1/chat/completions', {
      method: 'POST',
      headers: authed(h.token),
      body: JSON.stringify({ messages: [{ role: 'user', content: SENTINEL }], tools: [SENTINEL] })
    })
    expect(badShape.status).toBe(400)

    const badAuth = await send('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: SENTINEL }] })
    })
    expect(badAuth.status).toBe(401)

    // 3. The models route, with the valid key.
    const models = await send('/v1/models', { headers: authed(h.token) })
    expect(models.status).toBe(200)

    // Every server-side sink.
    const sinks = h.logged.join('\n')
    expect(sinks).not.toContain(SENTINEL)
    expect(sinks).not.toContain(ANSWER_SENTINEL)
    expect(sinks).not.toContain(h.token)
    for (const spy of consoleSpies) {
      const said = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
      expect(said).not.toContain(SENTINEL)
      expect(said).not.toContain(ANSWER_SENTINEL)
      expect(said).not.toContain(h.token)
    }
    // Error bodies say what was wrong, never what was said; a rejected credential is not echoed back either; and the
    // access key never appears in a response body or header on any route.
    expect(badJson.body).not.toContain(SENTINEL)
    expect(badShape.body).not.toContain(SENTINEL)
    expect(badAuth.body).not.toContain(SENTINEL)
    expect(responses).toHaveLength(5)
    for (const { body, headers } of responses) {
      expect(body).not.toContain(h.token)
      expect(headers).not.toContain(h.token)
    }

    // …and the status the UI reads is counts and flags only (D1) — no field can carry a string of content.
    const status = h.server.status()
    expect(JSON.stringify(status)).not.toContain(SENTINEL)
    expect(Object.keys(status).sort()).toEqual([
      'externalActive',
      'lastError',
      'lastPreemptedAt',
      'port',
      'rejectedCount',
      'requestsServed',
      'running',
      'tokenRequired'
    ])
    expect(status.requestsServed).toBe(2)
    expect(status.rejectedCount).toBe(3)
  })
})

describe('local API hardening — hostile wire input is bounded', () => {
  it('the SERVER cuts off a slow-loris header phase (headersTimeout really is armed)', async () => {
    // A client-side read deadline would prove nothing — an empty read looks identical to a
    // patient server. The seam shortens the real `headersTimeout` so the test can watch the
    // SERVER hang up, and the assertion is the close itself: with the timeout unset (or set to
    // 0, which disables it in Node) this test times out instead of passing.
    const h = await localApiHarness({ runtime: { answer: ANSWER_SENTINEL }, deps: { headersTimeoutMs: 250 } })
    const socket = net.connect(h.port, '127.0.0.1')
    socket.on('error', () => {}) // an RST here is a valid way for the server to end it
    await new Promise<void>((r) => socket.once('connect', r))
    // Headers that never terminate: no blank line is ever sent.
    socket.write(`GET /v1/models HTTP/1.1\r\nhost: 127.0.0.1:${h.port}\r\nx-a: 1`)
    // Keep reading: a paused socket never reads the server's hang-up, so its 'close' would never fire.
    socket.resume()

    const closedByServer = await new Promise<boolean>((resolve) => {
      socket.once('close', () => resolve(true))
      const timer = setTimeout(() => resolve(false), hangBudgetMs(5_000))
      timer.unref?.()
    })
    socket.destroy()
    expect(closedByServer).toBe(true)

    // …and the listener is unharmed: a well-formed request right after still works.
    const ok = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    expect(ok.status).toBe(200)
  })

  it('refuses a request that carries BOTH Content-Length and Transfer-Encoding (smuggling)', async () => {
    const h = await localApiHarness({ runtime: { answer: ANSWER_SENTINEL } })
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    const answer = await rawHttp(
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

  it('a smuggled request line behind a header value is never answered as a second request', async () => {
    const h = await localApiHarness({ runtime: { answer: ANSWER_SENTINEL } })
    // The interesting attack is not a reflected header (the endpoint reflects none) — it is
    // getting TWO requests interpreted from one socket write. A bare LF in the header block is
    // the classic vector: if the parser accepted it, the trailing GET would be answered too.
    const answer = await rawHttp(
      h.port,
      `GET /v1/models HTTP/1.1\r\nhost: 127.0.0.1:${h.port}\r\n` +
        `authorization: Bearer ${h.token}\r\n` +
        `x-evil: a\nGET /v1/models HTTP/1.1\nhost: 127.0.0.1:${h.port}\n` +
        `authorization: Bearer ${h.token}\r\nconnection: close\r\n\r\n`
    )
    // Node's strict parser refuses the malformed header block outright — one answer, and it is
    // a rejection. The pin that matters: never TWO successful answers from one write.
    expect(answer.match(/HTTP\/1\.1 \d\d\d/g)?.length ?? 0).toBeLessThanOrEqual(1)
    expect(answer).not.toContain('"object":"list"')
    expect(answer).toContain('400')
  })

  // Admission runs only after the body arrived, so a truncated upload can never take the model slot; what this
  // path owns is the accounting: nobody received an answer, so nothing counts as a refusal ("Count only ANSWERED
  // refusals", server.ts).
  it('a body that stops mid-upload is answered nothing, counted as no refusal, and the next caller is served', async () => {
    const h = await localApiHarness({ runtime: { answer: ANSWER_SENTINEL } })
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    const socket = net.connect(h.port, '127.0.0.1')
    // Without this, a server-side close inside the window below surfaces as an uncaught
    // ECONNRESET that kills the vitest worker instead of failing an assertion.
    socket.on('error', () => {})
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
    // The headers passed the key check, so the server is in the body phase when the client vanishes.
    await until(() => h.tokenCalls() === 1, 'the server reading the truncated body')
    socket.destroy() // client vanishes mid-upload

    const ok = await fetch(`${h.base}/v1/chat/completions`, {
      method: 'POST',
      headers: authed(h.token),
      body
    })
    expect(ok.status).toBe(200)
    // Stopping closes every server-side socket, so the dead upload's end has been handled by now.
    await h.server.stop()
    expect(h.server.status()).toMatchObject({ requestsServed: 1, rejectedCount: 0 })
  })

  it('the SERVER cuts off a body that trickles forever — a total deadline, not only the idle timer (#255)', async () => {
    // One byte every 25 ms keeps the idle timer reset for as long as the client likes, and
    // sixteen such sockets exhaust the listener. Only a TOTAL body deadline ends it. The seam
    // shortens that deadline so the test can watch the server hang up; without the deadline
    // the socket stays open and this test fails on its own timer.
    const h = await localApiHarness({ runtime: { answer: ANSWER_SENTINEL }, deps: { bodyTotalTimeoutMs: 400 } })
    const socket = net.connect(h.port, '127.0.0.1')
    socket.on('error', () => {}) // an RST is a valid way for the server to end it
    await new Promise<void>((r) => socket.once('connect', r))
    socket.write(
      [
        'POST /v1/chat/completions HTTP/1.1',
        `host: 127.0.0.1:${h.port}`,
        `authorization: Bearer ${h.token}`,
        'content-type: application/json',
        'content-length: 100000', // far below the body cap: the cap never ends this
        '',
        ''
      ].join('\r\n')
    )
    const trickle = setInterval(() => {
      if (!socket.destroyed) socket.write('x')
    }, 25)
    const closedByServer = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), hangBudgetMs(5_000))
      timer.unref?.()
      socket.once('close', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    clearInterval(trickle)
    socket.destroy()
    expect(closedByServer).toBe(true)

    // The listener is unharmed.
    const ok = await fetch(`${h.base}/v1/models`, { headers: authed(h.token) })
    expect(ok.status).toBe(200)
  })
})
