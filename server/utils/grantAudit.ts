/**
 * Grants that reference nothing an app reads. A typo grant does nothing and
 * looks identical to a working one in the admin UI (ADR-0014, ADR-0021).
 */

import { db, schema } from '@nuxthub/db'
import { and, eq, sql } from 'drizzle-orm'

export type GrantProblem = 'unknown-namespace' | 'undefined-role' | 'withdrawn'

export interface SuspectGrant {
  role: string
  holders: number
  problem: GrantProblem
}

const EXPLANATIONS: Record<GrantProblem, string> = {
  'unknown-namespace': 'No registered app owns this namespace, so nothing reads it.',
  'undefined-role': 'The app exists but declares no such role, so nothing reads it.',
  'withdrawn': 'The app stopped declaring this role. Holders keep it until revoked.',
}

export function explain(problem: GrantProblem): string {
  return EXPLANATIONS[problem]
}

/**
 * Active grants whose role matches no live definition, worst first. Dormant
 * namespaces are history by design and never appear.
 */
export async function findSuspectGrants(now: Date = new Date()): Promise<SuspectGrant[]> {
  // The role vocabulary is tens of rows, so this groups rather than scanning
  // per grant, and binds one parameter.
  const grants = await db.select({
    role: schema.userRoles.role,
    holders: sql<number>`count(*)`,
  }).from(schema.userRoles)
    .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
    .where(and(activeRoleCondition(now), isRealRow()))
    .groupBy(schema.userRoles.role)
    .all()

  const definitions = await db.select({
    roleKey: schema.roleDefinitions.roleKey,
    withdrawnAt: schema.roleDefinitions.withdrawnAt,
  }).from(schema.roleDefinitions).all()
  const byRoleKey = new Map(definitions.map(d => [d.roleKey ?? '', d]))

  const apps = await db.select({ namespace: schema.apps.namespace }).from(schema.apps).all()
  // `auth` is this service's own namespace and has no registry row by design.
  const known = new Set([...apps.map(a => a.namespace), 'auth'])
  const dormant = new Set(ROLES_CONFIG.dormantNamespaces)

  const suspects: SuspectGrant[] = []
  for (const grant of grants) {
    const namespace = grant.role.split(':')[0] ?? ''
    if (dormant.has(namespace)) continue

    const definition = byRoleKey.get(grant.role)
    if (definition && definition.withdrawnAt === null) continue

    const problem: GrantProblem = definition
      ? 'withdrawn'
      : known.has(namespace) ? 'undefined-role' : 'unknown-namespace'

    suspects.push({ role: grant.role, holders: grant.holders, problem })
  }

  const order: GrantProblem[] = ['unknown-namespace', 'undefined-role', 'withdrawn']
  return suspects.sort((a, b) =>
    order.indexOf(a.problem) - order.indexOf(b.problem) || a.role.localeCompare(b.role))
}
