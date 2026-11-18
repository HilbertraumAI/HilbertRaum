// The LocalApiServer harness local-api-server.test.ts and local-api-hardening.test.ts each built (`makeHarness`, plus
// their raw-socket and auth-header helpers): a REAL listener on an ephemeral loopback port (`localApiPort: 0`, never
// the shipped 4980) in front of a REAL RuntimeManager over a fake runtime, every server dependency observable or
// switchable from the test (vault + local API test campaign, 2026-11-16).
import net from 'node:net'
import { onTestFinished } from 'vitest'
import { RuntimeManager, type ModelRuntime, type RuntimeChatOptions } from '../../src/main/services/runtime'
import { LocalApiServer, type LocalApiServerDeps } from '../../src/main/services/local-api/server'
import { hangBudgetMs } from './hang-budget'
import { manualSource, type ManualSource } from './manual-stream'

/** The access key the harness serves (`hr-` + 43 base64url chars, the shipped shape); rows read it as `h.token`. */
const HARNESS_TOKEN = 'hr-' + 'a'.repeat(43)

/**
 * `LocalApiServerDeps` around `mgr` with calm defaults: port 0 (ephemeral) with the key required, the harness key, no
 * doc task, the workspace admits work, a 42 s Retry-After estimate, app version `0.0.0-test`, no `log`. `runtime` is
 * wired to the manager's own predicates, so a never-started manager reports busy (`isExternallyBusy()` is true with
 * no active runtime). `over` is spread last. For the rows that build an unstarted server themselves (a taken port, a
 * slow model start); `localApiHarness` builds on it.
 */
export function localApiDeps(mgr: RuntimeManager, over: Partial<LocalApiServerDeps> = {}): LocalApiServerDeps {
  return {
    getSettings: () => ({ localApiPort: 0, localApiTokenRequired: true }),
    getToken: () => HARNESS_TOKEN,
    runtime: {
      status: () => mgr.status(),
      active: () => mgr.active(),
      isExternallyBusy: () => mgr.isExternallyBusy(),
      setExternalPreemption: (hook) => mgr.setExternalPreemption(hook)
    },
    hasActiveDocTask: () => false,
    admitsWork: () => true,
    estimateBusySeconds: () => 42,
    appVersion: '0.0.0-test',
    ...over
  }
}

export interface LocalApiHarnessOptions {
  /** Start the model `test-model` (4,096-token window) before the server (default true). */
  startModel?: boolean
  /** `localApiTokenRequired` (default true). */
  tokenRequired?: boolean
  /**
   * What the model answers. `'echo'` (default): two tokens, `'echo: '` then the last message's content, then
   * `onFinish('stop')`. `'manual'`: one `ManualSource` per chatStream call, appended to `sources`, the test pushes the
   * tokens. `{ answer }`: that one token, then `onFinish('stop')` (the hardening suite's sentinel answer). Every
   * kind records the chat options (`lastOptions()`) and returns at once on an already-aborted signal.
   */
  runtime?: 'echo' | 'manual' | { answer: string }
  /**
   * `runtime: 'manual'` only (the harness throws on any other kind). How a generation ends when its signal aborts. `false` (default): the stream returns, as
   * the mock runtime of dev mode does. `true`: it rejects with an `AbortError`-named plain Error, as the real
   * `LlamaRuntime` does when the abort lands inside a token read (#860 API3). Both are production shapes, and the server
   * takes a different branch for each, so an abort row should run under both.
   */
  rejectOnAbort?: boolean
  /**
   * More server deps, spread last (the timeout seams, `estimateBusySeconds`, …). Never one the harness observes:
   * `getToken`, `admitsWork`, `hasActiveDocTask`, `getSettings` or `log` would silently replace `tokenCalls()`/
   * `setToken`, `setAdmitsWork`/`admitChecks()`, `setDocTask`, `tokenRequired` or `logged`, so the harness throws on
   * them (use those options instead). With `headersTimeoutMs` set and no `connectionsCheckIntervalMs`, the harness
   * sweeps every 100 ms (Node only checks header deadlines on its sweep, every 30 s by default), as the hardening
   * harness did.
   */
  deps?: Partial<LocalApiServerDeps>
}

export interface LocalApiHarness {
  server: LocalApiServer
  mgr: RuntimeManager
  /** `http://127.0.0.1:<port>` */
  base: string
  port: number
  /** The key the server was started with (`'hr-' + 'a'.repeat(43)`); `setToken` changes what it validates, not this. */
  token: string
  /** `runtime: 'manual'` only: one source per chatStream call, in call order. */
  sources: ManualSource[]
  /** Everything the server wrote to its injected `log`, one `"<msg> <JSON meta>"` line per call (info and warn). */
  logged: string[]
  /** The options of the most recent chatStream call. */
  lastOptions: () => RuntimeChatOptions | undefined
  /** The answer of `hasActiveDocTask()` from now on. */
  setDocTask: (busy: boolean) => void
  /** Rotate the key the server validates against (the regenerate flow). */
  setToken: (token: string) => void
  /** The `localApiPort` the server's `getSettings` reports from now on (0, the default, binds an ephemeral port).
   *  Set it to `port` to reach `applySettings`'s same-port path, or to another free port for a re-port. */
  setSettingsPort: (port: number) => void
  /** The answer of `admitsWork()` from now on (false = the workspace locked / a lock under way). */
  setAdmitsWork: (admits: boolean) => void
  /** How many `admitsWork()` checks ran: each request's `tryAdmit` asks once, synchronously, before it parks. */
  admitChecks: () => number
  /**
   * How many times the server read the access key. With the key required it reads it on every auth check: once per
   * request when the headers are in (any route), and once more after a completion's body arrived. Never with
   * `tokenRequired: false`. An observer, so a row can gate on "the headers were authenticated" instead of sleeping;
   * it supplies no ordering of its own.
   */
  tokenCalls: () => number
  /** Stop the server, then the manager. Registered with `onTestFinished` already. */
  stopAll: () => Promise<void>
}

/**
 * `stream`, except that where it returns because `signal` aborted, it rejects with an `AbortError`-named plain Error,
 * the shape `LlamaRuntime`'s aborted read rejects with (`abortReadError`, runtime/llama.ts). The wake/abort logic
 * stays in `manualSource`; this only changes how an aborted stream ends.
 */
async function* rejectingOnAbort(
  stream: AsyncGenerator<string, void, unknown>,
  signal: AbortSignal | undefined
): AsyncGenerator<string, void, unknown> {
  yield* stream
  if (signal?.aborted) {
    const err = new Error('The stream read was aborted.')
    err.name = 'AbortError'
    throw err
  }
}

/** The deps `localApiHarness` wires to its own observers and switches; `deps` may not carry them. */
const OBSERVED_DEPS = ['getToken', 'admitsWork', 'hasActiveDocTask', 'getSettings', 'log'] as const

/**
 * Start a `LocalApiServer` on an ephemeral port over a real `RuntimeManager` (see the options). The harness stops it
 * when the test finishes (`onTestFinished`, which also runs on failure), so call it inside a test body. It injects a
 * `log` sink (`logged`); console output is not captured: a row that greps the console installs its own spies.
 */
export async function localApiHarness(opts: LocalApiHarnessOptions = {}): Promise<LocalApiHarness> {
  const extra = opts.deps ?? {}
  if (opts.rejectOnAbort && opts.runtime !== 'manual') {
    // Only the manual source has the two shapes; another kind would test the returning one under a rejecting title.
    throw new Error("localApiHarness: rejectOnAbort needs runtime: 'manual'")
  }
  for (const key of OBSERVED_DEPS) {
    if (key in extra) {
      throw new Error(`localApiHarness: deps.${key} would replace the harness's own observer; use its option`)
    }
  }
  const sources: ManualSource[] = []
  const optionsSeen: RuntimeChatOptions[] = []
  const kind = opts.runtime ?? 'echo'
  const mgr = new RuntimeManager(
    (startOpts): ModelRuntime => ({
      modelId: startOpts.modelId,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: '', port: null }),
      contextWindow: () => startOpts.contextTokens,
      chatStream(messages, options?: RuntimeChatOptions) {
        if (options) optionsSeen.push(options)
        if (kind === 'manual') {
          const src = manualSource()
          sources.push(src)
          return opts.rejectOnAbort ? rejectingOnAbort(src.stream(options?.signal), options?.signal) : src.stream(options?.signal)
        }
        const tokens = kind === 'echo' ? ['echo: ', messages[messages.length - 1]?.content ?? ''] : [kind.answer]
        return (async function* (): AsyncGenerator<string, void, unknown> {
          if (options?.signal?.aborted) return
          for (const token of tokens) yield token
          options?.onFinish?.('stop')
        })()
      }
    })
  )
  if (opts.startModel !== false) {
    await mgr.start({ modelId: 'test-model', modelPath: '/m.gguf', contextTokens: 4096 })
  }
  let docTask = false
  let admits = true
  let admitChecks = 0
  let tokenCalls = 0
  let liveToken = HARNESS_TOKEN
  let settingsPort = 0
  const logged: string[] = []
  const record = (msg: string, meta?: unknown): void => {
    logged.push(`${msg} ${JSON.stringify(meta ?? null)}`)
  }
  const server = new LocalApiServer(
    localApiDeps(mgr, {
      getSettings: () => ({ localApiPort: settingsPort, localApiTokenRequired: opts.tokenRequired ?? true }),
      getToken: () => {
        tokenCalls++
        return liveToken
      },
      hasActiveDocTask: () => docTask,
      admitsWork: () => {
        admitChecks++
        return admits
      },
      log: { info: record, warn: record },
      ...(extra.headersTimeoutMs != null && extra.connectionsCheckIntervalMs === undefined
        ? { connectionsCheckIntervalMs: 100 }
        : {}),
      ...extra
    })
  )
  const stopAll = async (): Promise<void> => {
    await server.stop()
    await mgr.stop()
  }
  onTestFinished(stopAll)
  await server.start()
  const port = server.status().port!
  return {
    server,
    mgr,
    base: `http://127.0.0.1:${port}`,
    port,
    token: HARNESS_TOKEN,
    sources,
    logged,
    lastOptions: () => optionsSeen[optionsSeen.length - 1],
    setDocTask: (busy) => (docTask = busy),
    setToken: (token) => (liveToken = token),
    setSettingsPort: (p) => (settingsPort = p),
    setAdmitsWork: (value) => (admits = value),
    admitChecks: () => admitChecks,
    tokenCalls: () => tokenCalls,
    stopAll
  }
}

/** JSON request headers carrying `token` as the bearer key; `extra` is merged last. */
export function authed(token: string, extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }
}

/**
 * Write `request` verbatim to `127.0.0.1:<port>` and resolve with every byte the server sent, once the socket closes
 * or errors (an RST is a valid end) or after `hangBudgetMs(holdMs)` (default 3 s). Never rejects. For what `fetch`
 * cannot express: an absent or foreign Host, a smuggling attempt, a malformed header block. The deadline is a hang
 * bound, not a proof the server hung up: a row about the server closing the socket watches the close itself.
 */
export function rawHttp(port: number, request: string, holdMs = 3_000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request))
    socket.on('data', (c: Buffer) => chunks.push(c))
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      socket.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    socket.on('close', done)
    socket.on('error', done)
    timer = setTimeout(done, hangBudgetMs(holdMs))
    timer.unref?.()
  })
}

/** Bind `host:port` (0 = ephemeral) and release it again: the port it got, or the bind's error code. */
async function probeBind(host: string, port: number): Promise<number | string> {
  const probe = net.createServer()
  const bound = await new Promise<number | string>((resolve) => {
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? String(err)))
    probe.listen(port, host, () => resolve((probe.address() as net.AddressInfo).port))
  })
  if (typeof bound === 'number') await new Promise<void>((resolve) => probe.close(() => resolve()))
  return bound
}

/**
 * A port nothing listens on right now on EITHER loopback the server binds: 127.0.0.1 from the OS's ephemeral
 * allocator, then the same port on ::1, where a taken port is fatal to the server's start (PortInUseError) exactly as
 * on v4. Any other ::1 bind error (a host without IPv6 loopback) is the one the server degrades to v4-only on, so the
 * port is good.
 */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await probeBind('127.0.0.1', 0)
    if (typeof port !== 'number') throw new Error(`no free 127.0.0.1 port: ${port}`)
    const v6 = await probeBind('::1', port)
    if (v6 !== 'EADDRINUSE') return port
  }
  throw new Error('no port free on both 127.0.0.1 and ::1 in 20 tries')
}
