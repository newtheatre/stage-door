/**
 * Snapshotting rehearsal's eligibility answers (ADR-0019). Never on a request
 * path: loadRoles reads the snapshot, and only ever the snapshot.
 */

import { db, schema } from '@nuxthub/db'
import { eq, isNotNull } from 'drizzle-orm'

export interface SnapshotResult {
  ruleKey: string
  ok: boolean
  userCount?: number
  error?: string
}

/** Rule keys any definition depends on. Bounded by the definitions table. */
export async function referencedRuleKeys(): Promise<string[]> {
  const rows = await db.selectDistinct({ key: schema.roleDefinitions.requiresEligibilityKey })
    .from(schema.roleDefinitions)
    .where(isNotNull(schema.roleDefinitions.requiresEligibilityKey))
    .all()
  return rows.map(r => r.key!).filter(Boolean)
}

/** The registered app serving the `training` namespace, or null. */
export async function trainingApp() {
  return await db.select().from(schema.apps)
    .where(eq(schema.apps.namespace, 'training')).get() ?? null
}

async function recordSyncFailure(ruleKey: string, message: string): Promise<void> {
  const now = new Date()
  await db.insert(schema.eligibilitySyncs)
    .values({ ruleKey, lastAttemptAt: now, lastError: message })
    .onConflictDoUpdate({
      target: schema.eligibilitySyncs.ruleKey,
      // last_success_at is deliberately untouched: the old snapshot stays in force.
      set: { lastAttemptAt: now, lastError: message },
    })
}

/**
 * Replace one rule's snapshot from rehearsal's answer. Never throws; a failure
 * leaves the previous snapshot exactly as it was.
 */
export async function snapshotRule(ruleKey: string): Promise<SnapshotResult> {
  try {
    const app = await trainingApp()
    if (!app) throw new Error('No app registered for the training namespace')

    const token = useRuntimeConfig().trainingApiToken
    if (!token) throw new Error('NUXT_TRAINING_API_TOKEN is not set')

    const answer = await $fetch<{ key: string, userIds: string[] }>(
      `${app.baseUrl}/api/v1/eligibility/${ruleKey}`,
      { headers: { Authorization: `Bearer ${token}` }, retry: 1, timeout: 10_000 },
    )

    const userIds = [...new Set(answer.userIds ?? [])]
    const now = new Date()

    await db.delete(schema.eligibilitySnapshots)
      .where(eq(schema.eligibilitySnapshots.ruleKey, ruleKey))

    // Three bound parameters per row, so 30 rows is 90 (D1 caps at 100).
    for (let i = 0; i < userIds.length; i += 30) {
      await db.insert(schema.eligibilitySnapshots)
        .values(userIds.slice(i, i + 30).map(userId => ({ ruleKey, userId, capturedAt: now })))
    }

    await db.insert(schema.eligibilitySyncs)
      .values({ ruleKey, lastAttemptAt: now, lastSuccessAt: now, userCount: userIds.length, lastError: null })
      .onConflictDoUpdate({
        target: schema.eligibilitySyncs.ruleKey,
        set: { lastAttemptAt: now, lastSuccessAt: now, userCount: userIds.length, lastError: null },
      })

    return { ruleKey, ok: true, userCount: userIds.length }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[eligibility] ${ruleKey} snapshot failed:`, error)
    await recordSyncFailure(ruleKey, message)
    return { ruleKey, ok: false, error: message }
  }
}

/** Snapshot every rule a definition depends on. */
export async function snapshotAllRules(): Promise<SnapshotResult[]> {
  const keys = await referencedRuleKeys()
  const results: SnapshotResult[] = []
  for (const key of keys) results.push(await snapshotRule(key))
  return results
}
