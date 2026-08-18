import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/services/db'
import { seedSettings, updateSettings } from '../../src/main/services/settings'
import { RuntimeManager } from '../../src/main/services/runtime'
import { __resetPolicyCache } from '../../src/main/services/policy'
import {
  applyLocalApiSettings,
  createLocalApiServer,
  localApiShouldRun,
  maybeStartLocalApi
} from '../../src/main/services/local-api/lifecycle'
import type { AppContext } from '../../src/main/services/context'

// Local-API lifecycle pins (local-api wave P3): DEFAULT OFF means a fresh workspace opens
// ZERO listeners (the outbound-only test gap — the policy suite pins outbound calls, this
// pins the inbound side); the policy ceiling beats the setting; the post-unlock seam
// refuses while locked; a live settings change starts/stops the listener.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()!()
})

function makeCtx(opts?: { unlocked?: boolean; policyJson?: string; isDev?: boolean }): AppContext {
  __resetPolicyCache()
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-lapi-life-'))
  if (opts?.policyJson) writeFileSync(join(dir, 'policy.json'), opts.policyJson)
  const db = openDatabase(join(dir, 'test.sqlite'))
  seedSettings(db)
  const mgr = new RuntimeManager((startOpts) => ({
    modelId: startOpts.modelId,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: '', port: null }),
    chatStream: async function* (): AsyncGenerator<string, void, unknown> {}
  }))
  const unlocked = opts?.unlocked ?? true
  const ctx = {
    db,
    runtime: mgr,
    workspace: {
      isUnlocked: () => unlocked,
      isLocking: () => false
    },
    paths: { configPath: dir },
    isDev: opts?.isDev ?? true,
    docTasks: undefined
  } as unknown as AppContext
  ctx.localApi = createLocalApiServer(ctx, '0.0.0-test')
  cleanups.push(() => ctx.localApi!.stop())
  return ctx
}

async function settle(): Promise<void> {
  // maybeStartLocalApi is fire-and-forget; give its start() a few ticks to bind.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
}

describe('local API lifecycle (P3 wiring)', () => {
  it('DEFAULT OFF: a fresh workspace opens NO listener (no http server is even created)', async () => {
    const created = vi.spyOn(http, 'createServer')
    const ctx = makeCtx()
    expect(localApiShouldRun(ctx)).toBe(false) // localApiEnabled defaults false (D3)
    maybeStartLocalApi(ctx)
    await settle()
    expect(ctx.localApi!.status().running).toBe(false)
    expect(created).not.toHaveBeenCalled()
  })

  it('starts on the post-unlock seam when policy ∧ setting permit', async () => {
    const ctx = makeCtx()
    updateSettings((ctx as { db: Parameters<typeof updateSettings>[0] }).db, { localApiEnabled: true })
    maybeStartLocalApi(ctx)
    await settle()
    expect(ctx.localApi!.status().running).toBe(true)
    expect(ctx.localApi!.status().port).toBeGreaterThan(0)
  })

  it('the policy ceiling beats the setting (allow_local_api: false ⇒ no listener)', async () => {
    const ctx = makeCtx({ policyJson: '{"network":{"allow_local_api":false}}' })
    updateSettings((ctx as { db: Parameters<typeof updateSettings>[0] }).db, { localApiEnabled: true })
    expect(localApiShouldRun(ctx)).toBe(false)
    maybeStartLocalApi(ctx)
    await settle()
    expect(ctx.localApi!.status().running).toBe(false)
  })

  it('refuses to start while the workspace does not admit work (locked/locking)', async () => {
    const ctx = makeCtx({ unlocked: false })
    updateSettings((ctx as { db: Parameters<typeof updateSettings>[0] }).db, { localApiEnabled: true })
    maybeStartLocalApi(ctx)
    await settle()
    expect(ctx.localApi!.status().running).toBe(false)
  })

  it('a live settings change starts and stops the listener (applyLocalApiSettings)', async () => {
    const ctx = makeCtx()
    const db = (ctx as { db: Parameters<typeof updateSettings>[0] }).db
    updateSettings(db, { localApiEnabled: true })
    await applyLocalApiSettings(ctx)
    expect(ctx.localApi!.status().running).toBe(true)
    updateSettings(db, { localApiEnabled: false })
    await applyLocalApiSettings(ctx)
    expect(ctx.localApi!.status().running).toBe(false)
  })
})
