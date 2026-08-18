import { db, schema } from '@nuxthub/db'
import { and, asc, eq, sql } from 'drizzle-orm'

/**
 * The estate's permission vocabulary, each with the roles that carry it and
 * how many people hold one. Answers "who can approve refunds?".
 */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)

  // Metadata, not a decision. Private: it carries names and holder counts.
  setHeader(event, 'Cache-Control', 'private, max-age=60')

  const permissions = await db.select().from(schema.appPermissions)
    .orderBy(asc(schema.appPermissions.namespace), asc(schema.appPermissions.key)).all()

  // One join for the whole page; the index on permission_id is what makes the
  // reverse lookup cheap.
  const links = await db.select({
    permissionId: schema.roleDefinitionPermissions.permissionId,
    roleKey: schema.roleDefinitions.roleKey,
    withdrawnAt: schema.roleDefinitions.withdrawnAt,
  }).from(schema.roleDefinitionPermissions)
    .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.roleDefinitionPermissions.roleDefinitionId))
    .all()

  const holders = await db.select({
    role: schema.userRoles.role,
    holders: sql<number>`count(*)`,
  }).from(schema.userRoles)
    .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
    .where(and(activeRoleCondition(), isRealRow()))
    .groupBy(schema.userRoles.role)
    .all()
  const holdersByRole = new Map(holders.map(h => [h.role, h.holders]))

  const linksByPermission = new Map<string, typeof links>()
  for (const link of links) {
    linksByPermission.set(link.permissionId, [...(linksByPermission.get(link.permissionId) ?? []), link])
  }

  return {
    permissions: permissions.map(permission => ({
      id: permission.id,
      namespace: permission.namespace,
      key: permission.key,
      description: permission.description,
      active: permission.active,
      roles: (linksByPermission.get(permission.id) ?? []).map(c => ({
        role: c.roleKey ?? '',
        withdrawn: c.withdrawnAt !== null,
        holders: holdersByRole.get(c.roleKey ?? '') ?? 0,
      })),
    })),
  }
})
