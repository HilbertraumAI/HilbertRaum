import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { totalmem } from 'node:os'
import { basename, join } from 'node:path'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'
import { MTP_SERVER_ARGS } from '../../src/main/services/runtime/factory'
import type { RuntimeStartOptions } from '../../src/main/services/runtime'
import { promptCacheRamMib } from '../../src/shared/prompt-cache-rules'

// MANUAL prompt-cache smoke (issue #512) — NOT part of CI. Does the pinned llama-server RESTORE this
// GGUF's evicted conversation from its host-RAM prompt cache, or silently re-prefill it? The answer
// decides one manifest field: `disable_prompt_cache: true` only for a model that re-prefills.
//
//   HILBERTRAUM_PROMPT_CACHE_SMOKE=<root with runtime/llama.cpp/<os>/llama-server + models/chat/*.gguf>
//   HILBERTRAUM_SMOKE_MODEL=<one chat .gguf filename under models/chat/>    # default: the smallest
//   HILBERTRAUM_PROMPT_CACHE_SMOKE_DISABLE=1   # optional control: spawn as disable_prompt_cache: true
//   HILBERTRAUM_PROMPT_CACHE_SMOKE_MTP=1       # optional: add rung 1a's MTP flags (a manifest with
//                                              # speculative_decoding: mtp starts that way on a GPU)
//   HILBERTRAUM_PROMPT_CACHE_SMOKE_PROMPTS=N   # optional (#729): run the protocol for N different
//                                              # conversations on one server (default 1) and count how
//                                              # many restored answers equal their recompute
//   npm test -- tests/manual/prompt-cache-smoke.test.ts                     # from the repo root
//
// The server is spawned by `createLlamaRuntime`, so its argv is the app's chat argv exactly
// (`CHAT_SERVER_ARGS`, `-np 1`, the RAM-scaled `--cache-ram`, GPU auto-offload as on rung 1), at
// ctx 8192 as in the #399 sweep. The protocol (#399, re-run for #512):
//   1. conversation A — a synthetic ~1,700-token facts prompt + a question;
//   2. an unrelated conversation B, with the SAME system message, takes the one slot (A is evicted
//      to the host cache). Every app chat shares one system prompt, and that shared prefix is the
//      case #399 lost on b9849: a B with a different system message let b9849 restore qwen3.8 on
//      the 24 GB rig (PR #524), so it did not separate the builds;
//   3. A extended with its reply and a new question — `prompt_n` here is what was re-prefilled;
//   4. B again, then the same extended request with `cache_prompt: false` — the reference.
// It prints `prompt_n` on return, a RESTORED / RE-PREFILLED verdict, whether the restored answer
// equals the reference, and the advice for the manifest. Hard asserts only that the pipeline ran:
// the verdict is a measurement for a person to read, not a pass/fail.
//
// One matching answer is weak evidence that a restore and a recompute agree (#729): a restored
// prefix is followed by a re-prefill in other batch shapes, so the two can differ in a near-tie
// token and then in the rest of the answer. With PROMPTS=N each conversation gets its own facts and
// questions (conversation 0 is the one above, unchanged), and the run ends with the counts:
// restored k of N, restored answer == recompute m of k. That rate is what to compare across builds.
//
// The requests go to the runtime's own authenticated server handle (a private field — this is a
// manual harness, and it is the only way to send `cache_prompt: false` and read `cache_n` against
// the exact argv the app spawns).

const ROOT = process.env.HILBERTRAUM_PROMPT_CACHE_SMOKE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)
const DISABLE = process.env.HILBERTRAUM_PROMPT_CACHE_SMOKE_DISABLE?.trim() === '1'
const MTP = process.env.HILBERTRAUM_PROMPT_CACHE_SMOKE_MTP?.trim() === '1'
const PROMPTS = Number(process.env.HILBERTRAUM_PROMPT_CACHE_SMOKE_PROMPTS?.trim() || '1')
if (!Number.isInteger(PROMPTS) || PROMPTS < 1 || PROMPTS > 200) {
  throw new Error(`HILBERTRAUM_PROMPT_CACHE_SMOKE_PROMPTS must be a whole number from 1 to 200 (got: ${PROMPTS})`)
}

const PATIENT_MS = 300_000
const CTX = 8192
const MAX_TOKENS = 120
/** Re-prefilling less than this share of the return prompt counts as a restore. */
const RESTORED_MAX_SHARE = 0.2

function chatModel(root: string): string | null {
  const dir = join(root, 'models', 'chat')
  if (!existsSync(dir)) return null
  const override = process.env.HILBERTRAUM_SMOKE_MODEL?.trim()
  if (override) {
    const p = join(dir, override)
    return existsSync(p) ? p : null
  }
  const ggufs = readdirSync(dir)
    .filter((f) => f.endsWith('.gguf'))
    .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size)
  return ggufs.length ? ggufs[0].path : null
}

const NAMES = ['Anna', 'Bernd', 'Carla', 'Dieter', 'Elif', 'Farid', 'Greta', 'Hannes', 'Ida', 'Jonas']
const COLOURS = ['red', 'blue', 'green', 'yellow', 'black', 'white', 'grey', 'orange']
const ITEMS = ['lamp', 'chair', 'crate', 'kettle', 'drum', 'mirror', 'suitcase', 'barrel', 'clock']

/**
 * ~1,700 tokens of deterministic, checkable facts (no randomness: the run must be repeatable).
 * `k` picks conversation k of a PROMPTS=N run; k = 0 is the original prompt, byte for byte.
 */
function factsPrompt(k = 0): string {
  const lines: string[] = []
  for (let i = 1; i <= 64; i++) {
    const who = NAMES[(i + k) % NAMES.length]
    const colour = COLOURS[(i * 3 + k) % COLOURS.length]
    const item = ITEMS[(i * 5 + 2 * k) % ITEMS.length]
    lines.push(`Fact ${i}: In room ${100 + i} there is a ${colour} ${item} that weighs ${((i + k) * 7) % 50 + 3} kg and belongs to ${who}.`)
  }
  return lines.join('\n')
}

/** One system message for A and B, as in the app (see the protocol note above, #512 / PR #524). */
const SYSTEM = 'You answer questions about the facts the user gives you. Answer briefly and exactly.'
/** Conversation k's questions; k = 0 asks about rooms 117 and 142, as the smoke always has. */
const room = (base: number, k: number): number => 100 + ((base - 1 + 11 * k) % 64) + 1
const question1 = (k: number): string => `Who owns the item in room ${room(17, k)}, and how much does it weigh?`
const question2 = (k: number): string => `And which colour is the item in room ${room(42, k)}? Name its owner too.`
const B_MESSAGES = [
  { role: 'system', content: SYSTEM },
  {
    role: 'user',
    content:
      'Write four short sentences about autumn in a small harbour town: the boats, the weather, ' +
      'the market, and the evening light. Keep it plain and calm.'
  }
]

type Msg = { role: string; content: string }
interface Completion {
  content: string
  promptN: number | null
  cacheN: number | null
  promptTokens: number | null
}

type AuthedServer = { fetch(path: string, init?: RequestInit): Promise<Response>; buildArgs(port: number): string[] }

describe.skipIf(!enabled)('Prompt-cache smoke (manual, real llama-server + one chat GGUF)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, {}) : null
  const modelPath = enabled ? chatModel(ROOT) : null

  // Each further conversation is five requests; 5 min each is far above what a 27B needs on a card.
  it('evict-and-return: RESTORED or RE-PREFILLED, and does the restore match a recompute?', { timeout: 1_800_000 + (PROMPTS - 1) * 300_000 }, async () => {
    expect(binPath, 'llama-server binary on the drive').toBeTruthy()
    expect(modelPath, 'a chat GGUF under models/chat').toBeTruthy()
    const stderr: string[] = []
    const opts: RuntimeStartOptions = {
      modelId: 'prompt-cache-smoke',
      modelPath: modelPath!,
      contextTokens: CTX,
      ...(DISABLE ? { disablePromptCache: true } : {})
    }
    const runtime = createLlamaRuntime(opts, {
      binPath: binPath!,
      healthTimeoutMs: PATIENT_MS,
      onStderrData: (chunk) => stderr.push(String(chunk)),
      ...(MTP ? { extraArgs: [...MTP_SERVER_ARGS] } : {})
    })
    await runtime.start()
    const server = (runtime as unknown as { server: AuthedServer }).server
    const port = (await runtime.health()).port ?? 0

    const ask = async (messages: Msg[], cachePrompt: boolean): Promise<Completion> => {
      const res = await server.fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages,
          stream: false,
          temperature: 0,
          seed: 42,
          max_tokens: MAX_TOKENS,
          cache_prompt: cachePrompt,
          chat_template_kwargs: { enable_thinking: false }
        })
      })
      expect(res.ok, `HTTP ${res.status}`).toBe(true)
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        timings?: { prompt_n?: number; cache_n?: number }
        usage?: { prompt_tokens?: number }
      }
      return {
        content: json.choices?.[0]?.message?.content ?? '',
        promptN: json.timings?.prompt_n ?? null,
        cacheN: json.timings?.cache_n ?? null,
        promptTokens: json.usage?.prompt_tokens ?? null
      }
    }

    try {
      const argv = server.buildArgs(port)
      const cram = argv[argv.indexOf('--cache-ram') + 1]
      console.log(`[prompt-cache] model ${basename(modelPath!)}`)
      console.log(
        `[prompt-cache] --cache-ram ${cram} (RAM rule: ${promptCacheRamMib(totalmem())} MiB` +
          `${DISABLE ? '; spawned as disable_prompt_cache: true' : ''}), -np 1, --ctx-size ${CTX}` +
          (MTP ? `, ${MTP_SERVER_ARGS.join(' ')}` : '')
      )

      /** One evict-and-return round for conversation k (the protocol above). */
      const round = async (k: number) => {
        const a: Msg[] = [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `${factsPrompt(k)}\n\n${question1(k)}` }
        ]
        const first = await ask(a, true)
        await ask(B_MESSAGES, true)
        const extended: Msg[] = [...a, { role: 'assistant', content: first.content }, { role: 'user', content: question2(k) }]
        const back = await ask(extended, true)
        await ask(B_MESSAGES, true)
        const reference = await ask(extended, false)
        const total = back.promptTokens ?? (back.promptN ?? 0) + (back.cacheN ?? 0)
        const share = total > 0 && back.promptN != null ? back.promptN / total : 1
        const restored = back.promptN != null && share < RESTORED_MAX_SHARE
        return { first, back, reference, total, share, restored, same: back.content === reference.content }
      }

      const { first, back, reference, total, share, restored, same } = await round(0)

      console.log(`[prompt-cache] A: prompt_n ${first.promptN} of ${first.promptTokens} prompt tokens`)
      console.log(
        `[prompt-cache] A returned after B: prompt_n ${back.promptN} of ${total} (cache_n ${back.cacheN}) → ` +
          `${restored ? 'RESTORED' : 'RE-PREFILLED'} (${(share * 100).toFixed(1)} % re-prefilled)`
      )
      console.log(`[prompt-cache] reference (cache_prompt: false): prompt_n ${reference.promptN}`)
      console.log(`[prompt-cache] restored answer ${same ? '==' : '!='} reference (${back.content.length} chars)`)
      console.log(`[prompt-cache] answer: ${JSON.stringify(back.content.slice(0, 200))}`)
      if (!same) console.log(`[prompt-cache] reference: ${JSON.stringify(reference.content.slice(0, 200))}`)
      const advice = DISABLE
        ? 'control run (cache disabled) — expect RE-PREFILLED; no manifest advice'
        : restored && same
          ? 'leave disable_prompt_cache unset'
          : restored
            ? 'RESTORED but the answer differs from the recompute — investigate before deciding'
            : 'set disable_prompt_cache: true'
      console.log(`[prompt-cache] ADVICE: ${advice}`)
      const cacheLines = stderr
        .join('')
        .split(/\r?\n/)
        .filter((l) => /prompt cache|cache state|cache_ram|cache size|removing|restor/i.test(l))
      if (cacheLines.length) console.log(`[prompt-cache] server cache log:\n  ${cacheLines.slice(-12).join('\n  ')}`)

      // The pipeline ran: every request answered, and the server reported what it prefilled.
      expect(first.content.length).toBeGreaterThan(0)
      expect(back.content.length).toBeGreaterThan(0)
      expect(reference.content.length).toBeGreaterThan(0)
      expect(back.promptN).not.toBeNull()
      expect(reference.promptN).not.toBeNull()

      if (PROMPTS > 1) {
        // #729: the same round for conversations 1 … N-1 on the same server, then the counts.
        let restoredCount = restored ? 1 : 0
        let sameCount = restored && same ? 1 : 0
        const differing: string[] = restored && !same ? ['0'] : []
        for (let k = 1; k < PROMPTS; k++) {
          const r = await round(k)
          expect(r.back.content.length, `conversation ${k} answered`).toBeGreaterThan(0)
          expect(r.reference.content.length, `conversation ${k} recomputed`).toBeGreaterThan(0)
          if (r.restored) restoredCount++
          if (r.restored && r.same) sameCount++
          if (r.restored && !r.same) {
            let at = 0
            while (at < r.back.content.length && r.back.content[at] === r.reference.content[at]) at++
            differing.push(`${k}@${at}`)
          }
          console.log(
            `[prompt-cache] #${k}: prompt_n ${r.back.promptN} of ${r.total} → ${r.restored ? 'RESTORED' : 'RE-PREFILLED'}, ` +
              `restored ${r.same ? '==' : '!='} recompute`
          )
        }
        console.log(
          `[prompt-cache] SUMMARY over ${PROMPTS} conversations: restored ${restoredCount} of ${PROMPTS}; ` +
            `restored answer == recompute ${sameCount} of ${restoredCount}`
        )
        if (differing.length) console.log(`[prompt-cache] differing (conversation@first changed char): ${differing.join(', ')}`)
      }
    } finally {
      await runtime.stop()
    }
  })
})
