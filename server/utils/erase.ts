/**
 * Right to erasure — anonymise, never delete. Complete only when every app
 * hook succeeded; partial results are returned so it can be retried.
 */

import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'

export interface EraseResult {
  userId: string
  alreadyErased: boolean
  complete: boolean
  hooks: { app: string, ok: boolean, error?: string }[]
}

export async function eraseUser(userId: string, actor: { id: string | null, via: string }): Promise<EraseResult> {
  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get()
  if (!user) {
    throw createError({ statusCode: 404, statusMessage: 'User not found' })
  }

  const anonymisedEmail = `deleted-${userId}@anonymised.invalid`
  const alreadyErased = user.email === anonymisedEmail

  if (!alreadyErased) {
    await db.update(schema.users)
      .set({
        email: anonymisedEmail,
        name: 'Deleted user',
        password: null,
        googleSub: null,
        pendingGoogleEmail: null,
        verified: false,
        disabled: true,
        sessionEpoch: sql`${schema.users.sessionEpoch} + 1`,
      })
      .where(eq(schema.users.id, userId))

    await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId))
    await db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.userId, userId))
    await db.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, userId))
    await db.delete(schema.magicLinks).where(eq(schema.magicLinks.userId, userId))
    // Second factors are credentials and personal data both (ADR-0012).
    await clearAllFactors(userId)
  }

  // App hooks are idempotent, so call them on every run — that is what retries
  // a hook that failed before.
  const hooks = await callAllAppHooks<{ ok: boolean }>('anonymise', { userId })
  const complete = hooks.every(h => h.ok)

  await writeAudit({
    actorUserId: actor.id,
    action: complete ? 'user.erased' : 'user.erase-incomplete',
    // The audit entry references the anonymous id only (no personal data).
    target: userId,
    detail: {
      via: actor.via,
      hooks: hooks.map(h => ({ app: h.app, ok: h.ok })),
    },
  })

  return { userId, alreadyErased, complete, hooks: hooks.map(({ app, ok, error }) => ({ app, ok, error })) }
}
