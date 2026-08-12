import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  description: z.string().min(1).max(500),
  defaultExpiry: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }),
    z.object({ kind: z.literal('committee-year') }),
    z.object({ kind: z.literal('days'), days: z.number().int().min(1).max(3650) }),
  ]),
})

/**
 * PUT /api/role-definitions/:id — update description/default (admin) [AUD].
 * The namespace:role identity is immutable — delete and recreate to rename.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const id = getRouterParam(event, 'id')!
  const { description, defaultExpiry } = await readValidatedBody(event, bodySchema.parse)

  const [definition] = await db.update(schema.roleDefinitions)
    .set({
      description,
      defaultExpiryKind: defaultExpiry.kind,
      defaultExpiryDays: defaultExpiry.kind === 'days' ? defaultExpiry.days : null,
    })
    .where(eq(schema.roleDefinitions.id, id))
    .returning()

  if (!definition) {
    throw createError({ statusCode: 404, statusMessage: 'Role definition not found' })
  }

  await writeAudit({
    actorUserId: admin.id,
    action: 'role-definition.updated',
    target: id,
    detail: { namespace: definition.namespace, role: definition.role, defaultExpiry },
  })

  return { definition }
})
