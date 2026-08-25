import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  // null clears the marker.
  email: emailSchema.nullable(),
})

/**
 * Admin-directed link: the next Google sign-in with this address attaches to
 * this account. An admin can never complete a link alone.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))
  const { email } = await readValidatedBody(event, bodySchema.parse)

  if (email !== null) {
    if (!email.endsWith(`@${WORKSPACE_DOMAIN}`)) {
      throw createError({ statusCode: 400, statusMessage: `Must be an @${WORKSPACE_DOMAIN} address` })
    }
    if (user.googleSub !== null) {
      throw createError({ statusCode: 400, statusMessage: 'This account already has a Google account linked' })
    }

    // Refuse addresses already linked or pending elsewhere.
    const linkedElsewhere = await db.select().from(schema.users)
      .where(eq(schema.users.email, email)).get()
    if (linkedElsewhere && linkedElsewhere.id !== user.id && linkedElsewhere.googleSub !== null) {
      throw createError({ statusCode: 409, statusMessage: 'That address is already linked to another account' })
    }
    const pendingElsewhere = await db.select().from(schema.users)
      .where(eq(schema.users.pendingGoogleEmail, email)).get()
    if (pendingElsewhere && pendingElsewhere.id !== user.id) {
      throw createError({ statusCode: 409, statusMessage: 'That address is already pending on another account' })
    }
  }

  await db.update(schema.users)
    .set({ pendingGoogleEmail: email })
    .where(eq(schema.users.id, user.id))

  await writeAudit({
    actorUserId: admin.id,
    action: email === null ? 'google.pending-link-cleared' : 'google.pending-link-set',
    target: user.id,
    // The address is on the row until the link completes; it must not
    // outlive an erasure in here (same rule as user.erased).
    detail: { via: 'admin' },
  })

  return { ok: true }
})
