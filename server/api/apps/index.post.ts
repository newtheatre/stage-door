import { db, schema } from '@nuxthub/db'
import { eq, or } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  name: appNameSchema,
  namespace: namespaceSchema,
  displayName: z.string().min(1).max(80),
  baseUrl: baseUrlSchema,
  hooksEnabled: z.boolean().default(false),
  manifestEnabled: z.boolean().default(false),
})

/**
 * Register an app. This, not a deploy, is what adds one to the estate.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const body = await readValidatedBody(event, bodySchema.parse)

  const clash = await db.select().from(schema.apps)
    .where(or(eq(schema.apps.name, body.name), eq(schema.apps.namespace, body.namespace)))
    .get()
  if (clash) {
    const field = clash.name === body.name ? 'name' : 'namespace'
    throw createError({ statusCode: 409, statusMessage: `An app with that ${field} already exists` })
  }

  const [app] = await db.insert(schema.apps).values(body).returning()

  // Link an already-issued token, which is the usual order when an app was
  // integrated before the registry existed.
  await db.update(schema.serviceTokens)
    .set({ appId: app!.id })
    .where(eq(schema.serviceTokens.name, body.name))

  await writeAudit({
    actorUserId: admin.id,
    action: 'app.registered',
    target: app!.id,
    detail: { name: body.name, namespace: body.namespace, baseUrl: body.baseUrl, hooksEnabled: body.hooksEnabled, manifestEnabled: body.manifestEnabled },
  })

  return { app }
})
