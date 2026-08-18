import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** DELETE /api/apps/:id — deregister; hooks stop reaching it. */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const id = getRouterParam(event, 'id')!

  const app = await db.select().from(schema.apps).where(eq(schema.apps.id, id)).get()
  if (!app) throw createError({ statusCode: 404, statusMessage: 'App not found' })

  // SQLite cannot add ON DELETE to an existing table, so clear the link first
  // or the foreign key blocks the delete.
  await db.update(schema.serviceTokens).set({ appId: null }).where(eq(schema.serviceTokens.appId, id))
  await db.delete(schema.apps).where(eq(schema.apps.id, id))

  await writeAudit({
    actorUserId: admin.id,
    action: 'app.deregistered',
    target: id,
    detail: { name: app.name, namespace: app.namespace },
  })

  return { ok: true }
})
