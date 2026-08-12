/**
 * Right to erasure — anonymise, never delete (docs/gdpr-retention.md,
 * ADR-0008, CLAUDE.md invariant 4).
 *
 * Rewrites the auth identity, deletes credentials/tokens/roles, bumps the
 * session epoch, and calls every registered app's anonymise hook. An
 * erasure is only *complete* when every hook succeeded — partial results
 * are returned so the caller can surface and retry. Idempotent end to end.
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
  }

  // App hooks are idempotent — always call them, even on re-runs, so a
  // previously-failed hook gets retried.
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
