/**
 * Role-definition rules shared by every grant write path.
 */

import { db, schema } from '@nuxthub/db'
import { eq, isNull } from 'drizzle-orm'

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
      throw createError({ statusCode: 400, statusMessage: await undefinedRoleMessage(grant.role) })
    }
  }
}

/** Names the app to deploy: there is no write route to send anyone to (ADR-0024). */
async function undefinedRoleMessage(roleKey: string): Promise<string> {
  const namespace = roleKey.split(':')[0] ?? roleKey
  const app = await db.select({ name: schema.apps.name })
    .from(schema.apps).where(eq(schema.apps.namespace, namespace)).get()

  if (!app) {
    return `No definition for ${roleKey}: no registered app owns the '${namespace}' namespace, so check the spelling`
  }
  return `No definition for ${roleKey}: declare it in the ${app.name} manifest and deploy that app, then press Sync now under Admin, Apps`
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
