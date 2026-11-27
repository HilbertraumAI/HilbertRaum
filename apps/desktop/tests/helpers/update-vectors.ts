// The update verifier's contract vectors (app-update F-1–F-4; docs/app-updates.md §10.7): one reader for the sets under
// tests/fixtures/updates/vectors/, shared by the envelope runner (updates-envelope.test.ts) and the pipeline runner
// (updates-payload.test.ts), so both read a set the same way. It lists a set's files by name, reads each as a bare JSON
// array (§10.7 "File shape and routing"), guards each vector's form, and builds member 0's bytes from a vector's
// `envelope`. It throws, so a runner fails at collection and never passes on nothing, when a listed set does not exist,
// a file is no bare array or holds no vector, a set holds no vector, or a `vectors*.json` vector has not exactly one of
// the two forms (an `envelope`, or a `version` alone). No src/ import: the vectors' expected values never come from the
// code under test (C14), and the bytes are built here without it.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_ROOT } from './repo-files'

export const VECTORS_DIR: string = join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates', 'vectors')

/** spec/ holds these three files instead of `vectors*.json` (§10.7 "Folder"); their vectors have no envelope. */
export const SPEC_FILES: readonly string[] = ['pae.json', 'ed25519.json', 'key-set.json']

/** A set's vector files: `vectors.json` or `vectors-<part>.json` (§10.7 "Folder"). */
const VECTOR_FILE = /^vectors.*\.json$/

/** One part of an envelope held as parts (§10.7 "`envelope`"). */
export type VectorPart = { base64: string } | { text: string } | { repeat: string; times: number }

/** A pipeline vector (§10.7 "A vector"): an `envelope` with its `keys`, or a `version` alone. */
export interface Vector {
  id: string
  why: string
  /** The key set: Ed25519 SPKI DER in standard base64 (§2.7). */
  keys?: string[]
  envelope?: string | { parts: VectorPart[] }
  version?: string
  host: Record<string, unknown>
  expect: Record<string, unknown>
}

/** One file of a set, with its vectors. */
export interface VectorSetFile {
  set: string
  file: string
  vectors: Vector[]
}

/** One vector file: a bare JSON array, one vector per element (§10.7 "File shape and routing"); never empty. */
export function vectorFile<T>(set: string, name: string): T[] {
  const all: unknown = JSON.parse(readFileSync(join(VECTORS_DIR, set, name), 'utf8'))
  if (!Array.isArray(all) || all.length === 0) throw new Error(`${set}/${name} is no bare array of vectors`)
  return all as T[]
}

/**
 * Every file of a set, in name order: its `vectors*.json` (spec/: its three own files), each read by vectorFile. Throws
 * when the set does not exist or holds no vector, and when a `vectors*.json` vector has not exactly one form.
 */
export function vectorSetFiles(set: string): VectorSetFile[] {
  const dir = join(VECTORS_DIR, set)
  let names: string[]
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a folder')
    names = readdirSync(dir)
  } catch (err) {
    throw new Error(`the vector set ${set} does not exist: ${(err as Error).message}`)
  }
  const files = names
    .filter((name) => VECTOR_FILE.test(name) || (set === 'spec' && SPEC_FILES.includes(name)))
    .sort()
    .map((file) => ({ set, file, vectors: vectorFile<Vector>(set, file) }))
  if (files.every((f) => f.vectors.length === 0)) throw new Error(`the vector set ${set} holds no vector`)
  for (const { file, vectors } of files) {
    if (!VECTOR_FILE.test(file)) continue
    for (const v of vectors) {
      if ((v.envelope === undefined) === (v.version === undefined)) throw new Error(`${set}/${file} ${v.id} has no single form`)
    }
  }
  return files
}

/** Every vector of a set, with its file (vectorSetFiles, flattened). */
export function setVectors(set: string): Array<{ set: string; file: string; vector: Vector }> {
  return vectorSetFiles(set).flatMap(({ file, vectors }) => vectors.map((vector) => ({ set, file, vector })))
}

/** Standard base64 that re-encodes to itself: a vector's own encoding, never misread by a lenient decoder. */
function canonicalBase64(text: string): Buffer {
  const bytes = Buffer.from(text, 'base64')
  if (bytes.toString('base64') !== text) throw new Error('a vector holds base64 that is not canonical')
  return bytes
}

/** Member 0's bytes as §10.7 "`envelope`" writes them: one base64 string, or the parts joined in order. */
export function envelopeBytes(envelope: NonNullable<Vector['envelope']>): Buffer {
  if (typeof envelope === 'string') return canonicalBase64(envelope)
  return Buffer.concat(
    envelope.parts.map((part) => {
      if ('base64' in part) return canonicalBase64(part.base64)
      if ('text' in part) return Buffer.from(part.text, 'utf8')
      if ('repeat' in part) return Buffer.from(part.repeat.repeat(part.times), 'utf8')
      throw new Error(`a part of no known form: ${JSON.stringify(Object.keys(part))}`)
    })
  )
}
