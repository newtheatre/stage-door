import { z } from 'zod'

const bodySchema = z.object({
  action: z.string().min(1).max(100),
  target: z.string().min(1).max(200),
  detail: z.string().max(2000).optional(),
})

/**
 * Record a manual action. Prefixed `manual.` so it cannot impersonate a
 * system entry.
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
