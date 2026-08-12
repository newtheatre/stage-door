import { z } from 'zod/v4'

const bodySchema = z.object({
  // Typed confirmation: the account's own email address.
  confirmEmail: z.string().min(1),
  // Password-confirmed where a password exists (session alone is not enough
  // for an irreversible action on a possibly-unattended device).
  password: z.string().optional(),
})

/**
 * POST /api/account/erase — self-service GDPR erasure [AUD]. IRREVERSIBLE.
 */
export default defineEventHandler(async (event) => {
  const { user } = await requireAccountUser(event)
  const { confirmEmail, password } = await readValidatedBody(event, bodySchema.parse)

  if (confirmEmail.toLowerCase() !== user.email) {
    throw createError({ statusCode: 400, statusMessage: 'Confirmation email does not match your account' })
  }

  if (user.password !== null) {
    const valid = password !== undefined && await verifyPassword(user.password, password)
    if (!valid) {
      throw createError({ statusCode: 401, statusMessage: 'Password is incorrect' })
    }
  }

  const result = await eraseUser(user.id, { id: user.id, via: 'self-service' })

  await clearUserSession(event)

  return result
})
