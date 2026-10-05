// Fake ModelRuntimes for the skills suites (pure: no electron import). `scriptedRuntime` streams a reply token by
// token and records calls; `recordingRuntime` counts generations and yields one fixed chunk. Neither ever emits
// `onReasoning` / `onFinish`, so a test that needs either keeps its own fake.
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

export interface ScriptedCall {
  messages: ChatMessage[]
  options?: RuntimeChatOptions
}

/**
 * A fake ModelRuntime that replies from `reply` (a constant, or a function of the call) and records every call
 * into `calls`. Default `tokens: 'words'` streams the reply word by word (whitespace-delimited tokens) and stops if `options.signal` is
 * aborted before a token; `'whole'` yields the whole reply once and ignores the signal (the enricher's shape).
 * It never calls `onReasoning` / `onFinish` and has no `contextWindow` - a test that needs any of those keeps its own fake.
 */
export function scriptedRuntime(
  reply: string | ((call: ScriptedCall) => string),
  calls: ScriptedCall[] = [],
  o: { tokens?: 'words' | 'whole' } = {}
): ModelRuntime {
  return {
    modelId: 'mock',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      const call: ScriptedCall = { messages, options }
      calls.push(call)
      const text = typeof reply === 'function' ? reply(call) : reply
      if (o.tokens === 'whole') {
        yield text
        return
      }
      for (const tok of text.match(/\S+\s*/g) ?? []) {
        if (options?.signal?.aborted) return
        yield tok
      }
    }
  }
}

export interface RecordingRuntime extends ModelRuntime {
  calls: number
  lastMessages: ChatMessage[]
}

/**
 * A fake runtime that counts generations, remembers the last prompt, and yields one fixed single-chunk `reply`.
 * `emitNothing` yields no token (after counting the call); `contextWindow` adds a launched-window report.
 */
export function recordingRuntime(
  reply: string,
  o: { contextWindow?: number; emitNothing?: boolean } = {}
): RecordingRuntime {
  const rt: RecordingRuntime = {
    modelId: 'mock',
    calls: 0,
    lastMessages: [],
    ...(o.contextWindow !== undefined ? { contextWindow: () => o.contextWindow as number } : {}),
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[]) {
      rt.calls++
      rt.lastMessages = messages
      if (o.emitNothing) return
      yield reply
    }
  }
  return rt
}
