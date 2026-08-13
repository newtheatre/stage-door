import { db, schema } from '@nuxthub/db'
import { and, asc, eq, sql } from 'drizzle-orm'

/**
 * GET /api/role-definitions — list (admin). Each carries `defaultExpiresAt`
 * — the epoch-ms expiry a grant made RIGHT NOW would default to (null =
 * permanent), computed server-side so the committee-year maths stays
 * testable and the UI stays dumb — and `holders`, the count of ACTIVE
 * grants of that role (expired ones don't count, ADR-0011).
 */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)

  const rows = await db.select().from(schema.roleDefinitions)
    .orderBy(asc(schema.roleDefinitions.namespace), asc(schema.roleDefinitions.role))
    .all()

  // Active holders per role string, one grouped query for the whole page.
  // Real accounts only, so the count always matches what clicking through
  // to the (anonymised-filtered) user list shows.
  const counts = await db.select({
    role: schema.userRoles.role,
    holders: sql<number>`count(*)`,
  }).from(schema.userRoles)
    .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
    .where(and(activeRoleCondition(), isRealRow()))
    .groupBy(schema.userRoles.role)
    .all()
  const holdersByRole = new Map(counts.map(c => [c.role, c.holders]))

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
      holders: holdersByRole.get(`${d.namespace}:${d.role}`) ?? 0,
    })),
  }
})
