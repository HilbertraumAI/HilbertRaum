import type { ModelInfo } from '@shared/types'

/**
 * Pure availability predicates + the picker's display order, shared by `ModelsScreen` and
 * `lib/modelLibrary`. They live here (and NOT in the screen) so `modelLibrary` can read them
 * without importing the screen back — the group-face selector needs the same priority keys the
 * order uses, and `ModelsScreen → modelLibrary → ModelsScreen` would be a cycle.
 * `ModelsScreen` re-exports all three, so existing imports keep resolving unchanged.
 */

/**
 * Usable right now — no download needed. This is the VERIFIED/startable meaning: it drives the
 * picker order and the first-visit view choice, and the main process gates starts on the same
 * states. It is NOT the whole "On this drive" view any more — that view also lists known damaged
 * (`checksum_failed`) entries so they can be repaired; see `isModelOnDrive`.
 */
export function isModelInstalled(m: ModelInfo): boolean {
  return m.state === 'installed' || m.state === 'running' || m.state === 'ready'
}

/**
 * What the "On this drive" view shows (F3, Gate C1): a model that is usable right now, OR one
 * whose files are present but failed their checksum — the state whose whole recovery action
 * ("re-download it") lives on that row, so hiding it left the user no way back.
 *
 * Deliberately a view of KNOWN usable/repair states, never an inference about file presence:
 * `unsupported` and `not_recommended` say nothing about whether weights exist on the drive, and
 * the renderer has no backend presence contract to ask. Extending this set needs one first.
 */
export function isModelOnDrive(m: ModelInfo): boolean {
  return isModelInstalled(m) || m.state === 'checksum_failed'
}

/**
 * Runnable on THIS machine, by exactly the flag the card's RAM warning renders from
 * (`insufficientRam`, computed in the main process against the machine's whole-GB RAM).
 * Sharing the flag is the point: the order can never disagree with the "Needs at least N GB"
 * badge and banner printed on the card it moved.
 */
export function isModelRunnableHere(m: ModelInfo): boolean {
  return m.insufficientRam !== true
}

/**
 * DV-2 — display order for the chat picker (the cards below the active model).
 *
 * Three keys, in order:
 *  1. **Installed first** — a model already on the drive is usable now, while the rest cost a
 *     multi-GB download. It stays PRIMARY in Browse. (The On this drive view filters by the
 *     wider `isModelOnDrive`, so a damaged entry is listed too; it sorts with the rest.)
 *  2. **Recommended first** (issue #93 item 3) — the ★ card leads its group. On a fresh
 *     install with nothing on the drive, the recommendation is the ONE actionable answer the
 *     screen has for "which of these should I download?" — it must be the first card scanned,
 *     not sit wherever catalog order put it inside the runnable block. This supersedes the
 *     DV-2 "plays no part" stance for the UPWARD direction only (design-guidelines §11's DV-2
 *     note): the ★ still never crosses the installed/needs-download boundary.
 *  3. **Runnable on this machine first** — unconditionally. Catalog order is alphabetical, so
 *     without this key the picker opened on models the machine cannot run at all (on a 16 GB
 *     box: three of the first four cards carried a "Needs at least 20/24 GB RAM" warning) while
 *     the usable ones sat below the fold. Runnability is not a tiebreak of last resort here —
 *     "can this computer run it" outranks alphabetical, always.
 *
 * Keys 2 and 3 can never fight: whichever picker fires in the main process — RAM-best-fit, or
 * (PR #308, on a usable discrete card) graphics-memory-best-fit — RAM is always a hard gate, so
 * the ★ card is runnable by construction either way. Display order ONLY — the recommender in the
 * main process is untouched. `Array.prototype.sort` is stable, so models that tie on all keys
 * keep their catalog order.
 *
 * O8 — what this order does NOT promise once variants are grouped: the library renders task
 * sections of variant GROUPS, so the ordered list is read group-by-group (a group takes the
 * rank of its leader) and the variants inside a group keep their relative order. There is no
 * global installed-first boundary across the rendered rows; a group whose leader is installed
 * may still expand to needs-download siblings above the next group.
 */
export function orderPickerModels(list: ModelInfo[]): ModelInfo[] {
  return [...list].sort(
    (a, b) =>
      Number(isModelInstalled(b)) - Number(isModelInstalled(a)) ||
      Number(b.recommended === true) - Number(a.recommended === true) ||
      Number(isModelRunnableHere(b)) - Number(isModelRunnableHere(a))
  )
}
