/**
 * Bun test bootstrap: swaps the D1 binding and the published session
 * contract for local sources, then loads the globals.
 */

import { mock } from 'bun:test'

// Nuxt resolves `@nuxthub/db` from the hub layer, which needs a real binding.
const double = await import('./mocks/nuxthub-db')
mock.module('@nuxthub/db', () => double)

// Test the workspace source, not the last published build of it.
const authTypes = await import('../packages/auth-types/index')
mock.module('@newtheatre/auth-types', () => authTypes)

await import('./setup')
