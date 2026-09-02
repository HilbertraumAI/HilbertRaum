import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Standalone Node build of the commercial gate tool (src/main/tools/assert-commercial-drive.ts)
// into out/tools/, called by scripts/build-commercial-drive.{ps1,sh} with plain `node` (#233).
// A separate build, not a second electron-vite main entry: the main bundle runs
// `app.requestSingleInstanceLock()` on import and must stay one file. Dependencies (yaml)
// are bundled in so the tool needs nothing but Node; electron-builder excludes out/tools/.
export default defineConfig({
  build: {
    outDir: resolve(__dirname, 'out/tools'),
    emptyOutDir: true,
    target: 'node22',
    ssr: resolve(__dirname, 'src/main/tools/assert-commercial-drive.ts'),
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [/^node:/, ...builtinModules, 'electron'],
      output: { format: 'es', entryFileNames: 'assert-commercial-drive.mjs' }
    }
  },
  ssr: { noExternal: true, target: 'node' },
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  }
})
