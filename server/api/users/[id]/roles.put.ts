import { db, schema } from '@nuxthub/db'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod/v4'

const bodySchema = z.object({
  roles: z.array(roleGrantSchema).max(MAX_GRANTS_PER_REQUEST),
})

/**
 * Replace the grant set. Applied as a diff, so unchanged grants keep their
 * provenance. Full rules: docs/api-reference.md and ADR-0011/0014.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))
  const { roles } = await readValidatedBody(event, bodySchema.parse)

  const wanted = new Map(roles.map(g => [g.role, g]))
  if (wanted.size !== roles.length) {
    throw createError({ statusCode: 400, statusMessage: 'Duplicate roles in request' })
  }

  const existing = await db.select().from(schema.userRoles)
    .where(eq(schema.userRoles.userId, user.id)).all()
  const existingByRole = new Map(existing.map(r => [r.role, r]))

  await assertGrantsDefined(roles, new Set(existingByRole.keys()))

  // Aiming this at yourself is allowed; losing the last auth:ADMIN is not,
  // and a dated one lapses into the same lockout at handover.
  const wantedAdmin = wanted.get('auth:ADMIN')
  if (await holdsAuthAdmin(user.id) && (!wantedAdmin || wantedAdmin.expiresAt !== null)) {
    await assertNotLastAuthAdmin(user.id, wantedAdmin ? 'Dating that grant' : 'Removing that grant')
  }

  const before = await loadRoleGrants(user.id)

  // Removals: anything not in the wanted set (expired rows included — the
  // admin deleting an expired grant removes its history deliberately).
  for (const row of existing) {
    if (!wanted.has(row.role)) {
      await db.delete(schema.userRoles)
        .where(and(eq(schema.userRoles.userId, user.id), eq(schema.userRoles.role, row.role)))
    }
  }

  for (const grant of roles) {
    const current = existingByRole.get(grant.role)
    if (!current) {
      await db.insert(schema.userRoles).values({
        userId: user.id,
        role: grant.role,
        expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt),
        note: grant.note,
        grantedBy: admin.id,
        grantedAt: new Date(),
      })
      continue
    }

    const currentExpiry = current.expiresAt?.getTime() ?? null
    const expiryChanged = currentExpiry !== grant.expiresAt
    const noteChanged = (current.note ?? null) !== grant.note

    if (expiryChanged || noteChanged) {
      await db.update(schema.userRoles)
        .set({
          expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt),
          note: grant.note,
          // A changed expiry is a fresh act of granting: refresh provenance
          // and re-arm the warning (one warning per (grant, expiry value)).
          ...(expiryChanged
            ? { grantedBy: admin.id, grantedAt: new Date(), expiryWarnedAt: null }
            : {}),
        })
        .where(and(eq(schema.userRoles.userId, user.id), eq(schema.userRoles.role, grant.role)))
    }
  }

  await writeAudit({
    actorUserId: admin.id,
    action: 'user.roles-changed',
    target: user.id,
    detail: {
      from: before.map(g => ({ role: g.role, expiresAt: g.expiresAt })),
      to: roles.map(g => ({ role: g.role, expiresAt: g.expiresAt })),
    },
  })

  return { user: adminUserView(user, await loadRoleGrants(user.id)) }
})
