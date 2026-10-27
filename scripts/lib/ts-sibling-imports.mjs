// Lets a plain-Node script import the knowledge-pack converter's TypeScript sources directly.
//
// Node 24 loads `.ts` files through type stripping, but `zim/html.ts` imports its siblings
// (`./math`, `./supsub`, `./tables`) without an extension, the bundler's convention, which
// Node's own resolver refuses. scripts/zim-html-perf.mjs stopped loading the moment the
// converter grew its first such import, and nobody noticed (#627); scripts/zim-dev-set-diff.mjs
// then carried a second copy of the fix. Both now register this one.

import { register } from 'node:module'

/** Resolve a relative, extension-less specifier that Node cannot find to its `.ts` file. Call
 *  it once, before the first dynamic `import()` of a converter file. */
export function registerTsSiblingImports() {
  register(
    `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\\.\\.?\\//.test(specifier) || /\\.[cm]?[jt]s$/.test(specifier)) throw err
    return next(specifier + '.ts', context)
  }
}`)}`
  )
}
