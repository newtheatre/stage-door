import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  roles: z.array(roleSchema),
})

/**
 * PUT /api/users/:id/roles — replace the role set (admin).
 *
 * Propagates within 15 minutes on privileged surfaces via the staleness
 * refresh; pair with force-logout for instant effect (docs/operations.md).
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))
  const { roles } = await readValidatedBody(event, bodySchema.parse)

  const before = await loadRoles(user.id)

  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, user.id))
  for (const role of roles) {
    await db.insert(schema.userRoles).values({ userId: user.id, role })
  }

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.roles-changed',
    target: user.id,
    detail: { from: before, to: roles },
  })

  return { user: adminUserView(user, roles) }
})
