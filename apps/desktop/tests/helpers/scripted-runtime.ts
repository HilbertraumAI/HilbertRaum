// Fake ModelRuntimes for the skills and RAG suites (pure: no electron import). `scriptedRuntime` streams a reply token
// by token and records calls; `recordingRuntime` counts generations and yields one fixed chunk; `finishScriptedRuntime`
// scripts a reply + finish reason (or a Stop) per call. Only `finishScriptedRuntime` fires `onFinish`, and none emits
// `onReasoning`, so a test that needs reasoning keeps its own fake.
import type { ChatMessage, ModelRuntime, RuntimeChatOptions, RuntimeTimings } from '../../src/main/services/runtime'

export interface ScriptedCall {
  messages: ChatMessage[]
  options?: RuntimeChatOptions
}

/**
 * A fake ModelRuntime that replies from `reply` (a constant, or a function of the call) and records every call
 * into `calls`. Default `tokens: 'words'` streams the reply word by word (whitespace-delimited tokens) and stops if `options.signal` is
 * aborted before a token; `'whole'` yields the whole reply once and ignores the signal (the enricher's shape).
 * It never calls `onReasoning` / `onFinish` and has no `contextWindow` - see `finishScriptedRuntime` for those two.
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
  /** Every call's prompt, in call order (a map-reduce's map steps, then its reduce). */
  turns: ChatMessage[][]
  /** Every call's runtime options, index-aligned with `turns`. */
  options: Array<RuntimeChatOptions | undefined>
}

/**
 * A fake runtime that counts generations, records every prompt and its options (`lastMessages` is the latest), and
 * yields one fixed single-chunk `reply`. `emitNothing` yields no token (after recording the call); `contextWindow`
 * adds a launched-window report.
 */
export function recordingRuntime(
  reply: string,
  o: { contextWindow?: number; emitNothing?: boolean } = {}
): RecordingRuntime {
  const rt: RecordingRuntime = {
    modelId: 'mock',
    calls: 0,
    lastMessages: [],
    turns: [],
    options: [],
    ...(o.contextWindow !== undefined ? { contextWindow: () => o.contextWindow as number } : {}),
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      rt.calls++
      rt.lastMessages = messages
      rt.turns.push(messages)
      rt.options.push(options)
      if (o.emitNothing) return
      yield reply
    }
  }
  return rt
}

export interface FinishStep {
  /** Yielded as one chunk; an empty reply yields nothing (a Stop before the first token). */
  reply: string
  /** The finish reason fired via `options.onFinish` after the reply; omitted ⇒ 'stop'. Not fired when `abort`. */
  finish?: string
  /** Handed to `onFinish` with the finish reason (#498 reads `predicted_n`). */
  timings?: RuntimeTimings
  /** Throw an AbortError after the reply (a user Stop) and fire NO finish reason: an aborted request carries no
   *  final chunk. */
  abort?: boolean
}

export interface FinishScriptedRuntime extends ModelRuntime {
  calls: number
  /** Every call's prompt, in call order. */
  turns: ChatMessage[][]
  /** The `maxTokens` each call was sent, index-aligned with `turns`. */
  caps: Array<number | undefined>
}

/**
 * A fake runtime that plays `script[call]` per chatStream call (calls past the end reuse the LAST step) and reports
 * `contextWindow` as the launched window. Unlike the fakes above it FIRES `options.onFinish`, so a test can drive
 * continue-generation ('length') and the truncation-cause attribution (`timings`).
 */
export function finishScriptedRuntime(script: FinishStep[], contextWindow = 2048): FinishScriptedRuntime {
  const rt: FinishScriptedRuntime = {
    modelId: 'mock',
    calls: 0,
    turns: [],
    caps: [],
    contextWindow: () => contextWindow,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      const step = script[Math.min(rt.calls, script.length - 1)]
      rt.calls++
      rt.turns.push(messages)
      rt.caps.push(options?.maxTokens)
      if (step.reply) yield step.reply
      if (step.abort) {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
      options?.onFinish?.(step.finish ?? 'stop', step.timings)
    }
  }
  return rt
}
