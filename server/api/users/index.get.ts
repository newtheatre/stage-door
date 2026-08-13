import { db, schema } from '@nuxthub/db'
import { and, eq, isNull, isNotNull, like, or, sql, desc } from 'drizzle-orm'
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

// Anonymised/placeholder rows are excluded by default and surface as a
// count; the predicates live in adminUsers.ts (shared with the holder
// counts on role definitions).
const anonymisedRow = isAnonymisedRow()
const realRow = isRealRow()

// Accounts the ADR-0012 rollout wants an operator's eye on:
//  - a Workspace address that still has a password (should be Google-only,
//    and is usually a handed-over role account);
//  - an admin that signs in with a password and has no second factor.
const hasWorkspacePassword = and(
  like(schema.users.email, '%@newtheatre.org.uk'),
  isNotNull(schema.users.password),
)
const isAdminWithoutMfa = and(
  isNotNull(schema.users.password),
  sql`exists (select 1 from ${schema.userRoles} where ${schema.userRoles.userId} = ${schema.users.id} and ${schema.userRoles.role} like '%:ADMIN' and (${schema.userRoles.expiresAt} is null or ${schema.userRoles.expiresAt} > ${Date.now()}))`,
  sql`not exists (select 1 from ${schema.totpSecrets} where ${schema.totpSecrets.userId} = ${schema.users.id} and ${schema.totpSecrets.confirmedAt} is not null)`,
  sql`not exists (select 1 from ${schema.webauthnCredentials} where ${schema.webauthnCredentials.userId} = ${schema.users.id})`,
)

/**
 * GET /api/users?q=&role=&guest=&disabled=&anonymised=&page= — search/list
 * (admin). Anonymised/placeholder accounts are excluded by default and
 * reported via `hiddenAnonymised`; pass `anonymised=true` to list only them.
 */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)
  const { q, role, guest, disabled, anonymised, attention, page } = await getValidatedQuery(event, querySchema.parse)

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
    conditions.push(sql`exists (select 1 from ${schema.userRoles} where ${schema.userRoles.userId} = ${schema.users.id} and ${schema.userRoles.role} = ${role} and (${schema.userRoles.expiresAt} is null or ${schema.userRoles.expiresAt} > ${Date.now()}))`)
  }

  if (attention === 'workspace-password') conditions.push(hasWorkspacePassword)
  if (attention === 'admin-no-mfa') conditions.push(isAdminWithoutMfa)

  const where = conditions.length ? and(...conditions) : undefined

  const total = (await db.select({ total: sql<number>`count(*)` })
    .from(schema.users).where(where).get())?.total ?? 0

  // The number somewhere: how many anonymised/placeholder rows exist in all
  // (unfiltered — it's a standing fact about the store, not the search).
  const hiddenAnonymised = (await db.select({ n: sql<number>`count(*)` })
    .from(schema.users).where(anonymisedRow).get())?.n ?? 0

  // Standing counts for the dashboard banner — unfiltered, like the
  // anonymised count above.
  const needsAttention = {
    workspacePassword: (await db.select({ n: sql<number>`count(*)` })
      .from(schema.users).where(and(hasWorkspacePassword, realRow)).get())?.n ?? 0,
    adminNoMfa: (await db.select({ n: sql<number>`count(*)` })
      .from(schema.users).where(and(isAdminWithoutMfa, realRow)).get())?.n ?? 0,
  }

  const rows = await db.select().from(schema.users)
    .where(where)
    .orderBy(desc(schema.users.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)
    .all()

  const now = Date.now()
  const roleRows = rows.length
    ? await db.select().from(schema.userRoles).all()
    : []
  const rolesByUser = new Map<string, RoleGrant[]>()
  for (const r of roleRows) {
    const grant = {
      role: r.role,
      expiresAt: r.expiresAt?.getTime() ?? null,
      grantedAt: r.grantedAt?.getTime() ?? null,
      grantedBy: r.grantedBy,
      note: r.note,
      expired: r.expiresAt !== null && r.expiresAt.getTime() <= now,
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
