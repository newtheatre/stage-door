/**
 * Calling consumer-app hooks (docs/api-reference.md#app-hooks).
 *
 * Authentication is the SHA-256 of the app's own service token: the app
 * holds the plaintext (its AUTH_SERVICE_TOKEN worker secret) and can derive
 * the hash; this service only ever stored the hash. No plaintext is stored
 * anywhere, no second secret exists, and the hash cannot be replayed
 * INBOUND against this service (inbound auth needs the preimage).
 */

import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** Registered apps and their hook base URLs. Update when an app integrates. */
export const HOOK_APPS = [
  { name: 'proscenium', baseURL: 'https://newtheatre.org.uk' },
  { name: 'rooms', baseURL: 'https://rooms.newtheatre.org.uk' },
] as const

export type HookApp = (typeof HOOK_APPS)[number]['name']

export interface HookResult<T> {
  app: HookApp
  ok: boolean
  data?: T
  error?: string
}

async function hookBearer(app: HookApp): Promise<string> {
  const row = await db.select({ tokenHash: schema.serviceTokens.tokenHash })
    .from(schema.serviceTokens)
    .where(eq(schema.serviceTokens.name, app))
    .get()
  if (!row) throw new Error(`No service token registered for app '${app}'`)
  return row.tokenHash
}

/** Call one hook on one app. Never throws — failures come back in the result. */
export async function callAppHook<T>(app: HookApp, hook: 'export' | 'anonymise' | 'last-activity', body: Record<string, unknown>): Promise<HookResult<T>> {
  const { baseURL } = HOOK_APPS.find(a => a.name === app)!
  try {
    const bearer = await hookBearer(app)
    const data = await $fetch<T>(`${baseURL}/api/_hooks/auth/${hook}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body,
      retry: 2,
      retryDelay: 1000,
      timeout: 15_000,
    })
    return { app, ok: true, data }
  }
  catch (error) {
    console.error(`[hooks] ${app}/${hook} failed:`, error)
    return { app, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Call the same hook on every registered app. */
export async function callAllAppHooks<T>(hook: 'export' | 'anonymise' | 'last-activity', body: Record<string, unknown>): Promise<HookResult<T>[]> {
  return Promise.all(HOOK_APPS.map(({ name }) => callAppHook<T>(name, hook, body)))
}
