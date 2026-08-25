import { z } from 'zod'

const bodySchema = z.object({
  // Typed confirmation: the account's own email address.
  confirmEmail: z.string().min(1),
  // Required where a password exists. A fresh login is required either way:
  // a session alone is not enough for an irreversible act.
  password: z.string().optional(),
})

/**
 * POST /api/account/erase: self-service GDPR erasure [AUD]. IRREVERSIBLE.
 */
export default defineEventHandler(async (event) => {
  const { user, loggedInAt } = await requireAccountUser(event)
  const { confirmEmail, password } = await readValidatedBody(event, bodySchema.parse)

  if (confirmEmail.toLowerCase() !== user.email) {
    throw createError({ statusCode: 400, statusMessage: 'Confirmation email does not match your account' })
  }

  // Unconditional, and the only barrier a Google-only account has: linking an
  // identity already demands this, and linking is the reversible one.
  if (Date.now() - loggedInAt > FRESH_SESSION_MS) {
    throw createError({ statusCode: 401, statusMessage: 'Log in again before closing your account' })
  }

  if (user.password !== null) {
    const valid = password !== undefined && await verifyPassword(user.password, password)
    if (!valid) {
      throw createError({ statusCode: 401, statusMessage: 'Password is incorrect' })
    }
  }

  // Erasure is irreversible, so losing the last auth:ADMIN here cannot be
  // undone the way a role change can: recovery means hand-editing D1.
  if (await holdsAuthAdmin(user.id)) {
    await assertNotLastAuthAdmin(user.id, 'Closing your account')
  }

  const result = await eraseUser(user.id, { id: user.id, via: 'self-service' })

  await clearUserSession(event)

  return result
})
