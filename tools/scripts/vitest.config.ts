import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Loaded by the root `test-tools` script with an explicit `--config`: the root vitest config collects src/ only, so these suites run in their own
// lane. `root` is this directory, so the test globs resolve here whatever the cwd; the tests themselves locate the repository from their own path.
// `clearMocks: false` keeps vitest 4's mock-call history (vitest 5 defaults it to true).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    clearMocks: false,
    environment: 'node',
    name: 'tools-scripts',
  },
})
