import { db, schema } from '@nuxthub/db'
import { and, eq, inArray, isNull, isNotNull, like, or, sql, desc } from 'drizzle-orm'
import { z } from 'zod/v4'
import type { RoleGrant } from '~~/server/utils/session'

const querySchema = z.object({
  q: z.string().max(200).optional(),
  role: z.string().max(100).optional(),
  guest: z.enum(['true', 'false']).optional(),
  disabled: z.enum(['true', 'false']).optional(),
  anonymised: z.enum(['true']).optional(),
  attention: z.enum(['workspace-password', 'admin-no-mfa']).optional(),
  page: z.coerce.number().int().min(1).default(1),
})

const PAGE_SIZE = 20

// Anonymised rows are excluded by default and surface as a count; the
// predicates live in adminUsers.ts.
const anonymisedRow = isAnonymisedRow()
const realRow = isRealRow()

// Accounts the ADR-0012 rollout wants an operator's eye on — see
// docs/security.md#rollout-flags.
const hasWorkspacePassword = and(
  like(schema.users.email, '%@newtheatre.org.uk'),
  isNotNull(schema.users.password),
)
// Built per request, never hoisted: a module-scope `now` freezes for the
// lifetime of the isolate.
function isAdminWithoutMfa(now: Date) {
  return and(
    isNotNull(schema.users.password),
    activeGrantExists(sql`${schema.userRoles.role} like '%:ADMIN'`, now),
    sql`not exists (select 1 from ${schema.totpSecrets} where ${schema.totpSecrets.userId} = ${schema.users.id} and ${schema.totpSecrets.confirmedAt} is not null)`,
    sql`not exists (select 1 from ${schema.webauthnCredentials} where ${schema.webauthnCredentials.userId} = ${schema.users.id})`,
  )
}

/**
 * Search and list users. Anonymised accounts are excluded unless asked for.
 */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)
  const { q, role, guest, disabled, anonymised, attention, page } = await getValidatedQuery(event, querySchema.parse)

  const now = new Date()
  const adminNoMfa = isAdminWithoutMfa(now)
  const conditions = [anonymised === 'true' ? anonymisedRow : realRow]

  if (q) {
    const pattern = `%${q.toLowerCase()}%`
    conditions.push(or(like(schema.users.email, pattern), like(sql`lower(${schema.users.name})`, pattern)))
  }
  if (guest === 'true') {
    conditions.push(and(isNull(schema.users.password), isNull(schema.users.googleSub)))
  }
  if (guest === 'false') {
    conditions.push(or(isNotNull(schema.users.password), isNotNull(schema.users.googleSub)))
  }
  if (disabled) {
    conditions.push(eq(schema.users.disabled, disabled === 'true'))
  }
  if (role) {
    // Active holders only — expired grants don't count (ADR-0011).
    conditions.push(activeGrantExists(eq(schema.userRoles.role, role), now))
  }

  if (attention === 'workspace-password') conditions.push(hasWorkspacePassword)
  if (attention === 'admin-no-mfa') conditions.push(adminNoMfa)

  const where = conditions.length ? and(...conditions) : undefined

  const total = (await db.select({ total: sql<number>`count(*)` })
    .from(schema.users).where(where).get())?.total ?? 0

  // Three standing facts about the store, unfiltered by the search, so one
  // pass rather than three. Recomputed on every keystroke otherwise.
  const standing = await db.select({
    hiddenAnonymised: sql<number>`sum(case when ${anonymisedRow} then 1 else 0 end)`,
    workspacePassword: sql<number>`sum(case when ${and(hasWorkspacePassword, realRow)} then 1 else 0 end)`,
    adminNoMfa: sql<number>`sum(case when ${and(adminNoMfa, realRow)} then 1 else 0 end)`,
  }).from(schema.users).get()

  const hiddenAnonymised = standing?.hiddenAnonymised ?? 0
  const needsAttention = {
    workspacePassword: standing?.workspacePassword ?? 0,
    adminNoMfa: standing?.adminNoMfa ?? 0,
  }

  const rows = await db.select().from(schema.users)
    .where(where)
    .orderBy(desc(schema.users.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)
    .all()

  // Scoped to the page: bounded by PAGE_SIZE, not by the data, so the bound
  // parameter count cannot grow (D1 caps at 100).
  const roleRows = rows.length
    ? await db.select().from(schema.userRoles)
        .where(inArray(schema.userRoles.userId, rows.map(u => u.id))).all()
    : []
  // Same page-scoped bound as the grant query above.
  const effective = await loadEffectiveRolesFor(rows.map(u => u.id), now)

  const rolesByUser = new Map<string, RoleGrant[]>()
  for (const r of roleRows) {
    const expired = r.expiresAt !== null && r.expiresAt.getTime() <= now.getTime()
    const grant: RoleGrant = {
      role: r.role,
      expiresAt: r.expiresAt?.getTime() ?? null,
      grantedAt: r.grantedAt?.getTime() ?? null,
      grantedBy: r.grantedBy,
      note: r.note,
      expired,
      inert: !expired && !effective.get(r.userId)?.has(r.role),
      overrideUntil: r.eligibilityOverrideUntil?.getTime() ?? null,
    }
    rolesByUser.set(r.userId, [...(rolesByUser.get(r.userId) ?? []), grant])
  }

  return {
    users: rows.map(u => adminUserView(u, rolesByUser.get(u.id) ?? [])),
    total,
    page,
    pageSize: PAGE_SIZE,
    hiddenAnonymised,
    needsAttention,
  }
})
