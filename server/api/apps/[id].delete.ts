import { db, schema } from '@nuxthub/db'
import { and, eq, isNull, or } from 'drizzle-orm'

/** DELETE /api/apps/:id: deregister; hooks stop reaching it. */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const id = getRouterParam(event, 'id')!

  const app = await db.select().from(schema.apps).where(eq(schema.apps.id, id)).get()
  if (!app) throw createError({ statusCode: 404, statusMessage: 'App not found' })

  // Withdrawn before the app row goes, and by namespace so pre-existing
  // orphans go too: role_definitions.app_id has no foreign key to cascade.
  const [withdrawn, revoked] = await db.batch([
    db.update(schema.roleDefinitions)
      .set({ withdrawnAt: new Date() })
      .where(and(
        eq(schema.roleDefinitions.namespace, app.namespace),
        isNull(schema.roleDefinitions.withdrawnAt),
      ))
      .returning({ id: schema.roleDefinitions.id }),
    // Deleted, not orphaned: requireServiceToken never consults app_id, so a
    // surviving token would still authenticate a decommissioned app inbound.
    db.delete(schema.serviceTokens)
      .where(or(eq(schema.serviceTokens.name, app.name), eq(schema.serviceTokens.appId, id)))
      .returning({ id: schema.serviceTokens.id }),
    db.delete(schema.apps).where(eq(schema.apps.id, id)),
  ])

  await writeAudit({
    actorUserId: admin.id,
    action: 'app.deregistered',
    target: id,
    detail: {
      name: app.name,
      namespace: app.namespace,
      tokensRevoked: revoked.length,
      definitionsWithdrawn: withdrawn.length,
    },
  })

  return { ok: true }
})
