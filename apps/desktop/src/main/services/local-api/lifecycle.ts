import { getSettings } from '../settings'
import { loadPolicy } from '../policy'
import { workspaceAdmitsWork } from '../workspace-vault'
import { localApiEffectivelyEnabled } from '../../../shared/local-api'
import { log } from '../logging'
import type { AppContext } from '../context'
import { getOrCreateToken } from './token'
import { LocalApiServer, PortInUseError } from './server'

// Local-API lifecycle wiring (local-api wave P3). The server exists only while the
// workspace is unlocked (D7 — settings + token live in the workspace DB) AND
// policy ∧ setting permit it (D3). Three post-unlock seams start it (plaintext startup,
// unlock, create); `runLockTeardown` / `performShutdown` stop it; a live settings change
// rides `applyLocalApiSettings` (the `applyUiLanguageSetting` seam precedent).

/** Construct the server bound to the app context (initBackend, beside vision). */
export function createLocalApiServer(ctx: AppContext, appVersion: string): LocalApiServer {
  return new LocalApiServer({
    getSettings: () => {
      const s = getSettings(ctx.db)
      return { localApiPort: s.localApiPort, localApiTokenRequired: s.localApiTokenRequired }
    },
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
    log: { info: (m, meta) => log.info(m, meta), warn: (m, meta) => log.warn(m, meta) }
  })
}

/** Retry-After heuristic from the persisted measured throughput (registerModelIpc's
 *  `speedSignal` read pattern): a typical remaining generation at the measured rate,
 *  clamped sane. Unknown rate → 30 s. */
function estimateBusySeconds(ctx: AppContext): number {
  try {
    const bench = getSettings(ctx.db).lastBenchmark
    const tps = bench?.tokensPerSecond
    if (typeof tps === 'number' && Number.isFinite(tps) && tps > 0) {
      return Math.min(180, Math.max(5, Math.round(768 / tps)))
    }
  } catch {
    /* settings unreadable (locking) — the default is fine */
  }
  return 30
}

/** Policy ∧ setting (spec §3.6 precedence): may the endpoint run right now? */
export function localApiShouldRun(ctx: AppContext): boolean {
  const { policy } = loadPolicy(ctx.paths.configPath, (m) => log.warn(m), { isDev: ctx.isDev })
  return localApiEffectivelyEnabled(policy, getSettings(ctx.db).localApiEnabled)
}

/**
 * Post-unlock start seam (fire-and-forget, the maybeAutoStartActiveModel shape): starts
 * the listener only when policy ∧ setting permit. A bind failure surfaces in the status
 * (not running) + the log — never a crash (the P4 card shows the PortInUseError copy).
 */
export function maybeStartLocalApi(ctx: AppContext): void {
  if (!ctx.localApi) return
  if (!workspaceAdmitsWork(ctx.workspace)) return
  if (!localApiShouldRun(ctx)) return
  void ctx.localApi.start().catch((err) => {
    if (err instanceof PortInUseError) {
      log.warn('Local API not started: port in use', { port: getSettings(ctx.db).localApiPort })
    } else {
      log.warn('Local API failed to start', { error: String(err) })
    }
  })
}

/** Live settings change (`settings:update` with a localApi* key): start/stop/re-port.
 *  Rejections are surfaced to the caller (the Settings card owns the error copy). */
export async function applyLocalApiSettings(ctx: AppContext): Promise<void> {
  if (!ctx.localApi) return
  const shouldRun = workspaceAdmitsWork(ctx.workspace) && localApiShouldRun(ctx)
  await ctx.localApi.applySettings({ shouldRun })
}
