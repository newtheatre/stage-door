import { z } from 'zod/v4'

const bodySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Lowercase app name, e.g. proscenium'),
})

/**
 * POST /api/service-tokens — issue a token for an app (docs/operations.md
 * #service-tokens). The plaintext is returned once; store it straight in
 * the password manager and the app's worker secret.
 */
export default defineEventHandler(async (event) => {
  const { user: admin } = await requireAuthAdmin(event)
  const { name } = await readValidatedBody(event, bodySchema.parse)

  const { id, token } = await createServiceToken(name)

  await writeAudit({
    actorUserId: admin.id,
    action: 'service-token.created',
    target: id,
    detail: { name },
  })

  return { id, name, token }
})
