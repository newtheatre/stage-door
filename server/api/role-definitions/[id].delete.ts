import { db, schema } from '@nuxthub/db'
import { eq } from 'drizzle-orm'

/**
 * Remove a definition. Existing grants are untouched — definitions are UX
 * metadata, not the source of access (ADR-0011).
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const id = getRouterParam(event, 'id')!

  const [removed] = await db.delete(schema.roleDefinitions)
    .where(eq(schema.roleDefinitions.id, id))
    .returning()

  if (!removed) {
    throw createError({ statusCode: 404, statusMessage: 'Role definition not found' })
  }

  await writeAudit({
    actorUserId: admin.id,
    action: 'role-definition.deleted',
    target: id,
    detail: { namespace: removed.namespace, role: removed.role },
  })

  return { ok: true }
})
