import { db, schema } from '@nuxthub/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod/v4'

const querySchema = z.object({
  actor: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
  target: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
})

const PAGE_SIZE = 50

/** GET /api/audit?actor=&action=&target=&page=: audit log query (admin). */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)
  const { actor, action, target, page } = await getValidatedQuery(event, querySchema.parse)

  const conditions = []
  if (actor) conditions.push(eq(schema.auditLog.actorUserId, actor))
  if (action) conditions.push(eq(schema.auditLog.action, action))
  if (target) conditions.push(eq(schema.auditLog.target, target))
  const where = conditions.length ? and(...conditions) : undefined

  const total = (await db.select({ total: sql<number>`count(*)` })
    .from(schema.auditLog).where(where).get())?.total ?? 0

  const entries = await db.select().from(schema.auditLog)
    .where(where)
    .orderBy(desc(schema.auditLog.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)
    .all()

  return { entries, total, page, pageSize: PAGE_SIZE }
})
