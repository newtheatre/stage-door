/**
 * Account merge (ADR-0015). App hooks re-point FIRST; no auth-side state
 * changes until every app succeeds, so a partial failure is retryable.
 */

import { db, schema } from '@nuxthub/db'
import { and, eq, sql } from 'drizzle-orm'
import type { HookResult } from './appHooks'

type UserRow = typeof schema.users.$inferSelect

interface RoleOutcome {
  role: string
  outcome: 'kept' | 'moved' | 'conflict-earliest-expiry'
  expiresAt: number | null
}

export interface MergePlan {
  winner: { id: string, email: string, name: string }
  loser: { id: string, email: string, name: string }
  roles: RoleOutcome[]
  /** Credentials the winner would gain from the loser. */
  gains: { password: boolean, google: boolean, verified: boolean }
  legacyIds: { source: string, legacyId: string }[]
  warnings: string[]
  apps: HookResult<{ ok: boolean, notMirrored?: boolean, counts?: Record<string, number> }>[]
}

export interface MergeResult {
  winnerId: string
  loserId: string
  complete: boolean
  dryRun: boolean
  plan: MergePlan
}

const ANONYMISED_SUFFIX = '@anonymised.invalid'

/**
 * Conservative union: a concrete date beats permanent, and the earlier date
 * wins. A merge must never extend anyone's access.
 */
function earliestExpiry(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b
  if (b === null) return a
  return a.getTime() <= b.getTime() ? a : b
}

async function loadUsers(winnerId: string, loserId: string, actorId: string | null) {
  if (winnerId === loserId) {
    throw createError({ statusCode: 400, statusMessage: 'An account cannot be merged into itself' })
  }
  if (loserId === actorId) {
    throw createError({ statusCode: 400, statusMessage: 'You cannot merge your own account away' })
  }

  const winner = await loadUserOr404(winnerId)
  const loser = await loadUserOr404(loserId)

  for (const [user, side] of [[winner, 'winning'], [loser, 'losing']] as const) {
    if (user.email.endsWith(ANONYMISED_SUFFIX)) {
      throw createError({ statusCode: 400, statusMessage: `The ${side} account is anonymised — nothing to merge` })
    }
  }

  return { winner, loser }
}

function buildPlan(
  winner: UserRow,
  loser: UserRow,
  winnerGrants: (typeof schema.userRoles.$inferSelect)[],
  loserGrants: (typeof schema.userRoles.$inferSelect)[],
  legacyIds: { source: string, legacyId: string }[],
  loserFactors: string[],
  apps: MergePlan['apps'],
): MergePlan {
  const winnerByRole = new Map(winnerGrants.map(g => [g.role, g]))

  const roles: RoleOutcome[] = winnerGrants.map(g => ({
    role: g.role,
    outcome: 'kept' as const,
    expiresAt: g.expiresAt?.getTime() ?? null,
  }))
  for (const grant of loserGrants) {
    const existing = winnerByRole.get(grant.role)
    if (!existing) {
      roles.push({ role: grant.role, outcome: 'moved', expiresAt: grant.expiresAt?.getTime() ?? null })
    }
    else {
      const merged = earliestExpiry(existing.expiresAt, grant.expiresAt)
      const kept = roles.find(r => r.role === grant.role)!
      if ((merged?.getTime() ?? null) !== (existing.expiresAt?.getTime() ?? null)) {
        kept.outcome = 'conflict-earliest-expiry'
        kept.expiresAt = merged?.getTime() ?? null
      }
    }
  }

  const warnings: string[] = []
  if (loserFactors.length > 0) {
    warnings.push('The losing account has two-step sign-in set up — second factors are never moved and will be deleted.')
  }
  if (loser.password !== null && winner.password !== null) {
    warnings.push('The losing account\'s password is discarded — the winning account keeps its own.')
  }
  if (loser.googleSub !== null && winner.googleSub !== null) {
    warnings.push('The losing account\'s Google link is discarded — the winning account keeps its own.')
  }

  return {
    winner: { id: winner.id, email: winner.email, name: winner.name },
    loser: { id: loser.id, email: loser.email, name: loser.name },
    roles,
    gains: {
      password: winner.password === null && loser.password !== null,
      google: winner.googleSub === null && loser.googleSub !== null,
      verified: !winner.verified && loser.verified,
    },
    legacyIds,
    warnings,
    apps,
  }
}

export async function mergeUsers(
  winnerId: string,
  loserId: string,
  actor: { id: string | null },
  opts: { dryRun: boolean },
): Promise<MergeResult> {
  const { winner, loser } = await loadUsers(winnerId, loserId, actor.id)

  // Everything the loser holds, captured before anything mutates — erasure
  // deletes the grants and nulls the credentials further down.
  const loserGrants = await db.select().from(schema.userRoles)
    .where(eq(schema.userRoles.userId, loser.id)).all()
  const winnerGrants = await db.select().from(schema.userRoles)
    .where(eq(schema.userRoles.userId, winner.id)).all()
  const legacyIds = await db.select({ source: schema.legacyIds.source, legacyId: schema.legacyIds.legacyId })
    .from(schema.legacyIds).where(eq(schema.legacyIds.userId, loser.id)).all()
  const loserFactors = await enrolledFactors(loser.id)

  // App hooks first — the only step that can partially fail. Dry runs ask
  // the apps for counts without writing.
  const apps = await callAllAppHooks<{ ok: boolean, notMirrored?: boolean, counts?: Record<string, number> }>(
    'merge',
    { fromUserId: loser.id, toUserId: winner.id, ...(opts.dryRun ? { dryRun: true } : {}) },
  )

  const plan = buildPlan(winner, loser, winnerGrants, loserGrants, legacyIds, loserFactors, apps)
  const hooksOk = apps.every(a => a.ok)

  if (opts.dryRun) {
    return { winnerId: winner.id, loserId: loser.id, complete: hooksOk, dryRun: true, plan }
  }

  if (!hooksOk) {
    // Nothing auth-side has changed; the admin re-runs once the app is
    // back. Hooks are idempotent, so already-merged apps no-op.
    await writeAudit({
      actorUserId: actor.id,
      action: 'user.merge-incomplete',
      target: winner.id,
      detail: { loserId: loser.id, hooks: apps.map(a => ({ app: a.app, ok: a.ok })) },
    })
    return { winnerId: winner.id, loserId: loser.id, complete: false, dryRun: false, plan }
  }

  // Row-by-row, since UNIQUE(user_id, role) forbids a blanket re-point.
  // Direct, not via the endpoint: definition-less history must move too.
  const winnerByRole = new Map(winnerGrants.map(g => [g.role, g]))
  for (const grant of loserGrants) {
    const existing = winnerByRole.get(grant.role)
    if (!existing) {
      await db.insert(schema.userRoles).values({
        userId: winner.id,
        role: grant.role,
        expiresAt: grant.expiresAt,
        grantedBy: grant.grantedBy,
        grantedAt: grant.grantedAt,
        note: grant.note,
      }).onConflictDoNothing()
      continue
    }
    const merged = earliestExpiry(existing.expiresAt, grant.expiresAt)
    if ((merged?.getTime() ?? null) !== (existing.expiresAt?.getTime() ?? null)) {
      await db.update(schema.userRoles)
        .set({ expiresAt: merged, expiryWarnedAt: null })
        .where(and(eq(schema.userRoles.userId, winner.id), eq(schema.userRoles.role, grant.role)))
    }
  }

  // Legacy ids follow the person; the marker makes the merge itself a
  // findable fact under the winner.
  await db.update(schema.legacyIds).set({ userId: winner.id })
    .where(eq(schema.legacyIds.userId, loser.id))
  await db.insert(schema.legacyIds)
    .values({ userId: winner.id, source: 'merge', legacyId: loser.id })
    .onConflictDoNothing()

  // UNIQUE(user_id, stage) forbids re-pointing these; the winner's own
  // retention clock stands.
  await db.delete(schema.retentionNotices).where(eq(schema.retentionNotices.userId, loser.id))

  // Values the erasure below destroys, captured for the winner-side fill.
  const loserCredentials = {
    password: loser.password,
    googleSub: loser.googleSub,
    verified: loser.verified,
    lastLogin: loser.lastLogin,
    createdAt: loser.createdAt,
  }

  // Erasing the loser frees its email and googleSub uniques. The anonymise
  // hooks are cheap no-ops by this point.
  await eraseUser(loser.id, { id: actor.id, via: 'merge' })

  // Fill the winner's gaps. Its own credentials always win; the fill only
  // covers what it never had. googleSub is free now (erasure nulled it).
  await db.update(schema.users)
    .set({
      ...(winner.password === null && loserCredentials.password !== null ? { password: loserCredentials.password } : {}),
      ...(winner.googleSub === null && loserCredentials.googleSub !== null ? { googleSub: loserCredentials.googleSub } : {}),
      ...(loserCredentials.verified ? { verified: true } : {}),
      ...(loserCredentials.lastLogin && (!winner.lastLogin || loserCredentials.lastLogin > winner.lastLogin)
        ? { lastLogin: loserCredentials.lastLogin }
        : {}),
      ...(loserCredentials.createdAt < winner.createdAt ? { createdAt: loserCredentials.createdAt } : {}),
      // Roles/credentials changed: other sessions re-seal at next refresh.
      sessionEpoch: sql`${schema.users.sessionEpoch} + 1`,
    })
    .where(eq(schema.users.id, winner.id))

  await writeAudit({
    actorUserId: actor.id,
    action: 'user.merged',
    target: winner.id,
    // The anonymous id only — the loser's email must not outlive the
    // erasure in the audit log (same rule as user.erased).
    detail: {
      loserId: loser.id,
      roles: plan.roles.filter(r => r.outcome !== 'kept'),
      gains: plan.gains,
      hooks: apps.map(a => ({ app: a.app, ok: a.ok })),
    },
  })

  return { winnerId: winner.id, loserId: loser.id, complete: true, dryRun: false, plan }
}
