import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Default environment is node (the bulk of the suite tests main-process services). Renderer
// component tests opt into jsdom per-file with a `// @vitest-environment jsdom` docblock and
// pull in React Testing Library; the setup file registers @testing-library/jest-dom matchers.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    globals: true
  }
})
