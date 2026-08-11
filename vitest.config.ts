import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Tests run the real handlers/utils against an in-memory SQLite in
      // place of the D1 binding (docs/development.md#testing).
      '@nuxthub/db': fileURLToPath(new URL('./tests/mocks/nuxthub-db.ts', import.meta.url)),
      '@newtheatre/auth-types': fileURLToPath(new URL('./packages/auth-types/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
})
