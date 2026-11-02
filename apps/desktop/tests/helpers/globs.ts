/**
 * The electron-builder `files`/`asarUnpack` glob translator. It is the one `scripts/lib/shipped-packages.mjs` uses,
 * so the gates (`packaging.test.ts`, `asar-unpack-closure.test.ts`, #232) read a glob the way the notices do.
 */
export { globToRegExp } from '../../../../scripts/lib/shipped-packages.mjs'
