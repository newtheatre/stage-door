/**
 * Role-definition rules shared by every grant write path.
 */

import { db, schema } from '@nuxthub/db'

/**
 * New grants must reference a definition (ADR-0014). Roles the holder already
 * has are exempt, which keeps the dormant `ticketing:*` history editable.
 */
export async function assertGrantsDefined(roles: { role: string }[], alreadyHeld: Set<string>): Promise<void> {
  const fresh = roles.filter(g => !alreadyHeld.has(g.role))
  if (!fresh.length) return

  const definitions = await db.select().from(schema.roleDefinitions).all()
  const defined = new Set(definitions.map(d => `${d.namespace}:${d.role}`))

  for (const grant of fresh) {
    if (!defined.has(grant.role)) {
      throw createError({
        statusCode: 400,
        statusMessage: `No definition for ${grant.role} — define it under Role definitions first`,
      })
    }
  }
}
