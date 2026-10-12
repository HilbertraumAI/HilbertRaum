import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { canonicalCase, oneModulePerFile } from './path-casing'

// Paths from the canonical app directory + the one-module guard: see path-casing.ts (#646).
const appDir = canonicalCase(__dirname)

// Standalone Vite build for the screenshot-verify preview harness (src/renderer/preview). Reuses the
// renderer's @shared/@renderer aliases. Builds to out/preview as static files so the Electron
// capture script (scripts/screenshot.mjs) can load them over file:// — no dev server, fully offline.
export default defineConfig({
  root: resolve(appDir, 'src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(appDir, 'src/shared'),
      '@renderer': resolve(appDir, 'src/renderer')
    }
  },
  build: {
    outDir: resolve(appDir, 'out/preview'),
    emptyOutDir: true,
    rollupOptions: { input: { preview: resolve(appDir, 'src/renderer/preview/preview.html') } }
  },
  plugins: [react(), oneModulePerFile()]
})
