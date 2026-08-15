import { z } from 'zod/v4'

const bodySchema = z.object({
  loserId: z.string().min(1),
  confirmEmail: z.string().optional(),
  dryRun: z.boolean().optional(),
})

/**
 * Absorb another account into this one; `:id` is the WINNER. A commit
 * requires typing the losing account's email (ADR-0015).
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const winnerId = getRouterParam(event, 'id')!
  const { loserId, confirmEmail, dryRun } = await readValidatedBody(event, bodySchema.parse)

  if (!dryRun) {
    const loser = await loadUserOr404(loserId)
    if ((confirmEmail ?? '').toLowerCase() !== loser.email) {
      throw createError({ statusCode: 400, statusMessage: 'Confirmation email does not match the losing account' })
    }
  }

  return mergeUsers(winnerId, loserId, { id: admin.id }, { dryRun: dryRun ?? false })
})
