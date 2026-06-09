// Vitest setup, applied to every test file. Registers @testing-library/jest-dom matchers
// (toBeInTheDocument, toBeDisabled, …). Harmless in node-env tests — it only augments
// `expect`; jsdom is opted into per-file by the renderer tests' `@vitest-environment` docblock.
import '@testing-library/jest-dom/vitest'
