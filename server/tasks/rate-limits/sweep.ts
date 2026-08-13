import { db, schema } from '@nuxthub/db'
import { lt } from 'drizzle-orm'

export default defineTask({
  meta: {
    name: 'rate-limits:sweep',
    description: 'Delete rate-limit counters whose window lapsed over a day ago, plus expired MFA challenges and magic links',
  },
  async run() {
    const removed = await sweepRateLimits()
    console.info(`[rate-limits:sweep] removed ${removed} stale counters`)

    // Short-lived MFA state (pending logins, WebAuthn challenges) rides along
    // here rather than earning its own cron trigger (ADR-0012).
    const challenges = await sweepMfaChallenges()
    console.info(`[rate-limits:sweep] removed ${challenges} expired MFA challenges`)

    // Expired magic links likewise (ADR-0013). Most rows go at consumption
    // or re-request; this catches links that were simply never clicked.
    const links = await db.delete(schema.magicLinks)
      .where(lt(schema.magicLinks.expiresAt, new Date()))
      .returning({ id: schema.magicLinks.id })
    console.info(`[rate-limits:sweep] removed ${links.length} expired magic links`)

    return { result: { removed, challenges, magicLinks: links.length } }
  },
})
