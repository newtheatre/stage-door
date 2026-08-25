/**
 * Right to erasure: anonymise, never delete. Complete only when every app
 * hook succeeded; partial results are returned so it can be retried.
 */

import { db, schema } from '@nuxthub/db'
import { eq, sql } from 'drizzle-orm'
import type { HookResult } from './appHooks'

export interface EraseResult {
  userId: string
  alreadyErased: boolean
  complete: boolean
  hooks: { app: string, ok: boolean }[]
}

export async function eraseUser(userId: string, actor: { id: string | null, via: string }): Promise<EraseResult> {
  const user = await loadUserOr404(userId)

  const anonymisedEmail = `deleted-${userId}@anonymised.invalid`
  const alreadyErased = user.email === anonymisedEmail

  if (!alreadyErased) {
    // One batch, because `alreadyErased` is set by the first of these writes:
    // a half-applied scrub would report itself finished on the retry.
    await db.batch([
      db.update(schema.users)
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
        .where(eq(schema.users.id, userId)),
      db.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId)),
      db.delete(schema.emailVerifications).where(eq(schema.emailVerifications.userId, userId)),
      db.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, userId)),
      db.delete(schema.magicLinks).where(eq(schema.magicLinks.userId, userId)),
      // Second factors are credentials and personal data both (ADR-0012).
      ...factorClearStatements(userId),
      // Neither is a statistic that must survive: one records a named person's
      // training standing, the other when we warned them (ADR-0008).
      db.delete(schema.eligibilitySnapshots).where(eq(schema.eligibilitySnapshots.userId, userId)),
      db.delete(schema.retentionNotices).where(eq(schema.retentionNotices.userId, userId)),
    ])
  }

  // Outside the branch above: a retry of a failed erasure must redact too, and
  // rewriting an already-redacted row changes nothing (ADR-0026).
  await redactAuditDetail(userId)

  // App hooks are idempotent, so call them on every run: that is what retries
  // a hook that failed before.
  let hooks: HookResult<{ ok: boolean }>[] = []
  let complete = false
  try {
    hooks = await callAllAppHooks<{ ok: boolean }>('anonymise', { userId })

    // every() is vacuously true on an empty list, which would report an erasure
    // nobody was told about as done. An app answering 200 { ok: false } refused.
    complete = hooks.length > 0 && hooks.every(h => h.ok && h.data?.ok !== false)
  }
  finally {
    // The scrub is already committed, so the audit row must be written either
    // way: the sweep re-drives off `user.erase-incomplete` and nothing else.
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
  }

  // No upstream error text: this is returned to the member by /api/account/erase.
  return { userId, alreadyErased, complete, hooks: hooks.map(({ app, ok }) => ({ app, ok })) }
}
