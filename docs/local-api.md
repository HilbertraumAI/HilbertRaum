# Local API — using your HilbertRaum model from other apps

HilbertRaum can make the chat model you already have running available to **other programs on the
same computer** — an editor plugin, a note-taking app, a shell script, a small tool you wrote —
over a small **OpenAI-compatible HTTP endpoint** bound to loopback.

It is **off by default**, it **never touches the internet**, it exposes **nothing but completions**
(no documents, no conversations, no search index), and it **keeps no record** of what was asked or
answered. Everything below explains how to turn it on, how to point a client at it, exactly what
the wire contract is, and where its edges are.

> **One sentence for the impatient:** switch it on in **Settings → Privacy & data → Local API**,
> then point any OpenAI-compatible client at `http://127.0.0.1:4980/v1` with the access key the
> card gives you.

**Audience.** §1–§5 and §7–§11 are for anyone connecting an app. §6 is the wire contract for
people writing a client. §12 points maintainers at the design records.

## Table of contents

- [§1 What it is — and what it is not](#1-what-it-is--and-what-it-is-not)
- [§2 Before you start](#2-before-you-start)
- [§3 Turning it on](#3-turning-it-on)
- [§4 Your first request](#4-your-first-request)
- [§5 Connecting real clients](#5-connecting-real-clients)
- [§6 The HTTP contract](#6-the-http-contract)
- [§7 Sharing one model with yourself](#7-sharing-one-model-with-yourself)
- [§8 Security posture](#8-security-posture)
- [§9 Privacy](#9-privacy)
- [§10 Settings and policy reference](#10-settings-and-policy-reference)
- [§11 Troubleshooting](#11-troubleshooting)
- [§12 For maintainers](#12-for-maintainers)

---

## §1 What it is — and what it is not

```
your app  ──HTTP──▶  127.0.0.1:4980  (HilbertRaum, opt-in)
                          │  Host check · Origin policy · no CORS · JSON only
                          │  Bearer access key (on by default)
                          │  admission: one outside request at a time
                          ▼
                     the chat model you already started
```

**It is:** a two-route HTTP endpoint that answers chat completions with the model **currently
running** in HilbertRaum, in the OpenAI request/response shape, streaming or all at once.

**It is not:**

| Not | Why |
|---|---|
| A document/RAG API | There is no route to your documents, chunks, embeddings, or citations. Retrieval stays inside the app. |
| A workspace API | Conversations, settings, the activity log, and the vector index are unreachable — not "protected", *unreachable*: no route exists. |
| A model manager | The endpoint never starts, stops, or switches a model. If nothing is running, callers get an honest error and a human has to start one. |
| A network service | Loopback only (`127.0.0.1` and `::1`). No LAN mode, no `0.0.0.0`, no proxy, no setting that could produce one. |
| An embeddings / vision / audio / translation API | Those features exist in the app, not on this endpoint. |
| A tool-calling backend | `tools` / `functions` are refused by name (see [§6.4](#64-request-fields)). |

## §2 Before you start

Four things must be true before an outside app can get an answer:

1. **Your drive's policy permits it.** A managed or commercial drive can forbid the feature
   outright; the card then appears greyed out *with that reason* rather than disappearing. See
   [§10](#10-settings-and-policy-reference).
2. **You switched it on** and confirmed the consent dialog. Off is the default.
3. **Your workspace is unlocked.** The endpoint exists only while it is — the settings and the
   access key live inside the encrypted workspace. Lock or quit stops the listener; the next
   unlock starts it again if the switch is still on.
4. **A chat model is running** (the **AI Model** screen). The endpoint borrows the model you
   started; it never starts one for a caller.

## §3 Turning it on

1. Open **Settings → Privacy & data** and find the **Local API** card.
2. Switch on **Allow other apps on this computer to use my AI model**.
3. Read the dialog, tick the acknowledgement, and choose **Turn on**. Nothing is saved until you do.
4. The card now reads **Listening on port 4980** and shows a **Connect another app** block with
   the two values every client asks for:

| The card shows | Your client probably calls it |
|---|---|
| **Server address** — `http://127.0.0.1:4980/v1` | "Base URL", "API base", "endpoint", "OpenAI-compatible URL" |
| **Access key** — starts with `hr-` | "API key", "token", "secret key" |

Use the **Copy** buttons rather than retyping. The key is only ever *displayed* shortened
(`hr-…7f3q`); copying puts the real value on your clipboard, and the app clears the clipboard
again after about a minute if you have not copied something else since.

**Use the literal `127.0.0.1` string from the card, not `localhost`.** HilbertRaum binds both
loopback addresses, but on Windows 11 `localhost` resolves to the IPv6 address `::1` first and
some clients try only one of the two — and on a machine with IPv6 disabled the `::1` listener
cannot be created at all. The printed address is unambiguous; a typed `localhost` is not.

**If the port is taken**, the card says so and the endpoint does not start — the switch stays on,
only the bind failed. Type another number (4981, for example) and press **Apply**. Treat an
unexpected conflict seriously: a program squatting on the port could be posing as HilbertRaum to
collect the key you are about to paste somewhere. Find out what is listening first
(`netstat -ano | findstr :4980` on Windows, `lsof -i :4980` on macOS/Linux).

## §4 Your first request

Start a model, then check the endpoint answers before you configure anything else.

**Is it up, and which model is loaded?**

```bash
curl -s http://127.0.0.1:4980/v1/models -H "Authorization: Bearer hr-YOURKEY"
```

```json
{"object":"list","data":[{"id":"gemma4-e2b-it-qat-q4","object":"model","owned_by":"hilbertraum","context_window":8192}]}
```

**Ask something** (non-streaming — the default of every SDK):

```bash
curl -s http://127.0.0.1:4980/v1/chat/completions \
  -H "Authorization: Bearer hr-YOURKEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in five words."}]}'
```

**The same on Windows PowerShell** — PowerShell's `curl` is an alias for `Invoke-WebRequest`, so
use the cmdlet properly rather than pasting a bash line:

```powershell
$key = 'hr-YOURKEY'
Invoke-RestMethod -Uri 'http://127.0.0.1:4980/v1/chat/completions' -Method Post `
  -Headers @{ Authorization = "Bearer $key" } -ContentType 'application/json' `
  -Body '{"messages":[{"role":"user","content":"Say hello in five words."}]}' |
  ForEach-Object { $_.choices[0].message.content }
```

**Streaming** (server-sent events):

```bash
curl -N http://127.0.0.1:4980/v1/chat/completions \
  -H "Authorization: Bearer hr-YOURKEY" \
  -H "Content-Type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"Count to five."}]}'
```

You will see a role-first chunk, then content deltas, then a `finish_reason` chunk, then
`data: [DONE]`.

> A first request against a cold CPU model can take a while to produce its first token — prefill
> is silent. That is normal, and the endpoint deliberately does not time it out; see
> [§6.7](#67-limits-and-timeouts).

## §5 Connecting real clients

### Any OpenAI-compatible client

Most tools that speak "OpenAI-compatible" need exactly three values:

| Field | Value |
|---|---|
| Base URL / API base | `http://127.0.0.1:4980/v1` (exactly what the card shows) |
| API key | the `hr-…` key from the card (any non-empty string if you turned the key requirement off) |
| Model name | **anything** — HilbertRaum always answers with the model you have running. Use the id from `GET /v1/models` if the client validates it. |

Turn **off** any client feature that maps to a refused capability: tool/function calling, vision
attachments, and "n > 1" completions (see [§6.4](#64-request-fields)). Clients that insist on
token-usage numbers will find `usage` absent ([§6.5](#65-responses)).

### Python (`openai` SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:4980/v1", api_key="hr-YOURKEY")

resp = client.chat.completions.create(
    model="hilbertraum",                      # ignored; any value works
    messages=[{"role": "user", "content": "Summarize this in one sentence: ..."}],
)
print(resp.choices[0].message.content)

# streaming
for chunk in client.chat.completions.create(
    model="hilbertraum",
    messages=[{"role": "user", "content": "Count to five."}],
    stream=True,
):
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

### Node / TypeScript (`openai` SDK)

```ts
import OpenAI from 'openai'

const client = new OpenAI({ baseURL: 'http://127.0.0.1:4980/v1', apiKey: 'hr-YOURKEY' })

const resp = await client.chat.completions.create({
  model: 'hilbertraum',
  messages: [{ role: 'user', content: 'Say hello in five words.' }]
})
console.log(resp.choices[0].message.content)
```

### Plain `fetch` (Node, an Electron main process, a plugin host)

```ts
const res = await fetch('http://127.0.0.1:4980/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer hr-YOURKEY' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] })
})
if (!res.ok) {
  const { error } = await res.json() // { message, type, code }
  throw new Error(`${res.status} ${error.code}: ${error.message}`)
}
```

**Browser JavaScript cannot use this endpoint, by design** — see [§8](#8-security-posture). A
plugin running in an Electron/VS Code *main* or extension-host process can (its requests carry no
`http(s)` origin, or a custom-scheme one such as `vscode-webview://`, both of which pass); a web
page's `fetch` cannot.

### Asking for JSON in a fixed shape

`response_format: { type: 'json_schema', json_schema: { name, schema } }` is supported and mapped
onto grammar-constrained decoding, so the model's output conforms to your schema:

```json
{
  "messages": [{ "role": "user", "content": "Extract the invoice total." }],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "invoice",
      "schema": {
        "type": "object",
        "properties": { "total": { "type": "number" }, "currency": { "type": "string" } },
        "required": ["total", "currency"]
      }
    }
  }
}
```

`response_format: { type: 'json_object' }` is **not** supported (400) — pass a schema instead.

### A retry rule worth writing once

Two answers mean "ask again shortly", and both carry `Retry-After` (seconds):

- **429 `busy`** — the model is answering something else (yours, or another caller's).
- **`preempted_by_user`** — you were interrupted because the user started their own chat. See
  [§7](#7-sharing-one-model-with-yourself).

Everything else is either a client mistake (4xx) or a state a human must fix (503
`model_not_loaded`, `workspace_locked`).

## §6 The HTTP contract

The authoritative, maintained version of this contract lives in
[`data-contracts.md`](data-contracts.md) ("Local-api wave P3 — the exposed HTTP contract"); this
section is the same thing written for a client author.

### 6.1 Base URL, headers, authentication

- Base URL: `http://127.0.0.1:4980/v1` (the port is configurable, 1024–65535).
- Every response carries `Server: HilbertRaum/<app version>`.
- **`Authorization: Bearer <key>`** is required on **both** routes while *Require an access key*
  is on (the default). The comparison is constant-time. With the requirement off, a present
  `Authorization` header is ignored rather than validated (SDKs always send one).
- `Content-Type: application/json` is required on POST; a `; charset=utf-8` suffix is fine.
- The `Host` header must name a loopback address **and the port actually bound**; an absent or
  empty `Host` is refused. Send the URL as printed and any normal HTTP client does this for you.

### 6.2 `GET /v1/models`

Lists the **one** model currently running. It is the cheap "is it up?" probe and never occupies
the model.

```json
{ "object": "list",
  "data": [{ "id": "<model id>", "object": "model", "owned_by": "hilbertraum",
             "context_window": 8192 }] }
```

`context_window` is a non-standard extra so a client can size its prompts. Three distinct
outcomes: **200** (running) · **503 `model_starting`** + `Retry-After` (loading — pace yourself) ·
**503 `model_not_loaded`** (a human must start a model).

### 6.3 `POST /v1/chat/completions`

The only generation route. Minimal body:

```json
{ "messages": [{ "role": "user", "content": "…" }] }
```

Roles: `system`, `user`, `assistant`. `content` is a string, or an array of **text-only** content
parts (they are flattened); image/audio parts are refused.

### 6.4 Request fields

| Field | Behaviour |
|---|---|
| `messages` | **Required**, non-empty. Roles above; text content only. |
| `stream` | `true` → SSE, otherwise a single JSON object (the SDK default). |
| `max_tokens` | Honoured, clamped to the launched context window. |
| `temperature` | Honoured. |
| `response_format.type: "json_schema"` | **Supported** — grammar-constrained decoding against `json_schema.schema`. |
| `response_format.type: "text"` | Accepted (the default behaviour). |
| `model` | **Ignored** — the running model answers. Any value works. |
| `top_p`, `presence_penalty`, `frequency_penalty`, `stop`, `seed`, `user`, `stream_options`, `n: 1` | **Accepted and ignored.** v1 does not pass sampling extras through to the runtime. If your prompt depends on `stop` or `top_p`, handle it client-side. |
| `tools`, `tool_choice`, `functions` | **400** `unsupported_field` — no tool calling. |
| `audio`, `modalities` | **400** `unsupported_field`. |
| `n` > 1 | **400** `unsupported_field` — one answer per request. |
| `response_format.type: "json_object"` | **400** `unsupported_field` — use `json_schema`. |
| image / audio content parts | **400** `unsupported_field` — the endpoint has no vision surface. |

External requests run at answer depth **balanced, with thinking off**, so a client's first-token
timeout does not sit through a silent reasoning phase. There is no RAG, no document context, and
no chat history — the endpoint sends exactly the messages you passed.

### 6.5 Responses

**Non-streaming** — one `chat.completion` object:

```json
{ "id": "chatcmpl-…", "object": "chat.completion", "created": 1755600000,
  "model": "<model id>",
  "choices": [{ "index": 0,
                "message": { "role": "assistant", "content": "…" },
                "finish_reason": "stop" }] }
```

**Streaming** — `text/event-stream`, in this order: a role-first `chat.completion.chunk`
(`delta: {"role":"assistant"}`), content chunks (`delta: {"content":"…"}`), a final chunk carrying
`finish_reason`, then `data: [DONE]`.

> **`usage` is deliberately absent in v1.** The runtime's streaming reader discards token counts,
> and fabricating numbers would be worse than omitting them. Do not read `usage.total_tokens` — it
> is not there. (A post-v1 candidate.)

> **A truncated stream never ends with `[DONE]`.** If a generation is interrupted you get an
> in-band error frame and the stream closes *without* the terminator. Treat "no `[DONE]`" as "not
> a complete answer" — that distinction is the whole point of omitting it.

### 6.6 Errors

All errors are OpenAI-shaped: `{"error": {"message": …, "type": …, "code": …}}`. Branch on `code`.

| HTTP | `code` | Meaning | What a client should do |
|---|---|---|---|
| 400 | `invalid_body`, `invalid_messages`, `invalid_json`, `invalid_response_format` | Malformed request | Fix the request |
| 400 | `unsupported_field` | A capability this endpoint does not have (named in the message) | Disable that client feature |
| 400 | `context_overflow` | Prompt + answer do not fit the context window | Send less text |
| 401 | `invalid_api_key` | Missing or wrong access key | Re-copy the key from the card |
| 403 | `forbidden_host` | `Host` was absent, or not a loopback name for this port | Use the printed base URL |
| 403 | `forbidden_origin` | A web-page origin (or `Origin: null`) | Browsers are locked out by design |
| 403 | `no_cors` | An `OPTIONS` preflight | Same |
| 404 | `unknown_route` | Only the two routes above exist | — |
| 413 | `body_too_large` | Body exceeded 1 MB (counted as bytes arrive) | Send less |
| 415 | `unsupported_content_type` | POST was not `application/json` | Set the header |
| 429 | `busy` | The model is answering something else | Retry after `Retry-After` |
| 429 | `preempted_by_user` | The user's own chat interrupted this request before any bytes were sent | Retry after `Retry-After` |
| 500 | `internal_error` | An unexpected failure inside the endpoint (for example the workspace locking mid-request) | Retry; if it persists, check Diagnostics |
| 502 | `runtime_unresponsive` | The model runtime did not answer | Check the app — the model may have crashed |
| 503 | `model_not_loaded` | No model is running | A human must start one |
| 503 | `model_starting` | A model is loading | Retry after `Retry-After` |
| 503 | `workspace_locked` | The workspace is locked | Retry once it is unlocked |
| 503 / in-band | `server_stopped` | The endpoint is shutting down (lock or quit) | Reconnect later |

`Retry-After` on `busy` / `model_starting` / `preempted_by_user` is derived from the machine's
**measured** tokens-per-second when one is available for the running model, and is 30 s otherwise;
it is clamped to 5–180 s.

**Mid-stream failures** arrive as an in-band frame with the same body shape (`preempted_by_user`,
`server_stopped`, or `runtime_error`), and the stream then closes **without** `[DONE]`.

### 6.7 Limits and timeouts

| Bound | Value | Why |
|---|---|---|
| Request body | **1 MB**, counted as bytes arrive (`Content-Length` is never trusted) | A chunked body makes a header check meaningless |
| Header phase | 10 s | Slow-loris |
| Body idle | 30 s (body phase only) | A stalled upload should not hold a socket |
| Generation | **no timeout** | A legitimate CPU generation can run for minutes; Node's 300 s default would kill it. Wedge detection is done app-side instead |
| SSE reader stall | 15 s of unrelieved backpressure → the request is aborted and the slot reclaimed | One stalled reader must not wedge the model |
| Concurrent connections | 16 | Cheap flood ceiling |
| Outside requests generating at once | **1** (plus one waiting up to ~30 s) | [§7](#7-sharing-one-model-with-yourself) |

**A client disconnect aborts the generation** in both modes — an abandoned request never burns a
multi-minute answer nobody will read.

## §7 Sharing one model with yourself

There is one model and one machine, so the rules are explicit rather than emergent:

- **One outside request generates at a time.** A second one waits up to about 30 seconds; if the
  first is still going it gets **429 `busy`** with a `Retry-After`. A third is refused immediately
  rather than left hanging — on slow CPU hardware a deeper queue is a silent multi-minute stall,
  not politeness.
- **Your own use always wins.** If you start an in-app chat while an outside request is
  generating, that request is interrupted: it receives `preempted_by_user` (in-band if the stream
  had started, 429 otherwise) and the Settings card tells you it happened. The reverse never
  occurs — an outside caller cannot interrupt you.
- **Background work counts as busy.** Document tasks (summaries, whole-document translation,
  comparisons, extraction), skill runs, and the hardware benchmark hold the model for their whole
  multi-step run; the endpoint waits or answers `busy` honestly instead of slipping into the gap
  between two steps of a background job.
- **Lock and quit stop the endpoint first**, before the model sidecars come down. A stream running
  at that moment ends with `server_stopped`.
- **Switching models** while a caller waits is safe: a promoted waiter re-checks which model is
  running and never generates against a stopped one.

## §8 Security posture

The full threat analysis is in [`security-model.md`](security-model.md) ("The fifth threat:
same-machine processes"). The controls, in the order a request meets them:

| Control | Stops |
|---|---|
| **Off by default, behind a consent dialog** | The door existing before you knowingly open it |
| **Policy ceiling `network.allow_local_api`** (restrict-only) | A managed/commercial drive forbidding it outright; your setting can never override the policy |
| **Exists only while the workspace is unlocked** | Anything being served out of a locked vault |
| **Binds `127.0.0.1` + `::1` only** | Everything off-machine. No LAN mode, no `0.0.0.0`, no forwarding — and no setting that could create one |
| **`Host` validation (absent ⇒ 403)** | DNS rebinding: a page resolving an attacker domain to 127.0.0.1 still fails the check |
| **Origin policy + `OPTIONS` refused + no CORS header ever emitted + JSON required** | Drive-by access from browser JavaScript, structurally |
| **Bearer access key, on by default, constant-time compared** | Casual use by any other program on the machine |
| **Two routes and no others** | Documents, conversations, embeddings, settings, the activity log — there is no route to authorize |
| **Counts-only accounting** | A record of what was asked or answered existing at all |
| **Single-slot admission + user pre-emption** | An outside caller starving your own use |

**Rotating the key.** *Create a new key* re-mints it and **immediately** aborts every outside
request the old key admitted — including one that is mid-stream. Apps holding the old key need the
new one pasted in. Use it whenever a key may have leaked, or simply to cut an app off.

**Turning the key off** is a confirmed choice, not a click: without it, *any* program running as
you can use your model. The Host / Origin / content-type checks stay unconditional in that mode,
so browsers remain locked out either way.

**Honest residuals** (also recorded in [`../SECURITY.md`](../SECURITY.md)):

- A loopback endpoint **cannot tell one local program from another**. The access key is the
  boundary, and any program that can read your unlocked workspace could read the key. That is why
  the feature is off by default and why the key requirement stays on unless you turn it off.
- A debugger running **as you** can read process memory; so can a full-memory crash dump. On
  Windows, leaving crash dumps at the **minidump** default is recommended.
- What a connected app does with an answer is outside HilbertRaum's control — see [§9](#9-privacy).

## §9 Privacy

- **Nothing about a request is recorded.** The prompt and the answer are held in memory for the
  length of the request and then dropped. They are never written to your chat history, your
  documents, or the logs. The app keeps **counts only** — how many requests were answered and how
  many refused — visible on the card and in **Settings → Diagnostics**.
- **Nothing reaches the internet.** The listener is loopback-bound; connecting an app adds no
  outbound traffic of any kind.
- **The switch itself is recorded, minimally.** Turning the feature on or off writes one entry to
  your local activity log with the new state (`{ enabled: true | false }`) and nothing else — the
  same treatment other privacy-relevant settings get. The port number is not recorded.
- **The access key lives in your workspace database**, so it is encrypted at rest exactly like the
  rest of your data and unreadable before you unlock. It never crosses to the app's UI process in
  full — the interface only ever displays `hr-…<last four>`, and copying happens inside the
  privileged process.

**Your responsibility.** Once a connected app has an answer, that answer is in that app's hands.
An editor plugin or note app may store the text in its own files, index it, or sync it to its own
cloud service as part of normal behaviour. That would be **that app** sending your data somewhere,
not HilbertRaum — but the effect on your privacy is identical. Check a program's own logging and
sync behaviour before you point it at confidential material, exactly as you would before pasting
confidential text into it.

See [`../PRIVACY.md`](../PRIVACY.md) for the full statement.

## §10 Settings and policy reference

**Settings → Privacy & data → Local API**

| Setting | Default | Notes |
|---|---|---|
| Allow other apps on this computer to use my AI model | **off** | Consent dialog required; the change is audited (state only) |
| Require an access key | **on** | Turning it off is a confirmed choice |
| Port number | **4980** | Range 1024–65535, clamped. 4980 avoids the ports Ollama (11434) and LM Studio (1234) use |

Changing any of these applies immediately — the listener starts, stops, or re-binds to the new
port without a restart.

**Drive policy** (`config/policy.json`, key `network.allow_local_api`) is a **ceiling**: the
effective state is `policy AND your setting`. A policy can only restrict, never enable.

| Drive kind | `allow_local_api` |
|---|---|
| Commercial / prepared drive (`prepare-drive`) | explicit **`false`** — the card shows "Turned off by your drive's policy" |
| `--dev` prepared drive | `true` |
| Standalone install (a GitHub release, app-data fallback) | `true` — the setting is still off until you turn it on |
| A policy file written **before** the key existed | inherits the permissive default (an absent key means "not yet decided", so drives already in the field are not silently denied). An explicit `false` denies; a junk value or a malformed policy file fails closed |

## §11 Troubleshooting

Symptom-by-symptom fixes — connection refused, port conflicts, firewall/EDR questions, and a
plain-language table of the HTTP status codes — live in
[`troubleshooting.md`](troubleshooting.md). The three that catch almost everyone:

1. **`localhost` instead of `127.0.0.1`** — paste the exact address from the card
   ([§3](#3-turning-it-on)).
2. **Workspace locked, or no model running** — the endpoint is alive only with the former, and
   useful only with the latter ([§2](#2-before-you-start)).
3. **A client with tool calling enabled** — turn it off; it is refused by name
   ([§6.4](#64-request-fields)).

**Windows Firewall does not prompt for this**: it filters traffic crossing the network stack, and
a loopback listener never does. Some endpoint-protection (EDR) products *do* alert on any process
opening a listening socket — that alert is accurate, and if your organization's tooling objects,
the honest answer is to leave the feature off. Nothing else in the app depends on it.

## §12 For maintainers

| Where | What |
|---|---|
| [`architecture.md`](architecture.md) — "Local API endpoint — design record (wave local-api, PR #184, §1–§9)" | The design: framing decisions D1–D9, owner options O1–O6, the generation gate, the HTTP surface, deliberate omissions, what the audits changed, and the verification (incl. the real-model smoke) |
| [`data-contracts.md`](data-contracts.md) | The authoritative wire + IPC + settings + policy contract |
| [`security-model.md`](security-model.md) | "The fifth threat: same-machine processes" — controls and accepted residuals |
| [`user-guide.md`](user-guide.md) | The end-user walkthrough ("Use HilbertRaum from other apps") |
| `apps/desktop/src/main/services/local-api/` | `server.ts` (listener + lifecycle), `handlers.ts` (pipeline checks, parsing, envelopes), `admission.ts` (the single external slot), `token.ts` (access key), `lifecycle.ts` (start seams) |
| `apps/desktop/src/shared/local-api.ts` | The shared derivations: `localApiEffectivelyEnabled`, `localApiServerAddress`, `isStrictLoopbackHostname`, the port clamp, `LOCAL_API_SETTINGS_KEYS` |
| `apps/desktop/tests/**/local-api-*.test.ts` | The pinned behaviour: bind posture, the check matrix in both auth modes, zero CORS headers, streaming and non-streaming paths, error mapping, pre-emption closing without `[DONE]`, the counted-byte body cap, drain-timeout reclaim, lock/quit ordering, rotation aborting live streams, and a no-content sentinel grepped out of every log and status surface |

**Contract stability.** The wire shape above is what external apps code against; treat it as
public API. Additive changes (a new optional field, a new error `code`) are fine; changing an
existing status/code mapping or the streaming frame order is a breaking change and needs a note in
the [`../CHANGELOG.md`](../CHANGELOG.md) section for the release that carries it — which is what
that release's page publishes, so client authors meet it where they look.
