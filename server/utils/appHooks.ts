/**
 * Calling consumer-app hooks. Auth is the SHA-256 of the app's own service
 * token, which cannot be replayed inbound against this service.
 */

import { db, schema } from '@nuxthub/db'
import { desc, eq } from 'drizzle-orm'

/** An app name as registered, e.g. 'rehearsal'. Not its role namespace. */
export type HookApp = string

export type AppHook = 'export' | 'anonymise' | 'last-activity' | 'merge'

export interface HookResult<T> {
  app: HookApp
  ok: boolean
  data?: T
  /** Upstream detail. Log it, audit it, never put it in a response. */
  error?: string
}

/**
 * Apps that receive hooks. Read per call rather than memoised: the registry is
 * edited in the admin UI and must take effect without a deploy (ADR-0017).
 */
export async function loadHookApps() {
  return db.select().from(schema.apps)
    .where(eq(schema.apps.hooksEnabled, true))
    .all()
}

/** The newest token, so an overlap rotation sends the one just issued. */
async function hookBearer(app: HookApp): Promise<string> {
  const row = await db.select({ tokenHash: schema.serviceTokens.tokenHash })
    .from(schema.serviceTokens)
    .where(eq(schema.serviceTokens.name, app))
    .orderBy(desc(schema.serviceTokens.createdAt))
    .get()
  if (!row) throw new Error(`No service token registered for app '${app}'`)
  return row.tokenHash
}

/** Call one hook on one app. Never throws: failures come back in the result. */
export async function callAppHook<T>(app: HookApp, hook: AppHook, body: Record<string, unknown>): Promise<HookResult<T>> {
  try {
    const row = await db.select({ baseUrl: schema.apps.baseUrl, hooksEnabled: schema.apps.hooksEnabled })
      .from(schema.apps).where(eq(schema.apps.name, app)).get()
    if (!row) throw new Error(`App '${app}' is not registered`)
    if (!row.hooksEnabled) throw new Error(`Hooks are disabled for app '${app}'`)

    const bearer = await hookBearer(app)
    const data = await $fetch<T>(`${row.baseUrl}/api/_hooks/auth/${hook}`, {
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

/** Call the same hook on every app with hooks enabled. */
export async function callAllAppHooks<T>(hook: AppHook, body: Record<string, unknown>): Promise<HookResult<T>[]> {
  const registered = await loadHookApps()
  return Promise.all(registered.map(({ name }) => callAppHook<T>(name, hook, body)))
}
