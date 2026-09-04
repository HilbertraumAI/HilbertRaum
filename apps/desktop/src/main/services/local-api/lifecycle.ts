import { loadPolicy } from '../policy'
import { workspaceAdmitsWork } from '../workspace-vault'
import { localApiEffectivelyEnabled } from '../../../shared/local-api'
import { log } from '../logging'
import { prepareCached } from '../db'
import { DEFAULT_SETTINGS } from '../../../shared/types'
import type { AppContext } from '../context'
import { getOrCreateToken } from './token'
import { LocalApiServer, PortInUseError } from './server'

// Local-API lifecycle wiring (local-api wave P3). The server exists only while the
// workspace is unlocked (D7 — settings + token live in the workspace DB) AND
// policy ∧ setting permit it (D3). Three post-unlock seams start it (plaintext startup,
// unlock, create); `runLockTeardown` / `performShutdown` stop it; a live settings change
// rides `applyLocalApiSettings` (the `applyUiLanguageSetting` seam precedent).

/** Read ONE settings row without the full-table scan+parse `getSettings` pays (this runs
 *  per request / per status poll / per rejection — review 2026-08-18). */
function readSettingRow<T>(ctx: AppContext, key: string, fallback: T): T {
  try {
    const row = prepareCached(ctx.db, 'SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined
    if (!row) return fallback
    return JSON.parse(row.value_json) as T
  } catch {
    return fallback
  }
}

/** Construct the server bound to the app context (initBackend, beside vision). */
export function createLocalApiServer(ctx: AppContext, appVersion: string): LocalApiServer {
  return new LocalApiServer({
    getSettings: () => ({
      localApiPort: readSettingRow(ctx, 'localApiPort', DEFAULT_SETTINGS.localApiPort),
      localApiTokenRequired: readSettingRow(
        ctx,
        'localApiTokenRequired',
        DEFAULT_SETTINGS.localApiTokenRequired
      )
    }),
    getToken: () => getOrCreateToken(ctx.db),
    runtime: {
      status: () => ctx.runtime.status(),
      active: () => ctx.runtime.active(),
      isExternallyBusy: () => ctx.runtime.isExternallyBusy(),
      setExternalPreemption: (hook) => ctx.runtime.setExternalPreemption(hook)
    },
    hasActiveDocTask: () => ctx.docTasks?.hasActiveTask() ?? false,
    admitsWork: () => workspaceAdmitsWork(ctx.workspace),
    estimateBusySeconds: () => estimateBusySeconds(ctx),
    appVersion,
    // `log` structurally satisfies the deps shape — no adapter layer.
    log
  })
}

/** Retry-After heuristic from the persisted measured throughput. #52 rule: a measured
 *  rate applies only when it was measured ON the currently active model
 *  (`measuredModelId` — the registerModelIpc `speedSignal` guard); anything else → 30 s.
 *  Basis (#291): the persisted figure is now the runtime's decode-only tokens/sec when the
 *  runtime sent `timings` (higher than the old prefill-inclusive chunk rate), so this estimate
 *  reads a little shorter for the same machine — an advisory hint, deliberately not retuned. */
function estimateBusySeconds(ctx: AppContext): number {
  const bench = readSettingRow<{ tokensPerSecond?: number | null; measuredModelId?: string | null } | null>(
    ctx,
    'lastBenchmark',
    null
  )
  const tps = bench?.tokensPerSecond
  const measuredOn = bench?.measuredModelId ?? null
  if (
    typeof tps === 'number' &&
    Number.isFinite(tps) &&
    tps > 0 &&
    measuredOn != null &&
    measuredOn === ctx.runtime.activeModelId()
  ) {
    return Math.min(180, Math.max(5, Math.round(768 / tps)))
  }
  return 30
}

/** Policy ∧ setting (spec §3.6 precedence): may the endpoint run right now? */
export function localApiShouldRun(ctx: AppContext): boolean {
  const { policy } = loadPolicy(ctx.paths.configPath, (m) => log.warn(m), { isDev: ctx.isDev })
  return localApiEffectivelyEnabled(
    policy,
    readSettingRow(ctx, 'localApiEnabled', DEFAULT_SETTINGS.localApiEnabled)
  )
}

/**
 * Post-unlock start seam (fire-and-forget, the maybeAutoStartActiveModel shape). ONE
 * gate, one code path with the settings:update seam: both delegate to
 * `applyLocalApiSettings` (idempotent, serialized inside the server), so the seams can
 * never disagree about whether the listener should exist. A bind failure surfaces in
 * `status().lastError` + the log — never a crash, never a DB read from the catch (the
 * workspace may have locked since; PortInUseError carries its port).
 */
export function maybeStartLocalApi(ctx: AppContext): void {
  void applyLocalApiSettings(ctx).catch((err) => {
    if (err instanceof PortInUseError) {
      log.warn('Local API not started: port in use', { port: err.port })
    } else {
      log.warn('Local API failed to start', { error: String(err) })
    }
  })
}

/** Live settings change (`settings:update` with a localApi* key): start/stop/re-port.
 *  Rejections surface to the caller; the run/no-run VERDICT also lands in
 *  `status().lastError` for the P4 card. */
export async function applyLocalApiSettings(ctx: AppContext): Promise<void> {
  if (!ctx.localApi) return
  const shouldRun = workspaceAdmitsWork(ctx.workspace) && localApiShouldRun(ctx)
  await ctx.localApi.applySettings({ shouldRun })
}
