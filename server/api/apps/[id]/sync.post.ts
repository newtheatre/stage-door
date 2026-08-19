import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** POST /api/apps/:id/sync — the admin "Sync now" button. */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const id = getRouterParam(event, 'id')!

  const app = await db.select().from(schema.apps).where(eq(schema.apps.id, id)).get()
  if (!app) throw createError({ statusCode: 404, statusMessage: 'App not found' })

  const result = await syncApp(app)

  await writeAudit({
    actorUserId: admin.id,
    action: 'app.manifest-sync-requested',
    target: id,
    detail: { app: app.name, ok: result.ok },
  })

  return result
})
