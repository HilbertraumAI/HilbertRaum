import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings, updateSettings } from '../../src/main/services/settings'
import { RuntimeManager } from '../../src/main/services/runtime'
import {
  applyLocalApiSettings,
  createLocalApiServer,
  maybeStartLocalApi
} from '../../src/main/services/local-api/lifecycle'
import type { AppContext } from '../../src/main/services/context'
import { tempRoot } from '../helpers/db-fixtures'
import { freePort } from '../helpers/local-api-harness'

// Local-API lifecycle pins (local-api wave P3): DEFAULT OFF means a fresh workspace opens
// ZERO listeners (the outbound-only test gap — the policy suite pins outbound calls, this
// pins the inbound side); the policy ceiling beats the setting; the post-unlock seam
// refuses while locked or locking; a live settings change starts/stops the listener. A row
// that starts the listener first moves the workspace to a free port: the seeded default is
// the shipped 4980, which a running HilbertRaum (or anything else) on this machine may hold.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()!()
})

function makeCtx(opts?: { unlocked?: boolean; locking?: boolean; policyJson?: string; isDev?: boolean }): AppContext {
  const dir = tempRoot('lapi-life')
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
  const locking = opts?.locking ?? false
  const ctx = {
    db,
    runtime: mgr,
    workspace: {
      isUnlocked: () => unlocked,
      isLocking: () => locking
    },
    paths: { configPath: dir },
    isDev: opts?.isDev ?? true,
    docTasks: undefined
  } as unknown as AppContext
  ctx.localApi = createLocalApiServer(ctx, '0.0.0-test')
  cleanups.push(() => ctx.localApi!.stop())
  return ctx
}

const dbOf = (ctx: AppContext): Db => (ctx as { db: Db }).db

/**
 * Run the fire-and-forget post-unlock seam and wait for the decision it handed the server to SETTLE, so a
 * "no listener" negative looks past it instead of past a guessed number of ticks. Returns that decision.
 */
async function startSeam(ctx: AppContext): Promise<{ shouldRun: boolean }> {
  const apply = vi.spyOn(ctx.localApi!, 'applySettings')
  maybeStartLocalApi(ctx)
  // The seam reaches the server synchronously (applyLocalApiSettings awaits nothing before it).
  expect(apply).toHaveBeenCalledTimes(1)
  await apply.mock.results[0].value
  return apply.mock.calls[0][0]
}

describe('local API lifecycle (P3 wiring)', () => {
  it('DEFAULT OFF: a fresh workspace opens NO listener (no http server is even created)', async () => {
    const created = vi.spyOn(http, 'createServer')
    const ctx = makeCtx()
    expect(await startSeam(ctx)).toEqual({ shouldRun: false }) // localApiEnabled defaults false (D3)
    expect(ctx.localApi!.status().running).toBe(false)
    expect(created).not.toHaveBeenCalled()
  })

  it('starts on the post-unlock seam when policy ∧ setting permit', async () => {
    const ctx = makeCtx()
    const port = await freePort()
    updateSettings(dbOf(ctx), { localApiEnabled: true, localApiPort: port })
    expect(await startSeam(ctx)).toEqual({ shouldRun: true })
    expect(ctx.localApi!.status().running).toBe(true)
    // The port the workspace's settings row names: the server reads the DB, not a default.
    expect(ctx.localApi!.status().port).toBe(port)
  })

  it('the policy ceiling beats the setting (allow_local_api: false ⇒ no listener)', async () => {
    const ctx = makeCtx({ policyJson: '{"network":{"allow_local_api":false}}' })
    updateSettings(dbOf(ctx), { localApiEnabled: true })
    expect(await startSeam(ctx)).toEqual({ shouldRun: false })
    expect(ctx.localApi!.status().running).toBe(false)
  })

  // AUD-02: the seam reads workspaceAdmitsWork (unlocked ∧ not locking), never a bare isUnlocked().
  it.each([
    ['locked', { unlocked: false }],
    ['a lock under way', { unlocked: true, locking: true }]
  ] as const)('refuses to start while the workspace does not admit work (%s)', async (_label, state) => {
    const ctx = makeCtx(state)
    updateSettings(dbOf(ctx), { localApiEnabled: true })
    expect(await startSeam(ctx)).toEqual({ shouldRun: false })
    expect(ctx.localApi!.status().running).toBe(false)
  })

  it('a live settings change starts and stops the listener (applyLocalApiSettings)', async () => {
    const ctx = makeCtx()
    const db = dbOf(ctx)
    updateSettings(db, { localApiEnabled: true, localApiPort: await freePort() })
    await applyLocalApiSettings(ctx)
    expect(ctx.localApi!.status().running).toBe(true)
    updateSettings(db, { localApiEnabled: false })
    await applyLocalApiSettings(ctx)
    expect(ctx.localApi!.status().running).toBe(false)
  })
})
