import { db, schema } from '@nuxthub/db'

/** GET /api/service-tokens — list (names and usage; hashes never leave the DB). */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)

  const rows = await db.select({
    id: schema.serviceTokens.id,
    name: schema.serviceTokens.name,
    createdAt: schema.serviceTokens.createdAt,
    lastUsedAt: schema.serviceTokens.lastUsedAt,
  }).from(schema.serviceTokens).all()

  return { tokens: rows }
})
