import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Local-only rotating logger (spec §7.11 — diagnostics logs stay on device, never uploaded).

type Level = 'info' | 'warn' | 'error'

const MAX_BYTES = 1_000_000 // rotate at ~1 MB

let logDir: string | null = null
let logFile: string | null = null

export function initLogging(directory: string): void {
  mkdirSync(directory, { recursive: true })
  logDir = directory
  logFile = join(directory, 'app.log')
}

function rotateIfNeeded(): void {
  if (!logFile || !logDir) return
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_BYTES) {
      renameSync(logFile, join(logDir, 'app.1.log'))
    }
  } catch {
    /* rotation is best-effort */
  }
}

function write(level: Level, message: string, meta?: unknown): void {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${
    meta !== undefined ? ' ' + safeJson(meta) : ''
  }\n`
  // Always echo to the console for dev visibility.
  if (level === 'error') console.error(line.trimEnd())
  else if (level === 'warn') console.warn(line.trimEnd())
  else console.log(line.trimEnd())

  if (!logFile) return
  rotateIfNeeded()
  try {
    appendFileSync(logFile, line)
  } catch {
    /* never crash the app because logging failed */
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const log = {
  info: (m: string, meta?: unknown) => write('info', m, meta),
  warn: (m: string, meta?: unknown) => write('warn', m, meta),
  error: (m: string, meta?: unknown) => write('error', m, meta)
}
