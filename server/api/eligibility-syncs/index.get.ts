import { db, schema } from '@nuxthub/db'
import { asc } from 'drizzle-orm'

/** Eligibility rule sync status, so a failing snapshot is visible (ADR-0019). */
export default defineEventHandler(async (event) => {
  await requireAuthAdmin(event)
  setHeader(event, 'Cache-Control', 'private, max-age=60')

  const referenced = new Set(await referencedRuleKeys())
  const rows = await db.select().from(schema.eligibilitySyncs)
    .orderBy(asc(schema.eligibilitySyncs.ruleKey)).all()
  const byKey = new Map(rows.map(r => [r.ruleKey, r]))

  // Keyed on what definitions actually depend on: a rule nothing references
  // enforces nothing, and a referenced rule with no row has never answered.
  return {
    syncs: [...referenced].sort().map(ruleKey => ({
      ruleKey,
      lastAttemptAt: byKey.get(ruleKey)?.lastAttemptAt?.getTime() ?? null,
      lastSuccessAt: byKey.get(ruleKey)?.lastSuccessAt?.getTime() ?? null,
      userCount: byKey.get(ruleKey)?.userCount ?? 0,
      lastError: byKey.get(ruleKey)?.lastError ?? null,
      stale: (byKey.get(ruleKey)?.lastSuccessAt?.getTime() ?? null) === null
        || Date.now() - byKey.get(ruleKey)!.lastSuccessAt!.getTime() > SNAPSHOT_STALE_MS,
    })),
  }
})
