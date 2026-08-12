import { z } from 'zod/v4'

const bodySchema = z.object({
  // Typed confirmation: the admin must send the account's current email.
  confirmEmail: z.string().min(1),
})

/**
 * POST /api/users/:id/erase — GDPR erasure (admin) [AUD].
 *
 * IRREVERSIBLE. Anonymises the auth identity and every app's data via
 * hooks (docs/gdpr-retention.md). Verify the requester's identity first —
 * operations.md#user-operations. Returns per-hook status; re-POST to retry
 * failed hooks (idempotent).
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const target = await loadUserOr404(getRouterParam(event, 'id'))
  const { confirmEmail } = await readValidatedBody(event, bodySchema.parse)

  if (target.id === admin.id) {
    throw createError({ statusCode: 400, statusMessage: 'Use your own account page to close your account' })
  }
  if (confirmEmail.toLowerCase() !== target.email) {
    throw createError({ statusCode: 400, statusMessage: 'Confirmation email does not match the account' })
  }

  return eraseUser(target.id, { id: admin.id, via: 'admin' })
})
