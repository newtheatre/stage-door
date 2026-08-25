/**
 * Per-app service tokens. Plaintext is shown once at creation; only the
 * SHA-256 is stored, compared constant-time per candidate row.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

export function hashServiceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function generateServiceToken(): string {
  return `nnt_svc_${randomBytes(32).toString('base64url')}`
}

/** Create a token for an app. Returns the plaintext: shown once, never stored. */
export async function createServiceToken(name: string): Promise<{ id: string, token: string }> {
  const token = generateServiceToken()

  // Reporting only, and null when the app is not registered yet: an app may be
  // integrated before it is in the registry (docs/integrating-an-app.md).
  const app = await db.select({ id: schema.apps.id })
    .from(schema.apps).where(eq(schema.apps.name, name)).get()

  const [row] = await db.insert(schema.serviceTokens)
    .values({ name, appId: app?.id ?? null, tokenHash: hashServiceToken(token) })
    .returning()
  return { id: row!.id, token }
}

type ServiceTokenRow = typeof schema.serviceTokens.$inferSelect

/**
 * Authenticate a server-to-server request. Stamps `last_used_at`, which is
 * monitored: a stale stamp on an active app means misconfiguration.
 */
export async function requireServiceToken(event: H3Event): Promise<ServiceTokenRow> {
  const authorization = getRequestHeader(event, 'authorization')

  if (authorization?.startsWith('Bearer nnt_svc_')) {
    const candidate = Buffer.from(hashServiceToken(authorization.slice('Bearer '.length)))

    // The table holds a handful of rows (one per app): compare against each
    // in constant time rather than looking up by hash.
    const rows = await db.select().from(schema.serviceTokens).all()
    for (const row of rows) {
      // timingSafeEqual throws on a length mismatch, which would 500 a request
      // that should simply be rejected.
      const stored = Buffer.from(row.tokenHash)
      if (stored.length !== candidate.length) continue
      if (!timingSafeEqual(candidate, stored)) continue

      await db.update(schema.serviceTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.serviceTokens.id, row.id))
      return row
    }
  }

  throw createError({ statusCode: 401, statusMessage: 'Invalid service token' })
}
