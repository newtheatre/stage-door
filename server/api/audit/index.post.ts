import { z } from 'zod/v4'

const bodySchema = z.object({
  action: z.string().min(1).max(100),
  target: z.string().min(1).max(200),
  detail: z.string().max(2000).optional(),
})

/**
 * POST /api/audit — record a manual action (docs/operations.md, e.g.
 * "rotated session seal secret"). Actions recorded this way are prefixed
 * `manual.` so they can't impersonate system entries.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const { action, target, detail } = await readValidatedBody(event, bodySchema.parse)

  await writeAudit({
    actorUserId: admin.id,
    action: `manual.${action}`,
    target,
    detail: detail ? { note: detail } : undefined,
  })

  return { ok: true }
})
