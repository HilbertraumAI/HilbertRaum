import { randomUUID } from 'node:crypto'

/**
 * Picker capability tokens. The renderer is the untrusted boundary; the OS file dialog is
 * owned by MAIN. Each dialog result is bound to a one-time opaque token that the consuming
 * handler redeems for the exact value main returned — the renderer never names a path it did
 * not pick. Documents (`pickDocuments` → `importDocuments`) have used this since D1; the
 * skills picker joined in #240 (`pickSkillPackage` → `previewSkillPackage` / `importSkill`).
 *
 * Bounded FIFO: past `cap` the oldest unconsumed token is evicted. No clock — a token lives
 * until it is consumed or evicted; the map is process-local and dies with the session.
 */
export const PICKER_TOKEN_CAP = 16

export interface PickerTokens<T> {
  /** Bind `value` to a fresh token and return the token. */
  mint(value: T): string
  /** Read the bound value WITHOUT spending the token; `undefined` for junk/unknown/spent. */
  peek(token: unknown): T | undefined
  /** Spend the token and return its value; `undefined` for junk/unknown/spent. */
  consume(token: unknown): T | undefined
  /** Live (unconsumed, unevicted) tokens. */
  size(): number
}

export function createPickerTokens<T>(cap: number = PICKER_TOKEN_CAP): PickerTokens<T> {
  const map = new Map<string, T>()
  const lookup = (token: unknown): string | undefined =>
    typeof token === 'string' && token !== '' && map.has(token) ? token : undefined
  return {
    mint(value) {
      const token = randomUUID()
      map.set(token, value)
      while (map.size > cap) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
      return token
    },
    peek(token) {
      const key = lookup(token)
      return key === undefined ? undefined : map.get(key)
    },
    consume(token) {
      const key = lookup(token)
      if (key === undefined) return undefined
      const value = map.get(key)
      map.delete(key)
      return value
    },
    size() {
      return map.size
    }
  }
}
