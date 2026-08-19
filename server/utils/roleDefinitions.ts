/**
 * Role-definition rules shared by every grant write path.
 */

import { db, schema } from '@nuxthub/db'
import { isNull } from 'drizzle-orm'

/**
 * New grants must reference a definition (ADR-0014). Roles the holder already
 * has are exempt, which keeps the dormant `ticketing:*` history editable.
 */
export async function assertGrantsDefined(roles: { role: string }[], alreadyHeld: Set<string>): Promise<void> {
  const fresh = roles.filter(g => !alreadyHeld.has(g.role))
  if (!fresh.length) return

  // Withdrawn definitions are excluded: the app has stopped reading the role,
  // so a new grant would do nothing (ADR-0018). Existing holders are exempt.
  const definitions = await db.select().from(schema.roleDefinitions)
    .where(isNull(schema.roleDefinitions.withdrawnAt)).all()
  const defined = new Set(definitions.map(d => d.roleKey))

  for (const grant of fresh) {
    if (!defined.has(grant.role)) {
      throw createError({
        statusCode: 400,
        statusMessage: `No definition for ${grant.role}: define it under Role definitions first`,
      })
    }
  }
}

/**
 * A bad snapshot must never be able to remove every `auth:ADMIN` or
 * `training:ADMIN`: that removes the ability to fix the rule (ADR-0019).
 */
export function eligibilityModeAllowed(namespace: string, role: string, mode: string): boolean {
  void namespace
  return mode !== 'enforcing' || role !== 'ADMIN'
}

/** The throwing form, for an admin edit. A manifest is downgraded instead. */
export function assertEligibilityModeAllowed(namespace: string, role: string, mode: string): void {
  if (eligibilityModeAllowed(namespace, role, mode)) return

  throw createError({
    statusCode: 400,
    statusMessage: `${namespace}:ADMIN cannot have an enforcing training prerequisite: an outage would lock out the people who fix it`,
  })
}
