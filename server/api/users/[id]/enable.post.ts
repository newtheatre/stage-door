import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** POST /api/users/:id/enable — reverse a disable. */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))

  assertNotAnonymised(user)

  await db.update(schema.users)
    .set({ disabled: false })
    .where(eq(schema.users.id, user.id))

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.enabled',
    target: user.id,
  })

  return { ok: true }
})
