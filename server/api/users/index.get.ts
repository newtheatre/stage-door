import { db, schema } from '@nuxthub/db'
import { and, eq, isNull, isNotNull, like, or, sql, desc } from 'drizzle-orm'
import { z } from 'zod/v4'

const querySchema = z.object({
  q: z.string().max(200).optional(),
  role: z.string().max(100).optional(),
  guest: z.enum(['true', 'false']).optional(),
  disabled: z.enum(['true', 'false']).optional(),
  anonymised: z.enum(['true']).optional(),
  page: z.coerce.number().int().min(1).default(1),
})

const PAGE_SIZE = 20

// Anonymised/placeholder accounts live on undeliverable domains (mirrors
// isUndeliverableEmail; SQL so the filter happens in the database). The
// legacy import brought in ~8.3k of them — they are records, not people who
// can log in, so listings exclude them by default and surface a count.
const UNDELIVERABLE_LIKE = [
  '%.invalid', '%.test', '%.example', '%.localhost',
  '%@example.com', '%@example.org', '%@example.net',
]
const isAnonymisedRow = or(...UNDELIVERABLE_LIKE.map(p => like(schema.users.email, p)))
const isRealRow = and(...UNDELIVERABLE_LIKE.map(p => sql`${schema.users.email} NOT LIKE ${p}`))

/**
 * GET /api/users?q=&role=&guest=&disabled=&anonymised=&page= — search/list
 * (admin). Anonymised/placeholder accounts are excluded by default and
 * reported via `hiddenAnonymised`; pass `anonymised=true` to list only them.
 */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)
  const { q, role, guest, disabled, anonymised, page } = await getValidatedQuery(event, querySchema.parse)

  const conditions = [anonymised === 'true' ? isAnonymisedRow : isRealRow]

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
    conditions.push(sql`exists (select 1 from ${schema.userRoles} where ${schema.userRoles.userId} = ${schema.users.id} and ${schema.userRoles.role} = ${role})`)
  }

  const where = conditions.length ? and(...conditions) : undefined

  const total = (await db.select({ total: sql<number>`count(*)` })
    .from(schema.users).where(where).get())?.total ?? 0

  // The number somewhere: how many anonymised/placeholder rows exist in all
  // (unfiltered — it's a standing fact about the store, not the search).
  const hiddenAnonymised = (await db.select({ n: sql<number>`count(*)` })
    .from(schema.users).where(isAnonymisedRow).get())?.n ?? 0

  const rows = await db.select().from(schema.users)
    .where(where)
    .orderBy(desc(schema.users.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)
    .all()

  const roleRows = rows.length
    ? await db.select().from(schema.userRoles).all()
    : []
  const rolesByUser = new Map<string, string[]>()
  for (const r of roleRows) {
    rolesByUser.set(r.userId, [...(rolesByUser.get(r.userId) ?? []), r.role])
  }

  return {
    users: rows.map(u => adminUserView(u, rolesByUser.get(u.id) ?? [])),
    total,
    page,
    pageSize: PAGE_SIZE,
    hiddenAnonymised,
  }
})
