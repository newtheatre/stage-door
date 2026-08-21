import { db, schema } from '@nuxthub/db'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

const bodySchema = z.object({
  role: roleSchema,
  // Null clears it. Bounded so an override cannot quietly become permanent.
  until: z.number().int().positive().nullable(),
  note: z.string().max(500).optional(),
})

/**
 * Lift an enforcing training prerequisite for one grant, for a while.
 * For a wrong snapshot, or training earned during an outage (ADR-0019).
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const user = await loadUserOr404(getRouterParam(event, 'id'))
  const { role, until, note } = await readValidatedBody(event, bodySchema.parse)

  const MAX_DAYS = 90
  if (until !== null && until > Date.now() + MAX_DAYS * 24 * 60 * 60 * 1000) {
    throw createError({ statusCode: 400, statusMessage: `An override cannot run beyond ${MAX_DAYS} days` })
  }

  const [updated] = await db.update(schema.userRoles)
    .set({ eligibilityOverrideUntil: until === null ? null : new Date(until) })
    .where(and(eq(schema.userRoles.userId, user.id), eq(schema.userRoles.role, role)))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 404, statusMessage: 'This user does not hold that role' })
  }

  await writeAudit({
    actorUserId: admin.id,
    action: until === null ? 'user.eligibility-override-cleared' : 'user.eligibility-override-set',
    target: user.id,
    detail: { role, until, note: note ?? null },
  })

  return { ok: true }
})
