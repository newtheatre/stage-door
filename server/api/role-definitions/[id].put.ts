import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  description: z.string().min(1).max(500),
  defaultExpiry: defaultExpirySchema,
  eligibilityMode: z.enum(['advisory', 'enforcing']).optional(),
})

/**
 * PUT /api/role-definitions/:id: update description/default (admin) [AUD].
 * The namespace:role identity is immutable: delete and recreate to rename.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const id = getRouterParam(event, 'id')!
  const { description, defaultExpiry, eligibilityMode } = await readValidatedBody(event, bodySchema.parse)

  const before = await db.select().from(schema.roleDefinitions)
    .where(eq(schema.roleDefinitions.id, id)).get()
  if (!before) {
    throw createError({ statusCode: 404, statusMessage: 'Role definition not found' })
  }

  if (eligibilityMode) {
    assertEligibilityModeAllowed(before.namespace, before.role, eligibilityMode)
  }

  const [definition] = await db.update(schema.roleDefinitions)
    .set({
      description,
      ...defaultExpiryColumns(defaultExpiry),
      // An admin edit pins the field so a later manifest cannot move it.
      defaultExpiryPinned: true,
      ...(eligibilityMode ? { eligibilityMode, eligibilityModePinned: true } : {}),
    })
    .where(eq(schema.roleDefinitions.id, id))
    .returning()

  await writeAudit({
    actorUserId: admin.id,
    action: 'role-definition.updated',
    target: id,
    detail: { namespace: definition!.namespace, role: definition!.role, defaultExpiry, eligibilityMode },
  })

  return { definition }
})
