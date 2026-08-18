import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/** POST /api/apps/sync — an app asking to be re-read after a deploy. */
export default defineEventHandler(async (event) => {
  const token = await requireServiceToken(event)
  await enforceRateLimit('manifest-ping:app', token.name)

  const app = await db.select().from(schema.apps)
    .where(eq(schema.apps.name, token.name)).get()
  if (!app) {
    throw createError({ statusCode: 404, statusMessage: 'This token belongs to no registered app' })
  }

  // An app can only ever ask for itself: the token names it.
  return await syncApp(app)
})
