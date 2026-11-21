// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvidenceReviewDetail, EvidenceReviewItem, ReviewDecision } from '../../src/shared/types'
import {
  deleteReviewSelection,
  editReviewHead,
  editReviewItem,
  exportReviewPack,
  getReviewSessionSnapshot,
  linkEvidence,
  markReviewReady,
  openReviewSession,
  purgeReviewSession,
  reopenReview,
  retryReviewSave,
  unlinkEvidence,
  REVIEW_SAVE_DEBOUNCE_MS
} from '../../src/renderer/lib/reviewSession'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import {
  makeDetail,
  makeItem,
  makeSourceSnapshots,
  reviewDiff,
  reviewMain,
  stubReviewApi,
  type ReviewMainCall
} from '../helpers/evidenceReview'
import { testBudgetMs } from '../helpers/hang-budget'

// #889 / #901 (follow-ups wave 2): a seeded random-order checker for the review store's save rules. Each seed opens one
// review against `reviewMain` (it saves what the store sends, by main's rules, and answers the synchronous handlers in
// arrival order) and runs random steps: decision and note edits, head edits, selection removals, links and unlinks,
// the debounce timer, Mark ready, Export, Reopen and Try again, while main's next answers are held, failed or released
// at random. One step is one task: every microtask it starts runs before the next step, as between two user events.
// After each segment of steps everything is answered and every timer has run (a settle), and the checker asks:
//  (a) the screen equals what main saved: every item there is and its decision, note and links, the progress gate, the
//      head and ready or draft; and the screen is not left read-only — nor, after any step, on "Saving…" with no save
//      scheduled, no answer to come and no call running;
//  (b) each time the save line turns to an error, main failed a call in that segment that no earlier error accounts
//      for (no false error: #901; checked after every step and every settle round);
//  (c) whenever main receives Mark ready, Export or Reopen, every edit on screen is already saved (#889; links aside,
//      whose answers may still be on their way);
//  (d) no accepted edit is lost: the checker keeps the last value the store ACCEPTED for each item field (decision, note)
//      and head field (title, reviewer label, general note), forgetting an item once its delete succeeded. An edit is
//      accepted when the call did not refuse it, and it must refuse exactly when item editing is closed (frozen, ready,
//      the item gone; a head edit only with no review open). After a segment in which main failed no item or head write,
//      main holds every accepted value and so does the screen. (a) alone cannot see an edit lost on BOTH sides: dropped
//      from the queue and from the screen, the screen still equals main (review round 2, SF-1);
//  and when a segment ends on an error, Try again (main healthy now, its re-read held while one more edit is typed) clears
//  it and the screen then equals main. While an error shows, a quarter of the steps are Try again, and half of all Try
//  agains find main slow to answer their re-read: the window in which (d) catches an edit the re-read drops.
// At most EDITS_PER_ACTION edits are made between an action's click and its arrival in main: inside the drain's four
// passes, so (c) is exact. A link or unlink targets a selection whose removal is on its way half the time it can. Not
// covered here (their own rows are): the lock, a review switch, bulk actions and adding a selection.
// `HILBERTRAUM_REVIEW_ORDER_SEEDS` (default 300) and `HILBERTRAUM_REVIEW_ORDER_FIRST_SEED` (default 1) widen or move the
// run; a failure names its seed and every step it took.

const SEEDS = Number(process.env.HILBERTRAUM_REVIEW_ORDER_SEEDS ?? 300)
const FIRST_SEED = Number(process.env.HILBERTRAUM_REVIEW_ORDER_FIRST_SEED ?? 1)
const SEGMENTS = 3
const STEPS_PER_SEGMENT = 14
const EDITS_PER_ACTION = 3

// Captured before the row installs fake timers: one real macrotask hop runs every microtask a step started.
const realImmediate = globalThis.setImmediate
const flush = (): Promise<void> => new Promise((resolve) => realImmediate(resolve))

/** mulberry32: a small seeded generator, so a seed replays exactly. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A heading, two required paragraphs and two selections, with two sources to link. */
function fixture(): EvidenceReviewDetail {
  const items: EvidenceReviewItem[] = [
    makeItem({ id: 'h1', ordinal: 0, blockKind: 'heading', textSnapshot: 'Terms' }),
    makeItem({ id: 'p1', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Alpha [S1]' }),
    makeItem({ id: 'p2', ordinal: 2, blockKey: 'b2-paragraph-ghi', textSnapshot: 'Beta [S2]' }),
    makeItem({ id: 'sel1', ordinal: 3, kind: 'selection', blockKey: 'b1-paragraph-def', startOffset: 0, endOffset: 5, textSnapshot: 'Alpha' }),
    makeItem({ id: 'sel2', ordinal: 4, kind: 'selection', blockKey: 'b2-paragraph-ghi', startOffset: 0, endOffset: 4, textSnapshot: 'Beta' })
  ]
  return makeDetail({ items, sources: makeSourceSnapshots(2) })
}

const DECIDED: ReviewDecision[] = ['supported', 'partly_supported', 'not_supported', 'follow_up', 'not_applicable']
const RELATIONS = [null, 'supports', 'qualifies', 'contradicts', 'context'] as const
const CALLS: ReviewMainCall[] = ['item', 'item', 'item', 'head', 'head', 'delete', 'link', 'unlink', 'markReady', 'export', 'reopen', 'get']

type Action = 'markReady' | 'export' | 'reopen'

/** What the run did, summed over the seeds (printed on a long run). */
const tally = { seeds: 0, steps: 0, arrivals: 0, refusedActions: 0, failures: 0, heals: 0, deletes: 0, links: 0, acceptedChecks: 0 }

type HeadField = 'title' | 'reviewerLabel' | 'generalNote'
const HEAD_FIELDS: readonly HeadField[] = ['title', 'reviewerLabel', 'generalNote']
const ITEM_FIELDS = ['decision', 'reviewerNote'] as const

/** One seed, end to end. Null when every check held, else the failure with its seed and steps. */
async function runSeed(seed: number): Promise<string | null> {
  const random = seeded(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!
  purgeReviewSession()
  const detail = fixture()
  const main = reviewMain(detail)
  stubReviewApi(main.api)
  const steps: string[] = []
  const failure = (why: string): string => `seed ${seed}: ${why}\n  steps: ${steps.join(' | ')}`
  const running = new Set<Promise<unknown>>()
  let violation: string | null = null
  const track = (p: Promise<unknown>, done?: () => void): void => {
    running.add(p)
    p.then(
      () => {
        running.delete(p)
        done?.()
      },
      (e: unknown) => {
        running.delete(p)
        violation ??= `a store call rejected: ${String(e)}`
      }
    )
  }
  const actions: Array<{ kind: Action; edits: number; arrived: boolean; done: boolean }> = []
  /** Selections whose removal is on its way: a link or unlink picks one half the time (the S-W2-1 order). */
  const removing = new Set<string>()
  const pickTarget = (from: readonly EvidenceReviewItem[]): EvidenceReviewItem => {
    const going = from.filter((i) => removing.has(i.id))
    return going.length > 0 && random() < 0.5 ? pick(going) : pick(from)
  }
  let n = 0

  // (d): the last value the store accepted per field. An item is forgotten once its delete succeeded (main no longer holds it).
  const acceptedItems = new Map<string, { decision?: ReviewDecision; reviewerNote?: string | null }>()
  const acceptedHead: Partial<Record<HeadField, string | null>> = {}
  /** Every accepted value main or the screen does not hold now. */
  function lostEdits(): string[] {
    const saved = main.db()
    const shown = getReviewSessionSnapshot().detail
    const out: string[] = []
    const check = (what: string, want: unknown, inMain: unknown, onScreen: unknown): void => {
      tally.acceptedChecks += 1
      if (inMain !== want) out.push(`${what}: accepted ${JSON.stringify(want)}, saved ${JSON.stringify(inMain)}`)
      if (onScreen !== want) out.push(`${what}: accepted ${JSON.stringify(want)}, shown ${JSON.stringify(onScreen)}`)
    }
    for (const field of HEAD_FIELDS) {
      if (acceptedHead[field] !== undefined) check(field, acceptedHead[field], saved[field], shown?.[field])
    }
    for (const [id, fields] of acceptedItems) {
      const row = saved.items.find((i) => i.id === id)
      const seen = shown?.items.find((i) => i.id === id)
      for (const field of ITEM_FIELDS) {
        if (fields[field] !== undefined) check(`${id}.${field}`, fields[field], row?.[field], seen?.[field])
      }
    }
    return out
  }
  const failedWrites = (): number => main.failuresDelivered('item') + main.failuresDelivered('head')

  main.onArrival = (kind) => {
    if (kind !== 'markReady' && kind !== 'export' && kind !== 'reopen') return
    tally.arrivals += 1
    const action = actions.find((a) => a.kind === kind && !a.arrived && !a.done)
    if (action) action.arrived = true
    const diff = reviewDiff(getReviewSessionSnapshot().detail, main.db(), { links: false })
    if (diff.length > 0) violation ??= `${kind} reached main with edits on screen not saved: ${diff.join('; ')}`
  }

  // (b), per error: each time the save line turns to an error, main must have failed a call this segment that no earlier
  // error accounts for (an export's failure never sets the line, so it is not counted). Watched after every step and
  // every settle round; an error set and cleared inside one step goes unseen, which only weakens the check.
  let onsets = 0
  let wasError = false
  let failedAtStart = 0
  const failedCalls = (): number => main.failuresDelivered() - main.failuresDelivered('export')
  function observe(): void {
    const s = getReviewSessionSnapshot()
    const isError = s.saveState === 'error'
    if (isError && !wasError) onsets += 1
    wasError = isError
    const failed = failedCalls() - failedAtStart
    if (onsets > failed) {
      violation ??= `a save error with no failed call to cause it (errors ${onsets}, failed calls ${failed}, saveError ${JSON.stringify(s.saveError)})`
    }
  }

  /** Every answer released, every timer run, every started call settled; arms nothing new. */
  async function settle(): Promise<boolean> {
    main.cancelPlans()
    for (let round = 0; round < 50; round++) {
      for (const held of main.held()) held.release()
      await flush()
      observe()
      await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
      await flush()
      observe()
      if (main.held().length === 0 && vi.getTimerCount() === 0 && running.size === 0) return true
    }
    return false
  }

  /**
   * An edit, applied through the store; counted against every action still on its way to main when it is taken. `itemId`
   * null = a head edit. The store must refuse it exactly when editing is closed; `keep` records what it accepted (d).
   */
  function edit(label: string, itemId: string | null, apply: () => void, keep: () => void): string {
    if (actions.some((a) => !a.arrived && !a.done && a.edits >= EDITS_PER_ACTION)) return `${label} (skipped: cap)`
    const before = getReviewSessionSnapshot()
    const d = before.detail
    const open = d != null && (itemId == null || (d.status !== 'ready' && !before.finishing && d.items.some((i) => i.id === itemId)))
    apply()
    const took = getReviewSessionSnapshot() !== before
    if (took !== open) violation ??= `the store ${took ? 'took' : 'refused'} "${label}" with editing ${open ? 'open' : 'closed'}`
    if (!took) return `${label} (refused)`
    keep()
    for (const a of actions) if (!a.arrived && !a.done) a.edits += 1
    return label
  }
  const keepItem = (id: string, patch: { decision?: ReviewDecision; reviewerNote?: string | null }): void => {
    acceptedItems.set(id, { ...acceptedItems.get(id), ...patch })
  }
  function decide(item: EvidenceReviewItem): string {
    const decision = random() < 0.15 ? 'not_reviewed' : pick(DECIDED)
    return edit(`decide ${item.id} ${decision}`, item.id, () => editReviewItem(item.id, { decision }), () => keepItem(item.id, { decision }))
  }
  function note(item: EvidenceReviewItem): string {
    const reviewerNote = random() < 0.1 ? null : `n${++n}`
    return edit(`note ${item.id} ${reviewerNote}`, item.id, () => editReviewItem(item.id, { reviewerNote }), () => keepItem(item.id, { reviewerNote }))
  }
  function head(): string {
    const field = pick(HEAD_FIELDS)
    const value = field !== 'title' && random() < 0.15 ? null : `${field[0]}${++n}`
    return edit(`head ${field} ${value}`, null, () => editReviewHead({ [field]: value }), () => {
      acceptedHead[field] = value
    })
  }

  function act(kind: Action, start: () => Promise<unknown>): string {
    const action = { kind, edits: 0, arrived: false, done: false }
    actions.push(action)
    track(start(), () => {
      action.done = true
      if (!action.arrived) tally.refusedActions += 1
    })
    return kind
  }

  /** Try again. Main is slow to answer its re-read (nothing queued, S-2) half the time: a window for edits typed during it. */
  function tryAgain(): string {
    const held = random() < 0.5
    if (held) main.holdNext('get', random() < 0.25 ? 'fail' : 'answer')
    track(retryReviewSave())
    return `try again${held ? ' (a read held)' : ''}`
  }

  async function step(): Promise<string> {
    const s = getReviewSessionSnapshot()
    const items = s.detail?.items ?? []
    // A user who sees the error line often clicks Try again soon (a quarter of the steps while it shows; plus the 3 % below).
    if (s.saveState === 'error' && random() < 0.25) return tryAgain()
    const roll = random() * 100
    if (roll < 14 && items.length) return decide(pick(items))
    if (roll < 26 && items.length) return note(pick(items))
    if (roll < 36) return head()
    if (roll < 40) {
      const selections = items.filter((i) => i.kind === 'selection')
      if (!selections.length) return 'remove (none)'
      const id = pick(selections).id
      const held = random() < 0.3 // main is slow to answer this one: a window for links and edits
      if (held) main.holdNext('delete', random() < 0.25 ? 'fail' : 'answer')
      removing.add(id)
      tally.deletes += 1
      track(deleteReviewSelection(id), () => {
        removing.delete(id)
        if (!main.db().items.some((i) => i.id === id)) acceptedItems.delete(id) // the delete succeeded
      })
      return `remove ${id}${held ? ' (answer held)' : ''}`
    }
    if (roll < 46) {
      if (!items.length) return 'link (none)'
      const item = pickTarget(items)
      const key = pick(['s1', 's2'])
      const relation = pick(RELATIONS)
      tally.links += 1
      track(linkEvidence(item.id, key, relation))
      return `link ${item.id} ${key} ${relation}`
    }
    if (roll < 49) {
      const linked = items.filter((i) => i.links.length > 0)
      if (!linked.length) return 'unlink (none)'
      const item = pickTarget(linked)
      const key = pick(item.links).evidenceKey
      track(unlinkEvidence(item.id, key))
      return `unlink ${item.id} ${key}`
    }
    if (roll < 63) {
      const ms = pick([0, 50, 200, 400, REVIEW_SAVE_DEBOUNCE_MS + 10])
      await vi.advanceTimersByTimeAsync(ms)
      return `+${ms}ms`
    }
    if (roll < 67) {
      if (s.detail?.status !== 'draft') return 'markReady (not draft)'
      return act('markReady', markReviewReady)
    }
    if (roll < 70) return act('export', () => exportReviewPack({}))
    if (roll < 73) {
      if (s.detail?.status !== 'ready') return 'reopen (not ready)'
      return act('reopen', reopenReview)
    }
    if (roll < 76) {
      if (s.saveState !== 'error') return 'try again (no error)'
      return tryAgain()
    }
    if (roll < 86) {
      const kind = pick(CALLS)
      const then = random() < 0.25 ? 'fail' : 'answer'
      main.holdNext(kind, then)
      return `hold next ${kind}${then === 'fail' ? ' (then fail)' : ''}`
    }
    if (roll < 90) {
      const kind = pick(CALLS)
      main.failNext(kind)
      return `fail next ${kind}`
    }
    const held = main.held()
    if (!held.length) return 'release (none held)'
    const one = pick(held)
    one.release()
    return `release ${one.kind}`
  }

  await openReviewSession({ reviewId: detail.id })
  await flush()
  for (let segment = 0; segment < SEGMENTS; segment++) {
    const failuresBefore = main.failuresDelivered()
    const writeFailuresBefore = failedWrites()
    failedAtStart = failedCalls()
    onsets = 0
    wasError = getReviewSessionSnapshot().saveState === 'error'
    for (let i = 0; i < STEPS_PER_SEGMENT; i++) {
      steps.push(await step())
      tally.steps += 1
      await flush()
      observe()
      if (violation) return failure(violation)
      // "Saving…" needs something that will end it: a scheduled save, an answer still to come, or a call still running.
      const quiet = vi.getTimerCount() === 0 && main.held().length === 0 && running.size === 0
      if (quiet && getReviewSessionSnapshot().saveState === 'pending') return failure('"Saving…" with nothing left to save')
    }
    if (!(await settle())) return failure('did not settle: an answer, a timer or a store call is still pending')
    if (violation) return failure(violation)
    tally.failures += main.failuresDelivered() - failuresBefore
    const s = getReviewSessionSnapshot()
    if (s.finishing) return failure('still read-only after settling')
    if (s.saveState === 'pending') return failure('"Saving…" with nothing left to save')
    if (s.saveState === 'error') {
      if (main.failuresDelivered() === failuresBefore) {
        return failure(`a save error with no failed call in the segment (saveError ${JSON.stringify(s.saveError)})`)
      }
      // Main is slow to answer Try again's re-read (when nothing is queued it re-reads, S-2), and one more edit is typed
      // while it is out: the one path that puts main's read on screen (d).
      main.holdNext('get')
      track(retryReviewSave())
      await flush()
      const items = getReviewSessionSnapshot().detail?.items ?? []
      const which = random()
      steps.push(`[Try again, then ${which < 0.4 && items.length ? decide(pick(items)) : which < 0.7 && items.length ? note(pick(items)) : head()}]`)
      tally.heals += 1
      if (violation) return failure(violation)
      if (!(await settle())) return failure('Try again did not settle')
      const healed = getReviewSessionSnapshot().saveState
      if (healed === 'error' || healed === 'pending') return failure(`Try again (main healthy) left "${healed}"`)
    }
    const diff = reviewDiff(getReviewSessionSnapshot().detail, main.db())
    if (diff.length > 0) return failure(`the screen differs from main after settling: ${diff.join('; ')}`)
    if (failedWrites() === writeFailuresBefore) {
      const lost = lostEdits()
      if (lost.length > 0) return failure(`an accepted edit is lost after settling: ${lost.join('; ')}`)
    }
    steps.push('[settled]')
  }
  tally.seeds += 1
  return null
}

beforeEach(() => {
  purgeReviewSession()
  stubReviewApi()
})

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    vi.useRealTimers()
    purgeReviewSession()
  }
})

describe('reviewSession — random orders of edits, removals, links, actions and main answers (#889, #901)', () => {
  it(
    `${SEEDS} seeded orders settle with the screen equal to main, no accepted edit lost, no false save error, and no action run over an unsaved edit`,
    async () => {
      vi.useFakeTimers()
      let first: string | null = null
      for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS && first == null; seed++) first = await runSeed(seed)
      if (process.env.HILBERTRAUM_REVIEW_ORDER_SEEDS) console.log(`review orders ${FIRST_SEED}..${FIRST_SEED + SEEDS - 1}`, JSON.stringify(tally))
      expect(first).toBeNull()
    },
    testBudgetMs(Math.max(60_000, SEEDS * 100))
  )
})
