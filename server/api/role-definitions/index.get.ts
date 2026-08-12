import { db, schema } from '@nuxthub/db'
import { asc } from 'drizzle-orm'

/**
 * GET /api/role-definitions — list (admin). Each carries `defaultExpiresAt`:
 * the epoch-ms expiry a grant made RIGHT NOW would default to (null =
 * permanent). Computed server-side so the committee-year maths stays
 * testable and the UI stays dumb.
 */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)

  const rows = await db.select().from(schema.roleDefinitions)
    .orderBy(asc(schema.roleDefinitions.namespace), asc(schema.roleDefinitions.role))
    .all()

  const now = new Date()
  return {
    definitions: rows.map(d => ({
      id: d.id,
      namespace: d.namespace,
      role: d.role,
      description: d.description,
      defaultExpiryKind: d.defaultExpiryKind,
      defaultExpiryDays: d.defaultExpiryDays,
      defaultExpiresAt:
        d.defaultExpiryKind === 'committee-year'
          ? nextCommitteeYearEnd(now).getTime()
          : d.defaultExpiryKind === 'days'
            ? now.getTime() + (d.defaultExpiryDays ?? 0) * 24 * 60 * 60 * 1000
            : null,
    })),
  }
})
