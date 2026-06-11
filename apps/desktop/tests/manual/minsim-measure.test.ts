import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createE5Embedder } from '../../src/main/services/embeddings/e5'
import { cosineSimilarity } from '../../src/main/services/embeddings'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'

// MANUAL ragMinSimilarity measurement (Phase 21, rag-design §12.1 R3 / §12.2 D12) — NOT CI.
//
// CI stays zero-network/zero-model/zero-binary, so this file is skipped unless
// PAID_MINSIM_MEASURE points at a provisioned drive root (same shape as PAID_GPU_SMOKE):
//
//   PAID_MINSIM_MEASURE=<root with runtime/llama.cpp/<os>/llama-server + models/embeddings/*.gguf>
//   npx vitest run tests/manual/minsim-measure.test.ts
//
// PURPOSE: ragMinSimilarity is the cosine floor applied to vector hits BEFORE fusion
// (D12) — a hit scoring below it is dropped. Its default is locked at 0 because the score
// SCALE is empirical: this codebase embeds with the real multilingual-E5 WITHOUT the
// "query:"/"passage:" prefixes (E5Embedder.embed sends raw text, exactly as
// VectorIndex.searchText does), which compresses cosines toward the high end. This harness
// reproduces the production cosine EXACTLY (same embedder, same no-prefix path, the same
// cosineSimilarity used by VectorIndex) and prints the score distributions for a batch of
// RELEVANT queries (answerable from the corpus) vs IRRELEVANT queries (topics absent from
// it). A safe floor sits BELOW the relevant minimum with margin; if the distributions
// overlap, the honest answer is "keep 0" (a too-high floor drops real hits → empty answers,
// the worst failure; a too-low floor merely lets weak hits through, where RRF + the
// reranker + the token budget already cope).

const ROOT = process.env.PAID_MINSIM_MEASURE?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)

/** Generous health budget: a model from a possibly-cold USB drive. */
const PATIENT_MS = 240_000

function firstEmbeddingModel(root: string): string | null {
  // The provisioned drive keeps the E5 GGUF under models/embeddings/.
  const dir = join(root, 'models', 'embeddings')
  if (!existsSync(dir)) return null
  const gguf = readdirSync(dir).find((f) => f.endsWith('.gguf'))
  return gguf ? join(dir, gguf) : null
}

// A small but topically-DIVERSE corpus of chunk-sized passages. Each is self-contained and
// on a distinct topic so a query either has a real home here or genuinely does not.
const CORPUS: string[] = [
  'Invoice INV-2024-001 was issued on 12 March. The total amount due is 940 euro, payable within 30 days by bank transfer to the account on the footer.',
  'Solar panels convert sunlight into electricity using photovoltaic cells. A typical residential rooftop array produces three to six kilowatts under full sun.',
  'To bake sourdough, mix flour and water and let the starter ferment overnight. Fold the dough every thirty minutes, then proof and bake in a hot Dutch oven.',
  'The Shinkansen connects Tokyo and Osaka in about two and a half hours. Reserve seats in advance during holidays, and a Japan Rail Pass covers most lines.',
  'This residential lease runs for twelve months. The tenant pays rent on the first of each month; the security deposit is refundable less any damage on move-out.',
  'Puppies need a series of core vaccinations starting at six to eight weeks, with boosters every three to four weeks until about sixteen weeks of age.',
  'A Python list comprehension builds a list from an iterable in one expression, for example squares equals open bracket x times x for x in range ten close bracket.',
  'Marathon training builds weekly mileage gradually and includes one long run that increases until about three weeks before race day, followed by a taper.',
  'For pour-over coffee, use a ratio near sixteen grams of water to one gram of coffee, a medium grind, and a slow spiral pour over about three minutes.',
  'Photosynthesis lets plants turn carbon dioxide and water into glucose and oxygen using light energy captured by chlorophyll in the leaves.',
  'On a fixed-rate mortgage the interest rate stays constant for the whole term, so the monthly principal-and-interest payment never changes.',
  'Standard guitar tuning from the lowest string is E, A, D, G, B, E. Tune up to the note rather than down to it so the string holds pitch.'
]

// RELEVANT queries: each is answerable from exactly one corpus passage, phrased as a user
// would actually ask (not by copying corpus words).
const RELEVANT_QUERIES: string[] = [
  'How much do I owe on that March invoice and when is it due?',
  'How much power can rooftop solar make for a house?',
  'What are the steps for making sourdough bread at home?',
  'How long does the bullet train take from Tokyo to Osaka?',
  'When is my apartment rent due and is the deposit refundable?',
  'What is the puppy vaccination schedule by age?',
  'How do I write a list comprehension in Python?',
  'How should I increase mileage when training for a marathon?',
  'What coffee-to-water ratio should I use for pour over?',
  'How do plants make energy from sunlight?',
  'Does the payment change over time on a fixed-rate mortgage?',
  'What are the string notes for standard guitar tuning?'
]

// IRRELEVANT queries: real questions whose answers are NOT in the corpus at all.
const IRRELEVANT_QUERIES: string[] = [
  'How do volcanoes erupt and what causes the lava to flow?',
  'What is the capital city of Mongolia?',
  'How long do elephants usually live in the wild?',
  'What causes the northern lights in the night sky?',
  'How do I knit a wool scarf for winter?',
  'What is the offside rule in football?',
  'When was the printing press invented and by whom?',
  'How deep is the Mariana Trench in the ocean?',
  'What ingredients go into a traditional Thai green curry?',
  'How do noise-cancelling headphones block sound?',
  'What is the speed of light in a vacuum?',
  'How do bees communicate the location of flowers?'
]

function stats(scores: number[]): { min: number; median: number; mean: number; max: number } {
  const sorted = [...scores].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return { min, median, mean, max }
}

describe.skipIf(!enabled)('ragMinSimilarity measurement (manual, real multilingual-E5)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, {}) : null
  const modelPath = enabled ? firstEmbeddingModel(ROOT) : null

  it('reports relevant vs irrelevant cosine distributions and a recommended floor', { timeout: 600_000 }, async () => {
    expect(binPath).toBeTruthy()
    expect(modelPath).toBeTruthy()
    const embedder = createE5Embedder({
      id: 'minsim-measure',
      binPath: binPath!,
      modelPath: modelPath!,
      healthTimeoutMs: PATIENT_MS
    })
    try {
      // Embed the corpus once (passages), then each query, exactly as retrieve() does:
      // raw text, no E5 prefixes, L2-normalized → cosine == dot product.
      const corpusVecs = await embedder.embed(CORPUS)
      const bestCosine = async (query: string): Promise<number> => {
        const [qv] = await embedder.embed([query])
        let best = -1
        for (const cv of corpusVecs) best = Math.max(best, cosineSimilarity(qv, cv))
        return best
      }

      const relevant: number[] = []
      for (const q of RELEVANT_QUERIES) relevant.push(await bestCosine(q))
      const irrelevant: number[] = []
      for (const q of IRRELEVANT_QUERIES) irrelevant.push(await bestCosine(q))

      const rs = stats(relevant)
      const is = stats(irrelevant)
      const fmt = (n: number): string => n.toFixed(4)

      // eslint-disable-next-line no-console
      console.log('\n=== ragMinSimilarity measurement (best-chunk cosine per query) ===')
      // eslint-disable-next-line no-console
      console.log(
        `RELEVANT   (n=${relevant.length}): min=${fmt(rs.min)} median=${fmt(rs.median)} mean=${fmt(rs.mean)} max=${fmt(rs.max)}`
      )
      // eslint-disable-next-line no-console
      console.log(
        `IRRELEVANT (n=${irrelevant.length}): min=${fmt(is.min)} median=${fmt(is.median)} mean=${fmt(is.mean)} max=${fmt(is.max)}`
      )
      // eslint-disable-next-line no-console
      console.log('relevant   sorted:', relevant.map(fmt).sort())
      // eslint-disable-next-line no-console
      console.log('irrelevant sorted:', irrelevant.map(fmt).sort())

      const gap = rs.min - is.max // positive ⇒ clean separation
      if (gap > 0) {
        // A safe floor sits in the gap, biased LOW (closer to is.max) to never drop a real
        // hit: midpoint, then back off toward the irrelevant ceiling by 25% of the gap.
        const recommended = is.max + gap * 0.25
        // eslint-disable-next-line no-console
        console.log(
          `SEPARATION: clean gap of ${fmt(gap)} (relevant.min ${fmt(rs.min)} > irrelevant.max ${fmt(is.max)}).`
        )
        // eslint-disable-next-line no-console
        console.log(`RECOMMENDED ragMinSimilarity ≈ ${fmt(recommended)} (in the gap, biased low).`)
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `OVERLAP: relevant.min ${fmt(rs.min)} ≤ irrelevant.max ${fmt(is.max)} (overlap ${fmt(-gap)}).`
        )
        // eslint-disable-next-line no-console
        console.log('RECOMMENDED ragMinSimilarity = 0 — no positive floor separates the classes without dropping real hits.')
      }

      // Sanity only (the measurement lives in the console output above): on average a
      // relevant query must out-score an irrelevant one, or the corpus/queries are broken.
      expect(rs.mean).toBeGreaterThan(is.mean)
    } finally {
      await embedder.stop()
    }
  })
})
