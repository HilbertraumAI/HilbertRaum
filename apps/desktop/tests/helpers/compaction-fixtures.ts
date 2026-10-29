// Conversation-compaction fixtures for the chat suites (pure: no electron import): a history builder and a runtime that
// tells the compaction summary call (system message === `selfSummaryPrompt`) from an answer call, so a test can assert
// how often the summarizer ran and what it saw.
import type { Db } from '../../src/main/services/db'
import { appendMessage } from '../../src/main/services/chat'
import { selfSummaryPrompt } from '../../src/main/services/chat/compaction'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

/** A block of `n` whitespace-separated words, about `n` approx-tokens (the prose estimate path). */
export const words = (n: number): string => Array(n).fill('word').join(' ')

/** Append `n` alternating user/assistant turns of `wordsPerTurn` words each (turn 0 is a user turn). */
export function appendTurns(db: Db, conversationId: string, n: number, wordsPerTurn: number): void {
  for (let i = 0; i < n; i++) {
    appendMessage(db, {
      conversationId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: words(wordsPerTurn)
    })
  }
}

export interface CompactionRuntime extends ModelRuntime {
  /** One entry per summary call: the last message the summarizer was sent (the transcript to fold). */
  summaryCalls: Array<{ input: string }>
  answerCalls: number
}

export interface CompactionRuntimeOptions {
  /** The launched window `contextWindow()` reports. */
  window: number
  /** The summary the summarizer streams, word by word; default 'Goal: testing. Facts: value 42 from [S1].' */
  summary?: string
  /** The summary call throws before its first token. */
  failSummary?: boolean
  /** F-02: stream HALF the summary, then throw this (what readChatSSE does on an in-band mid-stream error frame). */
  failSummaryMidStream?: Error
}

/**
 * A runtime whose summary calls stream `summary` (honouring `options.signal` between tokens) and whose answer calls
 * stream `Reply to <first 12 chars of the last user turn>.`.
 */
export function compactionRuntime(opts: CompactionRuntimeOptions): CompactionRuntime {
  const rt: CompactionRuntime = {
    modelId: 'scripted-compaction',
    summaryCalls: [],
    answerCalls: 0,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    contextWindow: () => opts.window,
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      if (messages[0]?.content === selfSummaryPrompt) {
        rt.summaryCalls.push({ input: messages[messages.length - 1]?.content ?? '' })
        if (opts.failSummary) throw new Error('summary boom')
        const text = opts.summary ?? 'Goal: testing. Facts: value 42 from [S1].'
        const tokens = text.match(/\S+\s*/g) ?? [text]
        const emitUpTo = opts.failSummaryMidStream ? Math.ceil(tokens.length / 2) : tokens.length
        for (const tok of tokens.slice(0, emitUpTo)) {
          if (options?.signal?.aborted) return
          yield tok
        }
        if (opts.failSummaryMidStream) throw opts.failSummaryMidStream
        return
      }
      rt.answerCalls += 1
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      const reply = `Reply to ${lastUser.slice(0, 12)}.`
      for (const tok of reply.match(/\S+\s*/g) ?? [reply]) {
        if (options?.signal?.aborted) return
        yield tok
      }
    }
  }
  return rt
}
