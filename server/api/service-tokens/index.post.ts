import { z } from 'zod/v4'

const bodySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Lowercase app name, e.g. proscenium'),
})

/**
 * Issue a token for an app. The plaintext is returned once.
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
