import { z } from 'zod'

const bodySchema = z.object({
  // Typed confirmation: the admin must send the account's current email.
  confirmEmail: z.string().min(1),
})

/**
 * GDPR erasure. IRREVERSIBLE: verify the requester first
 * (docs/operations.md#user-operations). Idempotent; re-POST to retry hooks.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const target = await loadUserOr404(getRouterParam(event, 'id'), {
    notSelf: { actorId: admin.id, message: 'Use the self-service erasure on your own account' },
  })
  const { confirmEmail } = await readValidatedBody(event, bodySchema.parse)

  if (target.id === admin.id) {
    throw createError({ statusCode: 400, statusMessage: 'Use your own account page to close your account' })
  }
  if (confirmEmail.toLowerCase() !== target.email) {
    throw createError({ statusCode: 400, statusMessage: 'Confirmation email does not match the account' })
  }

  return eraseUser(target.id, { id: admin.id, via: 'admin' })
})
