import type { ServerResponse } from 'node:http'

// The `/raw` answers of the ZIM suites' loopback kiwix-serve stand-ins. Since #339 (D-Z22) every
// article request carries `Range: bytes=<n>-`, and libkiwix answers a 200 under it with `206` +
// `Content-Range` + the tail: `rangeStart` reads the header, `sendRawAnswer` answers the way
// libkiwix does (with knobs for the misbehaviours a resume must refuse), and `sendRawStall`
// writes the stall shapes of the #301 P7 T19 fault and the failures it must not be confused with.
// Each suite keeps its own routing and request log; these write one response.

/** The offset of an open `bytes=<n>-` range, or null when the request carried no such header.
 *  The client only ever sends that one form (#339 D-Z22). */
export function rangeStart(header: string | string[] | undefined): number | null {
  if (typeof header !== 'string') return null
  const m = /^bytes=(\d+)-$/.exec(header.trim())
  return m ? Number(m[1]) : null
}

/**
 * A plain answer. Status 200 answers are RANGE-AWARE: a `Range: bytes=<n>-` request is answered
 * `206` + `Content-Range` + the tail, and a range past the end `416`, exactly as libkiwix does.
 * The optional fields express the misbehaviours a resume must refuse.
 */
export interface RawAnswer {
  status: number
  headers?: Record<string, string>
  body: string
  /** Answer `200` with the WHOLE body even under `Range` — a server that ignores the header. */
  ignoreRange?: boolean
  /** Send this `Content-Range` instead of the true one (the mismatching-range leg). */
  contentRange?: string
  /** Send only this many bytes of the tail, honestly framed (the short-tail leg). */
  tailBytes?: number
  /** Answer `416 Range Not Satisfiable` to any `Range` request. */
  unsatisfiable?: boolean
}

/** Answer `answer` to a request whose range starts at `from` (`rangeStart`). No Range, a non-200
 *  status, or `ignoreRange` keeps the plain answer. */
export function sendRawAnswer(res: ServerResponse, answer: RawAnswer, from: number | null): void {
  const buf = Buffer.from(answer.body, 'utf8')
  const headers = { 'content-type': 'text/html', ...answer.headers }
  if (from === null || answer.ignoreRange === true || answer.status !== 200) {
    res.writeHead(answer.status, headers)
    res.end(buf)
    return
  }
  if (answer.unsatisfiable === true || from >= buf.length) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${buf.length}` })
    res.end('range not satisfiable')
    return
  }
  const tail = buf.subarray(from)
  const sent = answer.tailBytes === undefined ? tail : tail.subarray(0, answer.tailBytes)
  res.writeHead(206, {
    ...headers,
    // Honestly framed even when short: the client must catch the short tail on the LENGTH it
    // was promised in `Content-Range`, not on a framing error.
    'content-length': String(sent.length),
    'content-range': answer.contentRange ?? `bytes ${from}-${buf.length - 1}/${buf.length}`
  })
  res.end(sent)
}

/**
 * The stall shapes, and the slow-but-live body that must not be taken for one. The three hanging
 * shapes (`silent`, `headers-only`, `truncated`) end only when the client gives up.
 *   `truncated`    — 200/206 + an honest `Content-Length` + MOST of the body, then the connection
 *                    hangs: the MEASURED kiwix-serve 3.8.1 (win-x86_64) shape (#301 P7 T19).
 *   `silent`       — accepted, and nothing sent at all, not even headers.
 *   `headers-only` — headers and a `Content-Length`, then not one body byte: nothing to resume
 *                    from (#339 D-Z22).
 *   `reset`        — 200 + part of the body, then the SOCKET IS DESTROYED: a real network error,
 *                    not a stall.
 *   `drip`         — `chunks` pieces of `body`, one every `everyMs`: slow but alive. Always the
 *                    whole body (`bytes 0-` under Range); it is only ever a first answer.
 */
export type RawStall =
  | { stall: 'truncated'; partial: string | Buffer; total: number }
  | { stall: 'silent' }
  | { stall: 'headers-only'; total: number }
  | { stall: 'reset'; partial: string }
  | { drip: { body: string; chunks: number; everyMs: number } }

/** Write `stall` to a request whose range starts at `from` (`rangeStart`). */
export function sendRawStall(res: ServerResponse, stall: RawStall, from: number | null): void {
  if ('drip' in stall) {
    const { body, chunks, everyMs } = stall.drip
    const buf = Buffer.from(body, 'utf8')
    res.writeHead(from === null ? 200 : 206, {
      'content-type': 'text/html',
      'content-length': String(buf.length),
      ...(from === null ? {} : { 'content-range': `bytes 0-${buf.length - 1}/${buf.length}` })
    })
    const step = Math.ceil(buf.length / chunks)
    let sent = 0
    const pump = (): void => {
      if (sent >= buf.length) {
        res.end()
        return
      }
      res.write(buf.subarray(sent, sent + step))
      sent += step
      setTimeout(pump, everyMs).unref?.()
    }
    setTimeout(pump, everyMs).unref?.()
    return
  }
  if (stall.stall === 'silent') return // nothing is ever sent
  if (stall.stall === 'reset') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.write(stall.partial, () => res.destroy()) // a real socket error mid-body
    return
  }
  // Framed exactly like a real answer of `total` bytes.
  res.writeHead(from === null ? 200 : 206, {
    'content-type': 'text/html',
    'content-length': String(stall.total),
    ...(from === null ? {} : { 'content-range': `bytes ${from}-${stall.total - 1}/${stall.total}` })
  })
  if (stall.stall === 'headers-only') {
    // Node holds headers back until the first write — flush them, or this would look like
    // `silent` and never arm the client's inter-chunk timer.
    res.flushHeaders()
    return
  }
  res.write(stall.partial) // …and the rest never comes
}
