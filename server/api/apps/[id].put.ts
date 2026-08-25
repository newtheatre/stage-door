import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  displayName: z.string().min(1).max(80),
  baseUrl: baseUrlSchema,
  hooksEnabled: z.boolean(),
  manifestEnabled: z.boolean(),
})

/**
 * Update an app's origin and hook switch. Name and namespace are immutable:
 * grants and tokens join on them (ADR-0017).
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const id = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, bodySchema.parse)

  const before = await db.select().from(schema.apps).where(eq(schema.apps.id, id)).get()
  if (!before) throw createError({ statusCode: 404, statusMessage: 'App not found' })

  const [app] = await db.update(schema.apps).set(body).where(eq(schema.apps.id, id)).returning()

  await writeAudit({
    actorUserId: admin.id,
    action: 'app.updated',
    target: id,
    detail: {
      name: before.name,
      from: { baseUrl: before.baseUrl, hooksEnabled: before.hooksEnabled, manifestEnabled: before.manifestEnabled, displayName: before.displayName },
      to: body,
    },
  })

  return { app }
})
