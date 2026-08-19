import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** DELETE /api/apps/:id — deregister; hooks stop reaching it. */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const id = getRouterParam(event, 'id')!

  const app = await db.select().from(schema.apps).where(eq(schema.apps.id, id)).get()
  if (!app) throw createError({ statusCode: 404, statusMessage: 'App not found' })

  // Deleted, not orphaned: requireServiceToken never consults app_id, so a
  // surviving token would still authenticate a decommissioned app inbound.
  const revoked = await db.delete(schema.serviceTokens)
    .where(eq(schema.serviceTokens.appId, id))
    .returning({ id: schema.serviceTokens.id })
  await db.delete(schema.apps).where(eq(schema.apps.id, id))

  await writeAudit({
    actorUserId: admin.id,
    action: 'app.deregistered',
    target: id,
    detail: { name: app.name, namespace: app.namespace, tokensRevoked: revoked.length },
  })

  return { ok: true }
})
