import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone Vite build for the screenshot-verify preview harness (src/renderer/preview). Reuses the
// renderer's @shared/@renderer aliases. Builds to out/preview as static files so the Electron
// capture script (scripts/screenshot.mjs) can load them over file:// — no dev server, fully offline.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/preview'),
    emptyOutDir: true,
    rollupOptions: { input: { preview: resolve(__dirname, 'src/renderer/preview/preview.html') } }
  },
  plugins: [react()]
})
