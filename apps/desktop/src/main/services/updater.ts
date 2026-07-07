// Bridge to the loader launcher's localhost control API for self-updates.
//
// The launcher (loader/launcher/src/serve.rs) binds a loopback control server and exports its
// URL as HILBERTRAUM_CONTROL_URL before spawning Electron. The endpoints we use:
//   GET  /api/update         → UpdateStatus (JSON)
//   POST /api/update/check   → kicks off check + predownload (returns "checking")
//   POST /api/update/apply   → requests apply; the launcher kills Electron and applies on teardown
//
// When that env var is ABSENT — `npm run dev`, or any run not started by the launcher — there is
// no control server. Rather than dead buttons, we drive an in-memory MOCK through the same states
// so the Updates UI is fully exercisable; `mock: true` tells the renderer to show a warning.

import { log } from './logging'
import type { UpdateState, UpdateStatus, UpdaterStatus } from '../../shared/types'

export interface UpdaterClient {
  getStatus(): Promise<UpdaterStatus>
  check(): Promise<void>
  apply(): Promise<void>
}

const idle = (): UpdateStatus => ({
  state: 'idle',
  done: 0,
  total: 0,
  done_bytes: 0,
  total_bytes: 0,
  rate_bps: 0,
  version: '',
  commit: '',
  message: null
})

// ---- real client: proxy to the launcher control API ----------------------------------------

function realClient(baseUrl: string): UpdaterClient {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    async getStatus(): Promise<UpdaterStatus> {
      try {
        const res = await fetch(`${base}/api/update`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const status = (await res.json()) as UpdateStatus
        return { available: true, mock: false, status }
      } catch (e) {
        // The control server should always be up under the launcher; if the fetch fails, report
        // a failed status rather than throwing so the screen stays usable.
        log.warn(`updater: status fetch failed: ${String(e)}`)
        return {
          available: true,
          mock: false,
          status: { ...idle(), state: 'failed', message: 'Update service unreachable' }
        }
      }
    },
    async check(): Promise<void> {
      await fetch(`${base}/api/update/check`, { method: 'POST' })
    },
    async apply(): Promise<void> {
      // The launcher terminates Electron in response, so this call may not return cleanly.
      await fetch(`${base}/api/update/apply`, { method: 'POST' }).catch(() => {})
    }
  }
}

// ---- mock client: an in-memory state machine for dev ----------------------------------------

function mockClient(): UpdaterClient {
  let status: UpdateStatus = idle()
  let timer: ReturnType<typeof setInterval> | null = null

  const MOCK_VERSION = '9.9.9-mock'
  const MOCK_COMMIT = 'mock0c0'
  const FILES = 12
  const BYTES = 120 * 1024 * 1024 // 120 MB
  const RATE = 24 * 1024 * 1024 // ~24 MB/s → download completes in ~5 s

  const clear = (): void => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  // Advance a Downloading/Applying run by one 500 ms tick; flip to the terminal state at the end.
  const runProgress = (finalState: UpdateState, onDone: () => void): void => {
    clear()
    const step = RATE / 2 // bytes per 500 ms tick
    timer = setInterval(() => {
      const done_bytes = Math.min(BYTES, status.done_bytes + step)
      const frac = done_bytes / BYTES
      status = {
        ...status,
        done_bytes,
        total_bytes: BYTES,
        done: Math.min(FILES, Math.round(frac * FILES)),
        total: FILES,
        rate_bps: RATE
      }
      if (done_bytes >= BYTES) {
        clear()
        status = { ...status, done: FILES, done_bytes: BYTES, rate_bps: 0, state: finalState }
        onDone()
      }
    }, 500)
  }

  return {
    async getStatus(): Promise<UpdaterStatus> {
      return { available: true, mock: true, status }
    },
    async check(): Promise<void> {
      if (status.state === 'checking' || status.state === 'downloading') return
      clear()
      status = { ...idle(), state: 'checking', version: MOCK_VERSION, commit: MOCK_COMMIT }
      // A short "contacting server" beat, then a simulated download ending in a staged update.
      setTimeout(() => {
        status = { ...status, state: 'downloading', total: FILES, total_bytes: BYTES }
        runProgress('ready', () => {
          status = { ...status, message: `Update ${MOCK_VERSION} ready to install (mock)` }
        })
      }, 800)
    },
    async apply(): Promise<void> {
      if (status.state !== 'ready') return
      status = { ...status, state: 'applying', done: 0, done_bytes: 0 }
      runProgress('idle', () => {
        // A real apply relaunches into the new version; the mock just reports up to date.
        status = {
          ...idle(),
          version: MOCK_VERSION,
          commit: MOCK_COMMIT,
          message: `Updated to ${MOCK_VERSION} (mock)`
        }
      })
    }
  }
}

let client: UpdaterClient | null = null

/** The process-wide updater client — real when the launcher is present, mock otherwise. */
export function getUpdaterClient(): UpdaterClient {
  if (client) return client
  const url = process.env.HILBERTRAUM_CONTROL_URL
  if (url && url.trim()) {
    log.info(`updater: using launcher control API at ${url}`)
    client = realClient(url)
  } else {
    log.info('updater: HILBERTRAUM_CONTROL_URL unset — using in-memory mock updater')
    client = mockClient()
  }
  return client
}
