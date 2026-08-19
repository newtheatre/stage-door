import { db, schema } from '@nuxthub/db'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  namespace: namespaceSchema,
  role: roleNameSchema,
  description: z.string().min(1).max(500),
  defaultExpiry: defaultExpirySchema,
})

/** POST /api/role-definitions: create a definition (admin) [AUD]. */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const { namespace, role, description, defaultExpiry } = await readValidatedBody(event, bodySchema.parse)

  const clash = await db.select().from(schema.roleDefinitions)
    .where(and(eq(schema.roleDefinitions.namespace, namespace), eq(schema.roleDefinitions.role, role)))
    .get()
  if (clash) {
    throw createError({ statusCode: 409, statusMessage: 'That role is already defined' })
  }

  const [definition] = await db.insert(schema.roleDefinitions).values({
    namespace,
    role,
    description,
    ...defaultExpiryColumns(defaultExpiry),
  }).returning()

  await writeAudit({
    actorUserId: admin.id,
    action: 'role-definition.created',
    target: definition!.id,
    detail: { namespace, role, defaultExpiry },
  })

  return { definition }
})
