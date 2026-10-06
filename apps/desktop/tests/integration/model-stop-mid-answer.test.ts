import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  appendMessage,
  createConversation,
  generateAssistantMessage,
  listMessages
} from '../../src/main/services/chat'
import { RuntimeManager } from '../../src/main/services/runtime'
import { killableRuntime } from '../helpers/killable-runtime'
import { withChatStream, withRegenerateGuard } from '../../src/main/ipc/chat-stream'
import { endWorkOnModelStop } from '../../src/main/ipc/model-stop'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { endedEarlyCause } from '../../src/main/services/chat/ended-early'
import type { Message } from '../../src/shared/types'

// #600 — the user stops or switches the chat model while an answer is being written. Before #600 the
// sidecar was killed under the answer: the read failed with undici's raw "terminated", the turn
// rejected with that text, and the partial answer was thrown away (only an abort keeps a partial).
// Measured in the real app on master (2026-10-06): Stop mid-answer → "terminated", nothing saved.
// Now `RuntimeManager` ends the in-flight answers FIRST (its model-stop hook → `endWorkOnModelStop`),
// so the answer ends as a clean stop: the partial persists, marked "Reply stopped"; a question with no
// answer yet is marked "Not answered". Driven through the real manager, the real hook body, the chat
// stream lifecycle and `generateAssistantMessage` on a real database.

const dbs: Db[] = []
afterEach(() => {
  while (dbs.length) dbs.pop()?.close()
})

function freshDb(): Db {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-modelstop-')), 'test.sqlite'))
  dbs.push(db)
  return db
}

async function harness(tokens: string[]) {
  const db = freshDb()
  const conv = createConversation(db, {})
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Tell me about lighthouses.' })
  let markParked!: () => void
  const parked = new Promise<void>((r) => (markParked = r))
  // Like the llama-server sidecar under a kill: `tokens`, then a parked read that a stop rejects with
  // undici's "terminated" and an abort ends cleanly (`tests/helpers/killable-runtime.ts`).
  const mgr = new RuntimeManager((opts) => killableRuntime({ modelId: opts.modelId, tokens, onParked: markParked }))
  // The production wiring (`main/index.ts`); this harness has no local API and no doc tasks.
  mgr.setModelStopHook((kind) => endWorkOnModelStop({}, kind))
  await mgr.start({ modelId: 'model-a', modelPath: '/a.gguf', contextTokens: 4096 })
  const runtime = mgr.active()!
  const event = { sender: { isDestroyed: () => false, send: () => {} } } as unknown as IpcMainInvokeEvent
  const turn: Promise<Message> = withChatStream(
    event,
    conv.id,
    'Chat generation failed',
    withRegenerateGuard(db, conv.id, false, (signal, sendToken) =>
      generateAssistantMessage(db, runtime, conv.id, { signal, onToken: sendToken })
    )
  )
  // A rejection is the pre-#600 outcome; keep it observable instead of unhandled.
  turn.catch(() => undefined)
  return { db, conv, mgr, turn, parked }
}

describe('a model stop or switch mid-answer ends the answer cleanly (#600)', () => {
  it('Stop runtime mid-answer: the turn resolves with the partial, saved and marked "Reply stopped"', async () => {
    const h = await harness(['Lighthouses ', 'guide ships'])
    await h.parked // both tokens streamed; the next read is pending

    await h.mgr.stop()
    const answer = await h.turn // used to reject with the raw "terminated"

    expect(answer.content).toBe('Lighthouses guide ships')
    expect(answer.endedEarly).toBe('model')
    const saved = listMessages(h.db, h.conv.id)
    expect(saved.map((m) => [m.role, m.content, m.endedEarly])).toEqual([
      ['user', 'Tell me about lighthouses.', undefined],
      ['assistant', 'Lighthouses guide ships', 'model']
    ])
  })

  it.each([
    ['stop' as const, 'model_not_loaded'],
    ['switch' as const, 'model_starting']
  ])('on a %s the hook ends the local API request first (%s), then the deep-index build, the answers and the skill runs on the model', (kind, code) => {
    // The order is load-bearing: a turn ended inside its compaction pre-pass re-enters the runtime gate,
    // and by then the external request must already carry its model-change code.
    const calls: string[] = []
    const ctx = {
      localApi: { endForModelChange: (c: string) => calls.push(`api ${c}`) },
      docTasks: { abortActiveBuild: () => calls.push('build') },
      // #606: only the runs streaming on the model — an extraction never touched it.
      skillRuns: { cancelModelRuns: () => calls.push('model runs'), cancelAll: () => calls.push('ALL runs') }
    } as unknown as Parameters<typeof endWorkOnModelStop>[0]
    const answer = new AbortController()
    answer.signal.addEventListener('abort', () => calls.push('answer'))
    inFlightStreams.set('conv-hook-order', answer)
    try {
      endWorkOnModelStop(ctx, kind)
    } finally {
      inFlightStreams.delete('conv-hook-order')
    }
    expect(calls).toEqual([`api ${code}`, 'build', 'answer', 'model runs'])
    expect(endedEarlyCause(answer.signal)).toBe('model') // the reason the persist + restore rules key on
  })

  it('a switch to another model before the first word: no answer, and the question is marked "Not answered"', async () => {
    const h = await harness([])
    await h.parked // parked before its first token, as in a long CPU prefill

    await h.mgr.start({ modelId: 'model-b', modelPath: '/b.gguf', contextTokens: 4096 })
    const answer = await h.turn

    expect(answer.content).toBe('')
    const saved = listMessages(h.db, h.conv.id)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ role: 'user', endedEarly: 'model' })
  })
})
