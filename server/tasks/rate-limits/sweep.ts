export default defineTask({
  meta: {
    name: 'rate-limits:sweep',
    description: 'Delete rate-limit counters whose window lapsed over a day ago, and expired MFA challenges',
  },
  async run() {
    const removed = await sweepRateLimits()
    console.info(`[rate-limits:sweep] removed ${removed} stale counters`)

    // Short-lived MFA state (pending logins, WebAuthn challenges) rides along
    // here rather than earning its own cron trigger (ADR-0012).
    const challenges = await sweepMfaChallenges()
    console.info(`[rate-limits:sweep] removed ${challenges} expired MFA challenges`)

    return { result: { removed, challenges } }
  },
})
