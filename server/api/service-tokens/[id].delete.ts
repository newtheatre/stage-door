import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** DELETE /api/service-tokens/:id — revoke (rotation: issue new, redeploy app, revoke old). */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const id = getRouterParam(event, 'id')!

  const [removed] = await db.delete(schema.serviceTokens)
    .where(eq(schema.serviceTokens.id, id))
    .returning()

  if (!removed) {
    throw createError({ statusCode: 404, statusMessage: 'Service token not found' })
  }

  await writeAudit({
    actorUserId: admin.id,
    action: 'service-token.revoked',
    target: id,
    detail: { name: removed.name },
  })

  return { ok: true }
})
