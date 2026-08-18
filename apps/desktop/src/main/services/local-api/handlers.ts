import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Local-API request pipeline (local-api wave P3): the pure(ish) checks and the OpenAI
// envelope/error synthesis. The ORDER of the checks is part of the security contract —
// Host (DNS-rebinding backstop) → Origin (browser lockout) → content-type → auth — so
// nothing is readable pre-auth on either route. All of this is exercised by
// local-api-server.test.ts against a real listener.

// ---- Response/error envelope ------------------------------------------------------------

export interface ApiErrorBody {
  error: { message: string; type: string; code: string | number }
}

export function errorBody(message: string, type: string, code: string | number): ApiErrorBody {
  return { error: { message, type, code } }
}

/** Write a non-2xx JSON refusal. NEVER emits CORS headers (browser JS stays locked out).
 *  Safe on a dead/answered response: it only destroys, never throws mid-teardown. */
export function sendError(
  res: ServerResponse,
  status: number,
  body: ApiErrorBody,
  extraHeaders?: Record<string, string>
): void {
  if (res.destroyed || res.writableEnded || res.headersSent) {
    res.destroy()
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders
  })
  res.end(payload)
}

// ---- Pipeline checks --------------------------------------------------------------------

/** Hosts a request may address us as (O5: both loopbacks + localhost), with/without port. */
function isAllowedHostHeader(host: string, port: number): boolean {
  const h = host.trim().toLowerCase()
  const allowed = ['127.0.0.1', 'localhost', '[::1]']
  for (const base of allowed) {
    if (h === base || h === `${base}:${port}`) return true
  }
  return false
}

/** `Host` must be a loopback name for OUR port. Absent/empty (HTTP/1.0) → refuse: the
 *  header is the DNS-rebinding backstop, so its absence closes the door, not opens it. */
export function checkHost(req: IncomingMessage, port: number): ApiErrorBody | null {
  const host = req.headers.host
  if (!host || !isAllowedHostHeader(host, port)) {
    return errorBody('Forbidden host', 'permission_error', 'forbidden_host')
  }
  return null
}

/**
 * Origin policy (D4/A4, refined by SEC-F7): a web page's fetch always carries an
 * `http(s)://` Origin — reject any whose host is not loopback, and reject the literal
 * `null` Origin (sandboxed iframes/redirect chains; no legitimate local client sends it).
 * ABSENT Origin (curl, Python, most native code) and custom schemes (`app://`,
 * `vscode-webview://` — the Electron-based local clients this feature targets) pass.
 */
export function checkOrigin(req: IncomingMessage): ApiErrorBody | null {
  const origin = req.headers.origin
  if (origin === undefined) return null
  const value = String(origin).trim()
  if (value === '' || value.toLowerCase() === 'null') {
    return errorBody('Forbidden origin', 'permission_error', 'forbidden_origin')
  }
  const lower = value.toLowerCase()
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    try {
      const url = new URL(lower)
      const host = url.hostname
      const loopback = host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
      if (!loopback) return errorBody('Forbidden origin', 'permission_error', 'forbidden_origin')
    } catch {
      return errorBody('Forbidden origin', 'permission_error', 'forbidden_origin')
    }
  }
  // Custom app schemes: allowed.
  return null
}

/** POST bodies must be JSON. Parse the MEDIA TYPE only — axios/Python/Electron stacks
 *  append `; charset=utf-8` (client-dev 8). */
export function checkContentType(req: IncomingMessage): ApiErrorBody | null {
  if (req.method !== 'POST') return null
  const raw = req.headers['content-type']
  const mediaType = String(raw ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (mediaType !== 'application/json') {
    return errorBody('Content-Type must be application/json', 'invalid_request_error', 'unsupported_content_type')
  }
  return null
}

/**
 * Bearer auth, constant-time (compare sha256 digests — `timingSafeEqual` needs equal
 * lengths). When the key is NOT required, a present Authorization header is IGNORED,
 * never validated: SDKs always send one (users configure `apiKey: "dummy"`).
 */
export function checkAuth(
  req: IncomingMessage,
  tokenRequired: boolean,
  expectedToken: string
): ApiErrorBody | null {
  if (!tokenRequired) return null
  const header = req.headers.authorization
  const value = typeof header === 'string' ? header : ''
  const match = value.match(/^Bearer\s+(.+)$/i)
  const presented = match ? match[1].trim() : ''
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expectedToken).digest()
  if (!timingSafeEqual(a, b)) {
    return errorBody('Invalid or missing access key', 'authentication_error', 'invalid_api_key')
  }
  return null
}

// ---- Request-body parsing ----------------------------------------------------------------

export const BODY_MAX_BYTES = 1024 * 1024
/** Past this the flood is hostile — kill the socket instead of politely discarding. */
const BODY_HARD_KILL_BYTES = BODY_MAX_BYTES * 4

/**
 * Read + JSON-parse the body with the cap COUNTED AS BYTES ARRIVE — `Content-Length` is
 * never trusted (chunked/length-omitted bodies bypass a header check; SEC-F3). Crossing
 * the cap answers 413 and DISCARDS the rest (destroying mid-upload loses the response on
 * real clients); a 4× flood gets the socket destroyed outright.
 */
export function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const fail = (status: number, body: ApiErrorBody): void => {
      if (settled) return
      settled = true
      chunks.length = 0
      sendError(res, status, body)
      resolve({ ok: false })
    }
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (settled) {
        if (total > BODY_HARD_KILL_BYTES) req.destroy()
        return
      }
      if (total > BODY_MAX_BYTES) {
        fail(413, errorBody('Request body too large', 'invalid_request_error', 'body_too_large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => {
      if (!settled) {
        settled = true
        resolve({ ok: false })
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        sendError(res, 400, errorBody('Body is not valid JSON', 'invalid_request_error', 'invalid_json'))
        resolve({ ok: false })
      }
    })
  })
}

// ---- Chat-completions request validation --------------------------------------------------

export interface ParsedChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  stream: boolean
  maxTokens?: number
  temperature?: number
  responseSchema?: Record<string, unknown>
  responseSchemaName?: string
}

/**
 * Field policy (client-dev 4/6): CAPABILITY fields we cannot honor → 400 naming the
 * field; benign sampling/metadata fields → accepted and ignored (documented in
 * data-contracts). `response_format.json_schema` is supported (grammar-constrained
 * decoding is already wired); `json_object` is not mapped → 400.
 */
export function parseChatRequest(body: unknown): { ok: true; req: ParsedChatRequest } | { ok: false; error: ApiErrorBody } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: errorBody('Body must be a JSON object', 'invalid_request_error', 'invalid_body') }
  }
  const obj = body as Record<string, unknown>

  const unsupported = (field: string): { ok: false; error: ApiErrorBody } => ({
    ok: false,
    error: errorBody(
      `'${field}' is not supported by this server`,
      'invalid_request_error',
      'unsupported_field'
    )
  })
  if (obj.tools !== undefined || obj.tool_choice !== undefined || obj.functions !== undefined) {
    return unsupported('tools')
  }
  if (obj.audio !== undefined || obj.modalities !== undefined) return unsupported('audio')
  if (typeof obj.n === 'number' && obj.n > 1) return unsupported('n>1')

  // messages
  if (!Array.isArray(obj.messages) || obj.messages.length === 0) {
    return { ok: false, error: errorBody("'messages' must be a non-empty array", 'invalid_request_error', 'invalid_messages') }
  }
  const messages: ParsedChatRequest['messages'] = []
  for (const raw of obj.messages) {
    if (raw === null || typeof raw !== 'object') {
      return { ok: false, error: errorBody('Each message must be an object', 'invalid_request_error', 'invalid_messages') }
    }
    const m = raw as Record<string, unknown>
    const role = m.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { ok: false, error: errorBody(`Unsupported message role '${String(role)}'`, 'invalid_request_error', 'invalid_messages') }
    }
    let content = m.content
    if (Array.isArray(content)) {
      // Text-only content-parts arrays flatten (SDKs emit them); image/audio parts are a
      // capability we do not have (D6 — no vision surface on this endpoint).
      const parts: string[] = []
      for (const part of content) {
        const p = part as Record<string, unknown>
        if (p?.type === 'text' && typeof p.text === 'string') parts.push(p.text)
        else return unsupported('messages[].content parts')
      }
      content = parts.join('')
    }
    if (typeof content !== 'string') {
      return { ok: false, error: errorBody('Message content must be a string', 'invalid_request_error', 'invalid_messages') }
    }
    messages.push({ role, content })
  }

  // response_format
  let responseSchema: Record<string, unknown> | undefined
  let responseSchemaName: string | undefined
  const rf = obj.response_format as Record<string, unknown> | undefined
  if (rf !== undefined) {
    if (rf === null || typeof rf !== 'object') {
      return { ok: false, error: errorBody("'response_format' must be an object", 'invalid_request_error', 'invalid_response_format') }
    }
    if (rf.type === 'json_schema') {
      const js = rf.json_schema as Record<string, unknown> | undefined
      const schema = js?.schema
      if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        return { ok: false, error: errorBody("'response_format.json_schema.schema' must be an object", 'invalid_request_error', 'invalid_response_format') }
      }
      responseSchema = schema as Record<string, unknown>
      responseSchemaName = typeof js?.name === 'string' ? js.name : undefined
    } else if (rf.type !== undefined && rf.type !== 'text') {
      return unsupported(`response_format.type='${String(rf.type)}'`)
    }
  }

  const maxTokens =
    typeof obj.max_tokens === 'number' && Number.isFinite(obj.max_tokens) && obj.max_tokens > 0
      ? Math.floor(obj.max_tokens)
      : undefined
  const temperature =
    typeof obj.temperature === 'number' && Number.isFinite(obj.temperature) ? obj.temperature : undefined

  return {
    ok: true,
    req: {
      messages,
      stream: obj.stream === true,
      maxTokens,
      temperature,
      responseSchema,
      responseSchemaName
    }
  }
}

// ---- OpenAI envelope synthesis ------------------------------------------------------------

/** The runtime yields bare content-delta strings; the OpenAI chunk/completion envelopes
 *  are synthesized here (client-dev 1/2 — SDKs throw on anything else). */
export function chunkEnvelope(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null
): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })
}

export function completionEnvelope(
  id: string,
  created: number,
  model: string,
  content: string,
  finishReason: string
): string {
  // `usage` is deliberately ABSENT in v1 (documented in data-contracts): the SSE reader
  // discards token counts today; silence-with-documentation beats fabricated numbers.
  return JSON.stringify({
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }]
  })
}
