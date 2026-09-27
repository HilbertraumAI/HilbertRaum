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
// The requests go to the runtime's own authenticated server handle (a private field — this is a
// manual harness, and it is the only way to send `cache_prompt: false` and read `cache_n` against
// the exact argv the app spawns).

const ROOT = process.env.HILBERTRAUM_PROMPT_CACHE_SMOKE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)
const DISABLE = process.env.HILBERTRAUM_PROMPT_CACHE_SMOKE_DISABLE?.trim() === '1'
const MTP = process.env.HILBERTRAUM_PROMPT_CACHE_SMOKE_MTP?.trim() === '1'

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

/** ~1,700 tokens of deterministic, checkable facts (no randomness: the run must be repeatable). */
function factsPrompt(): string {
  const lines: string[] = []
  for (let i = 1; i <= 64; i++) {
    const who = NAMES[i % NAMES.length]
    const colour = COLOURS[(i * 3) % COLOURS.length]
    const item = ITEMS[(i * 5) % ITEMS.length]
    lines.push(`Fact ${i}: In room ${100 + i} there is a ${colour} ${item} that weighs ${(i * 7) % 50 + 3} kg and belongs to ${who}.`)
  }
  return lines.join('\n')
}

/** One system message for A and B, as in the app (see the protocol note above, #512 / PR #524). */
const SYSTEM = 'You answer questions about the facts the user gives you. Answer briefly and exactly.'
const FACTS = factsPrompt()
const QUESTION_1 = 'Who owns the item in room 117, and how much does it weigh?'
const QUESTION_2 = 'And which colour is the item in room 142? Name its owner too.'
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

  it('evict-and-return: RESTORED or RE-PREFILLED, and does the restore match a recompute?', { timeout: 1_800_000 }, async () => {
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

      const a: Msg[] = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${FACTS}\n\n${QUESTION_1}` }
      ]
      const first = await ask(a, true)
      await ask(B_MESSAGES, true)
      const extended: Msg[] = [...a, { role: 'assistant', content: first.content }, { role: 'user', content: QUESTION_2 }]
      const back = await ask(extended, true)
      await ask(B_MESSAGES, true)
      const reference = await ask(extended, false)

      const total = back.promptTokens ?? (back.promptN ?? 0) + (back.cacheN ?? 0)
      const share = total > 0 && back.promptN != null ? back.promptN / total : 1
      const restored = back.promptN != null && share < RESTORED_MAX_SHARE
      const same = back.content === reference.content

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
    } finally {
      await runtime.stop()
    }
  })
})
