/**
 * Daily eligibility snapshot (ADR-0019). Certification expiry is calendar
 * driven, so a day's granularity catches every lapse.
 */
export default defineTask({
  meta: {
    name: 'eligibility:snapshot',
    description: 'Re-read rehearsal\'s eligibility answers',
  },
  async run() {
    const results = await snapshotAllRules()
    const failed = results.filter(r => !r.ok).map(r => r.ruleKey)

    // Enforcement keeps honouring the last good answer, so nobody notices a
    // stale rule unless something says so (ADR-0019).
    const stale = await staleRules()
    if (stale.length) {
      await sendEligibilityStaleEmail(ROLES_CONFIG.digestEmail, stale)
    }

    return { result: { rules: results.length, failed, stale: stale.map(s => s.ruleKey) } }
  },
})
