import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** GET /api/users/:id — full admin profile incl. roles and legacy ids. */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))

  const roles = await loadRoles(user.id)
  const legacyIds = await db.select({
    source: schema.legacyIds.source,
    legacyId: schema.legacyIds.legacyId,
  }).from(schema.legacyIds).where(eq(schema.legacyIds.userId, user.id)).all()

  return { user: { ...adminUserView(user, roles), legacyIds } }
})
