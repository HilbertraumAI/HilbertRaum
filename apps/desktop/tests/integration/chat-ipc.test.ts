import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// IPC-layer tests for registerChatIpc — the handler glue that the service-level chat
// tests don't reach: the in-flight concurrency guard (H3), the abort→done streaming
// mapping (C1), the regenerate-with-nothing guard, and the no-runtime/empty-message
// errors. Only the Electron IPC transport is faked (see tests/helpers/ipc.ts); the real
// chat service + a real temp DB run underneath.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
// T-8: the export handlers (exportConversation / exportMessageTable) reach `saveTextExport`, which
// calls `BrowserWindow.getFocusedWindow()` + `dialog.showSaveDialog`. Fake both so we can assert
// the sanitized default path and drive cancel/write outcomes. `getFocusedWindow → null` routes
// saveTextExport down the single-arg `showSaveDialog(options)` branch.
type SaveDialogOptions = { title?: string; defaultPath?: string; filters?: unknown }
const dialogState = vi.hoisted(() => ({
  saveResult: { canceled: true } as { canceled: boolean; filePath?: string },
  lastSaveOptions: undefined as SaveDialogOptions | undefined
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showSaveDialog: async (...args: unknown[]) => {
      dialogState.lastSaveOptions = (args.length > 1 ? args[1] : args[0]) as SaveDialogOptions
      return dialogState.saveResult
    }
  }
}))

import { registerChatIpc } from '../../src/main/ipc/registerChatIpc'
import { registerBenchmarkIpc } from '../../src/main/ipc/registerBenchmarkIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { IPC, STREAM } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createConversation, listConversations, listMessages, appendMessage } from '../../src/main/services/chat'
import { linkConversationDocument } from '../../src/main/services/collections'
import { saveResultTable } from '../../src/main/services/tables/store'
import type { TableSpec } from '../../src/main/services/tables'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { ModelRuntime, RuntimeChatOptions, ChatMessage } from '../../src/main/services/runtime'
import type { AppContext } from '../../src/main/services/context'
import { invoke, invokeWithEvent, makeEvent, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** A runtime whose chatStream parks on a released-by-the-test promise, so a stream can be
 *  held open while a second request races it. */
function gatedRuntime(): { runtime: ModelRuntime; release: () => void; started: Promise<void> } {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let signalStarted!: () => void
  const started = new Promise<void>((r) => (signalStarted = r))
  const runtime: ModelRuntime = {
    modelId: 'gated',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: 1 }),
    async *chatStream(_m: ChatMessage[], opts?: RuntimeChatOptions) {
      yield 'first '
      signalStarted()
      await gate
      if (opts?.signal?.aborted) return
      yield 'second'
    }
  }
  return { runtime, release, started }
}

/** A runtime whose generation fails with a NON-abort error before any token — models the most
 *  reachable regenerate failure: an `exceed_context_size_error` HTTP 400 because regenerate
 *  replays the full history near the window. */
function throwingRuntime(): ModelRuntime {
  return {
    modelId: 'throwing',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: 1 }),
    // eslint-disable-next-line require-yield
    async *chatStream(): AsyncGenerator<string> {
      throw new Error('Chat request failed: HTTP 400 exceed_context_size_error')
    }
  }
}

function makeCtx(db: Db, runtime: ModelRuntime | null, unlocked = true): AppContext {
  return {
    db,
    workspace: { isUnlocked: () => unlocked },
    runtime: { active: () => runtime, activeModelId: () => runtime?.modelId ?? null }
  } as unknown as AppContext
}

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-chatipc-')), 'test.sqlite'))
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
  dialogState.saveResult = { canceled: true }
  dialogState.lastSaveOptions = undefined
})

describe('registerChatIpc', () => {
  it('throws a clear error when no model runtime is active', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, null))
    await expect(invoke(handlers, IPC.sendChatMessage, conv.id, 'hi')).rejects.toThrow(/No AI model is running/)
  })

  it('surfaces the friendly localized lock message on a locked-vault chat call, not the raw engine string (API-1)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    const { runtime } = gatedRuntime()
    // A locked workspace: every DB-touching handler must refuse with the friendly localized
    // copy BEFORE it reaches `ctx.db` (which would otherwise throw the raw English
    // "Workspace is locked — unlock it first." from the vault getter).
    registerChatIpc(makeCtx(db, runtime, /* unlocked */ false))

    // A representative DB-touching handler from each shape: list, send (the stream path), delete.
    await expect(invoke(handlers, IPC.listConversations)).rejects.toThrow(
      'Workspace is locked. Unlock it to chat.'
    )
    await expect(invoke(handlers, IPC.sendChatMessage, conv.id, 'hi')).rejects.toThrow(
      'Workspace is locked. Unlock it to chat.'
    )
    await expect(invoke(handlers, IPC.deleteConversation, conv.id)).rejects.toThrow(
      'Workspace is locked. Unlock it to chat.'
    )
    // None of these reached the raw engine string the vault getter throws.
    await expect(invoke(handlers, IPC.listConversations)).rejects.not.toThrow(/unlock it first/i)
  })

  it('rejects an empty message and an unknown conversation', async () => {
    const db = freshDb()
    const { runtime } = gatedRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))
    await expect(invoke(handlers, IPC.sendChatMessage, conv.id, '   ')).rejects.toThrow(/empty message/)
    await expect(invoke(handlers, IPC.sendChatMessage, 'nope', 'hi')).rejects.toThrow(/Unknown conversation/)
  })

  it('streams tokens over the per-conversation channel and resolves with the persisted reply', async () => {
    const db = freshDb()
    const { runtime, release } = gatedRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    const event = makeEvent()
    const p = invokeWithEvent(handlers, IPC.sendChatMessage, event, conv.id, 'hi') as Promise<unknown>
    release()
    const msg = (await p) as { role: string; content: string }

    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe('first second')
    // A token channel carried the deltas and a done channel carried the final message.
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.token(conv.id), 'first ')
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.done(conv.id), expect.objectContaining({ role: 'assistant' }))
    // The user turn + the assistant reply are persisted; nothing left in the in-flight map.
    expect(listMessages(db, conv.id).map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(inFlightStreams.has(conv.id)).toBe(false)
  })

  // ---- Phase C: chat attachments (plan C3/§16) -------------------------------------
  it('listAttachments returns a conversation\'s linked temporary docs (and [] for none)', async () => {
    const db = freshDb()
    const conv = createConversation(db, { mode: 'documents' })
    // A bare indexed document row, linked to the conversation as a temporary attachment.
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
    ).run('att-1', 'invoice.pdf', now, now)
    linkConversationDocument(db, conv.id, 'att-1')

    const ctx = {
      db,
      workspace: { isUnlocked: () => true },
      embedder: createMockEmbedder(),
      runtime: { active: () => null, activeModelId: () => null }
    } as unknown as AppContext
    registerChatIpc(ctx)

    const { result } = await invoke(handlers, IPC.listAttachments, conv.id)
    expect((result as Array<{ id: string; title: string }>).map((d) => d.id)).toEqual(['att-1'])
    // A conversation with no attachments resolves to an empty list.
    const other = createConversation(db, { mode: 'documents' })
    const { result: none } = await invoke(handlers, IPC.listAttachments, other.id)
    expect(none).toEqual([])
  })

  it('rejects a second concurrent stream on the same conversation without clobbering the first (H3)', async () => {
    const db = freshDb()
    const { runtime, release, started } = gatedRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    // First stream is parked mid-generation (its controller is in the in-flight map).
    const first = invoke(handlers, IPC.sendChatMessage, conv.id, 'one')
    await started
    expect(inFlightStreams.has(conv.id)).toBe(true)
    const firstController = inFlightStreams.get(conv.id)

    // A second concurrent send for the same conversation is refused…
    await expect(invoke(handlers, IPC.sendChatMessage, conv.id, 'two')).rejects.toThrow(/already being generated/)
    // …and it did NOT overwrite the first stream's canceller.
    expect(inFlightStreams.get(conv.id)).toBe(firstController)

    release()
    await first
    // Only ONE assistant reply exists; the transcript is not corrupted by interleaving.
    expect(listMessages(db, conv.id).filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(inFlightStreams.has(conv.id)).toBe(false)
  })

  it('stopGeneration aborts the stream and the invoke resolves via done, not error (C1)', async () => {
    const db = freshDb()
    const { runtime, release, started } = gatedRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    const event = makeEvent()
    const p = invokeWithEvent(handlers, IPC.sendChatMessage, event, conv.id, 'hi') as Promise<unknown>
    await started
    invokeWithEvent(handlers, IPC.stopGeneration, makeEvent(), conv.id)
    release()
    const msg = (await p) as { content: string }

    // Aborted after the first token → partial persisted, resolves normally.
    expect(msg.content).toBe('first ')
    const channels = event.sender.send.mock.calls.map((c) => String(c[0]))
    expect(channels).toContain(STREAM.done(conv.id))
    expect(channels).not.toContain(STREAM.error(conv.id))
  })

  it('refuses to regenerate when there is no prior assistant message', async () => {
    const db = freshDb()
    const { runtime } = gatedRuntime()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
    registerChatIpc(makeCtx(db, runtime))
    await expect(
      invoke(handlers, IPC.sendChatMessage, conv.id, '', { regenerate: true })
    ).rejects.toThrow(/Nothing to regenerate/)
  })

  // F2 (post-merge audit): the regenerate DELETE used to COMMIT before the stream slot was
  // claimed, so a non-abort failure (a context-exceeded 400, a dead sidecar, a rejected slot)
  // destroyed the prior answer with nothing in its place. The destructive delete is now deferred
  // into the stream's runFn (slot held) and the prior reply is RESTORED on a non-abort failure.
  it('regenerate whose generation fails restores the prior assistant reply — no answer-less turn (F2)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
    const prior = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'the original answer' })
    registerChatIpc(makeCtx(db, throwingRuntime()))

    // The failing regenerate rejects (the renderer surfaces a toast)…
    await expect(
      invoke(handlers, IPC.sendChatMessage, conv.id, '', { regenerate: true })
    ).rejects.toThrow(/HTTP 400|too large/i)

    // …but the prior answer is NOT destroyed: the conversation still ends in the assistant reply,
    // restored byte-faithfully (same id), not left answer-less.
    const history = listMessages(db, conv.id)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(history.at(-1)?.content).toBe('the original answer')
    expect(history.at(-1)?.id).toBe(prior.id)
    // The in-flight registry is clean (the slot was claimed and released).
    expect(inFlightStreams.has(conv.id)).toBe(false)
  })

  it('a successful regenerate still replaces the prior reply — the F2 guard does not block the happy path', async () => {
    const db = freshDb()
    const { runtime, release } = gatedRuntime()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q' })
    const prior = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'old answer' })
    registerChatIpc(makeCtx(db, runtime))

    const event = makeEvent()
    const p = invokeWithEvent(handlers, IPC.sendChatMessage, event, conv.id, '', { regenerate: true }) as Promise<unknown>
    release()
    const msg = (await p) as { id: string; content: string }

    const history = listMessages(db, conv.id)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(history.at(-1)?.content).toBe('first second') // the freshly generated reply
    expect(history.at(-1)?.id).toBe(msg.id)
    expect(history.at(-1)?.id).not.toBe(prior.id) // the old reply is gone
  })

  it('deletes a conversation and its messages (chat and documents mode alike)', async () => {
    const db = freshDb()
    registerChatIpc(makeCtx(db, null))
    const chat = createConversation(db, {})
    const docs = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: chat.id, role: 'user', content: 'hi' })
    appendMessage(db, { conversationId: chat.id, role: 'assistant', content: 'hello' })
    appendMessage(db, { conversationId: docs.id, role: 'user', content: 'what does it say?' })

    await invoke(handlers, IPC.deleteConversation, chat.id)
    expect(listConversations(db).map((c) => c.id)).toEqual([docs.id])
    expect(listMessages(db, chat.id)).toHaveLength(0)
    // The other conversation is untouched.
    expect(listMessages(db, docs.id)).toHaveLength(1)

    await invoke(handlers, IPC.deleteConversation, docs.id)
    expect(listConversations(db)).toHaveLength(0)
  })

  it('refuses to delete a conversation while a response is streaming into it', async () => {
    const db = freshDb()
    const { runtime, release, started } = gatedRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    const p = invoke(handlers, IPC.sendChatMessage, conv.id, 'hi')
    await started
    await expect(invoke(handlers, IPC.deleteConversation, conv.id)).rejects.toThrow(
      /still being generated/
    )
    release()
    await p
    // After the stream finishes the delete goes through.
    await invoke(handlers, IPC.deleteConversation, conv.id)
    expect(listConversations(db)).toHaveLength(0)
  })

  // ---- "Ask selected documents" scope (Phase 17, plan §5.3) ----------------------

  it('createConversation accepts a documents scope and updateConversationScope edits it', async () => {
    const db = freshDb()
    registerChatIpc(makeCtx(db, null))

    const conv = (
      await invoke(handlers, IPC.createConversation, {
        mode: 'documents',
        scopeDocumentIds: ['d1', 'd2']
      })
    ).result as { id: string; scopeDocumentIds: string[] | null }
    expect(conv.scopeDocumentIds).toEqual(['d1', 'd2'])

    // Chip removal: replace with a subset, then clear back to the whole corpus.
    const narrowed = (await invoke(handlers, IPC.updateConversationScope, conv.id, ['d2'])).result as {
      scopeDocumentIds: string[] | null
    }
    expect(narrowed.scopeDocumentIds).toEqual(['d2'])
    const cleared = (await invoke(handlers, IPC.updateConversationScope, conv.id, null)).result as {
      scopeDocumentIds: string[] | null
    }
    expect(cleared.scopeDocumentIds).toBeNull()
    expect(listConversations(db)[0].scopeDocumentIds).toBeNull()

    await expect(invoke(handlers, IPC.updateConversationScope, 'nope', ['d1'])).rejects.toThrow(
      /Unknown conversation/
    )
  })

  // ---- Answer-depth modes (Phase 20, architecture.md "Chat & streaming") ------------------------------------

  /** A runtime that records chatStream options and emits reasoning then answer text. */
  function depthRuntime(): { runtime: ModelRuntime; seen: { options?: RuntimeChatOptions } } {
    const seen: { options?: RuntimeChatOptions } = {}
    const runtime: ModelRuntime = {
      modelId: 'depth',
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: 1 }),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        seen.options = options
        options?.onReasoning?.('pondering ')
        options?.onReasoning?.('deeply')
        yield '<think>leaked inline reasoning</think>'
        yield 'The answer.'
      }
    }
    return { runtime, seen }
  }

  it('forwards the mode and streams reasoning on chat:reasoning:<id>, never on the token channel', async () => {
    const db = freshDb()
    const { runtime, seen } = depthRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    const event = makeEvent()
    const msg = (await invokeWithEvent(handlers, IPC.sendChatMessage, event, conv.id, 'hi', {
      mode: 'deep'
    })) as { content: string }

    expect(seen.options?.mode).toBe('deep')
    // Reasoning deltas travel ONLY on the additive reasoning channel; the locked
    // Phase-3 token channel carries answer tokens only.
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.reasoning(conv.id), 'pondering ')
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.reasoning(conv.id), 'deeply')
    const tokenPayloads = event.sender.send.mock.calls
      .filter((c) => String(c[0]) === STREAM.token(conv.id))
      .map((c) => String(c[1]))
    expect(tokenPayloads.join('')).not.toContain('pondering')
    // The persisted reply is stripped of any inline think block (D6).
    expect(msg.content).toBe('The answer.')
    expect(listMessages(db, conv.id).at(-1)?.content).toBe('The answer.')
  })

  it('degrades a junk mode from a non-UI caller to the balanced default', async () => {
    const db = freshDb()
    const { runtime, seen } = depthRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    await invoke(handlers, IPC.sendChatMessage, conv.id, 'hi', { mode: 'TURBO' })
    expect(seen.options?.mode).toBeUndefined()
  })
})

// TEST-N8: the locked-vault guard was spot-checked on only ~3 of the chat IPC handlers, so a newly
// added unguarded handler would slip through. These STRUCTURAL tests enumerate EVERY registered
// handler and assert the guard fires for all DB-touching ones (chat + the benchmark handlers, now
// guarded per SEC-N2) — and that the two in-memory chat handlers stay usable while locked.
describe('locked-vault guard coverage (TEST-N8)', () => {
  // The only chat handlers that legitimately work while locked: they touch in-memory stream state,
  // never ctx.db. Everything else must refuse.
  const IN_MEMORY_CHANNELS = new Set<string>([
    IPC.stopGeneration,
    IPC.getActiveStream,
    IPC.listActiveStreamConversations
  ])

  it('every DB-touching chat handler refuses with the friendly copy when locked (structural)', async () => {
    const db = freshDb()
    const { runtime } = gatedRuntime()
    registerChatIpc(makeCtx(db, runtime, /* unlocked */ false))
    const channels = [...handlers.keys()]
    // Sanity: the enumeration actually covers the surface (guards against a registration refactor
    // silently leaving this test asserting nothing).
    expect(channels.length).toBeGreaterThanOrEqual(14)
    for (const ch of channels) {
      if (IN_MEMORY_CHANNELS.has(ch)) continue
      // Throwaway args — the guard is the FIRST statement in every DB-touching handler, before any
      // arg is used, so the refusal is arg-shape-independent.
      await expect(invoke(handlers, ch, 'x', 'y', 'z')).rejects.toThrow(/Workspace is locked\./)
      // …and never the raw vault-getter string ("Workspace is locked — unlock it first.").
      await expect(invoke(handlers, ch, 'x', 'y', 'z')).rejects.not.toThrow(/unlock it first/i)
    }
  })

  it('the in-memory chat handlers stay usable when locked (documented exemption)', async () => {
    const db = freshDb()
    const { runtime } = gatedRuntime()
    registerChatIpc(makeCtx(db, runtime, false))
    // None throw when locked (they read/clear the in-memory in-flight map, never ctx.db).
    await expect(invoke(handlers, IPC.stopGeneration, 'no-such-conv')).resolves.toBeDefined()
    await expect(invoke(handlers, IPC.getActiveStream, 'no-such-conv')).resolves.toBeDefined()
    // listActiveStreamConversations enumerates the in-flight map (workspace-agnostic) → [] when idle.
    expect((await invoke(handlers, IPC.listActiveStreamConversations)).result).toEqual([])
  })

  it('the benchmark handlers refuse when locked (SEC-N2 parity)', async () => {
    registerBenchmarkIpc({ workspace: { isUnlocked: () => false } } as unknown as AppContext)
    await expect(invoke(handlers, IPC.runBenchmark)).rejects.toThrow('Workspace is locked. Unlock it to run the benchmark.')
    await expect(invoke(handlers, IPC.tryGpuAgain)).rejects.toThrow('Workspace is locked. Unlock it to run the benchmark.')
    await expect(invoke(handlers, IPC.runBenchmark)).rejects.not.toThrow(/unlock it first/i)
  })
})

// T-8 (Chat & Documents audit 2026-07-07): the chat export handlers' user-visible behaviour was
// untested (only the structural locked-vault enumeration touched the channels). These pin the
// SANITIZED default filename, the null-on-cancel path (no write, no audit), and the S1 privacy
// posture — the audit records the conversation/message id ONLY, never the title (chat content) or
// the user-chosen path.
describe('chat export handlers (T-8)', () => {
  function ctxWithAudit(db: Db): { ctx: AppContext; audit: ReturnType<typeof vi.fn> } {
    const audit = vi.fn()
    const ctx = {
      db,
      workspace: { isUnlocked: () => true },
      runtime: { active: () => null, activeModelId: () => null },
      audit
    } as unknown as AppContext
    return { ctx, audit }
  }

  it('exportConversation sanitizes the title into the default path and audits the id only', async () => {
    const db = freshDb()
    const { ctx, audit } = ctxWithAudit(db)
    // A title full of filesystem-hostile characters — the sanitizer strips ':' '/' '<' '>'.
    const conv = createConversation(db, { title: 'Report: Q1/Q2 <draft>' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
    registerChatIpc(ctx)

    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-export-'))
    const outPath = join(dir, 'saved.md')
    dialogState.saveResult = { canceled: false, filePath: outPath }

    const filePath = (await invoke(handlers, IPC.exportConversation, conv.id)).result as string | null
    expect(filePath).toBe(outPath)
    // TEETH: the safeName regex removed ':' '/' '<' '>' and collapsed to a safe stem. Weaken the
    // regex (e.g. stop stripping '/') → the '/'-bearing "Report Q1/Q2 draft.md" reddens this.
    expect(dialogState.lastSaveOptions?.defaultPath).toBe('Report Q1Q2 draft.md')
    // Audit records the id ONLY — never the title (chat content) or the chosen path (user-private).
    expect(audit).toHaveBeenCalledWith('conversation_exported', expect.any(String), { conversationId: conv.id })
    const meta = audit.mock.calls.find((c) => c[0] === 'conversation_exported')?.[2]
    expect(JSON.stringify(meta)).not.toContain('Report') // no title leak
    expect(JSON.stringify(meta)).not.toContain(outPath) // no path leak
  })

  it('exportConversation returns null on cancel — nothing written, nothing audited', async () => {
    const db = freshDb()
    const { ctx, audit } = ctxWithAudit(db)
    const conv = createConversation(db, { title: 'Cancelled export' })
    registerChatIpc(ctx)
    dialogState.saveResult = { canceled: true } // user pressed Cancel

    const filePath = (await invoke(handlers, IPC.exportConversation, conv.id)).result as string | null
    expect(filePath).toBeNull()
    expect(audit).not.toHaveBeenCalledWith('conversation_exported', expect.anything(), expect.anything())
  })

  it('exportMessageTable uses a static table.csv name, and returns null (no dialog) when there is no table', async () => {
    const db = freshDb()
    const { ctx } = ctxWithAudit(db)
    const conv = createConversation(db, { title: 'Tables' })
    const withTable = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'here you go' })
    const noTable = appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'just prose, no table' })
    const table: TableSpec = { columns: [{ key: 'a', label: 'A' }], rows: [{ a: '1' }] }
    saveResultTable(db, { messageId: withTable.id, conversationId: conv.id, table })
    registerChatIpc(ctx)

    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-exporttbl-'))
    dialogState.saveResult = { canceled: false, filePath: join(dir, 'out.csv') }
    const ok = (await invoke(handlers, IPC.exportMessageTable, withTable.id)).result as string | null
    expect(ok).toBe(join(dir, 'out.csv'))
    // The table's data IS content, so the suggested filename is a fixed, content-free name.
    expect(dialogState.lastSaveOptions?.defaultPath).toBe('table.csv')

    // A message with no persisted table resolves to null BEFORE opening the dialog.
    dialogState.lastSaveOptions = undefined
    const none = (await invoke(handlers, IPC.exportMessageTable, noTable.id)).result as string | null
    expect(none).toBeNull()
    expect(dialogState.lastSaveOptions).toBeUndefined() // returned before the save dialog
  })
})
