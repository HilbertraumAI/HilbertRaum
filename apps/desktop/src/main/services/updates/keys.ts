// The update keys this build embeds (app-update W-1, F-3; docs/app-updates.md §2.7): keys.json's `key_set`, read once
// through the one parser (`parseKeySet`, envelope.ts). This is the one module that reads keys.json as a module; the
// release tools, the release guard and the walk read it as a file. The production set stays empty until the owner's
// key ceremony (O2), and no test key is ever written into it (plan C8, C15).
//
// A set that does not read embeds no key (fail closed: every update file then answers UPD-NOT-AVAILABLE, §2.3), and
// `valid` says so, for the startup line in main/index.ts. That line is also what keeps the set in the main bundle,
// where the release guard finds it (§2.7, "The release guard's reading").

import keysJson from './keys.json'
import { parseKeySet } from './envelope'
import type { UpdateKey } from './envelope'

/** The embedded keys, and whether keys.json's set read (when not, `keys` is empty). */
export interface EmbeddedKeySet {
  readonly keys: readonly UpdateKey[]
  readonly valid: boolean
}

function embedded(json: unknown): EmbeddedKeySet {
  const keySet = typeof json === 'object' && json !== null && Object.hasOwn(json, 'key_set') ? (json as Record<string, unknown>).key_set : undefined
  const read = parseKeySet(keySet)
  return read.valid ? { keys: read.keys, valid: true } : { keys: [], valid: false }
}

export const embeddedKeySet: EmbeddedKeySet = embedded(keysJson)
